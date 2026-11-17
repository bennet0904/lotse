/**
 * Moving container images around: pushing to a registry or streaming them to
 * a server. Adapters receive these tools through `AdapterOptions.images`, so
 * contract tests can substitute a recording fake.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { createChannel, lineSplitter } from "./async.js";
import { LotseError } from "./errors.js";
import { event } from "./events.js";
import type { DeployEvent } from "./types.js";

export interface RegistryAuth {
  registry: string;
  username: string;
  password: string;
}

export interface ImageTools {
  /** Tags a local image as `target` and pushes it. Returns the pushed reference. */
  push(image: string, target: string, auth?: RegistryAuth, signal?: AbortSignal): AsyncGenerator<DeployEvent, string, void>;
  /** Streams the image as a tar archive (`docker save`). */
  save(image: string): Readable;
}

function run(
  file: string,
  args: string[],
  options: { stdin?: string; signal?: AbortSignal; onLine?: (line: string, stream: "stdout" | "stderr") => void } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], signal: options.signal });
    const out = lineSplitter((l) => options.onLine?.(l, "stdout"));
    const err = lineSplitter((l) => options.onLine?.(l, "stderr"));
    child.stdout?.on("data", (d) => out.write(d));
    child.stderr?.on("data", (d) => err.write(d));
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    child.on("error", (e) =>
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new LotseError("DEPLOY_FAILED", `"${file}" is not installed or not on the PATH.`)
          : e.name === "AbortError"
            ? new LotseError("ABORTED", "The operation was aborted.")
            : e,
      ),
    );
    child.on("close", (code) => {
      out.flush();
      err.flush();
      resolve(code ?? 1);
    });
  });
}

/** Image tools backed by the Docker or Podman command line. */
export function cliImageTools(runtime: "docker" | "podman" = process.env.LOTSE_CONTAINER_RUNTIME === "podman" ? "podman" : "docker"): ImageTools {
  return {
    async *push(image, target, auth, signal) {
      if (auth) {
        const errors: string[] = [];
        const code = await run(runtime, ["login", auth.registry, "--username", auth.username, "--password-stdin"], {
          stdin: auth.password,
          onLine: (l, s) => s === "stderr" && errors.push(l),
        });
        if (code !== 0) throw new LotseError("AUTH_FAILED", `Could not sign in to the registry ${auth.registry}: ${errors.join(" ")}`);
      }
      if (target !== image) {
        const code = await run(runtime, ["tag", image, target]);
        if (code !== 0) throw new LotseError("DEPLOY_FAILED", `Could not tag ${image} as ${target}.`);
      }
      yield event.log("deploy", `Pushing ${target}`);
      const channel = createChannel<DeployEvent>();
      const done = run(runtime, ["push", target], { signal, onLine: (line, stream) => channel.push(event.log("deploy", line, stream)) }).then(
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
      if ((await done) !== 0) throw new LotseError("DEPLOY_FAILED", `Pushing ${target} failed.`);
      return target;
    },
    save(image) {
      const child = spawn(runtime, ["save", image], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => child.stdout.destroy(e));
      child.on("close", (code) => {
        if (code !== 0) child.stdout.destroy(new LotseError("DEPLOY_FAILED", `Could not export image ${image}: ${stderr.trim()}`));
      });
      return child.stdout;
    },
  };
}
