/**
 * What protects a builder without sign-in (desktop app, single-user
 * installations), and how provider sign-ins with OAuth come back to it.
 */
import { rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AdapterRegistry, apiConnection, type ResourceAdapter } from "@lotse/core";
import { startTestServer, type TestServer } from "./helpers.js";

/** A provider with an OAuth 2.0 token endpoint that insists on PKCE. */
async function oauthProvider() {
  const challenges = new Map<string, string>();
  const exchanges: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      exchanges.push(form);
      const ok =
        form.grant_type === "authorization_code" && challenges.has(form.code ?? "") && form.client_id === "lotse-test-client" && Boolean(form.code_verifier);
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok
            ? { access_token: "provider-access-token-1234567890", refresh_token: "provider-refresh-token-1234567890", token_type: "Bearer", expires_in: 3600 }
            : { error: "invalid_grant" },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const adapter: ResourceAdapter = {
    id: "fakedb",
    displayName: "Fake DB",
    auth: ["oauth", "token"],
    resources: ["postgres"],
    oauth: {
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      scopes: ["databases"],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_FAKEDB",
    },
    async connect(input) {
      const conn = apiConnection("fakedb", input);
      conn.account = { id: "1", name: "ada@example.test" };
      return conn;
    },
    verify: async (conn) => ({ ok: true, account: conn.account.name, missingPermissions: [], warnings: [] }),
    provision: async () => {
      throw new Error("not used");
    },
    destroy: async () => {},
    status: async () => ({ state: "ready" }),
  };
  /** What the provider does after the user agreed: it sends the browser back with a code. */
  const approve = (authorizeUrl: string): string => {
    const url = new URL(authorizeUrl);
    const code = `code-${challenges.size + 1}`;
    challenges.set(code, url.searchParams.get("code_challenge") as string);
    return `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`;
  };
  return { adapter, approve, exchanges, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A request with a chosen Host header, as a page on a rebound domain would send it. */
function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("single-user builder inside the desktop app", () => {
  const TOKEN = "local-access-token-0123456789abcdef";
  const cookie = `lotse_local=${TOKEN}`;
  let t: TestServer;
  let provider: Awaited<ReturnType<typeof oauthProvider>>;

  beforeAll(async () => {
    provider = await oauthProvider();
    t = await startTestServer(
      { localToken: TOKEN, desktop: true, env: { LOTSE_OAUTH_FAKEDB_CLIENT_ID: "lotse-test-client" } },
      { registry: new AdapterRegistry().registerResource(provider.adapter) },
    );
  });
  afterAll(async () => {
    await t.server.close();
    await provider.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  it("answers only to the app that holds the local access token", async () => {
    expect((await t.api("GET", "/health")).status).toBe(200);
    expect((await t.api("GET", "/me")).status).toBe(401);
    expect((await t.api("GET", "/accounts", undefined, { cookie: "lotse_local=wrong-token-0123456789abcdef000" })).status).toBe(401);
    expect((await t.api("POST", "/accounts", { adapter: "fakedb", method: "token", token: "x" })).status).toBe(401);
    expect((await t.api("GET", "/me", undefined, { cookie })).body).toMatchObject({ user: { id: "local", role: "owner" } });
  });

  it("refuses the job stream without the token", async () => {
    const { WebSocket } = await import("ws");
    const open = (headers: Record<string, string>) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${t.url.replace("http", "ws")}/api/v1/ws`, { headers });
        socket.once("open", () => {
          socket.close();
          resolve("open");
        });
        socket.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
        socket.once("error", () => resolve("error"));
      });
    expect(await open({})).toBe("401");
    expect(await open({ cookie })).toBe("open");
  });

  it("finishes an OAuth sign-in that returns in the system browser", async () => {
    const begin = await t.api<{ url: string }>("POST", "/accounts/oauth", { adapter: "fakedb" }, { cookie });
    expect(begin.status).toBe(200);
    const authorize = new URL(begin.body.url);
    expect(authorize.searchParams.get("client_id")).toBe("lotse-test-client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    // The redirect goes to the loopback address of the local builder (RFC 8252).
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${t.server.services.config.publicUrl}/api/v1/oauth/callback`);

    // The system browser has no cookie of the app; the page tells the user to return to it.
    const back = await fetch(provider.approve(begin.body.url), { redirect: "manual" });
    expect(back.status).toBe(200);
    const page = await back.text();
    expect(page).toContain("You are signed in");
    expect(page).toContain("return to Lotse");
    expect(provider.exchanges.at(-1)).toMatchObject({ grant_type: "authorization_code", client_id: "lotse-test-client" });
    expect(provider.exchanges.at(-1)?.code_verifier?.length).toBeGreaterThanOrEqual(43);

    const accounts = await t.api<{ accounts: { adapter: string; method: string; account: string }[] }>("GET", "/accounts", undefined, { cookie });
    expect(accounts.body.accounts).toMatchObject([{ adapter: "fakedb", method: "oauth", account: "ada@example.test" }]);
    // Neither the page nor the API reveals the tokens.
    expect(page + JSON.stringify(accounts.body)).not.toMatch(/provider-(access|refresh)-token/);
  });

  it("does not accept a callback twice or with an unknown state", async () => {
    const begin = await t.api<{ url: string }>("POST", "/accounts/oauth", { adapter: "fakedb" }, { cookie });
    const callback = provider.approve(begin.body.url);
    expect((await fetch(callback)).status).toBe(200);
    const replay = await fetch(callback);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("The sign-in did not work");
    const forged = await fetch(`${t.url}/api/v1/oauth/callback?code=code-1&state=made-up`);
    expect(forged.status).toBe(400);
    // An error text from the provider is shown as text, not as markup.
    const denied = await fetch(`${t.url}/api/v1/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}`);
    expect(await denied.text()).not.toContain("<script>");
  });
});

describe("single-user builder in the browser", () => {
  let t: TestServer;
  let provider: Awaited<ReturnType<typeof oauthProvider>>;

  beforeAll(async () => {
    provider = await oauthProvider();
    t = await startTestServer(
      { env: { LOTSE_OAUTH_FAKEDB_CLIENT_ID: "lotse-test-client" } },
      { registry: new AdapterRegistry().registerResource(provider.adapter) },
    );
  });
  afterAll(async () => {
    await t.server.close();
    await provider.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  it("returns to the accounts page after an OAuth sign-in", async () => {
    const begin = await t.api<{ url: string }>("POST", "/accounts/oauth", { adapter: "fakedb" });
    const back = await fetch(provider.approve(begin.body.url), { redirect: "manual" });
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toMatch(/^\/accounts\?connected=acc_/);
    const failed = await fetch(`${t.url}/api/v1/oauth/callback?error=access_denied`, { redirect: "manual" });
    expect(failed.headers.get("location")).toBe("/accounts?error=access_denied");
  });

  it("only answers under its own host name", async () => {
    const port = new URL(t.url).port;
    expect(await rawGet(`${t.url}/api/v1/me`, `localhost:${port}`)).toBe(200);
    expect(await rawGet(`${t.url}/api/v1/me`, `127.0.0.1:${port}`)).toBe(200);
    // A page that points its own domain at this computer (DNS rebinding) gets nothing.
    expect(await rawGet(`${t.url}/api/v1/me`, `rebound.attacker.example:${port}`)).toBe(421);
    expect(await rawGet(`${t.url}/`, "rebound.attacker.example")).toBe(421);
  });
});
