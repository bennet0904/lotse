/**
 * Deployment manifest (`lotse.yaml`), specification section 7.1.
 *
 * The zod schema below is the single source of truth. The JSON schema
 * published with the package (`schema/lotse.schema.json`) is generated from it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { LotseError } from "./errors.js";

export const MANIFEST_FILE = "lotse.yaml";
export const MANIFEST_VERSION = 1;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APP_NAME = /^[a-z]([a-z0-9-]{0,48}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESOURCE_NAME = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

const envName = z.string().regex(ENV_NAME, "must be a valid environment variable name (letters, digits, underscore)");

const runtimeSchema = z.strictObject({
  kind: z.enum(["static", "server", "container"]).describe("How the app runs: static files, a server process or a container."),
  language: z
    .string()
    .regex(/^[a-z][a-z0-9+#-]*$/, "must be a lowercase language id such as node, python, go or php")
    .optional()
    .describe("Language of the app, e.g. node, python, go, php."),
  version: z.union([z.string(), z.number()]).transform(String).optional().describe("Language version, e.g. 22 or 3.13."),
  port: z.number().int().min(1).max(65535).optional().describe("Port the app listens on. Also passed to the app as PORT."),
  start: z.string().min(1).optional().describe("Command that starts a server app."),
  healthcheck: z
    .string()
    .regex(/^\/\S*$/, "must be a path starting with /")
    .optional()
    .describe("HTTP path that returns 2xx when the app is healthy."),
});

const buildSchema = z.strictObject({
  strategy: z
    .enum(["auto", "dockerfile", "static"])
    .optional()
    .describe("auto: buildpack-style image, dockerfile: own Dockerfile, static: build command plus output folder."),
  command: z.string().min(1).optional().describe("Build command, e.g. npm run build."),
  output: z.string().min(1).optional().describe("Output folder of a static build, relative to the app root."),
  dockerfile: z.string().min(1).optional().describe("Path of the Dockerfile for the dockerfile strategy."),
});

const resourceSchema = z.strictObject({
  type: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "must be a resource type such as postgres, redis or object-storage")
    .describe("Resource type: postgres, redis, object-storage ..."),
  name: z.string().regex(RESOURCE_NAME, "must be lowercase letters, digits and hyphens"),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).optional(),
});

const envSchema = z.strictObject({
  public: z
    .record(envName, z.union([z.string(), z.number(), z.boolean()]).transform(String))
    .default({})
    .describe("Non-secret values stored in the manifest."),
  secrets: z.array(envName).default([]).describe("Names of secrets. Values live in the encrypted credential store."),
});

const releaseSchema = z.strictObject({
  command: z.string().min(1).describe("Runs in the new version before it receives traffic, e.g. database migrations."),
});

export const manifestSchema = z
  .strictObject({
    version: z.literal(MANIFEST_VERSION).describe("Manifest format version."),
    name: z
      .string()
      .regex(APP_NAME, "must start with a letter and contain only lowercase letters, digits and hyphens (max 50 characters)")
      .describe("App name. Unique per provider account."),
    runtime: runtimeSchema,
    build: buildSchema.default({}),
    release: releaseSchema.optional(),
    resources: z.array(resourceSchema).default([]),
    env: envSchema.default({ public: {}, secrets: [] }),
    domains: z.array(z.string().toLowerCase().regex(HOSTNAME, "must be a valid domain name")).default([]),
  })
  .superRefine((m, ctx) => {
    const strategy = m.build.strategy;
    if (m.runtime.kind === "static" && strategy && strategy !== "static") {
      ctx.addIssue({ code: "custom", path: ["build", "strategy"], message: `runtime kind "static" requires build strategy "static"` });
    }
    if (m.runtime.kind !== "static" && strategy === "static") {
      ctx.addIssue({ code: "custom", path: ["build", "strategy"], message: `build strategy "static" requires runtime kind "static"` });
    }
    if (m.runtime.kind !== "static" && !m.runtime.language && strategy !== "dockerfile" && m.runtime.kind !== "container") {
      ctx.addIssue({ code: "custom", path: ["runtime", "language"], message: "is required for server apps" });
    }
    const seen = new Set<string>();
    m.resources.forEach((r, i) => {
      if (seen.has(r.name)) ctx.addIssue({ code: "custom", path: ["resources", i, "name"], message: `duplicate resource name "${r.name}"` });
      seen.add(r.name);
    });
    const publicNames = new Set(Object.keys(m.env.public));
    m.env.secrets.forEach((s, i) => {
      if (publicNames.has(s)) ctx.addIssue({ code: "custom", path: ["env", "secrets", i], message: `"${s}" is declared both as public value and as secret` });
    });
    const domains = new Set<string>();
    m.domains.forEach((d, i) => {
      if (domains.has(d)) ctx.addIssue({ code: "custom", path: ["domains", i], message: `duplicate domain "${d}"` });
      domains.add(d);
    });
  })
  .transform((m) => {
    const kind = m.runtime.kind;
    const strategy = m.build.strategy ?? (kind === "static" ? "static" : kind === "container" ? "dockerfile" : "auto");
    return {
      ...m,
      runtime: {
        ...m.runtime,
        port: kind === "static" ? m.runtime.port : (m.runtime.port ?? 3000),
        healthcheck: m.runtime.healthcheck ?? "/",
      },
      build: { ...m.build, strategy } as typeof m.build & { strategy: "auto" | "dockerfile" | "static" },
    };
  });

/** A validated manifest with defaults applied. */
export type Manifest = z.output<typeof manifestSchema>;
/** The manifest as written in `lotse.yaml`. */
export type ManifestInput = z.input<typeof manifestSchema>;

export interface ManifestIssue {
  path: string;
  message: string;
  line?: number;
}

export class ManifestError extends LotseError {
  readonly issues: ManifestIssue[];
  constructor(issues: ManifestIssue[], file = MANIFEST_FILE) {
    const lines = issues.map((i) => `  - ${i.path ? `${i.path}: ` : ""}${i.message}${i.line ? ` (line ${i.line})` : ""}`);
    super("MANIFEST_INVALID", `${file} is not valid:\n${lines.join("\n")}`, { details: { issues } });
    this.name = "LotseError";
    this.issues = issues;
  }
}

function formatPath(path: PropertyKey[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");
}

/** Validates an already parsed object. Throws `ManifestError` listing every problem. */
export function validateManifest(input: unknown, file?: string): Manifest {
  const result = manifestSchema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message:
      issue.code === "unrecognized_keys" ? `unknown ${issue.keys.length > 1 ? "keys" : "key"} ${issue.keys.map((k) => `"${k}"`).join(", ")}` : issue.message,
  }));
  throw new ManifestError(issues, file);
}

/** Parses and validates the text of a `lotse.yaml`. */
export function parseManifest(text: string, file?: string): Manifest {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ManifestError(
      doc.errors.map((e) => ({ path: "", message: e.message.split("\n")[0] ?? e.message, line: e.linePos?.[0]?.line })),
      file,
    );
  }
  const data = doc.toJS();
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ManifestError([{ path: "", message: "must be a YAML mapping" }], file);
  }
  try {
    return validateManifest(data, file);
  } catch (err) {
    if (err instanceof ManifestError) {
      // Attach line numbers from the YAML document where possible.
      for (const issue of err.issues) {
        const segments = issue.path
          .split(/\.|\[|\]/)
          .filter(Boolean)
          .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
        const node = segments.length > 0 ? doc.getIn(segments, true) : undefined;
        const range = (node as { range?: [number, number, number] } | undefined)?.range;
        if (range) issue.line = text.slice(0, range[0]).split("\n").length;
      }
      throw new ManifestError(err.issues, file);
    }
    throw err;
  }
}

/** Loads `lotse.yaml` from an app directory. */
export async function loadManifest(dir: string): Promise<Manifest> {
  const file = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LotseError("MANIFEST_NOT_FOUND", `No ${MANIFEST_FILE} found in ${dir}.`, {
        hints: ["Run `lotse init` to create one."],
      });
    }
    throw err;
  }
  return parseManifest(text, file);
}

/** Serializes a manifest to YAML, leaving out empty optional sections. */
export function stringifyManifest(manifest: ManifestInput | Manifest): string {
  const m = manifest as Manifest;
  const out: Record<string, unknown> = { version: m.version, name: m.name, runtime: { ...m.runtime } };
  if (m.build && Object.keys(m.build).length > 0) out.build = { ...m.build };
  if (m.release) out.release = { ...m.release };
  if (m.resources && m.resources.length > 0) out.resources = m.resources;
  const env: Record<string, unknown> = {};
  if (m.env?.public && Object.keys(m.env.public).length > 0) env.public = m.env.public;
  if (m.env?.secrets && m.env.secrets.length > 0) env.secrets = m.env.secrets;
  if (Object.keys(env).length > 0) out.env = env;
  if (m.domains && m.domains.length > 0) out.domains = m.domains;
  const header = "# yaml-language-server: $schema=https://unpkg.com/@lotse/core/schema/lotse.schema.json\n";
  return header + stringify(out, { lineWidth: 0 });
}

export async function writeManifest(dir: string, manifest: ManifestInput | Manifest): Promise<string> {
  const file = join(dir, MANIFEST_FILE);
  await writeFile(file, stringifyManifest(manifest), "utf8");
  return file;
}

/** JSON schema (draft 2020-12) describing `lotse.yaml` as written by users. */
export function manifestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(manifestSchema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://unpkg.com/@lotse/core/schema/lotse.schema.json",
    title: "Lotse deployment manifest",
    description: "Provider-neutral description of what an app needs to run (lotse.yaml).",
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema")),
  };
}
