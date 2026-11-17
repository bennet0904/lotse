import { loadCassette, runGitContract, runHostingContract, scenarioOf } from "@lotseai/adapter-testkit";
import type { HostingAdapter } from "@lotseai/core";
import { createGitlabProvider } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const pages = await loadCassette(new URL("./pages.cassette.json", import.meta.url));
const repo = {
  provider: "gitlab",
  owner: "ada",
  name: "customer-portal",
  id: "1001",
  defaultBranch: "main",
  private: true,
  url: "https://gitlab.com/ada/customer-portal",
  cloneUrl: "https://gitlab.com/ada/customer-portal.git",
};

runGitContract({
  cassette,
  create: (scenario) => createGitlabProvider({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "glpat-contract-token-0000" },
  invalidConnectInput: { method: "token", token: "glpat-wrong-000000000000" },
  repo,
  newRepoName: "new-app",
});

const published: { branch: string; extraFiles?: Record<string, string> }[] = [];
runHostingContract({
  cassette: pages,
  create: (scenario) =>
    createGitlabProvider({
      fetch: scenario.fetch,
      publish: async (input) => {
        published.push({ branch: input.branch, extraFiles: input.extraFiles });
        return "9fceb02d0ae598e95dc970b74767f19372d61af8";
      },
    }).pages as HostingAdapter,
  connectInput: { method: "token", token: "glpat-contract-token-0000" },
  invalidConnectInput: { method: "token", token: "glpat-wrong-000000000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "ada/lotse-reference", appMeta: { repo: "ada/lotse-reference" }, previousDeployment: { id: "abc" } },
});

describe("gitlab specifics", () => {
  it("publishes Pages through a pipeline job on the pages branch", () => {
    expect(published[0]?.branch).toBe("pages");
    expect(published[0]?.extraFiles?.[".gitlab-ci.yml"]).toContain("pages:");
    expect(published[0]?.extraFiles?.[".gitlab-ci.yml"]).toContain("public");
  });

  it("writes a pipeline that calls the CLI and masks secrets", async () => {
    const scenario = scenarioOf(cassette, "write-workflow");
    const connection = {
      adapter: "gitlab",
      method: "token" as const,
      account: { id: "42", name: "ada" },
      credentials: { token: "glpat-contract-token-0000" },
      settings: {},
    };
    await createGitlabProvider({ fetch: scenario.fetch }).writeWorkflow?.(
      { ...repo, connection },
      { adapter: "ssh", branch: "main", secrets: ["LOTSE_CONNECTION_SSH"], cliVersion: "0.1.0" },
    );
    const commit = scenario.transport.requests.at(-1)?.body as { actions: { content: string }[] };
    expect(commit.actions[0]?.content).toContain("npx --yes @lotseai/cli@0.1.0 deploy --target ssh --yes");
    expect(commit.actions[0]?.content).toContain('if: $CI_COMMIT_BRANCH == "main"');
  });

  it("works with self-managed instances", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({ id: 1, username: "ada" });
    }) as typeof fetch;
    const conn = await createGitlabProvider({ fetch: fetchImpl }).connect({
      method: "token",
      token: "glpat-selfmanaged-00000",
      options: { baseUrl: "https://git.example.com/" },
    });
    expect(seen).toEqual(["https://git.example.com/api/v4/user"]);
    expect(conn.settings.baseUrl).toBe("https://git.example.com");
  });
});
