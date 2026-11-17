import type { StackTemplate } from "./types.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const GITIGNORE = "node_modules/\ndist/\n.next/\n.env\n.env.*\n";

export const reactViteStack: StackTemplate = {
  id: "react-vite",
  name: "React with Vite",
  language: "typescript",
  runtime: "static",
  description: "A single-page app with React and TypeScript, built by Vite into static files. Best for interactive apps without their own backend.",
  beta: false,
  sandbox: {
    image: "node:22-alpine",
    install: "npm install --no-audit --no-fund",
    installTriggers: ["package.json"],
    dev: "npm run dev",
    port: 5173,
    hotReload: true,
    check: "npx tsc --noEmit -p tsconfig.json",
  },
  guidance: `- Components live in src/ as .tsx files; src/App.tsx is the root component, src/main.tsx only mounts it.
- Styles go into src/index.css or CSS files imported by components. Do not add a CSS framework unless asked.
- The app is static: there is no server. Persist data in localStorage, or call external APIs from the browser.
- New npm packages go into package.json; they are installed automatically.
- Keep vite.config.ts as it is: the preview depends on its server settings.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: static\nbuild:\n  strategy: static\n  command: npm run build\n  output: dist\n`,
    "package.json": json({
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
      dependencies: { react: "^19.3.1", "react-dom": "^19.3.1" },
      devDependencies: { "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0", "@vitejs/plugin-react": "^6.3.0", typescript: "^5.9.3", vite: "^8.3.8" },
    }),
    "vite.config.ts": `import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // The live preview is served through a proxy under another host name.
    allowedHosts: true,
  },
});
`,
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        types: ["vite/client"],
      },
      include: ["src"],
    }),
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    "src/App.tsx": `export default function App() {
  return (
    <main>
      <h1>${title}</h1>
      <p>Your app starts here.</p>
    </main>
  );
}
`,
    "src/index.css": `:root {
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
    ".gitignore": GITIGNORE,
    "README.md": `# ${title}\n\nReact and TypeScript, built with Vite.\n\n\`\`\`sh\nnpm install\nnpm run dev     # development server\nnpm run build   # static files in dist/\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};

export const nextStack: StackTemplate = {
  id: "nextjs",
  name: "Next.js",
  language: "typescript",
  runtime: "server",
  description: "A full-stack React app with server rendering and API routes. Best for apps that need pages and a backend in one project.",
  beta: false,
  sandbox: {
    image: "node:22-alpine",
    install: "npm install --no-audit --no-fund",
    installTriggers: ["package.json"],
    dev: "npm run dev",
    port: 3000,
    hotReload: true,
    check: "npx tsc --noEmit -p tsconfig.json",
  },
  guidance: `- Use the App Router: pages are app/**/page.tsx, API endpoints are app/api/**/route.ts.
- Components are server components unless they need state or browser APIs; then start the file with "use client".
- Keep app/api/health/route.ts: deployments call it as health check.
- Read configuration from process.env. Secrets must be declared under env.secrets in lotse.yaml, never written into code.
- If the app needs a database, add a postgres resource to lotse.yaml and read DATABASE_URL.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: node\n  version: 22\n  port: 3000\n  start: npm start\n  healthcheck: /api/health\nbuild:\n  strategy: auto\n  command: npm run build\n`,
    "package.json": json({
      name,
      private: true,
      version: "0.1.0",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
      scripts: { dev: "next dev --hostname 0.0.0.0 --port 3000", build: "next build", start: "next start --hostname 0.0.0.0 --port ${PORT:-3000}" },
      dependencies: { next: "^16.4.6", react: "^19.3.1", "react-dom": "^19.3.1" },
      devDependencies: { "@types/node": "^22.19.0", "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0", typescript: "^5.9.3" },
    }),
    "next.config.mjs": `/** @type {import('next').NextConfig} */
const nextConfig = {
  // The live preview is served through a proxy under another host name.
  allowedDevOrigins: ["*.localhost", ...(process.env.LOTSE_PREVIEW_HOST ? [process.env.LOTSE_PREVIEW_HOST] : [])],
};

export default nextConfig;
`,
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`,
    "app/layout.tsx": `import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "${title}" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    "app/page.tsx": `export default function Home() {
  return (
    <main>
      <h1>${title}</h1>
      <p>Your app starts here.</p>
    </main>
  );
}
`,
    "app/globals.css": `:root {
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
    "app/api/health/route.ts": `export function GET() {\n  return Response.json({ status: "ok" });\n}\n`,
    ".gitignore": GITIGNORE,
    "README.md": `# ${title}\n\nNext.js with TypeScript.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};

export const honoStack: StackTemplate = {
  id: "hono",
  name: "Hono API",
  language: "typescript",
  runtime: "server",
  description: "A small, fast HTTP API in TypeScript on Node.js. Best for backends, webhooks and JSON APIs.",
  beta: false,
  sandbox: {
    image: "node:22-alpine",
    install: "npm install --no-audit --no-fund",
    installTriggers: ["package.json"],
    dev: "npm run dev",
    port: 3000,
    hotReload: true,
    check: "npx tsc --noEmit -p tsconfig.json",
  },
  guidance: `- Routes are defined in src/index.ts or in modules under src/routes/ that are mounted there.
- Keep GET /health: deployments call it as health check.
- The server listens on process.env.PORT (default 3000) on 0.0.0.0.
- Validate request bodies before using them and answer errors as JSON with a fitting status code.
- If the app needs a database, add a postgres resource to lotse.yaml and read DATABASE_URL.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: node\n  version: 22\n  port: 3000\n  start: npm start\n  healthcheck: /health\nbuild:\n  strategy: auto\n  command: npm run build\n`,
    "package.json": json({
      name,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "tsx watch src/index.ts", build: "tsc -p tsconfig.json", start: "node dist/index.js" },
      dependencies: { "@hono/node-server": "^2.1.8", hono: "^4.13.18" },
      devDependencies: { "@types/node": "^22.19.0", tsx: "^4.23.15", typescript: "^5.9.3" },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["src"],
    }),
    "src/index.ts": `import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/", (c) => c.json({ name: "${title}" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(\`listening on \${port}\`);
});
`,
    ".gitignore": GITIGNORE,
    "README.md": `# ${title}\n\nA Hono API on Node.js.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};
