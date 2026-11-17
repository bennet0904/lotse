/**
 * The builder from prompt to preview to deployment, over its HTTP and
 * WebSocket API, with a scripted model and a real sandbox. Needs a container
 * engine; everything it creates is removed afterwards.
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import github from "@lotse/adapter-github";
import { scriptedModel } from "@lotse/agent";
import { AdapterRegistry } from "@lotse/core";
import { DockerClient } from "@lotse/sandbox";
import { WebSocket } from "ws";
import fake, { baseUrl, provider } from "../../cli/test/fixtures/fake-adapter.js";
import { getWithHost, startTestServer, type TestServer } from "./helpers.js";

const available = await new DockerClient().ping().then(
  () => true,
  () => false,
);

const plan = {
  stack: "static",
  name: "todo-list",
  title: "Todo List",
  summary: "A list of tasks that can be checked off.",
  dataModel: [{ entity: "Task", fields: ["title: text", "done: boolean"] }],
  pages: [{ name: "Home", purpose: "Shows the tasks" }],
  resources: [],
  notes: [],
};

const page = (heading: string) => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Todo List</title></head>
  <body><main><h1>${heading}</h1><ul id="tasks"></ul></main><script src="script.js"></script></body>
</html>
`;

describe.skipIf(!available)("builder: prompt, preview, iterate, publish", () => {
  let t: TestServer;
  let projectId = "";
  const model = scriptedModel([
    { text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` },
    // first generation
    { text: "I will write the page.", toolCalls: [{ name: "write_file", input: { path: "index.html", content: page("My tasks") } }] },
    { text: "I built a todo list with a heading and a list of tasks." },
    // second request
    { toolCalls: [{ name: "edit_file", input: { path: "index.html", old_text: "<h1>My tasks</h1>", new_text: "<h1>Things to do</h1>" } }] },
    { text: "The heading now says “Things to do”." },
  ]);

  beforeAll(async () => {
    provider.reset();
    const registry = new AdapterRegistry().use(fake).use(github);
    t = await startTestServer({}, { resolveModel: async () => model, registry });
  });

  afterAll(async () => {
    await t.server.services.sandboxes.shutdown({ removeGateway: true });
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  it("turns the prompt into a plan the user can review", async () => {
    const created = await t.api<{ project: { id: string; status: string }; jobId: string }>("POST", "/projects", { prompt: "A simple todo list" });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
    expect(created.body.project.status).toBe("planning");
    expect((await t.waitForJob(created.body.jobId)).status).toBe("succeeded");

    const { body } = await t.api<{ project: { status: string; name: string; plan: typeof plan; previewUrl: string } }>("GET", `/projects/${projectId}`);
    expect(body.project).toMatchObject({ status: "planned", name: "todo-list", plan: { stack: "static", title: "Todo List" } });
    expect(body.project.previewUrl).toMatch(new RegExp(`^http://p-${projectId}-[0-9a-f]{16}\\.localhost:\\d+$`));
    const messages = await t.api<{ messages: { role: string; meta: { kind?: string } | null }[] }>("GET", `/projects/${projectId}/messages`);
    expect(messages.body.messages.map((m) => `${m.role}:${m.meta?.kind ?? ""}`)).toEqual(["user:", "assistant:plan"]);
    // Nothing is implemented before the plan is approved.
    expect((await t.api("POST", `/projects/${projectId}/messages`, { text: "go" })).status).toBe(409);
    expect((await t.api<{ files: string[] }>("GET", `/projects/${projectId}/files`)).body.files).toEqual([]);
  });

  let generateJob = "";
  it("scaffolds, implements in the sandbox, verifies and commits; progress streams over WebSocket", async () => {
    const approved = await t.api<{ jobId: string }>("POST", `/projects/${projectId}/plan/approve`, {});
    expect(approved.status).toBe(202);
    generateJob = approved.body.jobId;

    const events: { data: { kind: string; event?: { type: string; phase?: string } } }[] = [];
    const done = new Promise<{ status: string; error: string | null }>((resolve, reject) => {
      const ws = new WebSocket(`${t.url.replace("http", "ws")}/api/v1/ws`);
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", jobId: generateJob })));
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "event") events.push(message);
        if (message.type === "done") {
          ws.close();
          resolve(message.job);
        }
      });
      ws.on("error", reject);
    });
    expect(await done).toMatchObject({ error: null, status: "succeeded" });

    const phases = events.filter((e) => e.data.kind === "agent" && e.data.event?.type === "phase").map((e) => e.data.event?.phase);
    expect(phases).toEqual(["implement", "verify", "commit", "done"]);
    expect(events.some((e) => e.data.kind === "status")).toBe(true);
    // Events are numbered without gaps, so a client can resume after a reconnect.
    expect(events.map((e) => (e as unknown as { seq: number }).seq)).toEqual(events.map((_, i) => i + 1));

    const project = await t.api<{ project: { status: string; stack: string } }>("GET", `/projects/${projectId}`);
    expect(project.body.project).toMatchObject({ status: "ready", stack: "static" });
    const files = (await t.api<{ files: string[] }>("GET", `/projects/${projectId}/files`)).body.files;
    expect(files).toEqual(expect.arrayContaining(["index.html", "lotse.yaml", "script.js", "styles.css"]));
    expect((await t.api<{ content: string }>("GET", `/projects/${projectId}/file?path=index.html`)).body.content).toContain("<h1>My tasks</h1>");
    expect((await t.api("GET", `/projects/${projectId}/file?path=../../etc/passwd`)).status).toBe(400);

    const commits = (await t.api<{ commits: { message: string; sha: string }[] }>("GET", `/projects/${projectId}/commits`)).body.commits;
    expect(commits.map((c) => c.message)).toEqual(["A simple todo list", "Scaffold Static site project"]);
    const last = (
      await t.api<{ messages: { content: string; meta: Record<string, unknown> | null }[] }>("GET", `/projects/${projectId}/messages`)
    ).body.messages.at(-1);
    expect(last).toMatchObject({
      content: "I built a todo list with a heading and a list of tasks.",
      meta: { kind: "result", verified: true, changedFiles: ["index.html"] },
    });
  });

  it("serves the live preview at the project's own address", async () => {
    const { body } = await t.api<{ url: string; ready: boolean }>("POST", `/projects/${projectId}/preview`);
    expect(body.ready).toBe(true);
    const host = new URL(body.url).host.split(":")[0] as string;
    const res = await getWithHost(t.url, host);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<h1>My tasks</h1>");
    // A guessed address for the same project does not work.
    expect((await getWithHost(t.url, host.replace(/-[0-9a-f]{16}\./, "-0000000000000000."))).status).toBe(404);
  });

  it("changes the app on a further prompt and can return to an earlier version", async () => {
    const sent = await t.api<{ jobId: string }>("POST", `/projects/${projectId}/messages`, { text: "Call the heading “Things to do”" });
    expect((await t.waitForJob(sent.body.jobId)).status).toBe("succeeded");
    expect(await readFile(join(t.server.services.projectDir(projectId), "index.html"), "utf8")).toContain("<h1>Things to do</h1>");
    // The earlier conversation is part of the request.
    expect(model.prompts.at(-2)).toContain("A simple todo list");
    expect(model.prompts.at(-2)).toContain("I built a todo list");

    const host = new URL((await t.api<{ project: { previewUrl: string } }>("GET", `/projects/${projectId}`)).body.project.previewUrl).host.split(
      ":",
    )[0] as string;
    expect((await getWithHost(t.url, host)).body).toContain("<h1>Things to do</h1>");

    const commits = (await t.api<{ commits: { message: string; sha: string }[] }>("GET", `/projects/${projectId}/commits`)).body.commits;
    expect(commits.length).toBe(3);
    const firstVersion = commits[1]?.sha as string;
    expect((await t.api("POST", `/projects/${projectId}/restore`, { sha: firstVersion })).status).toBe(200);
    expect(await readFile(join(t.server.services.projectDir(projectId), "index.html"), "utf8")).toContain("<h1>My tasks</h1>");
    expect((await t.api<{ commits: unknown[] }>("GET", `/projects/${projectId}/commits`)).body.commits.length).toBe(4);
  });

  it("shows token usage and estimated cost per project", async () => {
    const usage = await t.api<{ models: { model: string; calls: number; inputTokens: number }[]; totalCost: number | null }>(
      "GET",
      `/projects/${projectId}/usage`,
    );
    expect(usage.body.models).toEqual([{ model: "scripted:fixed", calls: 5, inputTokens: 5000, outputTokens: 1000, cost: 0 }]);
    expect(usage.body.totalCost).toBe(0);
  });

  let accountId = "";
  it("connects a provider with the guided token setup and never returns credentials", async () => {
    const rejected = await t.api("POST", "/accounts", { adapter: "fake", token: "wrong" });
    expect(rejected.status).toBe(401);
    const connected = await t.api<{ account: { id: string; account: string }; verify: { ok: boolean } }>("POST", "/accounts", {
      adapter: "fake",
      token: "fake-token-123456",
      scope: "team",
    });
    expect(connected.status).toBe(201);
    accountId = connected.body.account.id;
    expect(connected.body).toMatchObject({ account: { account: "ada", adapter: "fake", scope: "team" }, verify: { ok: true } });
    const listed = await t.api("GET", "/accounts");
    expect(JSON.stringify(listed.body)).not.toContain("fake-token-123456");
    // In the database the credential is encrypted.
    const stored = await t.server.services.database.db.select().from(t.server.services.database.schema.secrets);
    expect(JSON.stringify(stored)).not.toContain("fake-token-123456");
  });

  it("publishes with one click, after approval of the first deployment", async () => {
    const preview = await t.api<{ firstDeployment: boolean; steps: { title: string }[]; missingSecrets: string[] }>(
      "GET",
      `/projects/${projectId}/deploy/plan?account=${accountId}`,
    );
    expect(preview.body).toMatchObject({ firstDeployment: true, missingSecrets: [] });
    expect(provider.apps.size).toBe(0);

    // Without approval nothing happens.
    const refused = await t.api<{ error: { code: string } }>("POST", `/projects/${projectId}/deploy`, { accountId });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(provider.apps.size).toBe(0);

    const started = await t.api<{ jobId: string }>("POST", `/projects/${projectId}/deploy`, { accountId, approved: true });
    const job = await t.waitForJob(started.body.jobId);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({ url: `${baseUrl}/?app=todo-list`, deployment: "dep-1" });
    expect(provider.apps.get("todo-list")?.live).toBe("dep-1");

    // The job's events are the same ones the CLI shows, and contain no credentials.
    const events = (
      await t.api<{ events: { data: { kind: string; event: { type: string; phase: string; state?: string } } }[] }>("GET", `/jobs/${started.body.jobId}`)
    ).body.events;
    expect(events.filter((e) => e.data.event.type === "status").map((e) => `${e.data.event.phase}:${e.data.event.state}`)).toEqual([
      "build:started",
      "build:succeeded",
      "deploy:succeeded",
      "verify:started",
      "verify:succeeded",
      "finish:succeeded",
    ]);
    expect(JSON.stringify(events)).not.toContain("fake-token-123456");

    // Later deployments to the same target need no approval; rollback restores the previous one.
    const again = await t.api<{ jobId: string }>("POST", `/projects/${projectId}/deploy`, {});
    expect((await t.waitForJob(again.body.jobId)).status).toBe("succeeded");
    const history = await t.api<{ deployments: { id: string; state: string }[] }>("GET", `/projects/${projectId}/deployments`);
    expect(history.body.deployments.map((d) => `${d.id}:${d.state}`)).toEqual(["dep-2:live", "dep-1:superseded"]);
    const back = await t.api<{ jobId: string }>("POST", `/projects/${projectId}/rollback`, {});
    expect((await t.waitForJob(back.body.jobId)).status).toBe("succeeded");
    expect(provider.apps.get("todo-list")?.live).toBe("dep-1");
    expect((await t.api("GET", `/projects/${projectId}/status`)).body).toMatchObject({ state: "running" });
  });

  it("asks for approval before changing domains or deleting the app", async () => {
    expect((await t.api("POST", `/projects/${projectId}/domains`, { domain: "app.example.com" })).status).toBe(409);
    const domain = await t.api<{ state: string; dnsRecords: unknown[] }>("POST", `/projects/${projectId}/domains`, {
      domain: "app.example.com",
      approved: true,
    });
    expect(domain.body).toMatchObject({ state: "pending", dnsRecords: [{ type: "CNAME", value: "edge.fake.example" }] });
    expect((await t.api("DELETE", `/projects/${projectId}/app`, {})).status).toBe(409);
    expect(provider.apps.has("todo-list")).toBe(true);
    expect((await t.api("DELETE", `/projects/${projectId}/app`, { approved: true })).status).toBe(200);
    expect(provider.apps.has("todo-list")).toBe(false);
  });

  it("keeps an audit log of deployments and credential changes", async () => {
    await t.api("PUT", `/projects/${projectId}/secrets/API_KEY`, { value: "s3cr3t-value-1" });
    const audit = await t.api<{ entries: { action: string; detail: unknown }[] }>("GET", "/audit");
    const actions = audit.body.entries.map((e) => e.action);
    for (const action of ["credentials.added", "deploy.started", "deploy.succeeded", "deploy.rollback", "domain.added", "app.deleted", "secret.set"])
      expect(actions).toContain(action);
    expect(JSON.stringify(audit.body)).not.toContain("s3cr3t-value-1");
    expect(JSON.stringify(audit.body)).not.toContain("fake-token-123456");
  });

  it("removes the project together with its sandbox", async () => {
    expect((await t.api("DELETE", `/projects/${projectId}`)).status).toBe(200);
    expect((await t.api("GET", `/projects/${projectId}`)).status).toBe(404);
    expect(await t.server.services.sandboxes.get(projectId)).toBeUndefined();
  });
});
