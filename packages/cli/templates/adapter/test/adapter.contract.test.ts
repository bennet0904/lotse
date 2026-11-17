import { loadCassette, runHostingContract } from "@lotse/adapter-testkit";
import { create__CLASS__Adapter } from "../src/index.js";

// The shared contract every Lotse adapter must pass, run against recorded API responses.
const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => create__CLASS__Adapter({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "example-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "site_1", previousDeployment: { id: "dep_0" } },
});
