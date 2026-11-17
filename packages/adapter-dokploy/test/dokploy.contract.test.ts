import { loadCassette, runHostingContract } from "@lotse/adapter-testkit";
import { createDokployAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => createDokployAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } }),
  connectInput: { method: "token", token: "dokploy-test-key-123456", options: { baseUrl: "https://dokploy.example.test/" } },
  invalidConnectInput: { method: "token", token: "wrong-key-000000", options: { baseUrl: "https://dokploy.example.test" } },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: server\n  language: node\n  port: 3000\n  healthcheck: /health\n",
  fixtures: { appId: "app_1", previousDeployment: { id: "old" } },
});

describe("dokploy specifics", () => {
  it("needs the address of the instance", async () => {
    await expect(createDokployAdapter().connect({ method: "token", token: "x" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
