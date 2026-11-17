import { loadCassette, runHostingContract, scenarioOf } from "@lotse/adapter-testkit";
import { parseManifest } from "@lotse/core";
import { createRailwayAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const manifest = "version: 1\nname: lotse-reference\nruntime:\n  kind: server\n  language: node\n  port: 3000\n  healthcheck: /health\n";

runHostingContract({
  cassette,
  create: (scenario) => createRailwayAdapter({ fetch: scenario.fetch, images: scenario.images, settings: { pollIntervalMs: 1 } }),
  connectInput: { method: "token", token: "railway-test-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest,
  fixtures: { appId: "prj_1", appMeta: { environmentId: "env_1", serviceId: "svc_1" }, previousDeployment: { id: "dep_0" }, domain: "app.example.com" },
});

describe("railway specifics", () => {
  it("registers itself as an OAuth client where the provider supports it", () => {
    const adapter = createRailwayAdapter();
    expect(adapter.oauth?.registrationEndpoint).toMatch(/^https:\/\/backboard\.railway\.com\//);
  });

  it("reports the DNS record a custom domain needs", async () => {
    const scenario = scenarioOf(cassette, "add-domain");
    const adapter = createRailwayAdapter({ fetch: scenario.fetch });
    const connection = {
      adapter: "railway",
      method: "token" as const,
      account: { id: "usr_1", name: "Ada" },
      credentials: { token: "railway-test-token-123456" },
      settings: {},
    };
    const status = await adapter.addDomain?.(
      { adapter: "railway", name: "lotse-reference", id: "prj_1", meta: { environmentId: "env_1", serviceId: "svc_1" }, connection },
      "app.example.com",
    );
    expect(status).toEqual({
      domain: "app.example.com",
      state: "pending",
      dnsRecords: [{ type: "CNAME", name: "app.example.com", value: "abc123.up.railway.app" }],
    });
  });

  it("deploys an image instead of the source when a registry is configured", async () => {
    const scenario = scenarioOf(cassette, "plan");
    const adapter = createRailwayAdapter({ fetch: scenario.fetch });
    const connection = {
      adapter: "railway",
      method: "token" as const,
      account: { id: "usr_1", name: "Ada" },
      credentials: { token: "railway-test-token-123456" },
      settings: { registry: "ghcr.io/acme" },
    };
    expect((await adapter.plan(parseManifest(manifest), connection)).artifact).toBe("image");
  });
});
