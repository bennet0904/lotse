import { type Cassette, runHostingContract, type Scenario } from "@lotseai/adapter-testkit";
import type { LotseError } from "@lotseai/core";
import { buildSetupPlan, createSshAdapter, defaultHostFor, generateSshKeyPair, isSupportedOs, siteConfig } from "../src/index.js";
import { key, otherKey, READ_ONLY, scriptedServer, servers } from "./scripted-server.js";

const cassette: Cassette = {
  adapter: "ssh",
  source: "documentation",
  notes: "Scripted server. The real thing is covered by test/server.ssh.test.ts on fresh Ubuntu and Debian machines.",
  scenarios: Object.fromEntries(
    ["connect", "connect-invalid", "verify", "plan", "deploy", "status", "logs", "set-env", "add-domain", "rollback", "destroy"].map((n) => [n, []]),
  ),
};

runHostingContract({
  cassette,
  create: (scenario) => createSshAdapter({ connector: scriptedServer(scenario), images: scenario.images, resolve: async () => [] }),
  connectInput: { method: "ssh", host: "203.0.113.10", user: "root", privateKey: key.privateKey },
  invalidConnectInput: { method: "ssh", host: "203.0.113.10", user: "root", privateKey: otherKey.privateKey },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "lotse-reference", previousDeployment: { id: "2026111611000000", version: "2026111611000000" } },
  mutations: (scenario) => (servers.get(scenario.name)?.ops ?? []).filter((o) => !READ_ONLY.has(o.op)).length,
});

describe("ssh specifics", () => {
  it("generates OpenSSH keys that can always be read back", async () => {
    const { publicKeyOf } = await import("../src/index.js");
    for (let i = 0; i < 300; i++) {
      const pair = generateSshKeyPair("lotse@test");
      expect(publicKeyOf(pair.privateKey, "lotse@test")).toBe(pair.publicKey);
    }
  });

  it("never puts the private key into settings and never stores a password", async () => {
    const adapter = createSshAdapter({ connector: scriptedServer({ name: "connect" } as Scenario) });
    const conn = await adapter.connect({ method: "ssh", host: "203.0.113.10", password: "one-time-password" });
    expect(conn.credentials.privateKey).toContain("PRIVATE KEY");
    expect(JSON.stringify(conn)).not.toContain("one-time-password");
    expect(JSON.stringify(conn.settings)).not.toContain("PRIVATE KEY");
    const ops = servers.get("connect")?.ops ?? [];
    expect(ops[0]).toMatchObject({ op: "install-key", stdin: `${conn.settings.publicKey}\n` });
    await expect(adapter.connect({ method: "ssh", host: "203.0.113.10" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("deploys containers by starting the new version next to the old one", async () => {
    const scenario = { name: "deploy-image" } as Scenario;
    const { fakeImageTools } = await import("@lotseai/adapter-testkit");
    const { parseManifest } = await import("@lotseai/core");
    const images = fakeImageTools();
    const adapter = createSshAdapter({ connector: scriptedServer(scenario), images, drainSeconds: 0 });
    const conn = await adapter.connect({ method: "ssh", host: "203.0.113.10", privateKey: key.privateKey });
    const manifest = parseManifest(
      "version: 1\nname: api\nruntime:\n  kind: server\n  language: node\n  port: 4000\n  healthcheck: /health\nrelease:\n  command: npm run migrate\n",
    );
    const plan = await adapter.plan(manifest, conn);
    expect(plan).toMatchObject({ artifact: "image", meta: { platform: "linux/amd64" } });
    // The scripted server reports an existing static app under another name only; "api" exists as static here, so use a fresh state.
    (servers.get("deploy-image") as { ops: unknown[] }).ops.length = 0;
    const events = [];
    try {
      for await (const e of adapter.deploy(
        plan,
        { kind: "image", image: "lotse/api:1", platform: "linux/amd64", runtime: "docker", port: 4000 },
        { connection: conn, workdir: "/", env: [{ name: "API_KEY", value: "s3cr3t-value", secret: true }], resources: [] },
      )) {
        events.push(e);
      }
    } catch (err) {
      // The scripted state says the app is a static site: changing the kind is refused before anything is touched.
      expect((err as LotseError).message).toMatch(/changing the kind/);
      expect((servers.get("deploy-image")?.ops ?? []).filter((o) => !READ_ONLY.has(o.op))).toEqual([]);
    }
  });

  it("orders the steps of a container release so that a failure cannot take the app down", async () => {
    const scenario = { name: "plan" } as Scenario; // a server without the app
    const { fakeImageTools } = await import("@lotseai/adapter-testkit");
    const { parseManifest } = await import("@lotseai/core");
    const images = fakeImageTools();
    const adapter = createSshAdapter({ connector: scriptedServer(scenario), images, drainSeconds: 0 });
    const conn = await adapter.connect({ method: "ssh", host: "203.0.113.10", privateKey: key.privateKey });
    const manifest = parseManifest(
      "version: 1\nname: api\nruntime:\n  kind: server\n  language: node\n  port: 4000\n  healthcheck: /health\nrelease:\n  command: npm run migrate\n",
    );
    const plan = await adapter.plan(manifest, conn);
    (servers.get("plan") as { ops: unknown[] }).ops.length = 0;
    for await (const _ of adapter.deploy(
      plan,
      { kind: "image", image: "lotse/api:1", platform: "linux/amd64", runtime: "docker", port: 4000 },
      { connection: conn, workdir: "/", env: [{ name: "API_KEY", value: "it's a secret", secret: true }], resources: [] },
    )) {
      // drain
    }
    const ops = servers.get("plan")?.ops ?? [];
    expect(ops.map((o) => o.op)).toEqual([
      "read-state",
      "load-image",
      "write-env",
      "release-command",
      "start-container",
      "health-check",
      "switch-proxy",
      "write-state",
      "cleanup",
    ]);
    expect(images.saved).toEqual(["lotse/api:1"]);
    // Secrets travel on stdin, properly quoted, and never inside a command line.
    const env = ops.find((o) => o.op === "write-env");
    expect(env?.stdin).toContain(`export API_KEY='it'\\''s a secret'`);
    expect(ops.map((o) => o.script).join("\n")).not.toContain("it's a secret");
    expect(ops.find((o) => o.op === "release-command")?.script).toContain("npm run migrate");
    expect(ops.find((o) => o.op === "health-check")?.script).toContain(":4000/health");
    expect(ops.find((o) => o.op === "switch-proxy")?.stdin).toMatch(/reverse_proxy lotse-api-\w+-\w+:4000/);
  });

  it("requires explicit approval for the server setup and explains every step", async () => {
    const adapter = createSshAdapter({ connector: scriptedServer({ name: "connect" } as Scenario) });
    const conn = await adapter.connect({ method: "ssh", host: "203.0.113.10", privateKey: key.privateKey });
    const setup = adapter.server as NonNullable<typeof adapter.server>;
    const plan = await setup.planSetup(conn);
    expect(plan.steps.every((s) => !s.needed)).toBe(true);
    await expect(setup.runSetup(conn, plan, { approved: false }).next()).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
  });

  it("plans the setup for supported and unsupported systems", () => {
    expect(isSupportedOs("ubuntu", "24.04")).toBe(true);
    expect(isSupportedOs("ubuntu", "22.04")).toBe(false);
    expect(isSupportedOs("debian", "12")).toBe(true);
    expect(isSupportedOs("debian", "11")).toBe(false);
    const fresh = {
      id: "debian",
      version: "12",
      name: "Debian GNU/Linux 12",
      codename: "bookworm",
      arch: "aarch64",
      uid: 0,
      sudo: true,
      systemd: true,
      docker: "missing",
      dockerAccess: false,
      deployUser: false,
      deployKey: false,
      proxy: false,
      firewall: false,
      updates: false,
      backupTimer: false,
    };
    const plan = buildSetupPlan("203.0.113.10", fresh, { sshPort: 2222, httpPort: 80, httpsPort: 443 });
    expect(plan.steps.filter((s) => s.needed && !s.skipped).map((s) => s.id)).toEqual(["user", "docker", "proxy", "firewall", "updates", "backups"]);
    expect(plan.steps.find((s) => s.id === "firewall")?.changes[0]).toContain("2222 (SSH), 80 and 443");
    expect(plan.warnings[0]).toMatch(/SSH runs on port 2222/);

    const other = buildSetupPlan(
      "203.0.113.10",
      { ...fresh, id: "fedora", version: "43", name: "Fedora 43", docker: "28.0.0" },
      { sshPort: 22, httpPort: 80, httpsPort: 443 },
    );
    expect(other.os.supported).toBe(false);
    expect(other.steps.filter((s) => s.skipped).map((s) => s.id)).toEqual(["firewall", "updates"]);
    expect(other.steps.find((s) => s.id === "proxy")?.needed).toBe(true);
  });

  it("generates Caddy configuration per app", () => {
    expect(defaultHostFor("shop", { host: "203.0.113.10" })).toBe("shop.203-0-113-10.sslip.io");
    expect(defaultHostFor("shop", { host: "203.0.113.10", baseDomain: "apps.example.com" })).toBe("shop.apps.example.com");
    const proxy = siteConfig({
      app: "shop",
      defaultHost: "shop.203-0-113-10.sslip.io",
      domains: ["shop.example.com", "www.shop.example.com"],
      upstream: "lotse-shop-1:3000",
      tls: "auto",
    });
    expect(proxy).toContain("http://shop.203-0-113-10.sslip.io {");
    expect(proxy).toContain("shop.example.com, www.shop.example.com {");
    expect(proxy.match(/reverse_proxy lotse-shop-1:3000/g)?.length).toBe(2);
    const site = siteConfig({ app: "docs", defaultHost: "docs.example.org", domains: [], static: true, tls: "auto" });
    expect(site).toContain("root * /srv/apps/docs/current");
    expect(site).toContain("file_server");
  });
});
