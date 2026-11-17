import { loadCassette, runGitContract, runHostingContract, scenarioOf } from "@lotse/adapter-testkit";
import type { HostingAdapter } from "@lotse/core";
import sodium from "libsodium-wrappers";
import { completeGithubAppRegistration, createGithubProvider, githubAppManifest, githubAppRegistrationUrl, sealSecret } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));
const pages = await loadCassette(new URL("./pages.cassette.json", import.meta.url));

runGitContract({
  cassette,
  create: (scenario) => createGithubProvider({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "github_pat_contract_token_000000000000" },
  invalidConnectInput: { method: "token", token: "github_pat_wrong_000000000000000000000" },
  repo: {
    provider: "github",
    owner: "ada",
    name: "customer-portal",
    id: "1001",
    defaultBranch: "main",
    private: true,
    url: "https://github.com/ada/customer-portal",
    cloneUrl: "https://github.com/ada/customer-portal.git",
  },
  newRepoName: "new-app",
});

const published: { branch: string; message: string; extraFiles?: Record<string, string> }[] = [];
runHostingContract({
  cassette: pages,
  create: (scenario) =>
    createGithubProvider({
      fetch: scenario.fetch,
      publish: async (input) => {
        published.push({ branch: input.branch, message: input.message, extraFiles: input.extraFiles });
        return "9fceb02d0ae598e95dc970b74767f19372d61af8";
      },
    }).pages as HostingAdapter,
  connectInput: { method: "token", token: "github_pat_contract_token_000000000000" },
  invalidConnectInput: { method: "token", token: "github_pat_wrong_000000000000000000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "ada/lotse-reference", appMeta: { repo: "ada/lotse-reference" }, previousDeployment: { id: "abc" } },
});

describe("github specifics", () => {
  it("publishes Pages from the gh-pages branch without Jekyll", () => {
    expect(published[0]).toEqual({ branch: "gh-pages", message: "Deploy lotse-reference", extraFiles: { ".nojekyll": "" } });
  });

  it("encrypts CI secrets so that only GitHub can read them", async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const sealed = await sealSecret(Buffer.from(pair.publicKey).toString("base64"), "deploy-key-content");
    expect(sealed).not.toContain("deploy-key-content");
    const opened = sodium.crypto_box_seal_open(Buffer.from(sealed, "base64"), pair.publicKey, pair.privateKey);
    expect(Buffer.from(opened).toString("utf8")).toBe("deploy-key-content");

    const scenario = scenarioOf(cassette, "set-ci-secret");
    const provider = createGithubProvider({ fetch: scenario.fetch });
    const connection = {
      adapter: "github",
      method: "token" as const,
      account: { id: "42", name: "ada" },
      credentials: { token: "t0ken-value-000" },
      settings: {},
    };
    await provider.setCiSecret?.(
      { provider: "github", owner: "ada", name: "customer-portal", defaultBranch: "main", private: true, url: "", cloneUrl: "", connection },
      "LOTSE_SSH_KEY",
      "deploy-key-content",
    );
    const put = scenario.transport.requests.at(-1)?.body as { encrypted_value: string };
    expect(put.encrypted_value).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.stringify(scenario.transport.requests)).not.toContain("deploy-key-content");
  });

  it("writes a workflow that calls the CLI with secrets from the platform", async () => {
    const scenario = scenarioOf(cassette, "write-workflow");
    const provider = createGithubProvider({ fetch: scenario.fetch });
    const connection = {
      adapter: "github",
      method: "token" as const,
      account: { id: "42", name: "ada" },
      credentials: { token: "t0ken-value-000" },
      settings: {},
    };
    await provider.writeWorkflow?.(
      { provider: "github", owner: "ada", name: "customer-portal", defaultBranch: "main", private: true, url: "", cloneUrl: "", connection },
      { adapter: "ssh", branch: "main", secrets: ["LOTSE_MASTER_KEY", "LOTSE_CONNECTION_SSH"], cliVersion: "0.1.0", previews: true },
    );
    const body = scenario.transport.requests.at(-1)?.body as { content: string };
    const workflow = Buffer.from(body.content, "base64").toString("utf8");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("npx --yes @lotse/cli@0.1.0 deploy --target ssh --yes");
    expect(workflow).toContain("LOTSE_CONNECTION_SSH: ${{ secrets.LOTSE_CONNECTION_SSH }}");
    expect(workflow).toContain("--preview pr-${{ github.event.pull_request.number }}");
  });

  it("talks to GitHub Enterprise Server when a base URL is given", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({ id: 1, login: "ada" });
    }) as typeof fetch;
    const provider = createGithubProvider({ fetch: fetchImpl });
    const conn = await provider.connect({ method: "token", token: "ghes-token-0000", options: { baseUrl: "https://github.example.com/" } });
    expect(seen).toEqual(["https://github.example.com/api/v3/user"]);
    expect(conn.settings.baseUrl).toBe("https://github.example.com");
  });

  it("registers a GitHub App through the manifest flow", async () => {
    const manifest = githubAppManifest("https://lotse.example.com/");
    expect(manifest).toMatchObject({
      hook_attributes: { url: "https://lotse.example.com/api/v1/git/github/webhook" },
      redirect_url: "https://lotse.example.com/api/v1/git/github/app/callback",
      default_permissions: { contents: "write", metadata: "read" },
      public: false,
    });
    expect(githubAppRegistrationUrl("st4te")).toBe("https://github.com/settings/apps/new?state=st4te");
    expect(githubAppRegistrationUrl("s", { organization: "acme" })).toBe("https://github.com/organizations/acme/settings/apps/new?state=s");
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.github.com/app-manifests/temp-code/conversions");
      expect(init?.method).toBe("POST");
      return Response.json(
        {
          id: 7,
          slug: "lotse-acme",
          client_id: "Iv1.abc",
          client_secret: "shh",
          pem: "-----BEGIN RSA PRIVATE KEY-----",
          webhook_secret: "whsec",
          html_url: "https://github.com/apps/lotse-acme",
        },
        { status: 201 },
      );
    }) as typeof fetch;
    expect(await completeGithubAppRegistration("temp-code", { fetch: fetchImpl })).toMatchObject({
      id: 7,
      slug: "lotse-acme",
      clientId: "Iv1.abc",
      clientSecret: "shh",
      webhookSecret: "whsec",
    });
  });
});
