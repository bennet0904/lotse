/**
 * SSH tests (specification section 14.2): setup and deployment on a fresh
 * Ubuntu or Debian machine. Start one with `scripts/test-server.sh up` and run
 *
 *   LOTSE_TEST_SSH_HOST=$(scripts/test-server.sh ip) pnpm test:ssh
 *
 * LOTSE_TEST_SSH_PASSWORD defaults to the password of the test-server image.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_MARKER, writeReferenceServer, writeReferenceStaticSite } from "@lotseai/adapter-testkit";
import { LocalBuilder } from "@lotseai/build";
import {
  AdapterRegistry,
  type Connection,
  collectEvents,
  type DeployEvent,
  DeploymentEngine,
  type DeployOutcome,
  formatEvent,
  loadManifest,
  MemoryStateStore,
  MemoryVault,
  type SetupPlan,
} from "@lotseai/core";
import { createSshAdapter } from "../src/index.js";

const host = process.env.LOTSE_TEST_SSH_HOST;
const password = process.env.LOTSE_TEST_SSH_PASSWORD ?? "lotse-test-password";
/** Container that plays the server; used to look inside it. */
const machine = process.env.LOTSE_TEST_SSH_CONTAINER ?? "lotse-testserver-ubuntu";

function get(path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port: 80, path, headers: { Host: hostHeader }, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!host)("ssh adapter on a fresh server", () => {
  const adapter = createSshAdapter({ healthTimeoutSeconds: 30, drainSeconds: 1 });
  const registry = new AdapterRegistry().registerHosting(adapter);
  const state = new MemoryStateStore();
  const vault = new MemoryVault();
  const engine = new DeploymentEngine({ registry, builder: new LocalBuilder(), state, vault });
  const run = Date.now().toString(36).slice(-5);
  const site = `site-${run}`;
  const api = `api-${run}`;
  let root: Connection;
  let conn: Connection;
  let work = "";
  const hostOf = (app: string) => `${app}.${(host as string).replace(/\./g, "-")}.sslip.io`;

  async function deploy(dir: string, extra: { secrets?: Record<string, string> } = {}): Promise<{ events: DeployEvent[]; result: DeployOutcome }> {
    const manifest = await loadManifest(dir);
    const target = { adapter: "ssh", connection: conn };
    const plan = await engine.plan(manifest, target);
    const out = await collectEvents(engine.deploy(plan, { ...target, workdir: dir, healthTimeoutMs: 30_000, healthIntervalMs: 500, ...extra }));
    if (!out.result.ok && !process.env.LOTSE_TEST_QUIET) console.log(out.events.map(formatEvent).join("\n"));
    return out;
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "lotse-ssh-"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
    // Remove the images this run built on the machine that runs the tests.
    for (const app of [api]) {
      const ids = execFileSync("docker", ["images", "-q", `lotse/${app}`], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
      if (ids.length) execFileSync("docker", ["rmi", "-f", ...new Set(ids)], { stdio: "ignore" });
    }
  });

  it("installs the generated key with the password, once", async () => {
    root = await adapter.connect({ method: "ssh", host: host as string, user: "root", password, options: { tls: "internal" } });
    expect(root.credentials.privateKey).toContain("OPENSSH PRIVATE KEY");
    expect(JSON.stringify(root)).not.toContain(password);
    expect(root.settings.hostKey).toMatch(/^SHA256:/);
    expect(root.settings.publicKey).toMatch(/^ssh-ed25519 /);
    // From now on the key is enough.
    const again = await adapter.connect({ method: "ssh", host: host as string, user: "root", privateKey: root.credentials.privateKey });
    expect(again.settings.hostKey).toBe(root.settings.hostKey);
  });

  it("refuses a server whose host key changed", async () => {
    const pinned = { ...root, settings: { ...root.settings, hostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } };
    await expect(adapter.verify(pinned)).rejects.toMatchObject({ code: "AUTH_FAILED", message: expect.stringContaining("host key") });
  });

  let plan: SetupPlan;
  it("reports what is missing and shows what the setup would change", async () => {
    const before = await adapter.verify(root);
    expect(before.ok).toBe(false);
    expect(before.missingPermissions.join(" ")).toMatch(/Docker is not installed/);

    plan = await (adapter.server as NonNullable<typeof adapter.server>).planSetup(root);
    expect(plan.os.supported).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(["user", "docker", "proxy", "firewall", "updates", "backups"]);
    expect(plan.steps.every((s) => s.needed && !s.skipped && s.changes.length > 0)).toBe(true);
  });

  it("does not touch the server without explicit approval", async () => {
    const setup = adapter.server as NonNullable<typeof adapter.server>;
    await expect(setup.runSetup(root, plan, { approved: false }).next()).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect((await adapter.verify(root)).ok).toBe(false);
  });

  it("sets up the server: user, Docker, Caddy, firewall, updates, backups", async () => {
    const setup = adapter.server as NonNullable<typeof adapter.server>;
    const { events, result } = await collectEvents(setup.runSetup(root, plan, { approved: true }));
    conn = result;
    expect(conn.settings.user).toBe("lotse");
    expect(events.filter((e) => e.type === "progress").length).toBe(6);

    const verified = await adapter.verify(conn);
    expect(verified).toMatchObject({ ok: true, missingPermissions: [], warnings: [] });

    // Idempotent: a second plan has nothing left to do.
    const again = await setup.planSetup(root);
    expect(again.steps.filter((s) => s.needed).map((s) => s.id)).toEqual([]);
    const rerun = await collectEvents(setup.runSetup(root, again, { approved: true }));
    expect(rerun.events.filter((e) => e.type === "progress")).toEqual([]);
  });

  it("opens only SSH, HTTP and HTTPS in the firewall", () => {
    const status = execFileSync("docker", ["exec", machine, "ufw", "status"], { encoding: "utf8" });
    expect(status).toContain("Status: active");
    const ports = [...status.matchAll(/^(\d+)\/(tcp|udp)\s+ALLOW/gm)].map((m) => `${m[1]}/${m[2]}`).sort();
    expect(ports).toEqual(["22/tcp", "443/tcp", "443/udp", "80/tcp"]);
  });

  it("deploys a static site and switches releases atomically", async () => {
    const dir = join(work, "site");
    await writeReferenceStaticSite(dir, site, "1");
    const first = await deploy(dir);
    expect(first.result).toMatchObject({ ok: true, deployment: { state: "live", url: `http://${hostOf(site)}` } });
    const page = await get("/", hostOf(site));
    expect(page.status).toBe(200);
    expect(page.body).toContain(REFERENCE_MARKER);
    expect(page.body).toContain("version 1");

    await writeReferenceStaticSite(dir, site, "2");
    expect((await deploy(dir)).result.ok).toBe(true);
    expect((await get("/", hostOf(site))).body).toContain("version 2");

    const back = await collectEvents(engine.rollback(await loadManifest(dir), { adapter: "ssh", connection: conn, workdir: dir }));
    expect(back.result.ok).toBe(true);
    expect((await get("/", hostOf(site))).body).toContain("version 1");
  });

  it("deploys a server app as a container without a registry", async () => {
    const dir = join(work, "api");
    await writeReferenceServer(dir, api, { version: "1" });
    const { result, events } = await deploy(dir);
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === "log" && e.line.includes("Image transferred over SSH"))).toBe(true);
    const page = await get("/", hostOf(api));
    expect(page.body).toContain("version 1");
    expect(JSON.parse((await get("/env", hostOf(api))).body)).toMatchObject({ APP_NAME: "Reference" });
    expect(await adapter.status(await engine.app("ssh", api, conn))).toMatchObject({ state: "running", url: `http://${hostOf(api)}` });
    // Both apps run on the same server and are routed by host name.
    expect((await get("/", hostOf(site))).body).toContain("version 1");
  });

  it("replaces the running version without downtime", async () => {
    const dir = join(work, "api");
    await writeReferenceServer(dir, api, { version: "2" });
    const failures: string[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const res = await get("/", hostOf(api)).catch((e) => ({ status: 0, body: String(e) }));
        if (res.status !== 200) failures.push(`${res.status} ${res.body.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const { result } = await deploy(dir);
    polling = false;
    await poller;
    expect(result.ok).toBe(true);
    expect(failures).toEqual([]);
    expect((await get("/", hostOf(api))).body).toContain("version 2");
  });

  it("leaves the running version untouched when the new one is unhealthy", async () => {
    const dir = join(work, "api");
    await writeReferenceServer(dir, api, { version: "3", healthy: false });
    const { result, events } = await deploy(dir);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HEALTHCHECK_FAILED");
    expect(events.some((e) => e.type === "log" && e.line.includes("reference app version 3 listening"))).toBe(true);
    expect((await get("/", hostOf(api))).body).toContain("version 2");
    const containers = execFileSync("docker", ["exec", machine, "docker", "ps", "-a", "--filter", `label=dev.lotse.app=${api}`, "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    expect(containers.trim().split("\n").length).toBe(1);
  });

  it("rolls back to the previous image kept on the server", async () => {
    const dir = join(work, "api");
    const { result } = await collectEvents(engine.rollback(await loadManifest(dir), { adapter: "ssh", connection: conn, workdir: dir }));
    expect(result.ok).toBe(true);
    expect((await get("/", hostOf(api))).body).toContain("version 1");
  });

  it("applies changed environment variables with a restart", async () => {
    await engine.setEnv("ssh", api, conn, [
      { name: "APP_NAME", value: 'It\'s "renamed" $HOME', secret: false },
      { name: "API_KEY", value: "line1\nline2", secret: true },
    ]);
    expect(JSON.parse((await get("/env", hostOf(api))).body)).toEqual({ APP_NAME: 'It\'s "renamed" $HOME', hasSecret: true, hasDatabase: false });
  });

  it("runs Postgres next to the app, backs it up and restores it", async () => {
    const dir = join(work, "api");
    await writeReferenceServer(dir, api, { version: "4", resources: "resources:\n  - type: postgres\n    name: db\n" });
    const { result } = await deploy(dir);
    expect(result.ok).toBe(true);
    expect(JSON.parse((await get("/env", hostOf(api))).body)).toMatchObject({ hasDatabase: true });

    const pg = `lotse-${api}-res-db`;
    const psql = (sql: string) =>
      execFileSync("docker", ["exec", machine, "docker", "exec", pg, "psql", "-U", "app", "-d", "app", "-At", "-c", sql], { encoding: "utf8" }).trim();
    psql("create table notes (body text); insert into notes values ('before backup');");

    const backups = adapter.backups as NonNullable<typeof adapter.backups>;
    const appRef = await engine.app("ssh", api, conn);
    const backup = await backups.createBackup(appRef, "db");
    expect(backup.id).toMatch(/^\d{8}T\d{6}Z\.sql\.gz$/);
    expect(backup.bytes).toBeGreaterThan(100);
    expect((await backups.listBackups(appRef, "db")).map((b) => b.id)).toContain(backup.id);

    psql("delete from notes; insert into notes values ('after backup');");
    await backups.restoreBackup(appRef, "db", backup.id);
    expect(psql("select body from notes;")).toBe("before backup");
    await expect(backups.restoreBackup(appRef, "db", "../../etc/passwd")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // The nightly timer is installed and runs as the deployment user.
    const timer = execFileSync("docker", ["exec", machine, "systemctl", "is-enabled", "lotse-backup.timer"], { encoding: "utf8" });
    expect(timer.trim()).toBe("enabled");
  });

  it("serves a custom domain with TLS", async () => {
    const status = await engine.addDomain("ssh", api, conn, "portal.example.test");
    expect(status).toMatchObject({ domain: "portal.example.test", state: "pending", dnsRecords: [{ type: "A", name: "portal.example.test", value: host }] });
    const out = execFileSync("curl", ["-sk", "--resolve", `portal.example.test:443:${host}`, "https://portal.example.test/"], { encoding: "utf8" });
    expect(out).toContain("version 4");
  });

  it("streams the app's logs", async () => {
    const lines = [];
    for await (const line of engine.logs("ssh", api, conn, { tail: 20 })) lines.push(line);
    expect(lines.some((l) => l.line.includes("reference app version 4 listening"))).toBe(true);
    expect(lines.every((l) => l.at > 1_600_000_000_000)).toBe(true);
  });

  it("removes apps completely", async () => {
    await engine.destroy(await loadManifest(join(work, "api")), { adapter: "ssh", connection: conn, workdir: work });
    await engine.destroy(await loadManifest(join(work, "site")), { adapter: "ssh", connection: conn, workdir: work });
    expect((await get("/", hostOf(api))).status).toBe(404);
    expect((await get("/", hostOf(site))).status).toBe(404);
    const left = execFileSync("docker", ["exec", machine, "docker", "ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
    expect(left.trim()).toBe("lotse-caddy");
    expect(await adapter.status(await engine.app("ssh", api, conn))).toMatchObject({ state: "not-found" });
  });
});
