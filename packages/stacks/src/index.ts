import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LotseError } from "@lotse/core";
import { djangoStack, fastapiStack, goStack, laravelStack } from "./backend.js";
import { staticStack } from "./static.js";
import type { ScaffoldContext, StackTemplate } from "./types.js";
import { honoStack, nextStack, reactViteStack } from "./typescript.js";

export { STATIC_PREVIEW_SERVER } from "./static.js";
export * from "./types.js";

/** The stacks version 1.0 ships with (specification section 12.3). */
export const builtInStacks: StackTemplate[] = [staticStack, reactViteStack, nextStack, honoStack, fastapiStack, djangoStack, goStack, laravelStack];

export class StackRegistry {
  readonly #stacks = new Map<string, StackTemplate>();

  constructor(stacks: StackTemplate[] = builtInStacks) {
    for (const stack of stacks) this.register(stack);
  }

  register(stack: StackTemplate): this {
    if (!/^[a-z][a-z0-9-]*$/.test(stack.id)) throw new LotseError("INVALID_INPUT", `Invalid stack id "${stack.id}".`);
    this.#stacks.set(stack.id, stack);
    return this;
  }

  get(id: string): StackTemplate {
    const stack = this.#stacks.get(id);
    if (!stack) throw new LotseError("NOT_FOUND", `There is no stack "${id}". Available: ${[...this.#stacks.keys()].join(", ")}.`);
    return stack;
  }

  list(): StackTemplate[] {
    return [...this.#stacks.values()];
  }

  /** Hosts sandboxes need beyond the default registries, across all stacks. */
  allowedHosts(): string[] {
    return [...new Set(this.list().flatMap((s) => s.sandbox.allowedHosts ?? []))];
  }

  /**
   * Loads community stacks. A stack package is an npm package whose default
   * export is a `StackTemplate` or an array of them.
   */
  async load(packages: string[], importFn: (specifier: string) => Promise<unknown> = (s) => import(s)): Promise<this> {
    for (const name of packages) {
      const mod = (await importFn(name)) as { default?: StackTemplate | StackTemplate[] };
      const stacks = Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : [];
      if (stacks.length === 0) throw new LotseError("INVALID_INPUT", `"${name}" does not export a stack template.`);
      for (const stack of stacks) this.register(stack);
    }
    return this;
  }
}

/** Writes the template's files into a project directory. Returns the paths written. */
export async function scaffoldFiles(stack: StackTemplate, dir: string, ctx: ScaffoldContext): Promise<string[]> {
  const files = stack.files(ctx);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return Object.keys(files).sort();
}
