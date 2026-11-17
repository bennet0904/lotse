import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Everything the CLI needs from its surroundings; tests substitute their own. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  interactive: boolean;
  color: boolean;
  out(text: string): void;
  err(text: string): void;
  /** Asks a question. Hidden answers are not echoed. */
  prompt(question: string, options?: { hidden?: boolean }): Promise<string>;
  openBrowser(url: string): void;
}

export function processIo(): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
  return {
    cwd: process.cwd(),
    env: process.env,
    interactive,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    prompt(question, options = {}) {
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (options.hidden) {
          // Echo nothing while a secret is typed.
          const output = process.stdout;
          const write = output.write.bind(output);
          let muted = false;
          (output as { write: unknown }).write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
            muted ? true : (write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof output.write;
          rl.question(question, (answer) => {
            (output as { write: unknown }).write = write;
            output.write("\n");
            rl.close();
            resolve(answer.trim());
          });
          muted = true;
        } else {
          rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        }
      });
    },
    openBrowser(url) {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      try {
        spawn(command, args, { stdio: "ignore", detached: true })
          .on("error", () => {})
          .unref();
      } catch {
        // The URL is printed as well.
      }
    },
  };
}

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 } as const;

export function paint(io: Io, style: keyof typeof CODES, text: string): string {
  return io.color ? `\u001b[${CODES[style]}m${text}\u001b[0m` : text;
}

export async function confirm(io: Io, question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!io.interactive) return false;
  const answer = await io.prompt(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

/** Renders rows as an aligned table. */
export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
