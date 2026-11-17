import type { StackTemplate } from "./types.js";

/**
 * Preview server for static sites. It lives in the sandbox cache, not in the
 * project: a static site needs no tooling to be deployed anywhere.
 */
export const STATIC_PREVIEW_SERVER = `import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
const reload = '<script>(()=>{let v;setInterval(async()=>{try{const n=await(await fetch("/__lotse/version")).text();if(v&&n!==v)location.reload();v=n}catch{}},1000)})()</script>';

async function version(dir = root) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await version(path) : (await stat(path)).mtimeMs);
  }
  return newest;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/__lotse/version") return res.writeHead(200, { "cache-control": "no-store" }).end(String(await version()));
  const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\\.\\.[/\\\\])+/, "");
  for (const candidate of [safe, join(safe, "index.html"), safe + ".html", "index.html"]) {
    try {
      const file = join(root, candidate);
      if (!(await stat(file)).isFile()) continue;
      let body = await readFile(file);
      const type = types[extname(file)] || "application/octet-stream";
      if (type.startsWith("text/html")) body = Buffer.from(body.toString("utf8").replace("</body>", reload + "</body>"));
      return res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {}
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}).listen(port, "0.0.0.0", () => console.log("static preview on " + port));
`;

export const staticStack: StackTemplate = {
  id: "static",
  name: "Static site",
  language: "html",
  runtime: "static",
  description: "Plain HTML, CSS and JavaScript without a build step. Best for landing pages and small tools that need no server.",
  beta: false,
  sandbox: {
    image: "node:22-alpine",
    dev: "node /cache/lotse/static-preview.mjs",
    port: 3000,
    hotReload: true,
    helperFiles: { "lotse/static-preview.mjs": STATIC_PREVIEW_SERVER },
  },
  guidance: `- The site consists of index.html, styles.css and script.js in the project root. Add more pages as further .html files.
- No build step, no npm packages, no frameworks, no CDN links: everything must work from the files in the project.
- Use semantic HTML, a responsive layout and accessible markup (labels, alt texts, sufficient contrast).
- Data that must persist lives in localStorage. There is no server.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: static\nbuild:\n  strategy: static\n  output: .\n`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>Your app starts here.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`,
    "styles.css": `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}

body {
  margin: 0;
}

main {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 1rem;
}
`,
    "script.js": `// Behaviour of the page goes here.\n`,
    ".lotseignore": "README.md\n",
    "README.md": `# ${title}\n\nA static site. Open \`index.html\` in a browser or serve the folder with any web server.\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};
