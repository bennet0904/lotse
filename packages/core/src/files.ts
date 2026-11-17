import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

export interface FileEntry {
  /** Path relative to the root, with forward slashes. */
  path: string;
  abs: string;
  size: number;
  mode: number;
}

/** Folders and files that never belong into an upload. */
export const DEFAULT_IGNORE = [
  ".git",
  ".lotse",
  "node_modules",
  ".DS_Store",
  ".env",
  ".env.*",
  "__pycache__",
  ".venv",
  "venv",
  "*.pyc",
  ".next/cache",
  ".vercel",
  ".netlify",
  ".wrangler",
];

/** Files left out when a built static site is uploaded. */
export const STATIC_SITE_IGNORE = [".git", ".DS_Store", ".lotse", "lotse.yaml", ".lotseignore", "node_modules"];

export const IGNORE_FILE = ".lotseignore";

function toRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, "");
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  p = p.replace(/\/+$/, "");
  const body = p
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  const prefix = anchored || p.includes("/") ? "^" : "(^|/)";
  return new RegExp(`${prefix}${body}(/|$)`);
}

/** Compiles gitignore-style patterns (a practical subset: `*`, `**`, leading `/`, `!` negation). */
export function compileIgnore(patterns: string[]): (path: string) => boolean {
  const rules = patterns
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => ({ negate: line.startsWith("!"), re: toRegExp(line.replace(/^!/, "")) }));
  return (path) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.re.test(path)) ignored = !rule.negate;
    }
    return ignored;
  };
}

export interface WalkOptions {
  ignore?: string[];
  /** Also read patterns from `.lotseignore` in the root. Defaults to true. */
  useIgnoreFile?: boolean;
}

/** Lists the regular files of a directory tree in a stable order. Symlinks are skipped. */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<FileEntry[]> {
  const patterns = [...(options.ignore ?? DEFAULT_IGNORE)];
  if (options.useIgnoreFile !== false) {
    try {
      patterns.push(...(await readFile(join(root, IGNORE_FILE), "utf8")).split("\n"));
    } catch {
      // no ignore file
    }
  }
  const ignored = compileIgnore(patterns);
  const out: FileEntry[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const path = rel ? posix.join(rel, name) : name;
      if (ignored(path)) continue;
      const abs = join(dir, name);
      const stat = await lstat(abs);
      if (stat.isDirectory()) await visit(abs, path);
      else if (stat.isFile()) out.push({ path, abs, size: stat.size, mode: stat.mode & 0o777 });
    }
  }
  await visit(root, "");
  return out;
}

export function hashBuffer(data: Buffer | string, algorithm: "sha1" | "sha256" = "sha256"): string {
  return createHash(algorithm).update(data).digest("hex");
}

export function hashFile(path: string, algorithm: "sha1" | "sha256" = "sha256"): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarHeader(name: string, size: number, mode: number, type: "0" | "L" = "0"): Buffer {
  const header = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    const cut = base.lastIndexOf("/", 155);
    if (cut > 0 && Buffer.byteLength(base.slice(cut + 1)) <= 100) {
      prefix = base.slice(0, cut);
      base = base.slice(cut + 1);
    }
  }
  header.write(base.slice(0, 100), 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii"); // mtime 0 keeps archives reproducible
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function padding(size: number): Buffer {
  const rest = size % 512;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rest);
}

async function* tarChunks(entries: FileEntry[], extra: { path: string; content: Buffer | string; mode?: number }[]): AsyncGenerator<Buffer> {
  const needsLongName = (name: string) => {
    if (Buffer.byteLength(name) <= 100) return false;
    const cut = name.lastIndexOf("/", 155);
    return !(cut > 0 && Buffer.byteLength(name.slice(cut + 1)) <= 100);
  };
  const head = function* (name: string, size: number, mode: number): Generator<Buffer> {
    if (needsLongName(name)) {
      const longName = Buffer.from(`${name}\0`, "utf8");
      yield tarHeader("././@LongLink", longName.length, 0o644, "L");
      yield longName;
      yield padding(longName.length);
    }
    yield tarHeader(name, size, mode);
  };
  for (const file of extra) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    yield* head(file.path, content.length, file.mode ?? 0o644);
    yield content;
    yield padding(content.length);
  }
  for (const entry of entries) {
    yield* head(entry.path, entry.size, entry.mode || 0o644);
    let written = 0;
    for await (const chunk of createReadStream(entry.abs)) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (written !== entry.size) throw new Error(`${entry.path} changed while it was being archived`);
    yield padding(entry.size);
  }
  yield Buffer.alloc(1024);
}

export interface TarOptions {
  gzip?: boolean;
  /** Additional in-memory files placed at the start of the archive. */
  extra?: { path: string; content: Buffer | string; mode?: number }[];
}

/** Streams a tar archive (ustar, optionally gzipped) of the given files. */
export function tarStream(entries: FileEntry[], options: TarOptions = {}): Readable {
  const tar = Readable.from(tarChunks(entries, options.extra ?? []), { objectMode: false });
  return options.gzip ? tar.pipe(createGzip()) : tar;
}

export async function tarBuffer(entries: FileEntry[], options: TarOptions = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream(entries, options)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

export function contentType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
