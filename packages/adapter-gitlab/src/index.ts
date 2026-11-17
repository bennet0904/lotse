/**
 * GitLab as a Git platform: code storage, CI/CD variables and pipelines,
 * comments on merge requests and GitLab Pages. Works with gitlab.com and any
 * self-managed instance through the `baseUrl` option.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AuthenticatedUrl,
  accessToken,
  apiConnection,
  type ConnectInput,
  type Connection,
  createPagesAdapter,
  type GitProvider,
  gitlabPagesPipeline,
  gitlabPipeline,
  type HostingTarget,
  HttpClient,
  isLotseError,
  LotseError,
  type publishDirectory,
  type RepoRef,
  type RepoSpec,
} from "@lotse/core";

interface GlProject {
  id: number;
  path: string;
  path_with_namespace: string;
  namespace: { full_path: string };
  default_branch?: string | null;
  visibility: string;
  web_url: string;
  http_url_to_repo: string;
}

const CI_FILE = ".gitlab-ci.yml";

export function createGitlabProvider(options: AdapterOptions & { publish?: typeof publishDirectory } = {}): GitProvider {
  const defaultBase = ((options.settings?.baseUrl as string | undefined) ?? options.env?.LOTSE_GITLAB_URL ?? "https://gitlab.com").replace(/\/+$/, "");
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "GitLab",
      baseUrl: `${conn.settings.baseUrl ?? defaultBase}/api/v4`,
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: 300,
    });
  const toRepo = (p: GlProject, conn: Connection): RepoRef => ({
    provider: "gitlab",
    owner: p.namespace.full_path,
    name: p.path,
    id: String(p.id),
    defaultBranch: p.default_branch ?? "main",
    private: p.visibility !== "public",
    url: p.web_url,
    cloneUrl: p.http_url_to_repo,
    connection: conn,
  });
  const connectionOf = (repo: RepoRef): Connection => {
    if (!repo.connection) throw new LotseError("AUTH_FAILED", `The repository ${repo.owner}/${repo.name} is not bound to a GitLab connection.`);
    return repo.connection;
  };
  const projectPath = (repo: RepoRef) => `/projects/${encodeURIComponent(repo.id ?? `${repo.owner}/${repo.name}`)}`;

  const provider: GitProvider = {
    id: "gitlab",
    displayName: "GitLab",
    auth: ["oauth", "token"],
    oauth: {
      authorizationEndpoint: `${defaultBase}/oauth/authorize`,
      tokenEndpoint: `${defaultBase}/oauth/token`,
      scopes: ["api"],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_GITLAB",
    },
    tokenSetup: {
      url: `${defaultBase}/-/user_settings/personal_access_tokens`,
      permissions: ["api (repositories, CI/CD variables, merge request comments, Pages)"],
      steps: ["Create a personal access token with the scope listed here and an expiration date.", "Copy the token and paste it here."],
      fields: [
        { name: "baseUrl", label: "GitLab address", required: false, placeholder: "https://gitlab.example.com", help: "Only for self-managed instances." },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("gitlab", input, { baseUrl: (input.options?.baseUrl ?? defaultBase).replace(/\/+$/, "") });
      const user = await client(conn).get<{ id: number; username: string }>("/user");
      conn.account = { id: String(user.id), name: user.username };
      return conn;
    },

    async listRepos(conn: Connection, query?: string): Promise<RepoRef[]> {
      const projects = await client(conn).get<GlProject[]>("/projects", {
        query: { membership: true, per_page: 100, order_by: "last_activity_at", ...(query ? { search: query } : {}) },
      });
      return projects.map((p) => toRepo(p, conn));
    },

    async createRepo(conn: Connection, spec: RepoSpec): Promise<RepoRef> {
      const http = client(conn);
      let namespaceId: number | undefined;
      if (spec.owner && spec.owner !== conn.account.name) {
        namespaceId = (await http.get<{ id: number }>(`/namespaces/${encodeURIComponent(spec.owner)}`)).id;
      }
      const project = await http.post<GlProject>("/projects", {
        name: spec.name,
        path: spec.name,
        visibility: spec.private ? "private" : "public",
        description: spec.description,
        initialize_with_readme: Boolean(spec.initialize),
        ...(namespaceId ? { namespace_id: namespaceId } : {}),
      });
      return toRepo(project, conn);
    },

    async remoteUrl(repo: RepoRef, conn: Connection): Promise<AuthenticatedUrl> {
      return { url: repo.cloneUrl, username: "oauth2", password: accessToken(conn), expiresAt: conn.expiresAt };
    },

    async setCiSecret(repo: RepoRef, name: string, value: string): Promise<void> {
      const http = client(connectionOf(repo));
      // GitLab masks only values of at least eight characters without line breaks.
      const body = { key: name, value, masked: value.length >= 8 && !/\s/.test(value), protected: false };
      try {
        await http.put(`${projectPath(repo)}/variables/${encodeURIComponent(name)}`, body);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
        await http.post(`${projectPath(repo)}/variables`, body);
      }
    },

    async writeWorkflow(repo: RepoRef, target: HostingTarget): Promise<void> {
      const http = client(connectionOf(repo));
      const branch = repo.defaultBranch;
      let exists = true;
      try {
        await http.get(`${projectPath(repo)}/repository/files/${encodeURIComponent(CI_FILE)}`, { query: { ref: branch } });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
        exists = false;
      }
      await http.post(`${projectPath(repo)}/repository/commits`, {
        branch,
        commit_message: exists ? "Update Lotse deploy pipeline" : "Add Lotse deploy pipeline",
        actions: [{ action: exists ? "update" : "create", file_path: CI_FILE, content: gitlabPipeline(target) }],
      });
    },

    async comment(repo: RepoRef, request: number, body: string): Promise<void> {
      await client(connectionOf(repo)).post(`${projectPath(repo)}/merge_requests/${request}/notes`, { body });
    },
  };

  provider.pages = createPagesAdapter({
    id: "gitlab-pages",
    displayName: "GitLab Pages",
    provider: () => provider,
    // GitLab publishes Pages from a pipeline job; the branch carries the site and that job.
    branch: "pages",
    extraFiles: { [CI_FILE]: gitlabPagesPipeline() },
    publish: options.publish,
    async findRepo(conn, owner, name) {
      try {
        return toRepo(await client(conn).get<GlProject>(`/projects/${encodeURIComponent(`${owner ?? conn.account.name}/${name}`)}`), conn);
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return undefined;
        throw err;
      }
    },
    async url(repo, conn) {
      try {
        return (await client(conn).get<{ url: string }>(`${projectPath(repo)}/pages`)).url.replace(/\/$/, "");
      } catch {
        // Before the first pipeline finished there is no Pages record yet; this is the default address.
        const host = new URL(conn.settings.baseUrl ?? defaultBase).host.replace(/^gitlab\./, "");
        const [root = repo.owner, ...rest] = repo.owner.split("/");
        return `https://${root}.${host === "com" ? "gitlab.io" : `pages.${host}`}/${[...rest, repo.name].join("/")}`;
      }
    },
    async disable(repo, conn) {
      try {
        await client(conn).delete(`${projectPath(repo)}/pages`);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },
  });
  return provider;
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, git: createGitlabProvider };
export default pkg;
