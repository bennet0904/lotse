import { loadCassette, runHostingContract, scenarioOf } from "@lotse/adapter-testkit";
import { parseManifest } from "@lotse/core";
import { createCoolifyAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const manifest = "version: 1\nname: lotse-reference\nruntime:\n  kind: server\n  language: node\n  port: 3000\n  healthcheck: /health\n";

runHostingContract({
  cassette,
  create: (scenario) => createCoolifyAdapter({ fetch: scenario.fetch, images: scenario.images, settings: { pollIntervalMs: 1 }, resolve: async () => [] }),
  connectInput: {
    method: "token",
    token: "coolify-test-token-1234",
    options: { baseUrl: "https://coolify.example.test/", registry: "registry.example.test/acme" },
  },
  invalidConnectInput: { method: "token", token: "wrong-token-000000", options: { baseUrl: "https://coolify.example.test" } },
  manifest,
  fixtures: { appId: "app1", previousDeployment: { id: "dep0", version: "v0" } },
});

describe("coolify specifics", () => {
  const base = { adapter: "coolify", method: "token" as const, account: { id: "0", name: "Root Team" }, credentials: { token: "coolify-test-token-1234" } };

  it("pushes the image to the configured registry before deploying", async () => {
    const scenario = scenarioOf(cassette, "deploy");
    const adapter = createCoolifyAdapter({ fetch: scenario.fetch, images: scenario.images, settings: { pollIntervalMs: 1 } });
    const conn = { ...base, settings: { baseUrl: "https://coolify.example.test", serverUuid: "srv1", registry: "registry.example.test/acme" } };
    const plan = await adapter.plan(parseManifest(manifest), conn);
    for await (const _ of adapter.deploy(
      plan,
      { kind: "image", image: "lotse/lotse-reference:contract", platform: "linux/amd64", runtime: "docker", port: 3000 },
      {
        connection: conn,
        workdir: "/",
        env: [
          { name: "APP_NAME", value: "Reference", secret: false },
          { name: "API_KEY", value: "x", secret: true },
        ],
        resources: [],
      },
    )) {
      // drain
    }
    expect(scenario.images.pushed).toEqual([
      { image: "lotse/lotse-reference:contract", target: "registry.example.test/acme/lotse-reference:contract", auth: undefined },
    ]);
  });

  it("builds from Git when no registry is configured and says what is missing otherwise", async () => {
    const scenario = scenarioOf(cassette, "plan");
    const adapter = createCoolifyAdapter({ fetch: scenario.fetch });
    const conn = { ...base, settings: { baseUrl: "https://coolify.example.test", serverUuid: "srv1" } };
    const plan = await adapter.plan(parseManifest(manifest), conn);
    expect(plan.artifact).toBe("source");
    expect(plan.warnings[0]).toMatch(/only commits that were pushed/);
    const run = adapter.deploy(plan, { kind: "source", dir: "/", ignore: [] }, { connection: conn, workdir: "/", env: [], resources: [] });
    await expect(
      (async () => {
        for await (const _ of run) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: "DEPLOY_FAILED", message: expect.stringContaining("not linked to a Git repository") });
    expect(scenario.transport.mutations()).toEqual([]);
  });
});
