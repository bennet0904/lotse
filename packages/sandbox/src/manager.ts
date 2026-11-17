/**
 * Sandboxes (specification section 12.4): every project runs in its own
 * container with CPU and memory limits, without root privileges, seeing only
 * its own project directory, on its own network without direct outbound access.
 */
import { createHash, randomBytes } from "node:crypto";
import { chown, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LotseError } from "@lotse/core";
import { DockerClient, type ExecResult } from "./docker.js";
import { DEFAULT_ALLOWED_HOSTS, GATEWAY_EGRESS_PORT, GATEWAY_INGRESS_PORT, GATEWAY_SCRIPT } from "./gateway.js";

export interface SandboxConfig {
  docker?: DockerClient;
  /** CPU cores per sandbox. Default 2. */
  cpus?: number;
  /** Memory per sandbox in MiB. Default 2048. */
  memoryMb?: number;
  pidsLimit?: number;
  /** Hosts sandboxes may reach. Defaults to the package registries. */
  allowedHosts?: string[];
  /** Container runtime for stronger isolation, e.g. `runsc` (gVisor). */
  runtime?: string;
  /** Sandboxes are paused after this many idle minutes. Default 30. */
  idleMinutes?: number;
  /** First two octets of the address range sandbox networks are carved from. */
  subnetPrefix?: string;
  gatewayImage?: string;
  /** User the sandbox runs as. Defaults to the server's user, or 10001 when the server is root. */
  uid?: number;
  gid?: number;
  /** Prefix of all container and network names. */
  namePrefix?: string;
  /** Named volume that holds the project directories when the server itself runs in a container. */
  volume?: { name: string; workspaces: string; caches: string };
  onLog?: (line: string) => void;
}

export interface StartOptions {
  /** Lowercase letters, digits and hyphens. */
  projectId: string;
  /** Host path of the project directory. The only project data the container sees. */
  workdir: string;
  /** Host path for package caches. */
  cacheDir: string;
  image: string;
  env?: Record<string, string>;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  onOutput?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const WORKSPACE = "/workspace";

interface ContainerInfo {
  Id: string;
  State: { Status: string; Running: boolean; Paused: boolean };
  Config: { Env: string[]; Image: string; Labels?: Record<string, string> };
  NetworkSettings: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

export class Sandbox {
  lastActive = Date.now();

  constructor(
    readonly manager: SandboxManager,
    readonly projectId: string,
    readonly container: string,
    readonly image: string,
  ) {}

  /** Runs a shell command in the project directory. Resumes the sandbox if it was paused. */
  async exec(command: string, options: RunOptions = {}): Promise<ExecResult> {
    await this.resume();
    this.lastActive = Date.now();
    const seconds = options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined;
    // `timeout` ends the process inside the container; the client-side limit is only a backstop.
    const cmd = seconds ? ["timeout", "-s", "KILL", String(seconds), "sh", "-c", command] : ["sh", "-c", command];
    const result = await this.manager.docker.exec(this.container, cmd, {
      cwd: options.cwd ? join(WORKSPACE, options.cwd) : WORKSPACE,
      env: options.env,
      onOutput: options.onOutput,
      signal: options.signal,
      timeoutMs: options.timeoutMs ? options.timeoutMs + 5000 : undefined,
    });
    this.lastActive = Date.now();
    if (seconds && result.code === 137) return { code: 124, output: `${result.output}\nCommand timed out after ${seconds} seconds.` };
    return result;
  }

  /** Starts a long-running process such as a dev server. Its output goes to a log file inside the sandbox. */
  async startProcess(name: string, command: string, env: Record<string, string> = {}): Promise<void> {
    await this.stopProcess(name);
    const log = `/tmp/lotse-${name}.log`;
    const result = await this.exec(`: > ${log}; nohup sh -c ${shellQuote(command)} >> ${log} 2>&1 & echo $! > /tmp/lotse-${name}.pid`, { env });
    if (result.code !== 0) throw new LotseError("PROVIDER_ERROR", `Could not start "${command}" in the sandbox: ${result.output.trim()}`);
  }

  async stopProcess(name: string): Promise<void> {
    await this.exec(
      `if [ -f /tmp/lotse-${name}.pid ]; then p=$(cat /tmp/lotse-${name}.pid); pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; rm -f /tmp/lotse-${name}.pid; fi; true`,
    );
  }

  async processRunning(name: string): Promise<boolean> {
    const result = await this.exec(`[ -f /tmp/lotse-${name}.pid ] && kill -0 "$(cat /tmp/lotse-${name}.pid)" 2>/dev/null`);
    return result.code === 0;
  }

  async processLogs(name: string, tail = 200): Promise<string> {
    return (await this.exec(`tail -n ${Math.floor(tail)} /tmp/lotse-${name}.log 2>/dev/null || true`)).output;
  }

  /** Waits until something inside the sandbox listens on the port. */
  async waitForPort(port: number, timeoutMs = 60_000, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const probe = `(command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 ${port}) || (command -v node >/dev/null 2>&1 && node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))") || (command -v python3 >/dev/null 2>&1 && python3 -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',${port})))") || (command -v php >/dev/null 2>&1 && php -r "exit(@fsockopen('127.0.0.1',${port})?0:1);")`;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new LotseError("ABORTED", "The operation was aborted.");
      if ((await this.exec(probe)).code === 0) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Where the preview proxy finds the app: through the gateway, never directly. */
  previewTarget(port: number): { url: string; headers: Record<string, string> } {
    return this.manager.ingress(this.container, port);
  }

  async state(): Promise<"running" | "paused" | "stopped"> {
    try {
      const info = await this.manager.docker.request<ContainerInfo>("GET", `/containers/${this.container}/json`);
      return info.State.Paused ? "paused" : info.State.Running ? "running" : "stopped";
    } catch (err) {
      if (err instanceof LotseError && err.code === "NOT_FOUND") return "stopped";
      throw err;
    }
  }

  async pause(): Promise<void> {
    if ((await this.state()) === "running") await this.manager.docker.request("POST", `/containers/${this.container}/pause`);
  }

  /** Resumes a paused sandbox on the next access. */
  async resume(): Promise<void> {
    const state = await this.state();
    if (state === "paused") await this.manager.docker.request("POST", `/containers/${this.container}/unpause`);
    else if (state === "stopped") throw new LotseError("NOT_FOUND", "The sandbox is not running. Start it again.");
    this.lastActive = Date.now();
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class SandboxManager {
  readonly docker: DockerClient;
  readonly prefix: string;
  readonly #config: SandboxConfig;
  readonly #sandboxes = new Map<string, Sandbox>();
  readonly #starting = new Map<string, Promise<Sandbox>>();
  #gateway?: Promise<{ port: number; key: string }>;
  #resolved?: { port: number; key: string };
  #timer?: NodeJS.Timeout;

  constructor(config: SandboxConfig = {}) {
    this.#config = config;
    this.docker = config.docker ?? new DockerClient();
    this.prefix = config.namePrefix ?? "lotse";
  }

  get limits(): { cpus: number; memoryMb: number } {
    return { cpus: this.#config.cpus ?? 2, memoryMb: this.#config.memoryMb ?? 2048 };
  }

  /** The user sandboxes run as. Never root. */
  get user(): { uid: number; gid: number } {
    const own = process.getuid?.() ?? 1000;
    const uid = this.#config.uid ?? (own === 0 ? 10001 : own);
    return { uid, gid: this.#config.gid ?? (own === 0 ? 10001 : (process.getgid?.() ?? uid)) };
  }

  /**
   * How the sandbox user is mapped onto the host. A rootless engine runs
   * containers in a user namespace in which the ids of the host are shifted;
   * without care the sandbox user could not write to the project directory.
   */
  async #identity(): Promise<{ user: string; usernsMode?: string }> {
    const { uid, gid } = this.user;
    const engine = await this.docker.engine();
    if (!engine.rootless || this.#config.volume) return { user: `${uid}:${gid}` };
    // Podman can keep the ids of the user it runs as, so the sandbox user is that user inside as well.
    if (engine.name === "podman") return { user: `${uid}:${gid}`, usernsMode: "keep-id" };
    // Rootless Docker maps the user it runs as to id 0 inside. That "root" has no privileges on the
    // host, and all capabilities are dropped inside the container as well.
    return { user: "0:0" };
  }

  #containerName(projectId: string): string {
    return `${this.prefix}-sbx-${projectId}`;
  }

  #gatewayName(): string {
    return `${this.prefix}-sandbox-gateway`;
  }

  #log(line: string): void {
    this.#config.onLog?.(line);
  }

  /** Starts the gateway that all traffic into and out of sandboxes passes through. */
  ensureGateway(): Promise<{ port: number; key: string }> {
    this.#gateway ??= this.#startGateway().then(
      (g) => {
        this.#resolved = g;
        return g;
      },
      (err) => {
        this.#gateway = undefined;
        throw err;
      },
    );
    return this.#gateway;
  }

  async #startGateway(): Promise<{ port: number; key: string }> {
    const name = this.#gatewayName();
    const allow = (this.#config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).join(",");
    const read = async () => {
      try {
        return await this.docker.request<ContainerInfo>("GET", `/containers/${name}/json`);
      } catch (err) {
        if (err instanceof LotseError && err.code === "NOT_FOUND") return undefined;
        throw err;
      }
    };
    let info = await read();
    const envOf = (i: ContainerInfo, key: string) => i.Config.Env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1);
    // A gateway left over from an older version of the builder is replaced as well.
    const script = createHash("sha256").update(GATEWAY_SCRIPT).digest("hex").slice(0, 16);
    if (info && (!info.State.Running || envOf(info, "ALLOW_HOSTS") !== allow || info.Config.Labels?.["dev.lotse.gateway-script"] !== script)) {
      await this.docker.request("DELETE", `/containers/${name}?force=true`);
      info = undefined;
    }
    if (!info) {
      const image = this.#config.gatewayImage ?? "node:22-alpine";
      await this.docker.ensureImage(image, (l) => this.#log(l));
      const key = randomBytes(24).toString("hex");
      await this.docker.request("POST", `/containers/create?name=${name}`, {
        Image: image,
        Cmd: ["node", "-e", GATEWAY_SCRIPT],
        User: "node",
        Env: [`ALLOW_HOSTS=${allow}`, `INGRESS_KEY=${key}`],
        Labels: { "dev.lotse.role": "sandbox-gateway", "dev.lotse.prefix": this.prefix, "dev.lotse.gateway-script": script },
        ExposedPorts: { [`${GATEWAY_INGRESS_PORT}/tcp`]: {} },
        HostConfig: {
          // The ingress is only reachable from this machine.
          PortBindings: { [`${GATEWAY_INGRESS_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
          RestartPolicy: { Name: "unless-stopped" },
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Memory: 256 * 1024 * 1024,
          Init: true,
        },
      });
      await this.docker.request("POST", `/containers/${name}/start`);
      info = (await read()) as ContainerInfo;
    }
    const binding = info.NetworkSettings.Ports?.[`${GATEWAY_INGRESS_PORT}/tcp`]?.[0];
    const key = envOf(info, "INGRESS_KEY");
    if (!binding || !key) throw new LotseError("PROVIDER_ERROR", "The sandbox gateway did not start correctly.");
    return { port: Number(binding.HostPort), key };
  }

  ingress(container: string, port: number): { url: string; headers: Record<string, string> } {
    if (!this.#resolved) throw new LotseError("PROVIDER_ERROR", "The sandbox gateway is not running.");
    return { url: `http://127.0.0.1:${this.#resolved.port}`, headers: { "x-lotse-key": this.#resolved.key, "x-lotse-target": `${container}:${port}` } };
  }

  /** Creates the project's own internal network and attaches the gateway to it. */
  async #ensureNetwork(projectId: string): Promise<string> {
    const name = `${this.prefix}-sbx-net-${projectId}`;
    const networks = await this.docker.request<{ Name: string; Labels?: Record<string, string>; IPAM?: { Config?: { Subnet?: string }[] } }[]>(
      "GET",
      "/networks",
    );
    if (!networks.some((n) => n.Name === name)) {
      const used = new Set(networks.flatMap((n) => n.IPAM?.Config?.map((c) => c.Subnet) ?? []));
      const base = this.#config.subnetPrefix ?? "10.231";
      let subnet: string | undefined;
      for (let i = 0; i < 4096 && !subnet; i++) {
        const candidate = `${base}.${i >> 4}.${(i & 15) * 16}/28`;
        if (!used.has(candidate)) subnet = candidate;
      }
      if (!subnet) throw new LotseError("PROVIDER_ERROR", "No free address range is left for another sandbox.");
      await this.docker.request("POST", "/networks/create", {
        Name: name,
        // Internal: no route to the outside world or to the host.
        Internal: true,
        IPAM: { Config: [{ Subnet: subnet }] },
        Labels: { "dev.lotse.sandbox-net": projectId, "dev.lotse.prefix": this.prefix },
      });
    }
    await this.docker.request(
      "POST",
      `/networks/${name}/connect`,
      { Container: this.#gatewayName(), EndpointConfig: { Aliases: ["lotse-gateway"] } },
      [403, 409],
    );
    return name;
  }

  /**
   * Starts the sandbox of a project, replacing a stale one. Concurrent calls
   * for the same project share one start.
   */
  start(options: StartOptions): Promise<Sandbox> {
    const running = this.#starting.get(options.projectId);
    if (running) return running;
    const started = this.#start(options).finally(() => this.#starting.delete(options.projectId));
    this.#starting.set(options.projectId, started);
    return started;
  }

  async #start(options: StartOptions): Promise<Sandbox> {
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(options.projectId))
      throw new LotseError("INVALID_INPUT", "Project ids consist of lowercase letters, digits and hyphens.");
    await this.ensureGateway();
    await this.docker.ensureImage(options.image, (l) => this.#log(l));
    const { uid, gid } = this.user;
    await mkdir(options.workdir, { recursive: true });
    await mkdir(options.cacheDir, { recursive: true });
    if (process.getuid?.() === 0) {
      // The server runs as root but the sandbox must not: hand the directories to the sandbox user.
      await chownTree(options.workdir, uid, gid);
      await chownTree(options.cacheDir, uid, gid);
    }

    const network = await this.#ensureNetwork(options.projectId);
    const name = this.#containerName(options.projectId);
    await this.docker.request("DELETE", `/containers/${name}?force=true&v=true`, undefined, [404]);
    const proxy = `http://lotse-gateway:${GATEWAY_EGRESS_PORT}`;
    const env: Record<string, string> = {
      HOME: "/cache/home",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      npm_config_cache: "/cache/npm",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      PIP_CACHE_DIR: "/cache/pip",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PYTHONUSERBASE: "/cache/python",
      GOPATH: "/cache/go",
      GOCACHE: "/cache/go-build",
      GOFLAGS: "-modcacherw",
      COMPOSER_HOME: "/cache/composer",
      PATH: "/cache/python/bin:/cache/go/bin:/workspace/node_modules/.bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ...options.env,
    };
    const { cpus, memoryMb } = this.limits;
    const volume = this.#config.volume;
    const identity = await this.#identity();
    await this.docker.request("POST", `/containers/create?name=${name}`, {
      Image: options.image,
      Cmd: ["sleep", "infinity"],
      Entrypoint: [],
      User: identity.user,
      WorkingDir: WORKSPACE,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { "dev.lotse.sandbox": options.projectId, "dev.lotse.prefix": this.prefix },
      HostConfig: {
        // The container sees its own project directory and nothing else of the host.
        ...(volume
          ? {
              Mounts: [
                { Type: "volume", Source: volume.name, Target: WORKSPACE, VolumeOptions: { Subpath: `${volume.workspaces}/${options.projectId}` } },
                { Type: "volume", Source: volume.name, Target: "/cache", VolumeOptions: { Subpath: `${volume.caches}/${options.projectId}` } },
              ],
            }
          : { Binds: [`${options.workdir}:${WORKSPACE}`, `${options.cacheDir}:/cache`] }),
        NetworkMode: network,
        ...(identity.usernsMode ? { UsernsMode: identity.usernsMode } : {}),
        NanoCpus: Math.round(cpus * 1e9),
        Memory: memoryMb * 1024 * 1024,
        MemorySwap: memoryMb * 1024 * 1024,
        PidsLimit: this.#config.pidsLimit ?? 512,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: { "/tmp": "rw,exec,nosuid,size=256m" },
        Init: true,
        ...(this.#config.runtime ? { Runtime: this.#config.runtime } : {}),
      },
    });
    await this.docker.request("POST", `/containers/${name}/start`);
    const sandbox = new Sandbox(this, options.projectId, name, options.image);
    this.#sandboxes.set(options.projectId, sandbox);
    await sandbox.exec("mkdir -p /cache/home");
    return sandbox;
  }

  /** The running sandbox of a project, also after a restart of the server. */
  async get(projectId: string): Promise<Sandbox | undefined> {
    const starting = this.#starting.get(projectId);
    if (starting) return starting;
    const known = this.#sandboxes.get(projectId);
    if (known) return (await known.state()) === "stopped" ? undefined : known;
    try {
      const info = await this.docker.request<ContainerInfo>("GET", `/containers/${this.#containerName(projectId)}/json`);
      if (!info.State.Running) return undefined;
      await this.ensureGateway();
      const sandbox = new Sandbox(this, projectId, this.#containerName(projectId), info.Config.Image);
      this.#sandboxes.set(projectId, sandbox);
      return sandbox;
    } catch (err) {
      if (err instanceof LotseError && err.code === "NOT_FOUND") return undefined;
      throw err;
    }
  }

  async remove(projectId: string): Promise<void> {
    this.#sandboxes.delete(projectId);
    await this.docker.request("DELETE", `/containers/${this.#containerName(projectId)}?force=true&v=true`, undefined, [404]);
    const network = `${this.prefix}-sbx-net-${projectId}`;
    await this.docker.request("POST", `/networks/${network}/disconnect`, { Container: this.#gatewayName(), Force: true }, [404, 403, 500]);
    await this.docker.request("DELETE", `/networks/${network}`, undefined, [404, 403]);
  }

  /** Pauses sandboxes that were idle for too long. Returns the paused project ids. */
  async sweep(now = Date.now()): Promise<string[]> {
    const limit = (this.#config.idleMinutes ?? 30) * 60_000;
    const paused: string[] = [];
    for (const sandbox of this.#sandboxes.values()) {
      if (now - sandbox.lastActive < limit) continue;
      if ((await sandbox.state()) === "running") {
        await sandbox.pause();
        paused.push(sandbox.projectId);
      }
    }
    return paused;
  }

  startIdleTimer(intervalMs = 60_000): void {
    this.#timer ??= setInterval(() => void this.sweep().catch(() => {}), intervalMs);
    this.#timer.unref();
  }

  /** Marks a sandbox as used, e.g. on every preview request. */
  touch(projectId: string): void {
    const sandbox = this.#sandboxes.get(projectId);
    if (sandbox) sandbox.lastActive = Date.now();
  }

  /** Removes every sandbox, network and the gateway of this manager's prefix. */
  async shutdown(options: { removeGateway?: boolean } = {}): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    const filter = encodeURIComponent(JSON.stringify({ label: [`dev.lotse.prefix=${this.prefix}`, "dev.lotse.sandbox"] }));
    const containers = await this.docker.request<{ Labels: Record<string, string> }[]>("GET", `/containers/json?all=true&filters=${filter}`);
    for (const c of containers) await this.remove(c.Labels["dev.lotse.sandbox"] as string);
    if (options.removeGateway) {
      await this.docker.request("DELETE", `/containers/${this.#gatewayName()}?force=true`, undefined, [404]);
      this.#gateway = undefined;
      this.#resolved = undefined;
    }
  }
}

async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await chown(dir, uid, gid);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(path, uid, gid);
    else if (!entry.isSymbolicLink()) await chown(path, uid, gid);
  }
}

export { chownTree };
