import {
  AdapterRegistry,
  collectEvents,
  type DeployEvent,
  DeploymentEngine,
  type HealthChecker,
  MemoryStateStore,
  MemoryVault,
  resolveEnv,
} from "../src/index.js";
import { connection, type FakeAdapter, fakeAdapter, fakeBuilder, fakeResourceAdapter, manifest, serverManifest } from "./helpers.js";

function setup(options: { adapter?: FakeAdapter; health?: HealthChecker } = {}) {
  const adapter = options.adapter ?? fakeAdapter();
  const resource = fakeResourceAdapter();
  const registry = new AdapterRegistry().registerHosting(adapter).registerResource(resource);
  const state = new MemoryStateStore();
  const vault = new MemoryVault();
  const builder = fakeBuilder();
  const healthCalls: string[] = [];
  const health: HealthChecker =
    options.health ??
    (async (o) => {
      healthCalls.push(o.url);
      return { ok: true, status: 200, attempts: 1, durationMs: 1 };
    });
  const engine = new DeploymentEngine({ registry, builder, state, vault, health });
  return { adapter, resource, registry, state, vault, builder, engine, healthCalls };
}

const phases = (events: DeployEvent[]) => events.filter((e) => e.type === "status").map((e) => `${e.phase}:${e.type === "status" ? e.state : ""}`);

describe("deployment engine", () => {
  it("plans, builds, deploys and verifies", async () => {
    const t = setup();
    const m = manifest(serverManifest);
    const plan = await t.engine.plan(m, { adapter: "fake", connection });
    expect(plan.firstDeployment).toBe(true);
    expect(plan.steps.find((s) => s.id === "app")?.critical).toBe(true);

    const { events, result } = await collectEvents(t.engine.deploy(plan, { adapter: "fake", connection, workdir: "/app" }));
    expect(phases(events)).toEqual(["build:started", "build:succeeded", "deploy:succeeded", "verify:started", "verify:succeeded", "finish:succeeded"]);
    expect(result).toMatchObject({ ok: true, rolledBack: false, deployment: { id: "dep-1", state: "live", url: "https://demo-1.example.test" } });
    expect(t.builder.requests).toEqual(["image"]);
    expect(t.healthCalls).toEqual(["https://demo-1.example.test/health"]);
    expect(await t.state.getApp("fake", "demo")).toMatchObject({ id: "app-1", resources: [], domains: [] });
  });

  it("never lets credentials reach the event stream", async () => {
    const t = setup();
    const plan = await t.engine.plan(manifest(serverManifest), { adapter: "fake", connection });
    const { events } = await collectEvents(t.engine.deploy(plan, { adapter: "fake", connection, workdir: "/app" }));
    const text = JSON.stringify(events.filter((e) => e.type === "log"));
    expect(text).not.toContain("super-secret-token-123");
    expect(text).toContain("[redacted]");
  });

  it("passes PORT, public values, secrets and resource connections to the adapter", async () => {
    const t = setup();
    const m = manifest(`${serverManifest}resources:\n  - type: postgres\n    name: db\nenv:\n  public:\n    APP_NAME: Demo\n  secrets:\n    - API_KEY\n`);
    const target = { adapter: "fake", connection, resourceConnections: { fakedb: { ...connection, adapter: "fakedb" } } };
    const plan = await t.engine.plan(m, target);
    expect(plan.steps[0]).toMatchObject({ id: "resource:db", detail: "at Fake DB (external provider)" });

    const { events, result } = await collectEvents(t.engine.deploy(plan, { ...target, workdir: "/app", secrets: { API_KEY: "key-123456" } }));
    expect(result.ok).toBe(true);
    expect(phases(events)).toContain("provision:succeeded");
    expect(t.adapter.lastContext?.env).toEqual([
      { name: "PORT", value: "3000", secret: false },
      { name: "APP_NAME", value: "Demo", secret: false },
      { name: "DATABASE_URL", value: "postgres://user:pw-very-secret@db.example.test/app", secret: true },
      { name: "API_KEY", value: "key-123456", secret: true },
    ]);
    // The state file holds names only; the values live in the vault.
    const app = await t.state.getApp("fake", "demo");
    expect(app?.resources).toEqual([{ type: "postgres", name: "db", id: "db-123", provider: "fakedb", envNames: ["DATABASE_URL"], meta: undefined }]);
    expect(JSON.stringify(app)).not.toContain("pw-very-secret");
    expect(await t.vault.list("resource/")).toEqual(["resource/fake/demo/db/DATABASE_URL"]);

    // A second deployment reuses the database instead of creating another one.
    const second = await t.engine.plan(m, target);
    expect(second.resources[0]?.action).toBe("reuse");
    await collectEvents(t.engine.deploy(second, { ...target, workdir: "/app", secrets: { API_KEY: "key-123456" } }));
    expect(t.resource.calls).toEqual(["provision:demo:db"]);
    expect(t.adapter.lastContext?.env.find((e) => e.name === "DATABASE_URL")?.value).toContain("db.example.test");
  });

  it("stops before building when a secret has no value", async () => {
    const t = setup();
    const m = manifest(`${serverManifest}env:\n  secrets:\n    - STRIPE_API_KEY\n`);
    const plan = await t.engine.plan(m, { adapter: "fake", connection });
    const { events, result } = await collectEvents(t.engine.deploy(plan, { adapter: "fake", connection, workdir: "/app" }));
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(events[0]).toMatchObject({ type: "error", phase: "plan" });
    expect(t.builder.requests).toEqual([]);
  });

  it("restores the last working version when the health check fails", async () => {
    let healthy = true;
    const t = setup({ health: async () => ({ ok: healthy, attempts: 1, durationMs: 1, detail: "HTTP 500" }) });
    const m = manifest(serverManifest);
    const target = { adapter: "fake", connection, workdir: "/app" };
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));

    healthy = false;
    const { events, result } = await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    expect(phases(events)).toEqual([
      "build:started",
      "build:succeeded",
      "deploy:succeeded",
      "verify:started",
      "verify:failed",
      "rollback:started",
      "rollback:succeeded",
      "finish:failed",
    ]);
    expect(result).toMatchObject({ ok: false, rolledBack: true, error: { code: "HEALTHCHECK_FAILED" } });
    expect(t.adapter.calls).toContain("rollback:dep-1");
    const history = await t.state.listDeployments("fake", "demo");
    expect(history.map((d) => `${d.id}:${d.state}`)).toEqual(["dep-2:failed", "dep-1:live"]);
  });

  it("does not roll back when the adapter cannot or there is nothing to restore", async () => {
    const first = setup({ health: async () => ({ ok: false, attempts: 1, durationMs: 1 }) });
    const m = manifest(serverManifest);
    const target = { adapter: "fake", connection, workdir: "/app" };
    const run1 = await collectEvents(first.engine.deploy(await first.engine.plan(m, target), target));
    expect(phases(run1.events)).toContain("rollback:skipped");
    expect(run1.result.rolledBack).toBe(false);

    let healthy = true;
    const none = setup({ adapter: fakeAdapter({ rollback: "none" }), health: async () => ({ ok: healthy, attempts: 1, durationMs: 1 }) });
    await collectEvents(none.engine.deploy(await none.engine.plan(m, target), target));
    healthy = false;
    const run2 = await collectEvents(none.engine.deploy(await none.engine.plan(m, target), target));
    expect(phases(run2.events)).toContain("rollback:skipped");
    expect(none.adapter.calls.filter((c) => c.startsWith("rollback"))).toEqual([]);
  });

  it("reports provider failures without touching the recorded live version", async () => {
    const t = setup();
    const m = manifest(serverManifest);
    const target = { adapter: "fake", connection, workdir: "/app" };
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    t.adapter.failDeploy = "quota exceeded for token super-secret-token-123";
    const { events, result } = await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    expect(result).toMatchObject({ ok: false, rolledBack: false, error: { code: "DEPLOY_FAILED" } });
    expect(result.error?.message).not.toContain("super-secret-token-123");
    expect(phases(events).at(-1)).toBe("deploy:failed");
    expect((await t.state.listDeployments("fake", "demo")).map((d) => `${d.id}:${d.state}`)).toEqual(["dep-1:live"]);
  });

  it("aborts before the build when the signal is already aborted", async () => {
    const t = setup();
    const target = { adapter: "fake", connection, workdir: "/app" };
    const plan = await t.engine.plan(manifest(serverManifest), target);
    const { result } = await collectEvents(t.engine.deploy(plan, { ...target, signal: AbortSignal.abort() }));
    expect(result.error?.code).toBe("ABORTED");
    expect(t.adapter.calls).toEqual(["plan"]);
  });

  it("attaches domains and reports the DNS records to create", async () => {
    const t = setup();
    const target = { adapter: "fake", connection, workdir: "/app" };
    const m = manifest(`${serverManifest}domains:\n  - app.example.com\n`);
    const { events, result } = await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    expect(result.domains).toEqual([
      { domain: "app.example.com", state: "pending", dnsRecords: [{ type: "CNAME", name: "app.example.com", value: "cname.example.test" }] },
    ]);
    expect(events.some((e) => e.type === "log" && e.line.includes("CNAME app.example.com -> cname.example.test"))).toBe(true);
    expect((await t.state.getApp("fake", "demo"))?.domains).toEqual(["app.example.com"]);
  });

  it("keeps preview deployments apart from the live version", async () => {
    const t = setup();
    const m = manifest(serverManifest);
    const target = { adapter: "fake", connection, workdir: "/app" };
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    const { result } = await collectEvents(t.engine.deploy(await t.engine.plan(m, target), { ...target, preview: { id: "pr-7" } }));
    expect(result.deployment?.state).toBe("preview");
    expect(t.adapter.lastContext?.preview).toEqual({ id: "pr-7" });
    expect((await t.state.listDeployments("fake", "demo")).map((d) => `${d.id}:${d.state}`)).toEqual(["dep-2:preview", "dep-1:live"]);
  });

  it("rolls back to the previous deployment on request", async () => {
    const t = setup();
    const m = manifest(serverManifest);
    const target = { adapter: "fake", connection, workdir: "/app" };
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));

    const { result } = await collectEvents(t.engine.rollback(m, target));
    expect(result).toMatchObject({ ok: true, rolledBack: true, deployment: { id: "dep-1", state: "live" } });
    expect(t.adapter.calls.at(-1)).toBe("rollback:dep-1");
    expect((await t.state.listDeployments("fake", "demo")).map((d) => `${d.id}:${d.state}`)).toEqual(["dep-2:rolled-back", "dep-1:live"]);

    const again = await collectEvents(t.engine.rollback(m, { ...target, to: "dep-1" }));
    expect(again.result.error?.code).toBe("INVALID_INPUT");
  });

  it("destroys the app and forgets its state", async () => {
    const t = setup();
    const m = manifest(`${serverManifest}resources:\n  - type: postgres\n    name: db\n`);
    const target = { adapter: "fake", connection, workdir: "/app", resourceConnections: { fakedb: { ...connection, adapter: "fakedb" } } };
    await collectEvents(t.engine.deploy(await t.engine.plan(m, target), target));

    await t.engine.destroy(m, { ...target, withResources: true });
    expect(t.adapter.calls.at(-1)).toBe("destroy:demo");
    expect(t.resource.calls).toEqual(["provision:demo:db", "destroy:db"]);
    expect(await t.state.getApp("fake", "demo")).toBeUndefined();
    expect(await t.vault.list()).toEqual([]);
  });

  it("scrubs credentials from logs", async () => {
    const t = setup();
    const lines = [];
    for await (const line of t.engine.logs("fake", "demo", connection)) lines.push(line.line);
    expect(lines).toEqual(["hello [redacted]"]);
  });
});

describe("resolveEnv", () => {
  it("lets secrets override public values of the same name from resources", () => {
    const m = manifest("version: 1\nname: site\nruntime:\n  kind: static\nenv:\n  public:\n    A: one\n");
    expect(resolveEnv(m, {}, [])).toEqual([{ name: "A", value: "one", secret: false }]);
  });
});
