import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_API_VERSION, LotseError } from "@lotseai/core";

const TEMPLATES = fileURLToPath(new URL("../templates/adapter/", import.meta.url));

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

/** Creates an adapter package with a working example and the contract tests (specification section 14.1). */
export async function scaffoldAdapter(parent: string, name: string, displayName?: string): Promise<ScaffoldResult> {
  const id = name.replace(/^lotse-adapter-/, "");
  if (!/^[a-z][a-z0-9-]*$/.test(id))
    throw new LotseError("INVALID_INPUT", "Adapter names consist of lowercase letters, digits and hyphens, e.g. `acme-cloud`.");
  const dir = join(parent, `lotse-adapter-${id}`);
  const exists = await stat(dir).then(
    () => true,
    () => false,
  );
  if (exists) throw new LotseError("CONFLICT", `${dir} already exists.`);
  const className = id
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  const replace = (text: string) =>
    text
      .replaceAll("__ID__", id)
      .replaceAll("__CLASS__", className)
      .replaceAll("__DISPLAY__", displayName ?? className)
      .replaceAll("__CORE_VERSION__", ADAPTER_API_VERSION);
  const written: string[] = [];
  for (const source of await files(TEMPLATES)) {
    const target = join(
      dir,
      relative(TEMPLATES, source)
        .replace(/\.tpl$/, "")
        .replace(/^test[\\/]adapter\./, `test/${id}.`),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, replace(await readFile(source, "utf8")));
    written.push(relative(dir, target));
  }
  await writeFile(join(dir, ".gitignore"), "node_modules/\ndist/\n");
  return { dir, files: [...written, ".gitignore"].sort() };
}
