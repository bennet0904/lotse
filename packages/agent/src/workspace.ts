import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { LotseError } from "@lotseai/core";

export interface CommandResult {
  code: number;
  output: string;
}

/**
 * What the model can touch: the files of one project and a shell inside that
 * project's sandbox. Tools with external effects exist only here
 * (specification section 13.2).
 */
export interface Workspace {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Project files, relative paths with forward slashes, without dependencies and build output. */
  listFiles(): Promise<string[]>;
  /** Runs a shell command inside the sandbox, in the project directory. */
  run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;
  /** Recent output of the running app (development server). */
  logs(tail?: number): Promise<string>;
}

const HIDDEN_DIRS = new Set([".git", ".lotse", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "vendor", "staticfiles", ".cache"]);

/** Files the model may neither read nor write: local secrets and the framework's own state. */
export function isProtectedPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.includes(".git") || parts.includes(".lotse") || name === ".env" || name.startsWith(".env.") || /\.(pem|key)$/.test(name);
}

/** Normalizes a model-supplied path and makes sure it stays inside the project. */
export function safeRelativePath(path: string): string {
  const cleaned = posix.normalize(
    path
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/workspace\//, "")
      .replace(/^\.\//, ""),
  );
  if (!cleaned || cleaned === "." || cleaned.startsWith("../") || cleaned === ".." || cleaned.startsWith("/")) {
    throw new LotseError("INVALID_INPUT", `"${path}" is outside the project. Use a path relative to the project root.`);
  }
  if (isProtectedPath(cleaned)) throw new LotseError("INVALID_INPUT", `"${cleaned}" is protected and cannot be read or changed.`);
  return cleaned;
}

export interface HostWorkspaceOptions {
  root: string;
  run: Workspace["run"];
  logs?: Workspace["logs"];
  /** Called after every write, e.g. to hand the file to the sandbox user. */
  afterWrite?: (absolutePath: string) => Promise<void>;
}

/** Files on the host's disk, commands delegated to the sandbox. */
export class HostWorkspace implements Workspace {
  readonly #root: string;
  readonly #opts: HostWorkspaceOptions;

  constructor(options: HostWorkspaceOptions) {
    this.#root = resolve(options.root);
    this.#opts = options;
  }

  #abs(path: string): string {
    const full = resolve(this.#root, safeRelativePath(path));
    if (!full.startsWith(this.#root + sep)) throw new LotseError("INVALID_INPUT", `"${path}" is outside the project.`);
    return full;
  }

  async readFile(path: string): Promise<string> {
    try {
      return await readFile(this.#abs(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new LotseError("NOT_FOUND", `There is no file "${path}".`);
      if ((err as NodeJS.ErrnoException).code === "EISDIR") throw new LotseError("INVALID_INPUT", `"${path}" is a directory.`);
      throw err;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.#abs(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await this.#opts.afterWrite?.(abs);
    if (dirname(abs) !== this.#root) await this.#opts.afterWrite?.(dirname(abs));
  }

  async deleteFile(path: string): Promise<void> {
    await rm(this.#abs(path), { force: true });
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!HIDDEN_DIRS.has(entry.name)) await walk(join(dir, entry.name), path);
        } else if (entry.isFile() && !isProtectedPath(path) && entry.name !== ".DS_Store") {
          out.push(path);
        }
      }
    };
    await stat(this.#root);
    await walk(this.#root, "");
    return out;
  }

  run(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> {
    return this.#opts.run(command, options);
  }

  async logs(tail?: number): Promise<string> {
    return this.#opts.logs ? this.#opts.logs(tail) : "";
  }
}
