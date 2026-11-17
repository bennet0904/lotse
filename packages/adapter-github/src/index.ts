/**
 * GitHub as a Git platform: code storage, CI secrets and workflows, comments
 * on pull requests and GitHub Pages (specification section 11).
 *
 * Sign-in uses a GitHub App (user access tokens via OAuth with PKCE) or a
 * fine-grained personal access token. GitHub Enterprise Server works through
 * the `baseUrl` option.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AuthenticatedUrl,
  accessToken,
  actionsWorkflow,
  type ConnectInput,
  type Connection,
  createPagesAdapter,
  type DomainStatus,
  type GitProvider,
  type HostingTarget,
  HttpClient,
  isLotseError,
  LotseError,
  type OAuthClient,
  oauthCredentials,
  type publishDirectory,
  type RepoRef,
  type RepoSpec,
  WORKFLOW_NAME,
} from "@lotse/core";
import sodium from "libsodium-wrappers";

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  owner: { login: string };
}

const GITHUB = "https://github.com";

function apiBase(baseUrl: string): string {
  return baseUrl === GITHUB ? "https://api.github.com" : `${baseUrl}/api/v3`;
}

function toRepo(r: GhRepo, conn: Connection): RepoRef {
  return {
    provider: "github",
    owner: r.owner.login,
    name: r.name,
    id: String(r.id),
    defaultBranch: r.default_branch ?? "main",
    private: r.private,
    url: r.html_url,
    cloneUrl: r.clone_url,
    connection: conn,
  };
}

function connectionOf(repo: RepoRef): Connection {
  if (!repo.connection) throw new LotseError("AUTH_FAILED", `The repository ${repo.owner}/${repo.name} is not bound to a GitHub connection.`);
  return repo.connection;
}

/** Encrypts a secret for the Actions secrets API (libsodium sealed box). */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(Buffer.from(value, "utf8"), Buffer.from(publicKeyBase64, "base64"));
  return Buffer.from(sealed).toString("base64");
}

export interface GithubAdapterOptions extends AdapterOptions {
  publish?: typeof publishDirectory;
}

export function createGithubProvider(options: GithubAdapterOptions = {}): GitProvider {
  const defaultBase = ((options.settings?.baseUrl as string | undefined) ?? options.env?.LOTSE_GITHUB_URL ?? GITHUB).replace(/\/+$/, "");

  const client = (conn: Connection) =>
    new HttpClient({
      provider: "GitHub",
      baseUrl: apiBase(conn.settings.baseUrl ?? defaultBase),
      headers: {
        authorization: `Bearer ${accessToken(conn)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lotse",
      },
      fetch: options.fetch,
      retryDelayMs: 300,
    });

  async function findRepo(conn: Connection, owner: string | undefined, name: string): Promise<RepoRef | undefined> {
    try {
      return toRepo(await client(conn).get<GhRepo>(`/repos/${owner ?? conn.account.name}/${name}`), conn);
    } catch (err) {
      if (isLotseError(err) && err.code === "NOT_FOUND") return undefined;
      throw err;
    }
  }

  const provider: GitProvider = {
    id: "github",
    displayName: "GitHub",
    auth: ["oauth", "token"],
    oauth: {
      authorizationEndpoint: `${defaultBase}/login/oauth/authorize`,
      tokenEndpoint: `${defaultBase}/login/oauth/access_token`,
      // Permissions of a GitHub App are part of the app, not of the request.
      scopes: [],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_GITHUB",
    },
    tokenSetup: {
      url: `${defaultBase}/settings/personal-access-tokens/new`,
      permissions: [
        "Repository access: only the repositories Lotse should use",
        "Contents: read and write",
        "Metadata: read",
        "Workflows, Secrets, Pull requests, Pages: read and write (only for CI, previews and Pages)",
        "Administration: read and write (only to let Lotse create repositories)",
      ],
      steps: [
        "Create a fine-grained personal access token.",
        "Limit it to the repositories Lotse should use and grant the permissions listed here.",
        "Copy the token and paste it here.",
      ],
      fields: [{ name: "baseUrl", label: "GitHub Enterprise Server address", required: false, placeholder: "https://github.example.com" }],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      if (input.method === "ssh") throw new LotseError("INVALID_INPUT", "GitHub is connected with a GitHub App or an access token.");
      const conn: Connection = {
        adapter: "github",
        method: input.method,
        account: { id: "", name: "" },
        credentials: input.method === "token" ? { token: input.token } : oauthCredentials(input.tokens, input.client),
        settings: { baseUrl: (input.options?.baseUrl ?? defaultBase).replace(/\/+$/, "") },
        expiresAt: input.method === "oauth" ? input.tokens.expiresAt : undefined,
      };
      const user = await client(conn).get<{ id: number; login: string }>("/user");
      conn.account = { id: String(user.id), name: user.login };
      return conn;
    },

    async listRepos(conn: Connection, query?: string): Promise<RepoRef[]> {
      const repos = await client(conn).get<GhRepo[]>("/user/repos", {
        query: { per_page: 100, sort: "pushed", affiliation: "owner,collaborator,organization_member" },
      });
      const q = query?.toLowerCase();
      return repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)).map((r) => toRepo(r, conn));
    },

    async createRepo(conn: Connection, spec: RepoSpec): Promise<RepoRef> {
      const body = { name: spec.name, private: spec.private, description: spec.description, auto_init: Boolean(spec.initialize) };
      const path = spec.owner && spec.owner !== conn.account.name ? `/orgs/${spec.owner}/repos` : "/user/repos";
      return toRepo(await client(conn).post<GhRepo>(path, body), conn);
    },

    async remoteUrl(repo: RepoRef, conn: Connection): Promise<AuthenticatedUrl> {
      return { url: repo.cloneUrl, username: "x-access-token", password: accessToken(conn), expiresAt: conn.expiresAt };
    },

    async setCiSecret(repo: RepoRef, name: string, value: string): Promise<void> {
      const http = client(connectionOf(repo));
      const base = `/repos/${repo.owner}/${repo.name}/actions/secrets`;
      const key = await http.get<{ key_id: string; key: string }>(`${base}/public-key`);
      await http.put(`${base}/${encodeURIComponent(name)}`, { encrypted_value: await sealSecret(key.key, value), key_id: key.key_id });
    },

    async writeWorkflow(repo: RepoRef, target: HostingTarget): Promise<void> {
      const http = client(connectionOf(repo));
      const path = `/repos/${repo.owner}/${repo.name}/contents/.github/workflows/${WORKFLOW_NAME}`;
      const branch = repo.defaultBranch;
      let sha: string | undefined;
      try {
        sha = (await http.get<{ sha: string }>(path, { query: { ref: branch } })).sha;
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
      await http.put(path, {
        message: sha ? "Update Lotse deploy workflow" : "Add Lotse deploy workflow",
        content: Buffer.from(actionsWorkflow(target, "github"), "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      });
    },

    async comment(repo: RepoRef, request: number, body: string): Promise<void> {
      await client(connectionOf(repo)).post(`/repos/${repo.owner}/${repo.name}/issues/${request}/comments`, { body });
    },
  };

  provider.pages = createPagesAdapter({
    id: "github-pages",
    displayName: "GitHub Pages",
    provider: () => provider,
    branch: "gh-pages",
    extraFiles: { ".nojekyll": "" },
    publish: options.publish,
    findRepo,
    async enable(repo, conn) {
      try {
        await client(conn).post(`/repos/${repo.owner}/${repo.name}/pages`, { source: { branch: "gh-pages", path: "/" } });
      } catch (err) {
        // 409: Pages is already enabled for this repository.
        if (!(isLotseError(err) && err.code === "CONFLICT")) throw err;
      }
    },
    async url(repo, conn) {
      const pages = await client(conn).get<{ html_url: string }>(`/repos/${repo.owner}/${repo.name}/pages`);
      return pages.html_url.replace(/\/$/, "");
    },
    async state(repo, conn) {
      try {
        const pages = await client(conn).get<{ status: string | null }>(`/repos/${repo.owner}/${repo.name}/pages`);
        return pages.status === "errored" ? "failed" : pages.status === "built" ? "running" : "deploying";
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return "not-found";
        throw err;
      }
    },
    async addDomain(repo, conn, domain): Promise<DomainStatus> {
      await client(conn).put(`/repos/${repo.owner}/${repo.name}/pages`, { cname: domain });
      const apex = domain.split(".").length === 2;
      return {
        domain,
        state: "pending",
        dnsRecords: apex
          ? ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"].map((value) => ({ type: "A" as const, name: domain, value }))
          : [{ type: "CNAME", name: domain, value: `${repo.owner.toLowerCase()}.github.io` }],
        message: "GitHub issues the certificate once the DNS records are in place.",
      };
    },
    async disable(repo, conn) {
      try {
        await client(conn).delete(`/repos/${repo.owner}/${repo.name}/pages`);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },
  });
  return provider;
}

// ---------------------------------------------------------------------------
// GitHub App manifest flow (specification section 11.3)
// ---------------------------------------------------------------------------

export interface GithubAppRegistration {
  id: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string;
  htmlUrl: string;
}

/**
 * The manifest a self-hosted instance submits to GitHub. Permissions and the
 * webhook URL are fixed here, so the operator only picks a name.
 */
export function githubAppManifest(instanceUrl: string, name = "Lotse"): Record<string, unknown> {
  const base = instanceUrl.replace(/\/+$/, "");
  return {
    name,
    url: base,
    hook_attributes: { url: `${base}/api/v1/git/github/webhook`, active: true },
    redirect_url: `${base}/api/v1/git/github/app/callback`,
    callback_urls: [`${base}/api/v1/oauth/callback`],
    // After installing the app, users sign in to GitHub from the accounts page.
    setup_url: `${base}/accounts`,
    public: false,
    request_oauth_on_install: false,
    // Contents and metadata always; workflows and secrets for push-to-deploy, pull requests for preview comments,
    // Pages for Pages hosting, administration to create repositories.
    default_permissions: {
      contents: "write",
      metadata: "read",
      workflows: "write",
      secrets: "write",
      pull_requests: "write",
      pages: "write",
      administration: "write",
    },
    default_events: ["push", "pull_request"],
  };
}

/** Where the operator is sent to create the app. The manifest is posted as a form field named `manifest`. */
export function githubAppRegistrationUrl(state: string, options: { baseUrl?: string; organization?: string } = {}): string {
  const base = (options.baseUrl ?? GITHUB).replace(/\/+$/, "");
  const path = options.organization ? `/organizations/${options.organization}/settings/apps/new` : "/settings/apps/new";
  return `${base}${path}?state=${encodeURIComponent(state)}`;
}

/** Exchanges the temporary code GitHub hands back for the app's credentials. */
export async function completeGithubAppRegistration(code: string, options: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<GithubAppRegistration> {
  const http = new HttpClient({
    provider: "GitHub",
    baseUrl: apiBase((options.baseUrl ?? GITHUB).replace(/\/+$/, "")),
    headers: { accept: "application/vnd.github+json", "user-agent": "lotse" },
    fetch: options.fetch,
  });
  const app = await http.post<{ id: number; slug: string; client_id: string; client_secret: string; pem: string; webhook_secret: string; html_url: string }>(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
  );
  return {
    id: app.id,
    slug: app.slug,
    clientId: app.client_id,
    clientSecret: app.client_secret,
    privateKey: app.pem,
    webhookSecret: app.webhook_secret,
    htmlUrl: app.html_url,
  };
}

export function githubOAuthClient(registration: GithubAppRegistration): OAuthClient {
  return { clientId: registration.clientId, clientSecret: registration.clientSecret };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, git: createGithubProvider };
export default pkg;
