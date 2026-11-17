/**
 * End-to-end (specification section 14.2): from a prompt to a running
 * deployment in the builder, with a fixed model and fixed prompts. The target
 * is a real server reached over SSH:
 *
 *   scripts/test-server.sh up
 *   LOTSE_TEST_SSH_HOST=$(scripts/test-server.sh ip) pnpm test:e2e
 *
 * This is the automated gate of roadmap phase 2 ("prompt to deploy green").
 */

import { rm } from "node:fs/promises";
import { request } from "node:http";
import ssh from "@lotse/adapter-ssh";
import { scriptedModel } from "@lotse/agent";
import { AdapterRegistry } from "@lotse/core";
import { DockerClient } from "@lotse/sandbox";
import { startTestServer, type TestServer } from "../../packages/server/test/helpers.js";

const host = process.env.LOTSE_TEST_SSH_HOST;
const password = process.env.LOTSE_TEST_SSH_PASSWORD ?? "lotse-test-password";
const docker = await new DockerClient().ping().then(
  () => true,
  () => false,
);

function fromServer(path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: 80, path, headers: { Host: hostHeader }, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!host || !docker)("prompt to deployment on an own server", () => {
  let t: TestServer;
  const name = `guestbook-${Date.now().toString(36).slice(-5)}`;
  const plan = {
    stack: "static",
    name,
    title: "Guestbook",
    summary: "A page where visitors leave a short message.",
    dataModel: [],
    pages: [{ name: "Home", purpose: "Shows the entries and a form" }],
    resources: [],
    notes: [],
  };
  const html = (text: string) =>
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Guestbook</title></head><body><main><h1>Guestbook</h1><p id="state">${text}</p></main></body></html>\n`;
  const model = scriptedModel([
    { text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` },
    { toolCalls: [{ name: "write_file", input: { path: "index.html", content: html("first version") } }] },
    { text: "I built the guestbook page." },
    {
      toolCalls: [
        { name: "edit_file", input: { path: "index.html", old_text: "first version", new_text: "second version" } },
        { name: "propose_action", input: { action: "deploy", summary: "Publish the new version." } },
      ],
    },
    { text: "I updated the page and proposed to publish it." },
  ]);
  let projectId = "";
  let accountId = "";
  const site = () => `${name}.${(host as string).replace(/\./g, "-")}.sslip.io`;

  beforeAll(async () => {
    t = await startTestServer({}, { resolveModel: async () => model, registry: new AdapterRegistry().use(ssh) });
  });
  afterAll(async () => {
    await t.server.services.sandboxes.shutdown({ removeGateway: true });
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  const job = async (response: { body: { jobId: string } }) => {
    const done = await t.waitForJob(response.body.jobId);
    expect(done).toMatchObject({ error: null, status: "succeeded" });
    return done;
  };

  it("builds the app from the prompt", async () => {
    const created = await t.api<{ project: { id: string }; jobId: string }>("POST", "/projects", {
      prompt: "A guestbook where visitors leave a short message",
    });
    projectId = created.body.project.id;
    await job(created);
    await job(await t.api<{ jobId: string }>("POST", `/projects/${projectId}/plan/approve`, {}));
    expect((await t.api<{ project: { status: string } }>("GET", `/projects/${projectId}`)).body.project.status).toBe("ready");
  });

  it("registers the server with a password that is used once, and sets it up after approval", async () => {
    const key = await t.api<{ keyId: string; publicKey: string }>("POST", "/accounts/ssh-key", { host });
    expect(key.body.publicKey).toMatch(/^ssh-ed25519 /);
    const connected = await t.api<{ account: { id: string } }>("POST", "/accounts", {
      adapter: "ssh",
      host,
      user: "root",
      password,
      keyId: key.body.keyId,
      options: { tls: "internal" },
    });
    expect(connected.status).toBe(201);
    accountId = connected.body.account.id;

    const plan = await t.api<{ steps: { id: string; needed: boolean; changes: string[] }[] }>("GET", `/accounts/${accountId}/setup`);
    expect(plan.body.steps.map((s) => s.id)).toEqual(["user", "docker", "proxy", "firewall", "updates", "backups"]);
    // The setup never starts without explicit approval.
    expect((await t.api("POST", `/accounts/${accountId}/setup`, {})).status).toBe(409);
    await job(await t.api<{ jobId: string }>("POST", `/accounts/${accountId}/setup`, { approved: true }));
    expect((await t.api<{ ok: boolean }>("POST", `/accounts/${accountId}/verify`)).body.ok).toBe(true);
    // Neither the password nor the private key is stored in readable form or returned.
    const secrets = await t.server.services.database.db.select().from(t.server.services.database.schema.secrets);
    expect(JSON.stringify(secrets)).not.toContain(password);
    expect(JSON.stringify(secrets)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify((await t.api("GET", "/accounts")).body)).not.toContain("PRIVATE KEY");
  });

  it("publishes with one click and serves the app from the server", async () => {
    expect((await t.api("POST", `/projects/${projectId}/deploy`, { accountId })).status).toBe(409);
    const done = await job(await t.api<{ jobId: string }>("POST", `/projects/${projectId}/deploy`, { accountId, approved: true }));
    expect(done.result?.url).toBe(`http://${site()}`);
    const page = await fromServer("/", site());
    expect(page.status).toBe(200);
    expect(page.body).toContain("first version");
  });

  it("keeps iterating: a prompt changes the published app, and a rollback restores the previous version", async () => {
    await job(await t.api<{ jobId: string }>("POST", `/projects/${projectId}/messages`, { text: "Say second version instead" }));
    // The model proposed to publish; it could not do so itself.
    expect((await fromServer("/", site())).body).toContain("first version");
    const messages = await t.api<{ messages: { meta: { proposals?: { action: string }[] } | null }[] }>("GET", `/projects/${projectId}/messages`);
    expect(messages.body.messages.at(-1)?.meta?.proposals).toEqual([{ action: "deploy", summary: "Publish the new version.", details: {} }]);

    await job(await t.api<{ jobId: string }>("POST", `/projects/${projectId}/deploy`, {}));
    expect((await fromServer("/", site())).body).toContain("second version");

    await job(await t.api<{ jobId: string }>("POST", `/projects/${projectId}/rollback`, {}));
    expect((await fromServer("/", site())).body).toContain("first version");
    expect((await t.api("GET", `/projects/${projectId}/status`)).body).toMatchObject({ state: "running" });
  });

  it("removes the published app after approval", async () => {
    expect((await t.api("DELETE", `/projects/${projectId}/app`, {})).status).toBe(409);
    expect((await t.api("DELETE", `/projects/${projectId}/app`, { approved: true })).status).toBe(200);
    expect((await fromServer("/", site())).status).toBe(404);
  });
});
