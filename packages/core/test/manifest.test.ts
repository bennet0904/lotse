import { readFile } from "node:fs/promises";
import { ManifestError, manifestJsonSchema, parseManifest, stringifyManifest } from "../src/index.js";

const SPEC_EXAMPLE = `version: 1
name: customer-portal
runtime:
  kind: server        # static | server | container
  language: node      # node | python | go | ...
  port: 3000
  healthcheck: /health
build:
  strategy: auto      # auto | dockerfile | static
  output: dist
resources:
  - type: postgres
    name: db
  - type: object-storage
    name: uploads
env:
  public:
    APP_NAME: Customer Portal
  secrets:
    - STRIPE_API_KEY
domains:
  - portal.example.com
`;

function issues(yaml: string): string[] {
  try {
    parseManifest(yaml);
  } catch (err) {
    if (err instanceof ManifestError) return err.issues.map((i) => `${i.path}: ${i.message}`);
    throw err;
  }
  return [];
}

describe("manifest", () => {
  it("accepts the example from the specification", () => {
    const m = parseManifest(SPEC_EXAMPLE);
    expect(m.name).toBe("customer-portal");
    expect(m.runtime).toMatchObject({ kind: "server", language: "node", port: 3000, healthcheck: "/health" });
    expect(m.build).toEqual({ strategy: "auto", output: "dist" });
    expect(m.resources.map((r) => r.type)).toEqual(["postgres", "object-storage"]);
    expect(m.env.public.APP_NAME).toBe("Customer Portal");
    expect(m.env.secrets).toEqual(["STRIPE_API_KEY"]);
    expect(m.domains).toEqual(["portal.example.com"]);
  });

  it("applies defaults per runtime kind", () => {
    const site = parseManifest("version: 1\nname: site\nruntime:\n  kind: static\n");
    expect(site.build.strategy).toBe("static");
    expect(site.runtime.port).toBeUndefined();
    expect(site.runtime.healthcheck).toBe("/");
    expect(site.resources).toEqual([]);
    expect(site.env).toEqual({ public: {}, secrets: [] });

    const server = parseManifest("version: 1\nname: api\nruntime:\n  kind: server\n  language: python\n");
    expect(server.build.strategy).toBe("auto");
    expect(server.runtime.port).toBe(3000);

    const container = parseManifest("version: 1\nname: box\nruntime:\n  kind: container\n");
    expect(container.build.strategy).toBe("dockerfile");
  });

  it("coerces scalar env values to strings", () => {
    const m = parseManifest("version: 1\nname: site\nruntime:\n  kind: static\nenv:\n  public:\n    DEBUG: false\n    RETRIES: 3\n");
    expect(m.env.public).toEqual({ DEBUG: "false", RETRIES: "3" });
  });

  it("reports every problem with its path and line", () => {
    const text = "version: 1\nname: Bad_Name\nruntime:\n  kind: serverless\n  prot: 3\nextra: 1\n";
    try {
      parseManifest(text);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      const e = err as ManifestError;
      expect(e.code).toBe("MANIFEST_INVALID");
      expect(e.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["name", "runtime.kind", "runtime", ""]));
      expect(e.issues.find((i) => i.path === "name")?.line).toBe(2);
      expect(e.message).toContain('unknown key "prot"');
      expect(e.message).toContain('unknown key "extra"');
    }
  });

  it("rejects inconsistent combinations", () => {
    expect(issues("version: 1\nname: a\nruntime:\n  kind: static\nbuild:\n  strategy: auto\n")).toEqual([
      'build.strategy: runtime kind "static" requires build strategy "static"',
    ]);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: server\n  language: node\nbuild:\n  strategy: static\n")).toEqual([
      'build.strategy: build strategy "static" requires runtime kind "static"',
    ]);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: server\n")).toEqual(["runtime.language: is required for server apps"]);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: static\nresources:\n  - type: postgres\n    name: db\n  - type: redis\n    name: db\n")).toEqual([
      'resources[1].name: duplicate resource name "db"',
    ]);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: static\nenv:\n  public:\n    KEY: x\n  secrets: [KEY]\n")).toEqual([
      'env.secrets[0]: "KEY" is declared both as public value and as secret',
    ]);
    expect(issues("version: 2\nname: a\nruntime:\n  kind: static\n")[0]).toMatch(/^version:/);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: static\ndomains: [not a domain]\n")[0]).toMatch(/^domains\[0\]: must be a valid domain name/);
    expect(issues("version: 1\nname: a\nruntime:\n  kind: static\n  healthcheck: health\n")[0]).toMatch(/must be a path starting with \//);
  });

  it("reports YAML syntax errors as manifest errors", () => {
    expect(() => parseManifest("version: 1\nname: [unclosed\n")).toThrow(ManifestError);
    expect(() => parseManifest("- just\n- a list\n")).toThrow(/must be a YAML mapping/);
  });

  it("round-trips through YAML", () => {
    const m = parseManifest(SPEC_EXAMPLE);
    expect(parseManifest(stringifyManifest(m))).toEqual(m);
  });

  it("publishes a JSON schema that matches the zod schema", async () => {
    const committed = JSON.parse(await readFile(new URL("../schema/lotse.schema.json", import.meta.url), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(manifestJsonSchema())));
    expect(committed.required).toEqual(expect.arrayContaining(["version", "name", "runtime"]));
    expect(committed.additionalProperties).toBe(false);
  });
});
