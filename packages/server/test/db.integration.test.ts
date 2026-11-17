/**
 * The same suite against SQLite and PostgreSQL: both must behave identically
 * with the one schema. PostgreSQL runs in a throwaway container.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMasterKey, SecretStore, staticKeyProvider } from "@lotseai/secrets";
import { getTableColumns } from "drizzle-orm";
import { type Database, DbSecretBackend, DbStateStore, eq, type OpenOptions, openDatabase } from "../src/db/index.js";

const docker = (() => {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const pgName = `lotse-it-pg-${Date.now().toString(36)}`;
let pgUrl = "";
let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotse-db-"));
  if (!docker) return;
  execFileSync(
    "docker",
    ["run", "-d", "--rm", "--name", pgName, "--label", "dev.lotse.test=1", "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:16-alpine"],
    { stdio: "pipe" },
  );
  const port = execFileSync("docker", ["port", pgName, "5432/tcp"], { encoding: "utf8" }).trim().split(":").pop();
  pgUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync("docker", ["exec", pgName, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], { stdio: "pipe" });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});

afterAll(async () => {
  if (docker) execFileSync("docker", ["rm", "-f", pgName], { stdio: "pipe" });
  await rm(tmp, { recursive: true, force: true });
});

const kinds: [string, () => string, boolean, OpenOptions?][] = [
  ["sqlite", () => `sqlite:${join(tmp, "nested/dir/lotse.db")}`, true],
  // The desktop app's driver: the SQLite built into Node.js.
  ["sqlite (node:sqlite)", () => `sqlite:${join(tmp, "node/lotse.db")}`, true, { sqliteDriver: "node" }],
  ["postgres", () => pgUrl, docker],
];

describe.each(kinds)("database: %s", (kind, url, enabled, options) => {
  let database: Database;

  beforeAll(async () => {
    if (enabled) database = await openDatabase(url(), options);
  });
  afterAll(async () => {
    await database?.close();
  });

  it.runIf(enabled)("creates every table of the schema with every column", async () => {
    const { db, schema } = database;
    expect(database.kind).toBe(kind.split(" ")[0]);
    const now = Date.now();
    const rows: Record<keyof typeof schema, Record<string, unknown>> = {
      users: { id: "u1", email: "ada@example.test", name: "Ada", role: "owner", subject: "issuer|1", createdAt: now },
      sessions: { id: "s1", userId: "u1", expiresAt: now + 1000, createdAt: now },
      accounts: { id: "a1", adapter: "ssh", kind: "hosting", label: "prod", scope: "team", ownerId: "u1", method: "ssh", createdAt: now },
      secrets: { key: "k1", value: "v1.cipher", updatedAt: now },
      projects: {
        id: "p1",
        ownerId: "u1",
        name: "todo",
        title: "Todo",
        stack: "static",
        status: "ready",
        prompt: "a todo list",
        plan: "{}",
        models: "{}",
        target: "{}",
        git: "{}",
        createdAt: now,
        updatedAt: now,
      },
      messages: { id: "m1", projectId: "p1", role: "user", content: "hello", meta: "{}", createdAt: now },
      jobs: {
        id: "j1",
        projectId: "p1",
        type: "generate",
        status: "queued",
        input: "{}",
        result: null,
        error: null,
        createdBy: "u1",
        createdAt: now,
        startedAt: null,
        finishedAt: null,
      },
      jobEvents: { id: "e1", jobId: "j1", seq: 1, at: now, data: "{}" },
      apps: { key: "p1|ssh|todo", data: "{}", updatedAt: now },
      deployments: { id: "d1", appKey: "p1|ssh|todo", state: "live", createdAt: now, data: "{}" },
      usage: { id: "p1|m", projectId: "p1", model: "m", calls: 3, inputTokens: 5_000_000_000, outputTokens: 12, costMicros: 1234 },
      auditLog: { id: "l1", at: now, userId: "u1", action: "signin", target: null, detail: "{}", ip: "127.0.0.1" },
      settings: { key: "models", value: "{}" },
    };
    for (const name of Object.keys(schema) as (keyof typeof schema)[]) {
      const table = schema[name];
      // The test row must cover every column the schema declares.
      expect(Object.keys(rows[name]).sort(), name).toEqual(Object.keys(getTableColumns(table)).sort());
      await db.insert(table).values(rows[name] as never);
      const read = await db.select().from(table);
      expect(read[0], name).toEqual(rows[name]);
    }
    // 64-bit values survive (token counts beyond 2^31, epoch milliseconds).
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.id, "p1|m"));
    expect(usage[0]?.inputTokens).toBe(5_000_000_000);
  });

  it.runIf(enabled)("enforces unique e-mail addresses", async () => {
    const { db, schema } = database;
    await expect(db.insert(schema.users).values({ id: "u2", email: "ada@example.test", name: "Other", role: "member", createdAt: 1 })).rejects.toThrow();
  });

  it.runIf(enabled)("stores credentials encrypted", async () => {
    const backend = new DbSecretBackend(database);
    const store = new SecretStore(backend, staticKeyProvider(generateMasterKey()));
    await store.set("connection/acc_1", JSON.stringify({ token: "plain-token-value" }));
    await store.set("connection/acc_2", "two");
    await store.set("env/p1/API_KEY", "three");
    expect(await backend.get("connection/acc_1")).not.toContain("plain-token-value");
    expect(await store.get("connection/acc_1")).toContain("plain-token-value");
    await store.set("connection/acc_2", "changed");
    expect(await store.get("connection/acc_2")).toBe("changed");
    expect(await store.list("connection/")).toEqual(["connection/acc_1", "connection/acc_2"]);
    await store.delete("connection/acc_1");
    expect(await store.get("connection/acc_1")).toBeUndefined();
  });

  it.runIf(enabled)("keeps the deployment state per project", async () => {
    const a = new DbStateStore(database, "proj-a");
    const b = new DbStateStore(database, "proj-b");
    await a.saveApp({ adapter: "ssh", name: "app", id: "app", resources: [], domains: ["a.example.com"], updatedAt: 1 });
    await a.saveDeployment({ id: "d1", adapter: "ssh", app: "app", createdAt: 1, state: "live" });
    await a.saveDeployment({ id: "d2", adapter: "ssh", app: "app", createdAt: 2, state: "live" });
    await a.saveDeployment({ id: "d1", adapter: "ssh", app: "app", createdAt: 1, state: "superseded" });
    expect((await a.getApp("ssh", "app"))?.domains).toEqual(["a.example.com"]);
    expect((await a.listDeployments("ssh", "app")).map((d) => `${d.id}:${d.state}`)).toEqual(["d2:live", "d1:superseded"]);
    expect(await b.getApp("ssh", "app")).toBeUndefined();
    expect(await b.listDeployments("ssh", "app")).toEqual([]);
    await a.deleteApp("ssh", "app");
    expect(await a.listDeployments("ssh", "app")).toEqual([]);
  });

  it.runIf(enabled)("applies migrations once", async () => {
    const again = await openDatabase(url());
    const users = await again.db.select().from(again.schema.users);
    expect(users.map((u) => u.id)).toEqual(["u1"]);
    await again.close();
  });
});

describe("database URLs", () => {
  it("rejects unknown schemes", async () => {
    await expect(openDatabase("mysql://localhost/x")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
