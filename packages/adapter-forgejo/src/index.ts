/**
 * Forgejo and Gitea as a Git platform, including Codeberg: code storage,
 * Actions secrets and workflows, comments on pull requests and Pages.
 * The instance is chosen with the `baseUrl` option; it defaults to Codeberg.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AuthenticatedUrl,
  accessToken,
  actionsWorkflow,
  apiConnection,
  type ConnectInput,
  type Connection,
  createPagesAdapter,
  type GitProvider,
  type HostingTarget,
  HttpClient,
  isLotseError,
  LotseError,
  type publishDirectory,
  type RepoRef,
  type RepoSpec,
  WORKFLOW_NAME,
} from "@lotse/core";

interface FjRepo {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch?: string;
  html_url: string;
  clone_url: string;
}

export function createForgejoProvider(options: AdapterOptions & { publish?: typeof publishDirectory } = {}): GitProvider {
  const defaultBase = ((options.settings?.baseUrl as string | undefined) ?? options.env?.LOTSE_FORGEJO_URL ?? "https://codeberg.org").replace(/\/+$/, "");
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Forgejo",
      baseUrl: `${conn.settings.baseUrl ?? defaultBase}/api/v1`,
      headers: { authorization: `token ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: 300,
    });
  const toRepo = (r: FjRepo, conn: Connection): RepoRef => ({
    provider: "forgejo",
    owner: r.owner.login,
    name: r.name,
    id: String(r.id),
    defaultBranch: r.default_branch || "main",
    private: r.private,
    url: r.html_url,
    cloneUrl: r.clone_url,
    connection: conn,
  });
  const connectionOf = (repo: RepoRef): Connection => {
    if (!repo.connection) throw new LotseError("AUTH_FAILED", `The repository ${repo.owner}/${repo.name} is not bound to a Forgejo connection.`);
    return repo.connection;
  };
  /** Codeberg serves Pages at codeberg.page; other instances name their Pages domain in the settings. */
  const pagesDomain = (conn: Connection) =>
    conn.settings.pagesDomain ?? (new URL(conn.settings.baseUrl ?? defaultBase).host === "codeberg.org" ? "codeberg.page" : undefined);

  const provider: GitProvider = {
    id: "forgejo",
    displayName: "Forgejo / Gitea (Codeberg)",
    auth: ["oauth", "token"],
    oauth: {
      authorizationEndpoint: `${defaultBase}/login/oauth/authorize`,
      tokenEndpoint: `${defaultBase}/login/oauth/access_token`,
      scopes: ["write:repository", "write:user", "write:issue"],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_FORGEJO",
    },
    tokenSetup: {
      url: `${defaultBase}/user/settings/applications`,
      permissions: [
        "repository: read and write",
        "user: read and write (to create repositories)",
        "issue: read and write (only for comments on pull requests)",
      ],
      steps: ["Generate a new access token with the permissions listed here.", "Copy the token and paste it here."],
      fields: [
        { name: "baseUrl", label: "Instance address", required: false, placeholder: "https://codeberg.org" },
        {
          name: "pagesDomain",
          label: "Pages domain",
          required: false,
          placeholder: "codeberg.page",
          help: "Only for instances with a Pages server other than Codeberg.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("forgejo", input, {
        baseUrl: (input.options?.baseUrl ?? defaultBase).replace(/\/+$/, ""),
        ...(input.options?.pagesDomain ? { pagesDomain: input.options.pagesDomain } : {}),
      });
      const user = await client(conn).get<{ id: number; login: string }>("/user");
      conn.account = { id: String(user.id), name: user.login };
      return conn;
    },

    async listRepos(conn: Connection, query?: string): Promise<RepoRef[]> {
      const repos = await client(conn).get<FjRepo[]>("/user/repos", { query: { limit: 50 } });
      const q = query?.toLowerCase();
      return repos.filter((r) => !q || `${r.owner.login}/${r.name}`.toLowerCase().includes(q)).map((r) => toRepo(r, conn));
    },

    async createRepo(conn: Connection, spec: RepoSpec): Promise<RepoRef> {
      const body = { name: spec.name, private: spec.private, description: spec.description ?? "", auto_init: Boolean(spec.initialize), default_branch: "main" };
      const path = spec.owner && spec.owner !== conn.account.name ? `/orgs/${encodeURIComponent(spec.owner)}/repos` : "/user/repos";
      return toRepo(await client(conn).post<FjRepo>(path, body), conn);
    },

    async remoteUrl(repo: RepoRef, conn: Connection): Promise<AuthenticatedUrl> {
      return { url: repo.cloneUrl, username: conn.account.name, password: accessToken(conn), expiresAt: conn.expiresAt };
    },

    async setCiSecret(repo: RepoRef, name: string, value: string): Promise<void> {
      await client(connectionOf(repo)).put(`/repos/${repo.owner}/${repo.name}/actions/secrets/${encodeURIComponent(name)}`, { data: value });
    },

    async writeWorkflow(repo: RepoRef, target: HostingTarget): Promise<void> {
      const http = client(connectionOf(repo));
      const path = `/repos/${repo.owner}/${repo.name}/contents/.forgejo/workflows/${WORKFLOW_NAME}`;
      const content = Buffer.from(actionsWorkflow(target, "forgejo"), "utf8").toString("base64");
      let sha: string | undefined;
      try {
        sha = (await http.get<{ sha: string }>(path, { query: { ref: repo.defaultBranch } })).sha;
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
      if (sha) await http.put(path, { content, sha, branch: repo.defaultBranch, message: "Update Lotse deploy workflow" });
      else await http.post(path, { content, branch: repo.defaultBranch, message: "Add Lotse deploy workflow" });
    },

    async comment(repo: RepoRef, request: number, body: string): Promise<void> {
      await client(connectionOf(repo)).post(`/repos/${repo.owner}/${repo.name}/issues/${request}/comments`, { body });
    },
  };

  provider.pages = createPagesAdapter({
    id: "codeberg-pages",
    displayName: "Codeberg Pages",
    provider: () => provider,
    // Codeberg Pages serves the `pages` branch of a repository.
    branch: "pages",
    publish: options.publish,
    async findRepo(conn, owner, name) {
      try {
        return toRepo(await client(conn).get<FjRepo>(`/repos/${owner ?? conn.account.name}/${name}`), conn);
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return undefined;
        throw err;
      }
    },
    async url(repo, conn) {
      const domain = pagesDomain(conn);
      if (!domain) throw new LotseError("UNSUPPORTED", "This Forgejo instance has no Pages domain configured. Set `pagesDomain` when connecting.");
      return `https://${repo.owner.toLowerCase()}.${domain}/${repo.name}`;
    },
    // The site is the `pages` branch: removing the branch takes it offline, the repository stays.
    async disable(repo, conn) {
      try {
        await client(conn).delete(`/repos/${repo.owner}/${repo.name}/branches/pages`);
      } catch (err) {
        if (isLotseError(err) && err.code === "PERMISSION_MISSING" && /default branch/i.test(err.message)) {
          throw new LotseError("CONFLICT", `The site's branch is the default branch of ${repo.owner}/${repo.name} and cannot be removed.`, {
            hints: ["Choose another default branch in the repository settings, or delete the repository to take the site offline."],
          });
        }
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },
  });
  return provider;
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, git: createForgejoProvider };
export default pkg;
