import { loadCassette, ReplayTransport, runHostingContract, type Scenario, scenarioOf } from "@lotse/adapter-testkit";
import { collectEvents } from "@lotse/core";
import { key, READ_ONLY, scriptedServer, servers } from "../../adapter-ssh/test/scripted-server.js";
import { createHetznerAdapter, deleteHetznerServer } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

// The Hetzner API is replayed from the cassette; the server it hands over to is the scripted SSH server.
runHostingContract({
  cassette,
  create: (scenario) =>
    createHetznerAdapter({
      fetch: scenario.fetch,
      connector: scriptedServer(scenario),
      images: scenario.images,
      resolve: async () => [],
      settings: { pollIntervalMs: 1 },
    }),
  connectInput: { method: "token", token: "hetzner-test-token-123456", secrets: { privateKey: key.privateKey } },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "lotse-reference", previousDeployment: { id: "2026111611000000", version: "2026111611000000" } },
  mutations: (scenario) => scenario.transport.mutations().length + (servers.get(scenario.name)?.ops ?? []).filter((o) => !READ_ONLY.has(o.op)).length,
});

describe("hetzner specifics", () => {
  it("creates the server only after approval, then hands over to the SSH setup", async () => {
    const scenario = scenarioOf(cassette, "create-server");
    const adapter = createHetznerAdapter({
      fetch: scenario.fetch,
      connector: scriptedServer({ name: "connect" } as Scenario),
      settings: { pollIntervalMs: 1 },
    });
    const conn = await adapter.connect({ method: "token", token: "hetzner-test-token-123456" });
    // Nothing exists yet: no host, and deployments are refused with a pointer to the setup.
    expect(conn.settings.host).toBeUndefined();
    expect(conn.credentials.privateKey).toContain("PRIVATE KEY");
    await expect(adapter.plan({ name: "x" } as never, conn)).rejects.toMatchObject({ code: "PERMISSION_MISSING" });

    const setup = adapter.server as NonNullable<typeof adapter.server>;
    const plan = await setup.planSetup(conn);
    expect(plan.steps[0]).toMatchObject({ id: "server", needed: true });
    expect(plan.steps[0]?.changes.join(" ")).toContain("Hetzner bills the server until you delete it");
    expect(plan.steps.map((s) => s.id)).toEqual(["server", "user", "docker", "proxy", "firewall", "updates", "backups"]);

    await expect(setup.runSetup(conn, plan, { approved: false }).next()).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(scenario.transport.mutations()).toEqual([]);

    const { result } = await collectEvents(setup.runSetup(conn, plan, { approved: true }));
    expect(result.settings).toMatchObject({ serverId: "4711", host: "203.0.113.10", user: "lotse" });
    expect(result.settings.hostKey).toMatch(/^SHA256:/);
    const created = scenario.transport.requests.find((r) => r.method === "POST" && r.url.endsWith("/servers"))?.body as {
      ssh_keys: number[];
      labels: Record<string, string>;
    };
    expect(created).toMatchObject({ ssh_keys: [99], labels: { "managed-by": "lotse" } });
    // The API token never reaches the server.
    expect(JSON.stringify(servers.get("connect")?.ops ?? [])).not.toContain("hetzner-test-token-123456");
  });

  it("deletes only its own server and SSH key when the live tests clean up", async () => {
    const api = "https://api.hetzner.cloud/v1";
    const transport = new ReplayTransport([
      { request: { method: "DELETE", url: `${api}/servers/4711` }, response: { status: 200, body: { action: { id: 1, status: "running" } } } },
      {
        request: { method: "GET", url: `${api}/ssh_keys` },
        response: {
          status: 200,
          body: {
            ssh_keys: [
              { id: 98, public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOfSomeoneElse someone" },
              { id: 99, public_key: `${key.publicKey.split(" ").slice(0, 2).join(" ")} lotse` },
            ],
          },
        },
      },
      { request: { method: "DELETE", url: `${api}/ssh_keys/99` }, response: { status: 204 } },
    ]);
    const conn = {
      adapter: "hetzner",
      method: "token" as const,
      account: { id: "1", name: "test" },
      credentials: { token: "hetzner-test-token-123456" },
      settings: { serverId: "4711", publicKey: key.publicKey },
    };
    await deleteHetznerServer(conn, { fetch: transport.fetch });
    expect(transport.mutations().map((r) => r.url)).toEqual([`${api}/servers/4711`, `${api}/ssh_keys/99`]);
    expect(transport.unused()).toEqual([]);
  });
});
