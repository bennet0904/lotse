/**
 * Pages hosting through a Git platform (specification section 11.1). GitHub
 * Pages, GitLab Pages and Codeberg Pages all publish a branch of static files,
 * so the hosting adapter is shared and the platforms only supply the details.
 */
import { LotseError } from "./errors.js";
import { event } from "./events.js";
import { publishDirectory } from "./git.js";
import type { Manifest } from "./manifest.js";
import type {
  AppRef,
  AppStatus,
  BuildArtifact,
  Connection,
  DeployContext,
  DeployEvent,
  DeploymentPlan,
  DeploymentRef,
  DomainStatus,
  GitProvider,
  HostingAdapter,
  LogLine,
  RepoRef,
  VerifyResult,
} from "./types.js";

export interface PagesPlatform {
  id: string;
  displayName: string;
  /** The Git provider that owns the repositories. */
  provider: () => GitProvider;
  /** Branch that holds the published files. */
  branch: string;
  /** Files added next to the site, e.g. `.nojekyll` or a pipeline definition. */
  extraFiles?: Record<string, string>;
  /** Finds the repository of an app, or returns undefined when it does not exist yet. */
  findRepo(conn: Connection, owner: string | undefined, name: string): Promise<RepoRef | undefined>;
  /** Turns Pages on for the repository, if the platform needs that. */
  enable?(repo: RepoRef, conn: Connection): Promise<void>;
  /** Public address of the published site. */
  url(repo: RepoRef, conn: Connection): Promise<string>;
  state?(repo: RepoRef, conn: Connection): Promise<AppStatus["state"]>;
  addDomain?(repo: RepoRef, conn: Connection, domain: string): Promise<DomainStatus>;
  disable?(repo: RepoRef, conn: Connection): Promise<void>;
  verify?(conn: Connection): Promise<VerifyResult>;
  /** Injected for tests; defaults to pushing with the `git` binary. */
  publish?: typeof publishDirectory;
}

/** `owner/name` from a clone URL such as https://github.com/acme/site.git */
export function repoPathFromUrl(url: string): { owner: string; name: string } | undefined {
  const m = new URL(url).pathname.replace(/\.git$/, "").match(/^\/(.+)\/([^/]+)$/);
  return m ? { owner: m[1] as string, name: m[2] as string } : undefined;
}

export function createPagesAdapter(platform: PagesPlatform): HostingAdapter {
  const provider = platform.provider();
  const publish = platform.publish ?? publishDirectory;

  async function repoOf(app: AppRef, repository?: { url: string }): Promise<RepoRef | undefined> {
    const fromUrl = repository ? repoPathFromUrl(repository.url) : undefined;
    const [owner, name] = app.meta?.repo ? (app.meta.repo.split(/\/(?=[^/]+$)/) as [string, string]) : [fromUrl?.owner, fromUrl?.name ?? app.name];
    return platform.findRepo(app.connection, owner, name);
  }

  async function requireRepo(app: AppRef): Promise<RepoRef> {
    const repo = await repoOf(app);
    if (!repo) throw new LotseError("NOT_FOUND", `There is no repository for "${app.name}" at ${platform.displayName}.`);
    return repo;
  }

  const adapter: HostingAdapter = {
    id: platform.id,
    displayName: platform.displayName,
    auth: provider.auth,
    oauth: provider.oauth,
    tokenSetup: provider.tokenSetup,
    capabilities: {
      runtimes: ["static"],
      languages: [],
      resources: [],
      customDomains: Boolean(platform.addDomain),
      previewDeployments: false,
      rollback: "none",
    },

    connect: (input) => provider.connect(input).then((conn) => ({ ...conn, adapter: platform.id })),

    async verify(conn: Connection): Promise<VerifyResult> {
      if (platform.verify) return platform.verify(conn);
      await provider.listRepos(conn);
      return { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      if (manifest.runtime.kind !== "static") throw new LotseError("RUNTIME_UNSUPPORTED", `${platform.displayName} only hosts static sites.`);
      const repo = await platform.findRepo(conn, undefined, manifest.name);
      return {
        adapter: platform.id,
        app: {
          adapter: platform.id,
          name: manifest.name,
          id: repo ? `${repo.owner}/${repo.name}` : undefined,
          connection: conn,
          meta: repo ? { repo: `${repo.owner}/${repo.name}` } : undefined,
        },
        manifest,
        artifact: "static",
        firstDeployment: !repo,
        steps: [
          { id: "app", title: repo ? `Use repository ${repo.owner}/${repo.name}` : `Create repository ${manifest.name}`, action: repo ? "noop" : "create" },
          { id: "deploy", title: `Publish the site to the ${platform.branch} branch`, action: "update" },
        ],
        resources: [],
        warnings: [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "static") throw new LotseError("DEPLOY_FAILED", `${platform.displayName} only hosts static sites.`);
      if (ctx.signal?.aborted) throw new LotseError("ABORTED", "The deployment was aborted.");
      const conn = ctx.connection;
      let repo = await repoOf(plan.app, ctx.repository);
      if (!repo) {
        yield event.log("deploy", `Creating repository ${plan.manifest.name}`);
        // Initialized, so that the site's branch does not become the repository's default branch.
        repo = await provider.createRepo(conn, {
          name: plan.manifest.name,
          private: false,
          description: `${plan.manifest.name}, published with Lotse`,
          initialize: true,
        });
      }
      yield event.log("deploy", `Publishing to ${repo.owner}/${repo.name} (${platform.branch})`);
      const auth = await provider.remoteUrl(repo, conn);
      const commit = await publish({
        dir: artifact.dir,
        auth,
        branch: platform.branch,
        message: `Deploy ${plan.manifest.name}`,
        extraFiles: platform.extraFiles,
      });
      await platform.enable?.(repo, conn);
      const path = `${repo.owner}/${repo.name}`;
      const ref: DeploymentRef = {
        id: commit,
        app: { ...plan.app, id: path, meta: { repo: path } },
        url: await platform.url(repo, conn),
        createdAt: Date.now(),
        version: commit,
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(): Promise<void> {
      throw new LotseError("ROLLBACK_UNSUPPORTED", `${platform.displayName} cannot roll back; publish the earlier version again instead.`);
    },

    async destroy(app: AppRef): Promise<void> {
      const repo = await repoOf(app);
      // The repository belongs to the user and is kept; only the published site is taken offline.
      if (repo) await platform.disable?.(repo, app.connection);
    },

    async setEnv(): Promise<void> {
      // Static hosting has no runtime environment.
    },

    addDomain: platform.addDomain
      ? async (app, domain) => (platform.addDomain as NonNullable<PagesPlatform["addDomain"]>)(await requireRepo(app), app.connection, domain)
      : undefined,

    async *logs(): AsyncIterable<LogLine> {
      yield { at: Date.now(), stream: "system", line: `${platform.displayName} serves static files and has no application logs.` };
    },

    async status(app: AppRef): Promise<AppStatus> {
      const repo = await repoOf(app);
      if (!repo) return { state: "not-found", domains: [] };
      const state = platform.state ? await platform.state(repo, app.connection) : "running";
      if (state === "not-found") return { state, domains: [] };
      const url = await platform.url(repo, app.connection);
      return { state, url, domains: [new URL(url).host] };
    },
  };
  if (!platform.addDomain) delete adapter.addDomain;
  return adapter;
}
