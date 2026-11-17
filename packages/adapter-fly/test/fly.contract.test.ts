import { loadCassette, runHostingContract, scenarioOf } from "@lotseai/adapter-testkit";
import { parseManifest } from "@lotseai/core";
import { createFlyAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const manifest = "version: 1\nname: lotse-reference\nruntime:\n  kind: server\n  language: node\n  port: 3000\n  healthcheck: /health\n";

runHostingContract({
  cassette,
  create: (scenario) => createFlyAdapter({ fetch: scenario.fetch, images: scenario.images, settings: { waitSeconds: 1 } }),
  connectInput: { method: "token", token: "FlyV1 fm2_contract_token_0000000000" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest,
  fixtures: { appId: "lotse-reference", previousDeployment: { id: "mach_old", version: "registry.fly.io/lotse-reference:v0" } },
});

describe("fly specifics", () => {
  it("pushes to Fly's registry with the token and keeps the old machine when the new one fails", async () => {
    const scenario = scenarioOf(cassette, "deploy-failed");
    const adapter = createFlyAdapter({ fetch: scenario.fetch, images: scenario.images, settings: { waitSeconds: 1 } });
    const connection = {
      adapter: "fly",
      method: "token" as const,
      account: { id: "personal", name: "Fly.io" },
      credentials: { token: "FlyV1 fm2_contract_token_0000000000" },
      settings: { org: "personal" },
    };
    const plan = await adapter.plan(parseManifest(manifest), connection);
    const run = adapter.deploy(
      plan,
      { kind: "image", image: "lotse/lotse-reference:contract", platform: "linux/amd64", runtime: "docker", port: 3000 },
      { connection, workdir: "/", env: [], resources: [] },
    );
    await expect(
      (async () => {
        for await (const _ of run) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: "DEPLOY_FAILED", message: expect.stringContaining("The running version was not changed") });
    expect(scenario.images.pushed[0]).toMatchObject({
      target: "registry.fly.io/lotse-reference:contract",
      auth: { registry: "registry.fly.io", username: "x" },
    });
    const deletes = scenario.transport.requests.filter((r) => r.method === "DELETE").map((r) => new URL(r.url).pathname);
    expect(deletes).toEqual(["/v1/apps/lotse-reference/machines/mach_1"]);
  });
});
