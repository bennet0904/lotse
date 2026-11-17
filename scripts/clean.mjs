#!/usr/bin/env node
// Removes build output of all packages.
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
for (const name of await readdir(packages)) {
  await rm(`${packages}${name}/dist`, { recursive: true, force: true });
  await rm(`${packages}${name}/tsconfig.tsbuildinfo`, { force: true });
}
console.log("Removed build output.");
