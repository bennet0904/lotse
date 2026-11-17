import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, staticKeyProvider } from "@lotseai/secrets";
import { configFromEnv, createLotseServer, type LotseServer, type ServerConfig, type ServiceOverrides } from "../src/index.js";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface TestServer {
  server: LotseServer;
  url: string;
  dataDir: string;
  /** Calls the API as a browser session would. */
  api<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    options?: { cookie?: string; csrf?: boolean },
  ): Promise<{ status: number; body: T; headers: Headers }>;
  waitForJob(jobId: string, cookie?: string): Promise<{ status: string; error: string | null; result: Record<string, unknown> | null }>;
}

export async function startTestServer(overrides: Partial<ServerConfig> = {}, services: ServiceOverrides = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "lotse-server-"));
  const port = await freePort();
  const config = configFromEnv(overrides.env ?? {}, {
    dataDir,
    port,
    host: "127.0.0.1",
    publicUrl: `http://localhost:${port}`,
    masterKey: staticKeyProvider(generateMasterKey()),
    sandbox: { cpus: 1, memoryMb: 512, idleMinutes: 30, namePrefix: `lotse-it-${Date.now().toString(36)}` },
    ...overrides,
  });
  const server = await createLotseServer(config, services);
  const url = await server.listen();
  const api: TestServer["api"] = async (method, path, body, options = {}) => {
    const res = await fetch(`${url}/api/v1${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.csrf === false ? {} : { "x-requested-with": "lotse" }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON (redirects)
    }
    return { status: res.status, body: parsed as never, headers: res.headers };
  };
  return {
    server,
    url,
    dataDir,
    api,
    async waitForJob(jobId, cookie) {
      for (let i = 0; i < 1200; i++) {
        const { body } = await api<{ job: { status: string; error: string | null; result: Record<string, unknown> | null } }>(
          "GET",
          `/jobs/${jobId}`,
          undefined,
          { cookie },
        );
        if (body.job && body.job.status !== "queued" && body.job.status !== "running") return body.job;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`job ${jobId} did not finish`);
    },
  };
}

/** GET with an explicit Host header, as a browser does for `p-….localhost`. */
export function getWithHost(url: string, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ host: target.hostname, port: target.port, path, headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
