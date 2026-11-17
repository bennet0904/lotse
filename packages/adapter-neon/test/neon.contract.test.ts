import { loadCassette, runResourceContract, scenarioOf } from "@lotse/adapter-testkit";
import type { AppRef, Connection, ResourceRef } from "@lotse/core";
import { createNeonAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const create = (scenario: { fetch: typeof fetch }) => createNeonAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } });
const connectInput = { method: "token", token: "napi_test_key_1234567890" } as const;

runResourceContract({
  cassette,
  create,
  connectInput,
  invalidConnectInput: { method: "token", token: "napi_wrong_0000000000" },
  appName: "lotse-reference",
  resourceName: "db",
});

describe("neon specifics", () => {
  const POOLED = "postgresql://app_owner:npg_Jq7RhT2kVxAw@ep-cool-darkness-123456-pooler.eu-central-1.aws.neon.tech/app?sslmode=require";
  const DIRECT = "postgresql://app_owner:npg_Jq7RhT2kVxAw@ep-cool-darkness-123456.eu-central-1.aws.neon.tech/app?sslmode=require";
  let connection: Connection;
  const app = (): AppRef => ({ adapter: "neon", name: "lotse-reference", connection });
  const ref: ResourceRef = { type: "postgres", name: "db", id: "shiny-wind-028834", provider: "neon", env: [] };

  beforeAll(async () => {
    connection = await create(scenarioOf(cassette, "connect")).connect(connectInput);
  });

  it("remembers the organization new databases are created in", () => {
    expect(connection.account.name).toBe("ada@example.test");
    expect(connection.settings).toEqual({ orgId: "org-cool-darkness-12345678", orgName: "Ada Lovelace" });
  });

  it("waits for Neon's operations and hands out the pooled and the direct connection", async () => {
    const scenario = scenarioOf(cassette, "provision");
    const created = await create(scenario).provision(app(), { type: "postgres", name: "db" });
    expect(created.id).toBe("shiny-wind-028834");
    expect(created.env).toEqual([
      { name: "DATABASE_URL", value: POOLED, secret: true },
      { name: "DATABASE_URL_UNPOOLED", value: DIRECT, secret: true },
    ]);
    expect(created.meta).toEqual({ project: "lotse-reference-db", region: "aws-eu-central-1", postgres: "17" });
    // The first operation was still running when it was first asked for.
    expect(scenario.transport.requests.filter((r) => r.url.includes("/operations/22acbb37")).length).toBe(2);
  });

  it("passes the region and the Postgres version on", async () => {
    const scenario = scenarioOf(cassette, "provision");
    await create(scenario).provision(app(), { type: "postgres", name: "db", options: { region: "aws-eu-central-1", version: "17" } });
    const body = scenario.transport.requests.find((r) => r.method === "POST")?.body as { project: Record<string, unknown> };
    expect(body.project).toMatchObject({ region_id: "aws-eu-central-1", pg_version: 17 });
    await expect(
      create(scenarioOf(cassette, "provision")).provision(app(), { type: "postgres", name: "db", options: { version: "latest" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("uses an existing project of that exact name instead of creating a second one", async () => {
    const scenario = scenarioOf(cassette, "provision-existing");
    const existing = await create(scenario).provision(app(), { type: "postgres", name: "db" });
    expect(existing.id).toBe("shiny-wind-028834");
    expect(existing.env.map((e) => e.value)).toEqual([POOLED, DIRECT]);
    expect(scenario.transport.mutations()).toEqual([]);
  });

  it("reports failed operations and exhausted plans", async () => {
    await expect(create(scenarioOf(cassette, "provision-failed")).provision(app(), { type: "postgres", name: "db" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("could not create the timeline"),
    });
    await expect(create(scenarioOf(cassette, "provision-limit")).provision(app(), { type: "postgres", name: "db" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("projects limit exceeded"),
    });
  });

  it("only provides Postgres", async () => {
    await expect(create(scenarioOf(cassette, "provision")).provision(app(), { type: "redis", name: "cache" })).rejects.toMatchObject({
      code: "RESOURCE_UNSUPPORTED",
    });
  });

  it("tells a starting database from a suspended and a removed one", async () => {
    expect(await create(scenarioOf(cassette, "status-creating")).status(app(), ref)).toEqual({ state: "creating" });
    expect(await create(scenarioOf(cassette, "status")).status(app(), ref)).toMatchObject({ state: "ready", message: expect.stringContaining("Suspended") });
    expect(await create(scenarioOf(cassette, "status-gone")).status(app(), ref)).toEqual({ state: "not-found" });
    await create(scenarioOf(cassette, "destroy-gone")).destroy(app(), ref);
  });

  it("names the organization when the account has several", async () => {
    const first = await create(scenarioOf(cassette, "connect-two-orgs")).connect(connectInput);
    expect(first.settings).toMatchObject({ orgId: "org-cool-darkness-12345678", orgChoice: "first" });
    const verified = await create(scenarioOf(cassette, "verify")).verify(first);
    expect(verified.warnings[0]).toContain("Ada Lovelace");
    const chosen = await create(scenarioOf(cassette, "connect-two-orgs")).connect({ ...connectInput, options: { orgId: "org-quiet-river-87654321" } });
    expect(chosen.settings).toEqual({ orgId: "org-quiet-river-87654321", orgName: "Analytical Engines Ltd" });
  });

  it("accepts organization API keys, which belong to no user", async () => {
    const scenario = scenarioOf(cassette, "connect-org-key");
    const conn = await create(scenario).connect(connectInput);
    expect(conn.account.name).toBe("Neon organization");
    expect(scenario.transport.unused()).toEqual([]);
  });
});
