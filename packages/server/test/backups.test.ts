/**
 * Database backups through the builder's API, as the user interface uses
 * them: listed per database, created on demand, restored only with approval.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterRegistry, type BackupInfo, type HostingAdapter, LotseError } from "@lotseai/core";
import { startTestServer, type TestServer } from "./helpers.js";

const stored: BackupInfo[] = [];
const restored: string[] = [];
const adapter: HostingAdapter = {
  id: "box",
  displayName: "Box server",
  auth: ["token"],
  capabilities: { runtimes: ["server"], languages: ["node"], resources: ["postgres"], customDomains: false, previewDeployments: false, rollback: "native" },
  async connect(input) {
    if (input.method !== "token") throw new LotseError("AUTH_FAILED", "token only");
    return { adapter: "box", method: "token", account: { id: "1", name: "ada" }, credentials: { token: input.token }, settings: {} };
  },
  verify: async () => ({ ok: true, account: "ada", missingPermissions: [], warnings: [] }),
  plan: async () => {
    throw new Error("not used");
  },
  // biome-ignore lint/correctness/useYield: not used by these tests
  async *deploy() {
    throw new Error("not used");
  },
  rollback: async () => {},
  destroy: async () => {},
  setEnv: async () => {},
  async *logs() {},
  status: async () => ({ state: "running", domains: [] }),
  backups: {
    listBackups: async (_app, resource) => stored.filter((b) => b.resource === resource),
    async createBackup(_app, resource) {
      const backup: BackupInfo = { id: `${resource}-${stored.length + 1}.sql.gz`, resource, createdAt: Date.now(), bytes: 2048, location: "local" };
      stored.push(backup);
      return backup;
    },
    async restoreBackup(_app, resource, id) {
      restored.push(`${resource}/${id}`);
    },
  },
};

describe("backups through the builder", () => {
  let t: TestServer;
  const projectId = "pbackup00001";

  beforeAll(async () => {
    t = await startTestServer({}, { registry: new AdapterRegistry().registerHosting(adapter) });
    const account = await t.api<{ account: { id: string } }>("POST", "/accounts", { adapter: "box", token: "box-token-123456" });
    const { db, schema } = t.server.services.database;
    const now = Date.now();
    await db.insert(schema.projects).values({
      id: projectId,
      ownerId: "local",
      name: "guest-book",
      title: "Guest book",
      stack: "hono",
      status: "ready",
      prompt: "x",
      plan: null,
      models: null,
      target: JSON.stringify({ adapter: "box", accountId: account.body.account.id }),
      git: null,
      createdAt: now,
      updatedAt: now,
    });
    const dir = t.server.services.projectDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "lotse.yaml"),
      "version: 1\nname: guest-book\nruntime:\n  kind: server\n  language: node\n  port: 3000\nresources:\n  - type: postgres\n    name: db\n  - type: postgres\n    name: analytics\n    options:\n      provider: neon\n",
    );
  });
  afterAll(async () => {
    await t.server.close();
    await rm(t.dataDir, { recursive: true, force: true });
  });

  it("lists the databases whose backups the host keeps", async () => {
    // The database at an external provider is backed up there, not by Lotse.
    expect((await t.api("GET", `/projects/${projectId}/backups`)).body).toEqual({ supported: true, resources: [{ name: "db", type: "postgres" }] });
  });

  it("creates a backup on demand and lists it", async () => {
    expect((await t.api("POST", `/projects/${projectId}/backups/db`)).status).toBe(201);
    const list = await t.api<{ backups: BackupInfo[] }>("GET", `/projects/${projectId}/backups/db`);
    expect(list.body.backups.map((b) => b.id)).toEqual(["db-1.sql.gz"]);
  });

  it("restores only after explicit approval, and records it in the audit log", async () => {
    const refused = await t.api<{ error: { code: string } }>("POST", `/projects/${projectId}/backups/db/restore`, { backup: "db-1.sql.gz" });
    expect(refused.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(restored).toEqual([]);
    expect((await t.api("POST", `/projects/${projectId}/backups/db/restore`, { backup: "db-1.sql.gz", approved: true })).status).toBe(200);
    expect(restored).toEqual(["db/db-1.sql.gz"]);
    const audit = await t.api<{ entries: { action: string; target: string }[] }>("GET", "/audit");
    expect(audit.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ action: "backup.restored", target: projectId })]));
  });
});
