import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, stringifyManifest, validateManifest } from "@lotseai/core";
import { detectProject, generateDockerfile, slugify, staticSiteDockerfile, suggestManifest } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lotse-detect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), content);
};

describe("project detection", () => {
  it("recognises a plain static site", async () => {
    await write("index.html", "<h1>hi</h1>");
    expect(await detectProject(dir)).toMatchObject({ language: "static", kind: "static", outputDir: "." });
  });

  it("recognises a Vite single-page app as a static build", async () => {
    await write("package.json", JSON.stringify({ scripts: { build: "vite build", dev: "vite" }, devDependencies: { vite: "^8" } }));
    await write("pnpm-lock.yaml", "");
    expect(await detectProject(dir)).toMatchObject({
      language: "node",
      framework: "vite",
      kind: "static",
      packageManager: "pnpm",
      installCommand: "pnpm install --frozen-lockfile",
      buildCommand: "pnpm run build",
      outputDir: "dist",
    });
  });

  it("recognises Node.js servers", async () => {
    await write("package.json", JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { hono: "^4" }, engines: { node: ">=22" } }));
    await write("package-lock.json", "{}");
    expect(await detectProject(dir)).toMatchObject({
      kind: "server",
      framework: "hono",
      installCommand: "npm ci",
      startCommand: "npm start",
      languageVersion: "22",
      port: 3000,
    });
  });

  it("recognises FastAPI, Django, Go and Laravel", async () => {
    await write("requirements.txt", "fastapi==0.120\nuvicorn\n");
    await write("main.py", "app = None");
    expect(await detectProject(dir)).toMatchObject({ language: "python", framework: "fastapi", startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT" });

    await write("manage.py", `os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")`);
    expect(await detectProject(dir)).toMatchObject({ framework: "django", startCommand: "gunicorn shop.wsgi --bind 0.0.0.0:$PORT" });

    await rm(join(dir, "manage.py"));
    await rm(join(dir, "requirements.txt"));
    await write("go.mod", "module example.com/app\n\ngo 1.25\n");
    expect(await detectProject(dir)).toMatchObject({ language: "go", languageVersion: "1.25", kind: "server" });

    await write("artisan", "#!/usr/bin/env php");
    await write("Dockerfile", "FROM php:8.4");
    expect(await detectProject(dir)).toMatchObject({ language: "php", framework: "laravel", kind: "container", hasDockerfile: true });
  });

  it("suggests manifests that pass validation", async () => {
    expect(slugify("My Cool_App 2!")).toBe("my-cool-app-2");
    expect(slugify("123")).toBe("app");
    await write("package.json", JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "^5" } }));
    const server = validateManifest(suggestManifest("Customer Portal", await detectProject(dir)));
    expect(server).toMatchObject({
      name: "customer-portal",
      runtime: { kind: "server", language: "node", port: 3000, start: "npm start" },
      build: { strategy: "auto" },
    });
    expect(parseManifest(stringifyManifest(server))).toEqual(server);

    const container = validateManifest(suggestManifest("box", { language: "unknown", hasDockerfile: true, kind: "container" }));
    expect(container.build.strategy).toBe("dockerfile");
    const site = validateManifest(suggestManifest("site", { language: "static", hasDockerfile: false, kind: "static", outputDir: "." }));
    expect(site.build).toEqual({ strategy: "static", output: "." });
  });
});

describe("generated Dockerfiles", () => {
  const manifest = (yaml: string) => parseManifest(`version: 1\nname: app\n${yaml}`);

  it("builds Node.js apps with the detected package manager and runs them as non-root", () => {
    const text = generateDockerfile(
      {
        language: "node",
        packageManager: "pnpm",
        installCommand: "pnpm install --frozen-lockfile",
        buildCommand: "pnpm run build",
        startCommand: "pnpm start",
        hasDockerfile: false,
        kind: "server",
      },
      manifest("runtime:\n  kind: server\n  language: node\n  version: 24\n  port: 4000\n"),
    );
    expect(text).toContain("FROM node:24-alpine AS build");
    expect(text).toContain("RUN corepack enable");
    expect(text).toContain("RUN pnpm run build");
    expect(text).toContain("USER node");
    expect(text).toContain("EXPOSE 4000");
    expect(text).toContain('CMD ["sh", "-c", "exec pnpm start"]');
  });

  it("prefers the start command from the manifest", () => {
    const text = generateDockerfile(
      { language: "python", framework: "fastapi", startCommand: "uvicorn main:app", hasDockerfile: false, kind: "server" },
      manifest("runtime:\n  kind: server\n  language: python\n  start: gunicorn main:app\n"),
    );
    expect(text).toContain("FROM python:3.13-slim");
    expect(text).toContain("exec gunicorn main:app");
    expect(text).toContain("USER app");
  });

  it("covers Go and PHP and explains what it cannot build", () => {
    const go = generateDockerfile(
      { language: "go", languageVersion: "1.25", hasDockerfile: false, kind: "server" },
      manifest("runtime:\n  kind: server\n  language: go\n  port: 8080\n"),
    );
    expect(go).toContain("FROM golang:1.25-alpine AS build");
    expect(go).toContain("CGO_ENABLED=0 go build");
    const php = generateDockerfile(
      { language: "php", framework: "laravel", hasDockerfile: false, kind: "server" },
      manifest("runtime:\n  kind: server\n  language: php\n  port: 8080\n"),
    );
    expect(php).toContain("dunglas/frankenphp:1-php8.4");
    expect(php).toContain('"--root", "public"');
    expect(() =>
      generateDockerfile({ language: "unknown", hasDockerfile: false, kind: "server" }, manifest("runtime:\n  kind: server\n  language: rust\n")),
    ).toThrow(/does not know how to build "rust"/);
    expect(() =>
      generateDockerfile({ language: "node", hasDockerfile: false, kind: "server" }, manifest("runtime:\n  kind: server\n  language: node\n")),
    ).toThrow(/Cannot tell how to start/);
  });

  it("packages static sites behind Caddy", () => {
    const { dockerfile, caddyfile } = staticSiteDockerfile();
    expect(dockerfile).toContain("FROM caddy:2-alpine");
    expect(caddyfile).toContain(":{$PORT:8080}");
  });
});
