import { loadCassette, runHostingContract } from "@lotse/adapter-testkit";
import { createNetlifyAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => createNetlifyAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } }),
  connectInput: { method: "token", token: "netlify-test-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "site_1", previousDeployment: { id: "dep_0" } },
});
