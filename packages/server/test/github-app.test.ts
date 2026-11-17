/**
 * Registering the instance's GitHub App through GitHub's manifest flow, signing
 * in to GitHub with it, and the webhook that reports outside pushes.
 */
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { startTestServer, type TestServer } from "./helpers.js";

const conversion = {
  id: 7,
  slug: "lotse-acme",
  client_id: "Iv1.app-client-id",
  client_secret: "app-client-secret-0000000000",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE…\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "webhook-secret-0000000000",
  html_url: "https://github.com/apps/lotse-acme",
};

describe("GitHub App", () => {
  let t: TestServer;
  const conversions: string[] = [];

  beforeAll(async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.github.com/app-manifests/temp-code/conversions" && init?.method === "POST") {
        conversions.push(url);
        return Response.json(conversion, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    t = await startTestServer({}, { fetch: fetchImpl });
  });
  afterAll(async () => {
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  const githubAuth = async () => (await t.api<{ git: { id: string; auth: string[] }[] }>("GET", "/adapters")).body.git.find((g) => g.id === "github")?.auth;

  it("is registered through the manifest flow without copying credentials by hand", async () => {
    expect((await t.api("GET", "/git/github/app")).body).toEqual({ registered: false });
    expect(await githubAuth()).not.toContain("oauth");

    const begin = await t.api<{ url: string; manifest: Record<string, unknown> }>("POST", "/git/github/app/manifest", { organization: "acme" });
    expect(begin.status).toBe(200);
    const url = new URL(begin.body.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/organizations/acme/settings/apps/new");
    const publicUrl = t.server.services.config.publicUrl;
    expect(begin.body.manifest).toMatchObject({
      redirect_url: `${publicUrl}/api/v1/git/github/app/callback`,
      callback_urls: [`${publicUrl}/api/v1/oauth/callback`],
      hook_attributes: { url: `${publicUrl}/api/v1/git/github/webhook` },
      default_permissions: { contents: "write", metadata: "read" },
      public: false,
    });

    const back = await t.api("GET", `/git/github/app/callback?code=temp-code&state=${url.searchParams.get("state")}`);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/settings?github=registered");
    expect(conversions).toHaveLength(1);
    expect((await t.api("GET", "/git/github/app")).body).toEqual({
      registered: true,
      slug: "lotse-acme",
      url: "https://github.com/apps/lotse-acme",
      installUrl: "https://github.com/apps/lotse-acme/installations/new",
    });
    // The private key and secrets are only in the encrypted store.
    expect(JSON.stringify((await t.api("GET", "/git/github/app")).body)).not.toMatch(/PRIVATE KEY|secret/);

    // The same code cannot be used twice.
    const again = await t.api("GET", `/git/github/app/callback?code=temp-code&state=${url.searchParams.get("state")}`);
    expect(again.headers.get("location")).toMatch(/^\/settings\?error=/);
    expect(conversions).toHaveLength(1);
  });

  it("signs in to GitHub with the app, also after a restart", async () => {
    expect(await githubAuth()).toContain("oauth");
    const begin = await t.api<{ url: string }>("POST", "/accounts/oauth", { adapter: "github" });
    expect(new URL(begin.body.url).searchParams.get("client_id")).toBe("Iv1.app-client-id");
    // Loaded again from the encrypted store when the builder starts.
    await t.server.services.githubApp.load();
    expect(t.server.services.githubApp.status().registered).toBe(true);
  });

  it("tells linked projects about pushes made outside, and only those", async () => {
    const { db, schema } = t.server.services.database;
    const now = Date.now();
    const link = {
      provider: "github",
      accountId: "acc_1",
      repo: { provider: "github", owner: "acme", name: "guest-book", defaultBranch: "main", private: true, url: "", cloneUrl: "" },
    };
    await db.insert(schema.projects).values({
      id: "pgithub00001",
      ownerId: "local",
      name: "guest-book",
      title: "Guest book",
      stack: "static",
      status: "ready",
      prompt: "x",
      plan: null,
      models: null,
      target: null,
      git: JSON.stringify(link),
      createdAt: now,
      updatedAt: now,
    });

    const deliver = (event: string, payload: unknown, secret = conversion.webhook_secret) => {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return fetch(`${t.url}/api/v1/git/github/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
        body,
      });
    };
    const push = { ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "acme/guest-book" }, pusher: { name: "ada" } };

    expect((await deliver("push", push, "wrong-secret")).status).toBe(401);
    expect((await deliver("ping", { zen: "Keep it simple." })).status).toBe(202);
    expect(await (await deliver("push", { ...push, ref: "refs/heads/feature" })).json()).toEqual({ ok: true, notified: 0 });
    expect(await (await deliver("push", { ...push, repository: { full_name: "acme/other" } })).json()).toEqual({ ok: true, notified: 0 });
    expect(await (await deliver("push", push)).json()).toEqual({ ok: true, notified: 1 });

    const messages = await t.api<{ messages: { role: string; content: string; meta: { kind: string } | null }[] }>("GET", "/projects/pgithub00001/messages");
    expect(messages.body.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("ada pushed new commits to acme/guest-book (main)"),
        meta: expect.objectContaining({ kind: "git-push" }),
      }),
    ]);
  });
});
