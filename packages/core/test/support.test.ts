import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterRegistry,
  adapterPackageCandidates,
  availableAuthMethods,
  buildAuthorizationUrl,
  compileIgnore,
  dynamicRegistrationSource,
  ensureFreshConnection,
  envClientSource,
  event,
  exchangeCode,
  FileStateStore,
  HttpClient,
  type LotseError,
  listenOnLoopback,
  loadAdapters,
  Redactor,
  redact,
  redactConnection,
  resolveOAuthClient,
  serializeEvent,
  tarBuffer,
  waitForHealthy,
  walkFiles,
} from "../src/index.js";
import { connection, fakeAdapter } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lotse-core-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("redaction", () => {
  it("removes registered secrets and well-known token formats", () => {
    const r = new Redactor().add("hunter2-password", "abc");
    expect(r.redact("login with hunter2-password failed")).toBe("login with [redacted] failed");
    expect(r.redact("abc stays because it is too short to be a secret")).toContain("abc");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe("Authorization: Bearer [redacted]");
    expect(redact("clone https://user:s3cr3t-pass@github.com/acme/app.git")).toBe("clone https://user:[redacted]@github.com/acme/app.git");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked")).not.toContain("ghp_");
    expect(redact("STRIPE_API_KEY=sk_live_1234567890")).toBe("STRIPE_API_KEY=[redacted]");
    expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toBe("[redacted]");
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });

  it("masks connections and strips them from serialized events", () => {
    expect(redactConnection(connection).credentials).toEqual({ token: "[redacted]" });
    const e = event.status("deploy", "succeeded", "ok", { id: "d1", app: { adapter: "fake", name: "demo", id: "a1", connection }, createdAt: 1 });
    expect(JSON.stringify(serializeEvent(e))).not.toContain("super-secret-token-123");
  });
});

describe("files", () => {
  it("walks a tree, honours ignore rules and .lotseignore", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules/x"), { recursive: true });
    await mkdir(join(dir, "tmp"), { recursive: true });
    await writeFile(join(dir, "src/index.js"), "console.log(1)");
    await writeFile(join(dir, "node_modules/x/index.js"), "x");
    await writeFile(join(dir, ".env"), "SECRET=1");
    await writeFile(join(dir, ".env.production"), "SECRET=1");
    await writeFile(join(dir, "tmp/cache.bin"), "x");
    await writeFile(join(dir, "notes.log"), "x");
    await writeFile(join(dir, ".lotseignore"), "tmp/\n*.log\n");
    expect((await walkFiles(dir)).map((f) => f.path)).toEqual([".lotseignore", "src/index.js"]);
  });

  it("supports negation and anchored patterns", () => {
    const ignored = compileIgnore(["*.map", "!keep.map", "/build", "docs/**/draft.md"]);
    expect(ignored("a/b.map")).toBe(true);
    expect(ignored("keep.map")).toBe(false);
    expect(ignored("build/x.js")).toBe(true);
    expect(ignored("src/build/x.js")).toBe(false);
    expect(ignored("docs/a/b/draft.md")).toBe(true);
  });

  it("writes tar archives that the system tar can read", async () => {
    const long = `${"deep/".repeat(30)}file-with-a-rather-long-name.txt`;
    await mkdir(join(dir, "in", long, ".."), { recursive: true });
    await writeFile(join(dir, "in/a.txt"), "hello");
    await writeFile(join(dir, "in", long), "deep content");
    const entries = await walkFiles(join(dir, "in"));
    const archive = join(dir, "out.tar.gz");
    await writeFile(archive, await tarBuffer(entries, { gzip: true, extra: [{ path: "Dockerfile", content: "FROM scratch\n" }] }));
    await mkdir(join(dir, "x"));
    execFileSync("tar", ["-xzf", archive, "-C", join(dir, "x")]);
    expect(await readFile(join(dir, "x/a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(dir, "x/Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(await readFile(join(dir, "x", long), "utf8")).toBe("deep content");
  });
});

describe("http client", () => {
  it("maps provider errors to error codes and retries rate limits", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls++;
      const path = new URL(String(url)).pathname.replace("/v1", "");
      if (path === "/limited" && calls === 1) return new Response("slow down", { status: 429 });
      if (path === "/limited") return Response.json({ ok: true });
      if (path === "/denied") return Response.json({ error: { message: "Not authorized" } }, { status: 403 });
      return Response.json({ message: "nope" }, { status: 404 });
    }) as typeof fetch;
    const http = new HttpClient({ provider: "Example", baseUrl: "https://api.example.test/v1/", fetch: fetchImpl, retryDelayMs: 1 });
    expect(await http.get("/limited")).toEqual({ ok: true });
    expect(calls).toBe(2);
    await expect(http.get("/denied")).rejects.toMatchObject({
      code: "PERMISSION_MISSING",
      message: expect.stringContaining("Example responded with 403: Not authorized"),
    });
    await expect(http.get("/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(http.url("/a", { q: "x y", skip: undefined })).toBe("https://api.example.test/v1/a?q=x+y");
  });
});

describe("health check", () => {
  it("waits until the app answers with 2xx and sends the Host header", async () => {
    let hits = 0;
    let host = "";
    const server = createServer((req, res) => {
      hits++;
      host = req.headers.host ?? "";
      res.writeHead(hits < 3 ? 503 : 200).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    try {
      const result = await waitForHealthy({ url, headers: { Host: "app.example.com" }, intervalMs: 10, timeoutMs: 5000 });
      expect(result).toMatchObject({ ok: true, status: 200, attempts: 3 });
      expect(host).toBe("app.example.com");
      hits = -1000;
      const failed = await waitForHealthy({ url, intervalMs: 10, timeoutMs: 60 });
      expect(failed).toMatchObject({ ok: false, detail: "HTTP 503" });
    } finally {
      server.close();
    }
  });
});

describe("oauth", () => {
  const config = {
    authorizationEndpoint: "https://provider.test/oauth/authorize",
    tokenEndpoint: "https://provider.test/oauth/token",
    registrationEndpoint: "https://provider.test/oauth/register",
    scopes: ["deploy", "offline_access"],
    envPrefix: "LOTSE_OAUTH_TEST",
  };

  it("builds a PKCE authorization request", () => {
    const req = buildAuthorizationUrl(config, { clientId: "client-1" }, "http://127.0.0.1:9999/oauth/callback");
    const url = new URL(req.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("scope")).toBe("deploy offline_access");
    expect(url.searchParams.get("state")).toBe(req.state);
    expect(req.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("exchanges the code and refreshes connections before they expire", async () => {
    const bodies: URLSearchParams[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body as URLSearchParams);
      return Response.json({ access_token: `access-${bodies.length}`, refresh_token: "refresh-2", expires_in: 3600 });
    }) as typeof fetch;
    const tokens = await exchangeCode(config, { clientId: "client-1", clientSecret: "shh" }, { code: "c", verifier: "v", redirectUri: "http://x" }, fetchImpl);
    expect(tokens.accessToken).toBe("access-1");
    expect(bodies[0]?.get("code_verifier")).toBe("v");

    const conn = {
      ...connection,
      method: "oauth" as const,
      credentials: { accessToken: "old", refreshToken: "refresh-1", clientId: "client-1" },
      expiresAt: Date.now() + 60_000,
    };
    const fresh = await ensureFreshConnection(conn, config, { fetch: fetchImpl });
    expect(fresh.credentials).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(bodies[1]?.get("grant_type")).toBe("refresh_token");
    // Still valid for a long time: untouched.
    const valid = { ...conn, expiresAt: Date.now() + 3_600_000 };
    expect(await ensureFreshConnection(valid, config, { fetch: fetchImpl })).toBe(valid);
    // A failing refresh asks the user to sign in again.
    const failing = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
    await expect(ensureFreshConnection(conn, config, { fetch: failing })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("offers OAuth only when a client is available and falls back to the token setup", async () => {
    const adapter = { id: "x", auth: ["oauth" as const, "token" as const], oauth: { ...config, registrationEndpoint: undefined } };
    expect(availableAuthMethods(adapter, [envClientSource({})])).toEqual(["token"]);
    expect(availableAuthMethods(adapter, [envClientSource({ LOTSE_OAUTH_TEST_CLIENT_ID: "abc" })])).toEqual(["oauth", "token"]);

    // Dynamic registration (RFC 7591) happens once and is cached.
    let registrations = 0;
    const fetchImpl = (async () => {
      registrations++;
      return Response.json({ client_id: "dyn-1" }, { status: 201 });
    }) as typeof fetch;
    const cache = new Map<string, { clientId: string }>();
    const source = dynamicRegistrationSource({ get: async (k) => cache.get(k), set: async (k, v) => void cache.set(k, v) }, { fetch: fetchImpl });
    const request = { adapter: "x", config, redirectUri: "http://127.0.0.1/cb" };
    expect(availableAuthMethods({ ...adapter, oauth: config }, [envClientSource({}), source])).toEqual(["oauth", "token"]);
    expect(await resolveOAuthClient([envClientSource({}), source], request)).toEqual({ clientId: "dyn-1", clientSecret: undefined });
    await resolveOAuthClient([source], request);
    expect(registrations).toBe(1);
  });

  it("receives the code on a loopback redirect and checks the state", async () => {
    const listener = await listenOnLoopback();
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    const wait = listener.waitForCode("state-1", 5000);
    const res = await fetch(`${listener.redirectUri}?code=the-code&state=state-1`);
    expect(await res.text()).toContain("Signed in");
    expect(await wait).toBe("the-code");

    const second = await listenOnLoopback();
    const rejected = second.waitForCode("expected", 5000).catch((e: LotseError) => e);
    await fetch(`${second.redirectUri}?code=x&state=forged`);
    expect(await rejected).toMatchObject({ code: "AUTH_FAILED" });
  });
});

describe("adapter registry", () => {
  it("resolves short names to package names", () => {
    expect(adapterPackageCandidates("vercel")).toEqual(["@lotseai/adapter-vercel", "lotse-adapter-vercel"]);
    expect(adapterPackageCandidates("lotse-adapter-acme")).toEqual(["lotse-adapter-acme"]);
    expect(adapterPackageCandidates("@acme/lotse-adapter")).toEqual(["@acme/lotse-adapter"]);
  });

  it("loads community adapters and rejects incompatible ones", async () => {
    const notFound = Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });
    const importFn = async (specifier: string) => {
      if (specifier === "lotse-adapter-acme") return { default: { apiVersion: "0.1.3", hosting: () => fakeAdapter({}, "acme") } };
      if (specifier === "@lotseai/adapter-old") return { default: { apiVersion: "0.0.1", hosting: () => fakeAdapter({}, "old") } };
      throw notFound;
    };
    const registry = await loadAdapters(["acme"], { importFn });
    expect(registry.hosting("acme").displayName).toBe("Fake (acme)");
    await expect(loadAdapters(["old"], { importFn })).rejects.toMatchObject({ code: "ADAPTER_INVALID" });
    await expect(loadAdapters(["missing"], { importFn })).rejects.toMatchObject({ code: "ADAPTER_NOT_FOUND" });
    expect(() => new AdapterRegistry().hosting("nope")).toThrow(/No hosting adapter "nope"/);
  });

  it("validates the adapter shape", () => {
    const broken = { ...fakeAdapter(), deploy: undefined } as never;
    expect(() => new AdapterRegistry().registerHosting(broken)).toThrow(/deploy\(\) is missing/);
  });
});

describe("file state store", () => {
  it("persists apps and deployments", async () => {
    const path = join(dir, ".lotse/state.json");
    const store = new FileStateStore(path);
    await store.saveApp({ adapter: "fake", name: "demo", id: "a1", resources: [], domains: [], updatedAt: 1 });
    await store.saveDeployment({ id: "d1", adapter: "fake", app: "demo", createdAt: 1, state: "superseded" });
    await store.saveDeployment({ id: "d2", adapter: "fake", app: "demo", createdAt: 2, state: "live" });
    const reopened = new FileStateStore(path);
    expect((await reopened.getApp("fake", "demo"))?.id).toBe("a1");
    expect((await reopened.listDeployments("fake", "demo")).map((d) => d.id)).toEqual(["d2", "d1"]);
    await reopened.deleteApp("fake", "demo");
    expect(await new FileStateStore(path).listDeployments("fake", "demo")).toEqual([]);
  });
});
