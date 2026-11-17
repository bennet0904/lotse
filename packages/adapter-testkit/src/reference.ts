/**
 * The reference apps deployed by live tests, SSH tests and the end-to-end
 * test. They have no dependencies so that a deployment exercises the hosting
 * path and nothing else.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REFERENCE_MARKER = "Lotse reference app";

const html = (version: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${REFERENCE_MARKER}</title>
  </head>
  <body>
    <h1>${REFERENCE_MARKER}</h1>
    <p id="version">version ${version}</p>
  </body>
</html>
`;

/** A static site: `index.html` plus a `health` file. */
export async function writeReferenceStaticSite(dir: string, name: string, version = "1"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), html(version));
  await writeFile(join(dir, "health"), "ok\n");
  await writeFile(join(dir, "lotse.yaml"), `version: 1\nname: ${name}\nruntime:\n  kind: static\nbuild:\n  strategy: static\n  output: .\n`);
  await writeFile(join(dir, ".lotseignore"), "lotse.yaml\n.lotseignore\n");
}

/** A Node.js server without dependencies. `/health` answers 200, or 500 when `healthy` is false. */
export async function writeReferenceServer(
  dir: string,
  name: string,
  options: { version?: string; healthy?: boolean; port?: number; resources?: string } = {},
): Promise<void> {
  const port = options.port ?? 3000;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name, version: "1.0.0", private: true, scripts: { start: "node server.js" } }, null, 2)}\n`);
  await writeFile(
    join(dir, "server.js"),
    `const http = require("node:http");
const port = Number(process.env.PORT || ${port});
const version = ${JSON.stringify(options.version ?? "1")};
const healthy = ${options.healthy === false ? "false" : "true"};
http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(healthy ? 200 : 500, { "content-type": "text/plain" });
      return res.end(healthy ? "ok" : "unhealthy");
    }
    if (req.url === "/env") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ APP_NAME: process.env.APP_NAME ?? null, hasSecret: Boolean(process.env.API_KEY), hasDatabase: Boolean(process.env.DATABASE_URL) }));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>${REFERENCE_MARKER}</title><h1>${REFERENCE_MARKER}</h1><p id=\\"version\\">version " + version + "</p>");
  })
  .listen(port, "0.0.0.0", () => console.log("reference app version " + version + " listening on " + port));
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await writeFile(
    join(dir, "lotse.yaml"),
    `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: node\n  port: ${port}\n  start: node server.js\n  healthcheck: /health\nbuild:\n  strategy: auto\n${options.resources ?? ""}env:\n  public:\n    APP_NAME: Reference\n`,
  );
}
