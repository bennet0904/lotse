import { loadCassette, runGitContract, runHostingContract } from "@lotseai/adapter-testkit";
import type { HostingAdapter } from "@lotseai/core";
import { createForgejoProvider } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const pages = await loadCassette(new URL("./pages.cassette.json", import.meta.url));

runGitContract({
  cassette,
  create: (scenario) => createForgejoProvider({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "forgejo-contract-token-0000" },
  invalidConnectInput: { method: "token", token: "forgejo-wrong-0000000000" },
  repo: {
    provider: "forgejo",
    owner: "ada",
    name: "customer-portal",
    id: "2001",
    defaultBranch: "main",
    private: true,
    url: "https://codeberg.org/ada/customer-portal",
    cloneUrl: "https://codeberg.org/ada/customer-portal.git",
  },
  newRepoName: "new-app",
});

const published: string[] = [];
runHostingContract({
  cassette: pages,
  create: (scenario) =>
    createForgejoProvider({
      fetch: scenario.fetch,
      publish: async (input) => {
        published.push(input.branch);
        return "9fceb02d0ae598e95dc970b74767f19372d61af8";
      },
    }).pages as HostingAdapter,
  connectInput: { method: "token", token: "forgejo-contract-token-0000" },
  invalidConnectInput: { method: "token", token: "forgejo-wrong-0000000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "ada/lotse-reference", appMeta: { repo: "ada/lotse-reference" }, previousDeployment: { id: "abc" } },
});

describe("forgejo specifics", () => {
  it("publishes Codeberg Pages from the pages branch", () => {
    expect(published[0]).toBe("pages");
  });
});
