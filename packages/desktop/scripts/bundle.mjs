/**
 * Bundles the main process with all workspace packages into one file, so that
 * the packaged app carries no node_modules folder and no native modules: the
 * desktop app uses the SQLite built into Electron's Node.js.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "bundle");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const ui = join(root, "../ui/dist");
if (!existsSync(join(ui, "index.html"))) throw new Error("Build the user interface first: pnpm --filter @lotseai/ui build");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(out, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: "linked",
  legalComments: "linked",
  // Optional native speed-ups and drivers the desktop app does not use.
  // drizzle-orm/better-sqlite3 stays outside as well: bundled, its static import of the native module would load at start.
  external: ["electron", "better-sqlite3", "drizzle-orm/better-sqlite3", "cpu-features", "pg-native", "*.node"],
  // CommonJS dependencies expect require, __filename and __dirname, which an ES module does not have.
  banner: {
    js: [
      'import { createRequire as __lotseRequire } from "node:module";',
      'import { fileURLToPath as __lotseFilePath } from "node:url";',
      'import { dirname as __lotseDirname } from "node:path";',
      "const require = __lotseRequire(import.meta.url);",
      "const __filename = __lotseFilePath(import.meta.url);",
      "const __dirname = __lotseDirname(__filename);",
    ].join(" "),
  },
  metafile: true,
  logLevel: "info",
});
await writeFile(
  join(out, "package.json"),
  `${JSON.stringify({ name: "lotse", productName: "Lotse", version: pkg.version, description: pkg.description, license: pkg.license, author: "The Lotse contributors", type: "module", main: "main.mjs" }, null, 2)}\n`,
);
// Bundled packages keep their license texts: they are collected into one file next to the code.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (match && !packages.has(match[2])) packages.set(match[2], join(root, match[1]));
}
const notices = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const meta = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  meta.license ??= meta.licenses?.map((l) => l.type).join(" OR ");
  const file = (await readdir(dir)).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = file ? await readFile(join(dir, file), "utf8") : `License: ${meta.license ?? "unknown"}`;
  notices.push(`${name}@${meta.version} (${meta.license ?? "unknown"})\n\n${text.trim()}\n`);
}
await writeFile(join(out, "THIRD_PARTY_LICENSES.txt"), `Lotse bundles the following packages.\n\n${notices.join(`\n${"-".repeat(72)}\n\n`)}`);
console.log(`${packages.size} bundled packages, licenses in THIRD_PARTY_LICENSES.txt`);

// The user interface travels inside the app archive; the builder serves it from there.
await cp(join(root, "../ui/dist"), join(out, "ui"), { recursive: true });
console.log(`bundle written to ${out}`);
