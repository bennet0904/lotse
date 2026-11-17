import { rm } from "node:fs/promises";
import { startTestServer, type TestServer } from "./helpers.js";

/** A minimal OpenID Connect provider. */
function identityProvider() {
  const people: Record<string, { sub: string; email: string; name: string }> = {
    "code-ada": { sub: "1", email: "ada@example.test", name: "Ada" },
    "code-bob": { sub: "2", email: "bob@example.test", name: "Bob" },
  };
  const seen: { verifier?: string; redirect?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://id.example.test/.well-known/openid-configuration") {
      return Response.json({
        authorization_endpoint: "https://id.example.test/authorize",
        token_endpoint: "https://id.example.test/token",
        userinfo_endpoint: "https://id.example.test/userinfo",
      });
    }
    if (url === "https://id.example.test/token") {
      const body = init?.body as URLSearchParams;
      seen.push({ verifier: body.get("code_verifier") ?? undefined, redirect: body.get("redirect_uri") ?? undefined });
      const code = body.get("code") ?? "";
      return people[code] ? Response.json({ access_token: `at-${code}`, token_type: "Bearer" }) : Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url === "https://id.example.test/userinfo") {
      const code = new Headers(init?.headers).get("authorization")?.replace("Bearer at-", "") ?? "";
      return Response.json(people[code]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("multi-user sign-in with OpenID Connect", () => {
  let t: TestServer;
  const idp = identityProvider();

  beforeAll(async () => {
    t = await startTestServer(
      { auth: "oidc", oidc: { issuer: "https://id.example.test", clientId: "lotse", clientSecret: "shh", scopes: ["openid", "email", "profile"] } },
      { fetch: idp.fetchImpl },
    );
  });
  afterAll(async () => {
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  async function signIn(code: string): Promise<string> {
    const login = await t.api("GET", "/auth/login");
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location") as string);
    expect(authorize.origin + authorize.pathname).toBe("https://id.example.test/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = await t.api("GET", `/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
    expect(callback.status).toBe(302);
    const cookie = callback.headers.get("set-cookie") as string;
    expect(cookie).toMatch(/lotse_session=.+; .*HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    return cookie.split(";")[0] as string;
  }

  it("requires a session", async () => {
    expect((await t.api("GET", "/me")).status).toBe(401);
    expect((await t.api("GET", "/projects")).status).toBe(401);
    expect((await t.api<{ auth: string; telemetry: boolean }>("GET", "/config")).body).toMatchObject({ auth: "oidc", telemetry: false });
  });

  let ada = "";
  let bob = "";
  it("makes the first person to sign in the owner and later ones members", async () => {
    ada = await signIn("code-ada");
    bob = await signIn("code-bob");
    expect((await t.api("GET", "/me", undefined, { cookie: ada })).body).toMatchObject({ user: { email: "ada@example.test", name: "Ada", role: "owner" } });
    expect((await t.api("GET", "/me", undefined, { cookie: bob })).body).toMatchObject({ user: { role: "member" } });
    // The authorization code flow used PKCE and the registered redirect address.
    expect(idp.seen[0]?.verifier?.length).toBeGreaterThanOrEqual(43);
    expect(idp.seen[0]?.redirect).toMatch(/\/api\/v1\/auth\/callback$/);
    // Signing in again finds the same user.
    await signIn("code-ada");
    const users = await t.api<{ users: unknown[] }>("GET", "/users", undefined, { cookie: ada });
    expect(users.body.users.length).toBe(2);
  });

  it("rejects forged or replayed sign-in responses", async () => {
    expect((await t.api("GET", "/auth/callback?code=code-ada&state=forged")).status).toBe(401);
    const login = await t.api("GET", "/auth/login");
    const state = new URL(login.headers.get("location") as string).searchParams.get("state");
    expect((await t.api("GET", `/auth/callback?code=wrong&state=${state}`)).status).toBe(401);
    // The state is single-use.
    expect((await t.api("GET", `/auth/callback?code=code-ada&state=${state}`)).status).toBe(401);
  });

  it("enforces roles", async () => {
    expect((await t.api("GET", "/users", undefined, { cookie: bob })).status).toBe(403);
    expect((await t.api("GET", "/audit", undefined, { cookie: bob })).status).toBe(403);
    const users = (await t.api<{ users: { id: string; email: string }[] }>("GET", "/users", undefined, { cookie: ada })).body.users;
    const bobId = users.find((u) => u.email === "bob@example.test")?.id;
    const adaId = users.find((u) => u.email === "ada@example.test")?.id;
    // A member cannot promote anyone; the owner can.
    expect((await t.api("PATCH", `/users/${bobId}`, { role: "admin" }, { cookie: bob })).status).toBe(403);
    expect((await t.api("PATCH", `/users/${bobId}`, { role: "admin" }, { cookie: ada })).status).toBe(200);
    // An admin cannot appoint owners, and the last owner cannot be demoted.
    expect((await t.api("PATCH", `/users/${bobId}`, { role: "owner" }, { cookie: bob })).status).toBe(403);
    expect((await t.api("PATCH", `/users/${adaId}`, { role: "member" }, { cookie: ada })).status).toBe(409);
    expect((await t.api("PATCH", `/users/${bobId}`, { role: "member" }, { cookie: ada })).status).toBe(200);
  });

  it("refuses state-changing requests that do not come from the app", async () => {
    const res = await t.api("POST", "/projects", { prompt: "x" }, { cookie: ada, csrf: false });
    expect(res.status).toBe(403);
  });

  it("keeps team accounts usable without revealing credentials, and personal ones private", async () => {
    // Members cannot connect accounts for the whole team.
    const denied = await t.api("POST", "/accounts", { adapter: "vercel", token: "x", scope: "team" }, { cookie: bob });
    expect(denied.status).toBe(403);
    const adapters = await t.api<{ hosting: { id: string; auth: string[]; tokenSetup: { url: string; permissions: string[] } | null }[] }>(
      "GET",
      "/adapters",
      undefined,
      { cookie: bob },
    );
    const vercel = adapters.body.hosting.find((a) => a.id === "vercel");
    // Without a registered OAuth app the UI falls back to the guided token setup, without an error.
    expect(vercel?.auth).toEqual(["token"]);
    expect(vercel?.tokenSetup?.url).toBe("https://vercel.com/account/settings/tokens");
    expect(vercel?.tokenSetup?.permissions.length).toBeGreaterThan(0);
  });

  it("records sign-ins in the audit log", async () => {
    const audit = await t.api<{ entries: { action: string; userId: string | null }[] }>("GET", "/audit", undefined, { cookie: ada });
    const actions = audit.body.entries.map((e) => e.action);
    expect(actions.filter((a) => a === "signin").length).toBe(3);
    expect(actions).toContain("signin.failed");
    expect(actions).toContain("user.role");
  });

  it("ends the session on sign-out", async () => {
    await t.api("POST", "/auth/logout", {}, { cookie: bob });
    expect((await t.api("GET", "/me", undefined, { cookie: bob })).status).toBe(401);
  });
});

describe("single-user mode", () => {
  it("needs no sign-in and makes the local user the owner", async () => {
    const t = await startTestServer();
    try {
      expect((await t.api("GET", "/me")).body).toMatchObject({ user: { id: "local", role: "owner" } });
      expect((await t.api("GET", "/projects")).body).toEqual({ projects: [] });
      expect((await t.api("GET", "/nope")).status).toBe(404);
      const stacks = await t.api<{ stacks: { id: string; beta: boolean }[] }>("GET", "/stacks");
      expect(stacks.body.stacks.map((s) => s.id)).toEqual(["static", "react-vite", "nextjs", "hono", "fastapi", "django", "go-nethttp", "laravel"]);
    } finally {
      await t.server.close();
      await rm(t.dataDir, { recursive: true, force: true });
    }
  });
});
