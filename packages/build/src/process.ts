import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createChannel, type DeployEvent, event, LotseError, lineSplitter } from "@lotse/core";

export type OutputHandler = (line: string, stream: "stdout" | "stderr") => void;

export interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onOutput: OutputHandler;
}

/**
 * Runs the project's own commands (install, build). The default runs them on
 * the host; the builder server substitutes a runner that executes inside the
 * project's sandbox, because generated code is untrusted.
 */
export interface CommandRunner {
  run(command: string, options: RunOptions): Promise<number>;
}

export interface ExecOptions extends Omit<RunOptions, "cwd"> {
  cwd?: string;
  stdin?: Readable | Buffer | string;
}

/** Spawns a program without a shell and reports its output line by line. */
export function exec(file: string, args: string[], options: ExecOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const out = lineSplitter((line) => options.onOutput(line, "stdout"));
    const err = lineSplitter((line) => options.onOutput(line, "stderr"));
    child.stdout?.on("data", (d) => out.write(d));
    child.stderr?.on("data", (d) => err.write(d));
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // the process may exit before reading everything
      if (typeof options.stdin === "string" || Buffer.isBuffer(options.stdin)) child.stdin.end(options.stdin);
      else options.stdin.pipe(child.stdin);
    }
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") reject(new LotseError("BUILD_FAILED", `"${file}" is not installed or not on the PATH.`));
      else if (e.name === "AbortError") reject(new LotseError("ABORTED", "The build was aborted."));
      else reject(e);
    });
    child.on("close", (code) => {
      out.flush();
      err.flush();
      resolve(code ?? 1);
    });
  });
}

export const hostRunner: CommandRunner = {
  run(command, options) {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const flag = process.platform === "win32" ? "/c" : "-c";
    return exec(shell, [flag, command], options);
  },
};

/** Captures the output of a short command. Rejects when it exits with a non-zero code. */
export async function capture(file: string, args: string[], cwd?: string): Promise<string> {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await exec(file, args, { cwd, onOutput: (line, stream) => (stream === "stdout" ? lines : errors).push(line) });
  if (code !== 0) throw new LotseError("BUILD_FAILED", `${file} ${args[0] ?? ""} failed: ${errors.join("\n") || lines.join("\n")}`);
  return lines.join("\n");
}

/** Turns a callback-reporting process into build events. Returns the exit code. */
export async function* asEvents(start: (onOutput: OutputHandler) => Promise<number>): AsyncGenerator<DeployEvent, number, void> {
  const channel = createChannel<DeployEvent>();
  const done = start((line, stream) => channel.push(event.log("build", line, stream))).then(
    (code) => {
      channel.close();
      return code;
    },
    (err) => {
      channel.close(err);
      return -1;
    },
  );
  for await (const e of channel) yield e;
  return done;
}
