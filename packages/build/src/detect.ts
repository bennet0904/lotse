import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestInput, RuntimeKind } from "@lotseai/core";

export type Language = "static" | "node" | "python" | "go" | "php" | "unknown";

export interface ProjectInfo {
  language: Language;
  framework?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  languageVersion?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  /** Output folder of a static build. */
  outputDir?: string;
  port?: number;
  hasDockerfile: boolean;
  /** The runtime kind that fits the project best. */
  kind: RuntimeKind;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function read(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

interface PackageJson {
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

const SERVER_FRAMEWORKS = ["next", "hono", "express", "fastify", "koa", "@nestjs/core", "@remix-run/node", "nuxt"];

async function detectNode(dir: string, pkgText: string, hasDockerfile: boolean): Promise<ProjectInfo> {
  let pkg: PackageJson = {};
  try {
    pkg = JSON.parse(pkgText) as PackageJson;
  } catch {
    // An unreadable package.json still tells us this is a Node.js project.
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const packageManager = (await exists(join(dir, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(dir, "yarn.lock")))
      ? "yarn"
      : (await exists(join(dir, "bun.lock"))) || (await exists(join(dir, "bun.lockb")))
        ? "bun"
        : "npm";
  const installCommand = {
    npm: (await exists(join(dir, "package-lock.json"))) ? "npm ci" : "npm install",
    pnpm: "pnpm install --frozen-lockfile",
    yarn: "yarn install --frozen-lockfile",
    bun: "bun install --frozen-lockfile",
  }[packageManager];
  const runScript = (name: string) => (packageManager === "npm" ? `npm run ${name}` : `${packageManager} run ${name}`);
  const framework = SERVER_FRAMEWORKS.find((f) => f in deps) ?? ["astro", "vite", "react-scripts", "@11ty/eleventy"].find((f) => f in deps);
  const isServer = Boolean(framework && SERVER_FRAMEWORKS.includes(framework)) || (!framework && Boolean(scripts.start || pkg.main));
  const version = pkg.engines?.node?.match(/\d+/)?.[0];
  const base = { language: "node" as const, framework, packageManager, installCommand, languageVersion: version, hasDockerfile } satisfies Partial<ProjectInfo>;

  if (isServer) {
    return {
      ...base,
      kind: "server",
      buildCommand: scripts.build ? runScript("build") : undefined,
      startCommand: scripts.start ? (packageManager === "npm" ? "npm start" : `${packageManager} start`) : pkg.main ? `node ${pkg.main}` : undefined,
      port: 3000,
    };
  }
  const outputDir = framework === "react-scripts" ? "build" : framework === "@11ty/eleventy" ? "_site" : "dist";
  return { ...base, kind: "static", buildCommand: scripts.build ? runScript("build") : undefined, outputDir: scripts.build ? outputDir : "." };
}

async function detectPython(dir: string, hasDockerfile: boolean): Promise<ProjectInfo> {
  const requirements = ((await read(join(dir, "requirements.txt"))) ?? "") + ((await read(join(dir, "pyproject.toml"))) ?? "");
  const lower = requirements.toLowerCase();
  const base = { language: "python" as const, hasDockerfile, kind: "server" as const, port: 8000, installCommand: "pip install -r requirements.txt" };
  if (await exists(join(dir, "manage.py"))) {
    const manage = (await read(join(dir, "manage.py"))) ?? "";
    const project = manage.match(/["']([A-Za-z0-9_]+)\.settings["']/)?.[1] ?? "config";
    return { ...base, framework: "django", startCommand: `gunicorn ${project}.wsgi --bind 0.0.0.0:$PORT` };
  }
  if (lower.includes("fastapi")) {
    const module = (await exists(join(dir, "main.py"))) ? "main" : (await exists(join(dir, "app/main.py"))) ? "app.main" : "main";
    return { ...base, framework: "fastapi", startCommand: `uvicorn ${module}:app --host 0.0.0.0 --port $PORT` };
  }
  if (lower.includes("flask")) return { ...base, framework: "flask", startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT" };
  return { ...base, startCommand: (await exists(join(dir, "main.py"))) ? "python main.py" : undefined };
}

/** Inspects a project directory and derives how it is built and started. */
export async function detectProject(dir: string): Promise<ProjectInfo> {
  const hasDockerfile = await exists(join(dir, "Dockerfile"));
  const pkg = await read(join(dir, "package.json"));
  if (await exists(join(dir, "artisan"))) {
    return {
      language: "php",
      framework: "laravel",
      hasDockerfile,
      kind: hasDockerfile ? "container" : "server",
      port: 8080,
      installCommand: "composer install --no-dev --optimize-autoloader",
    };
  }
  if (pkg !== undefined) return detectNode(dir, pkg, hasDockerfile);
  if ((await exists(join(dir, "requirements.txt"))) || (await exists(join(dir, "pyproject.toml"))) || (await exists(join(dir, "manage.py")))) {
    return detectPython(dir, hasDockerfile);
  }
  const goMod = await read(join(dir, "go.mod"));
  if (goMod !== undefined) {
    return {
      language: "go",
      framework: "net/http",
      hasDockerfile,
      kind: "server",
      port: 8080,
      languageVersion: goMod.match(/^go\s+(\d+\.\d+)/m)?.[1],
      buildCommand: "go build -o app .",
      startCommand: "./app",
    };
  }
  if (await exists(join(dir, "composer.json"))) {
    return { language: "php", hasDockerfile, kind: "server", port: 8080, installCommand: "composer install --no-dev --optimize-autoloader" };
  }
  if (await exists(join(dir, "index.html"))) return { language: "static", hasDockerfile, kind: "static", outputDir: "." };
  for (const candidate of ["public", "dist", "site"]) {
    if (await exists(join(dir, candidate, "index.html"))) return { language: "static", hasDockerfile, kind: "static", outputDir: candidate };
  }
  return { language: "unknown", hasDockerfile, kind: hasDockerfile ? "container" : "static" };
}

/** Turns a folder name into a valid manifest name. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "app";
}

/** A manifest that fits the detected project; the starting point for `lotse init`. */
export function suggestManifest(name: string, info: ProjectInfo): ManifestInput {
  const slug = slugify(name);
  if (info.kind === "static") {
    return {
      version: 1,
      name: slug,
      runtime: { kind: "static" },
      build: { strategy: "static", ...(info.buildCommand ? { command: info.buildCommand } : {}), output: info.outputDir ?? "." },
    };
  }
  if (info.kind === "container" || (info.language === "unknown" && info.hasDockerfile)) {
    return { version: 1, name: slug, runtime: { kind: "container", port: info.port ?? 3000, healthcheck: "/" }, build: { strategy: "dockerfile" } };
  }
  return {
    version: 1,
    name: slug,
    runtime: {
      kind: "server",
      language: info.language,
      ...(info.languageVersion ? { version: info.languageVersion } : {}),
      port: info.port ?? 3000,
      ...(info.startCommand ? { start: info.startCommand } : {}),
      healthcheck: "/",
    },
    build: { strategy: "auto" },
  };
}
