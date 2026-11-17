/**
 * Minimal client for the Docker Engine API. Podman serves the same API on its
 * own socket, so Podman works as an equal alternative (specification section 12.5).
 */
import { existsSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LotseError } from "@lotse/core";

export interface DockerEndpoint {
  socketPath?: string;
  host?: string;
  port?: number;
}

/** Sockets and pipes where Docker, Podman, OrbStack and Colima serve the engine API, in order of preference. */
export function endpointCandidates(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return ["\\\\.\\pipe\\docker_engine", "\\\\.\\pipe\\podman-machine-default"];
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  return [
    "/var/run/docker.sock",
    join(runtimeDir, "docker.sock"),
    join(runtimeDir, "podman/podman.sock"),
    "/run/podman/podman.sock",
    join(homedir(), ".docker/run/docker.sock"),
    join(homedir(), ".orbstack/run/docker.sock"),
    join(homedir(), ".colima/default/docker.sock"),
    // Podman machine on macOS: version 5 and later, then earlier versions.
    join(env.TMPDIR ?? tmpdir(), "podman/podman-machine-default-api.sock"),
    join(homedir(), ".local/share/containers/podman/machine/podman.sock"),
    join(homedir(), ".local/share/containers/podman/machine/qemu/podman.sock"),
  ];
}

/** Finds the engine socket: LOTSE_DOCKER_HOST or DOCKER_HOST, otherwise the first candidate that exists. */
export function detectEndpoint(env: Record<string, string | undefined> = process.env): DockerEndpoint {
  const host = env.LOTSE_DOCKER_HOST ?? env.DOCKER_HOST;
  if (host) {
    if (host.startsWith("unix://")) return { socketPath: host.slice("unix://".length) };
    if (host.startsWith("npipe://")) return { socketPath: host.slice("npipe://".length).replace(/\//g, "\\") };
    const url = new URL(host.replace(/^tcp:/, "http:"));
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  const candidates = endpointCandidates(env);
  return { socketPath: candidates.find((p) => existsSync(p)) ?? (candidates[0] as string) };
}

export interface EngineInfo {
  name: "docker" | "podman";
  version: string;
  /** The engine itself runs as an ordinary user (rootless Docker or Podman). */
  rootless: boolean;
}

export interface ExecResult {
  code: number;
  /** Combined output, capped. */
  output: string;
}

const OUTPUT_CAP = 200_000;

export class DockerClient {
  readonly #fixed?: DockerEndpoint;
  readonly #env: Record<string, string | undefined>;

  /**
   * Without an endpoint the engine is looked up again for every request, so a
   * runtime that the user starts after the builder is found without a restart.
   */
  constructor(endpoint?: DockerEndpoint, env: Record<string, string | undefined> = process.env) {
    this.#fixed = endpoint;
    this.#env = env;
  }

  get endpoint(): DockerEndpoint {
    return this.#fixed ?? detectEndpoint(this.#env);
  }

  #raw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          ...this.endpoint,
          method,
          path,
          signal,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        resolve,
      );
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.name === "AbortError") return reject(new LotseError("ABORTED", "The operation was aborted."));
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "EACCES") {
          return reject(
            new LotseError(
              "PROVIDER_ERROR",
              `No container runtime is reachable at ${this.endpoint.socketPath ?? `${this.endpoint.host}:${this.endpoint.port}`}.`,
              {
                hints: [
                  "Start Docker Desktop, Docker Engine, OrbStack or Podman. Podman users: run `podman system service` or enable the Docker-compatible socket.",
                ],
              },
            ),
          );
        }
        reject(err);
      });
      req.end(payload);
    });
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    const res = await this.#raw(method, path, body);
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const status = res.statusCode ?? 0;
    if (status >= 400 && !okStatuses.includes(status)) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // plain text
      }
      throw new LotseError(status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "PROVIDER_ERROR", `Container runtime: ${message.trim()}`, {
        details: { status },
      });
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async ping(): Promise<{ version: string; name: string }> {
    const v = await this.request<{ Version: string; Components?: { Name: string }[] }>("GET", "/version");
    return { version: v.Version, name: v.Components?.some((c) => /podman/i.test(c.Name)) ? "podman" : "docker" };
  }

  #engine?: Promise<EngineInfo>;
  #engineAt?: string;

  /** Which engine answers on the socket, and whether it runs without root privileges on the host. */
  engine(): Promise<EngineInfo> {
    const at = JSON.stringify(this.endpoint);
    if (this.#engineAt !== at) this.#engine = undefined;
    this.#engineAt = at;
    this.#engine ??= (async () => {
      const { name, version } = await this.ping();
      const info = await this.request<{ SecurityOptions?: string[] }>("GET", "/info");
      return { name: name as EngineInfo["name"], version, rootless: (info.SecurityOptions ?? []).some((o) => /(^|,)name=rootless(,|$)/.test(o)) };
    })().catch((err) => {
      this.#engine = undefined;
      throw err;
    });
    return this.#engine;
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.request("GET", `/images/${encodeURIComponent(image)}/json`);
      return true;
    } catch (err) {
      if (err instanceof LotseError && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  /** Pulls an image unless it is already present. */
  async ensureImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    if (await this.imageExists(image)) return;
    onProgress?.(`Pulling ${image}`);
    const [name, tag = "latest"] =
      image.includes(":") && !image.split(":").pop()?.includes("/")
        ? [image.slice(0, image.lastIndexOf(":")), image.slice(image.lastIndexOf(":") + 1)]
        : [image];
    const res = await this.#raw("POST", `/images/create?fromImage=${encodeURIComponent(name as string)}&tag=${encodeURIComponent(tag)}`);
    let last = "";
    let rest = "";
    for await (const chunk of res) {
      rest += (chunk as Buffer).toString("utf8");
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { status?: string; error?: string };
          if (msg.error) throw new LotseError("PROVIDER_ERROR", `Could not pull ${image}: ${msg.error}`);
          if (msg.status && msg.status !== last && !/^(Downloading|Extracting|Waiting|Verifying)/.test(msg.status)) {
            last = msg.status;
            onProgress?.(msg.status);
          }
        } catch (err) {
          if (err instanceof LotseError) throw err;
        }
      }
    }
    if ((res.statusCode ?? 0) >= 400 || !(await this.imageExists(image))) throw new LotseError("PROVIDER_ERROR", `Could not pull ${image}.`);
  }

  /**
   * Runs a command in a container and streams its output. Docker multiplexes
   * stdout and stderr into frames with an 8-byte header.
   */
  async exec(
    container: string,
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      user?: string;
      onOutput?: (line: string, stream: "stdout" | "stderr") => void;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<ExecResult> {
    const created = await this.request<{ Id: string }>("POST", `/containers/${container}/exec`, {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: options.cwd,
      User: options.user,
      Env: Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
    });
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : (options.signal ?? timeout);
    let output = "";
    const partial = { stdout: "", stderr: "" };
    const emit = (stream: "stdout" | "stderr", text: string) => {
      if (output.length < OUTPUT_CAP) output += text;
      const lines = (partial[stream] + text).split(/\r?\n/);
      partial[stream] = lines.pop() ?? "";
      for (const line of lines) options.onOutput?.(line, stream);
    };
    let timedOut = false;
    try {
      const res = await this.#raw("POST", `/exec/${created.Id}/start`, { Detach: false, Tty: false }, signal);
      let buffer = Buffer.alloc(0);
      for await (const chunk of res) {
        buffer = Buffer.concat([buffer, chunk as Buffer]);
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          if (buffer.length < 8 + size) break;
          emit(buffer[0] === 2 ? "stderr" : "stdout", buffer.subarray(8, 8 + size).toString("utf8"));
          buffer = buffer.subarray(8 + size);
        }
      }
    } catch (err) {
      if (timeout?.aborted && !options.signal?.aborted) timedOut = true;
      else if (signal?.aborted || (err instanceof LotseError && err.code === "ABORTED") || (err as Error).name === "AbortError")
        throw new LotseError("ABORTED", "The command was aborted.");
      else throw err;
    }
    for (const stream of ["stdout", "stderr"] as const) if (partial[stream]) options.onOutput?.(partial[stream], stream);
    if (timedOut) {
      options.onOutput?.(`Command timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds.`, "stderr");
      return { code: 124, output: `${output}\nCommand timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} seconds.` };
    }
    const info = await this.request<{ ExitCode: number | null }>("GET", `/exec/${created.Id}/json`);
    return { code: info.ExitCode ?? 1, output };
  }
}
