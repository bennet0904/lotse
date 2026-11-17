#!/usr/bin/env node
// Regenerates packages/core/schema/lotse.schema.json from the zod schema.
// Run `pnpm build:lib` first. `--check` fails if the committed file is stale.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { manifestJsonSchema } = await import("../packages/core/dist/index.js");
const target = fileURLToPath(new URL("../packages/core/schema/lotse.schema.json", import.meta.url));
const next = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== next) {
    console.error("packages/core/schema/lotse.schema.json is out of date. Run `pnpm schema`.");
    process.exit(1);
  }
  console.log("Schema is up to date.");
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, next, "utf8");
  console.log(`Wrote ${target}`);
}
