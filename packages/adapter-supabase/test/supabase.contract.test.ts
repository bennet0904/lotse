import { loadCassette, runResourceContract, scenarioOf } from "@lotseai/adapter-testkit";
import type { AppRef, Connection, ResourceRef } from "@lotseai/core";
import { createSupabaseAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const create = (scenario: { fetch: typeof fetch }) => createSupabaseAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } });
const connectInput = { method: "token", token: "sbp_test_token_1234567890abcdef" } as const;

runResourceContract({
  cassette,
  create,
  connectInput,
  invalidConnectInput: { method: "token", token: "sbp_wrong_0000000000" },
  appName: "lotse-reference",
  resourceName: "db",
});

describe("supabase specifics", () => {
  const REF = "xyzcompanyabcdefghij";
  let connection: Connection;
  const app = (): AppRef => ({ adapter: "supabase", name: "lotse-reference", connection });
  const ref: ResourceRef = { type: "postgres", name: "db", id: REF, provider: "supabase", env: [] };

  beforeAll(async () => {
    connection = await create(scenarioOf(cassette, "connect")).connect(connectInput);
  });

  it("remembers the organization new projects are created in", () => {
    expect(connection.account).toEqual({ id: "3f1c5a0e-7f0b-4b0a-9d4e-2a6a5b1c9e77", name: "ada@example.test" });
    expect(connection.settings).toEqual({ organization: "wlknsdfojrwezmnbvcxq", organizationName: "Ada's Org" });
  });

  it("creates the project with a generated password and waits until it runs", async () => {
    const scenario = scenarioOf(cassette, "provision");
    const created = await create(scenario).provision(app(), { type: "postgres", name: "db" });
    const sent = scenario.transport.requests.find((r) => r.method === "POST")?.body as { db_pass: string; region_selection?: unknown };
    expect(sent.db_pass).toMatch(/^[\w-]{32}$/);
    expect(sent.region_selection).toBeUndefined();
    expect(created.id).toBe(REF);
    // Both addresses go through the pooler host, which is reachable over IPv4.
    expect(created.env).toEqual([
      { name: "DATABASE_URL", value: `postgresql://postgres.${REF}:${sent.db_pass}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`, secret: true },
      {
        name: "DATABASE_URL_UNPOOLED",
        value: `postgresql://postgres.${REF}:${sent.db_pass}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
        secret: true,
      },
    ]);
    expect(created.meta).toEqual({ project: "lotse-reference-db", region: "eu-central-1", api: `https://${REF}.supabase.co` });
    expect(JSON.stringify(created.meta)).not.toContain(sent.db_pass);
    expect(scenario.transport.requests.filter((r) => r.url.endsWith(`/projects/${REF}`)).length).toBe(2);
  });

  it("uses a new password for every database", async () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const scenario = scenarioOf(cassette, "provision");
      await create(scenario).provision(app(), { type: "postgres", name: "db" });
      const sent = scenario.transport.requests.find((r) => r.method === "POST") as { body: { db_pass: string } };
      passwords.add(sent.body.db_pass);
    }
    expect(passwords.size).toBe(3);
  });

  it("places the project in the requested region or region group", async () => {
    const specific = scenarioOf(cassette, "provision-region");
    await create(specific).provision(app(), { type: "postgres", name: "db", options: { region: "eu-central-1" } });
    expect(specific.transport.unused()).toEqual([]);

    // Without a pooler record the database's own address is used.
    const group = scenarioOf(cassette, "provision-smart-region");
    const created = await createSupabaseAdapter({ fetch: group.fetch, settings: { pollIntervalMs: 1, region: "emea" } }).provision(app(), {
      type: "postgres",
      name: "db",
    });
    expect(group.transport.unused()).toEqual([]);
    expect(created.env[0]?.value).toMatch(new RegExp(`^postgresql://postgres:[\\w-]{32}@db\\.${REF}\\.supabase\\.co:5432/postgres$`));
  });

  it("does not take over a project it did not create", async () => {
    const scenario = scenarioOf(cassette, "provision-existing");
    await expect(create(scenario).provision(app(), { type: "postgres", name: "db" })).rejects.toMatchObject({ code: "CONFLICT", details: { project: REF } });
    expect(scenario.transport.mutations()).toEqual([]);
  });

  it("reports projects that do not start and exhausted plans", async () => {
    await expect(create(scenarioOf(cassette, "provision-failed")).provision(app(), { type: "postgres", name: "db" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("INIT_FAILED"),
    });
    await expect(create(scenarioOf(cassette, "provision-limit")).provision(app(), { type: "postgres", name: "db" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("2 project limit"),
    });
    await expect(create(scenarioOf(cassette, "provision")).provision(app(), { type: "redis", name: "cache" })).rejects.toMatchObject({
      code: "RESOURCE_UNSUPPORTED",
    });
  });

  it("tells starting, paused and removed projects apart", async () => {
    expect(await create(scenarioOf(cassette, "status-creating")).status(app(), ref)).toEqual({ state: "creating", message: undefined });
    expect(await create(scenarioOf(cassette, "status-paused")).status(app(), ref)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("paused"),
    });
    expect(await create(scenarioOf(cassette, "status-gone")).status(app(), ref)).toEqual({ state: "not-found" });
    await create(scenarioOf(cassette, "destroy-gone")).destroy(app(), ref);
  });

  it("lets the user choose among several organizations", async () => {
    const first = await create(scenarioOf(cassette, "connect-two-orgs")).connect(connectInput);
    expect(first.settings).toMatchObject({ organization: "wlknsdfojrwezmnbvcxq", organizationChoice: "first" });
    expect((await create(scenarioOf(cassette, "verify")).verify(first)).warnings[0]).toContain("Ada's Org");
    const chosen = await create(scenarioOf(cassette, "connect-two-orgs")).connect({ ...connectInput, options: { organization: "analytical-engines" } });
    expect(chosen.settings).toEqual({ organization: "analytical-engines", organizationName: "Analytical Engines Ltd" });
    await expect(create(scenarioOf(cassette, "connect-two-orgs")).connect({ ...connectInput, options: { organization: "nope" } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(create(scenarioOf(cassette, "connect-no-org")).connect(connectInput)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // Access to the organization can be lost after signing in.
    expect(await create(scenarioOf(cassette, "verify")).verify(chosen)).toMatchObject({ ok: false });
  });
});
