import { createHmac } from "node:crypto";
import { join } from "node:path";
import { BUILT_IN_ADAPTERS } from "@lotseai/adapters";
import { type ResolvedModel, resolveModel } from "@lotseai/agent";
import { AdapterRegistry, dynamicRegistrationSource, envClientSource, LotseError, loadAdapters, type OAuthClientSource, type SecretVault } from "@lotseai/core";
import { DEFAULT_ALLOWED_HOSTS, DockerClient, SandboxManager } from "@lotseai/sandbox";
import { ConnectionStore, SecretStore } from "@lotseai/secrets";
import { StackRegistry } from "@lotseai/stacks";
import { AuthService, type User } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { type Database, DbSecretBackend, eq, openDatabase } from "./db/index.js";
import { GithubAppService } from "./github-app.js";
import { JobQueue } from "./jobs.js";

/** Adapters that ship with the builder. More are loaded through the configuration. */
export { BUILT_IN_ADAPTERS };

export interface ProjectRow {
  id: string;
  ownerId: string;
  name: string;
  title: string;
  stack: string | null;
  status: string;
  prompt: string;
  plan: string | null;
  models: string | null;
  target: string | null;
  git: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceOverrides {
  /** Tests substitute scripted models. */
  resolveModel?: (spec: string | undefined) => Promise<ResolvedModel>;
  registry?: AdapterRegistry;
  sandboxes?: SandboxManager;
  fetch?: typeof fetch;
}

/** Everything the request handlers and job handlers share. */
export class Services {
  readonly auth: AuthService;
  readonly jobs: JobQueue;
  readonly vault: SecretStore;
  readonly connections: ConnectionStore;
  readonly resolveModel: (spec: string | undefined) => Promise<ResolvedModel>;
  readonly githubApp: GithubAppService;

  private constructor(
    readonly config: ServerConfig,
    readonly database: Database,
    readonly registry: AdapterRegistry,
    readonly stacks: StackRegistry,
    readonly sandboxes: SandboxManager,
    overrides: ServiceOverrides,
  ) {
    this.auth = new AuthService(database, config, overrides.fetch);
    this.jobs = new JobQueue(database, config.concurrency);
    this.vault = new SecretStore(new DbSecretBackend(database), config.masterKey);
    this.connections = new ConnectionStore(this.vault);
    this.resolveModel = overrides.resolveModel ?? ((spec) => resolveModel(spec, config.env));
    this.githubApp = new GithubAppService(this, overrides.fetch);
  }

  static async create(config: ServerConfig, overrides: ServiceOverrides = {}): Promise<Services> {
    const database = await openDatabase(config.databaseUrl, { sqliteDriver: config.sqliteDriver });
    // Fail early when the master key is missing or malformed, not at the first sign-in.
    await config.masterKey.getKey();
    const registry = overrides.registry ?? new AdapterRegistry();
    if (!overrides.registry) {
      const options = { env: config.env, fetch: overrides.fetch };
      for (const pkg of BUILT_IN_ADAPTERS) registry.use(pkg, options);
      // An instance loads further adapters through its configuration; restarting the builder is enough.
      if (config.adapters.length > 0) await loadAdapters(config.adapters, { ...options, registry });
    }
    const stacks = await new StackRegistry().load(config.stacks);
    const sandboxes =
      overrides.sandboxes ??
      new SandboxManager({
        docker: new DockerClient(undefined, config.env),
        cpus: config.sandbox.cpus,
        memoryMb: config.sandbox.memoryMb,
        runtime: config.sandbox.runtime,
        idleMinutes: config.sandbox.idleMinutes,
        namePrefix: config.sandbox.namePrefix,
        allowedHosts: config.sandbox.allowedHosts ?? [...DEFAULT_ALLOWED_HOSTS, ...stacks.allowedHosts()],
      });
    const services = new Services(config, database, registry, stacks, sandboxes, overrides);
    await services.githubApp.load();
    await services.jobs.recover();
    return services;
  }

  projectDir(projectId: string): string {
    return join(this.config.dataDir, "projects", projectId, "workspace");
  }

  cacheDir(projectId: string): string {
    return join(this.config.dataDir, "projects", projectId, "cache");
  }

  /** Secrets of one project: app secrets and resource connection values. */
  projectVault(projectId: string): SecretVault {
    const prefix = `project/${projectId}/`;
    const vault = this.vault;
    return {
      get: (key) => vault.get(prefix + key),
      set: (key, value) => vault.set(prefix + key, value),
      delete: (key) => vault.delete(prefix + key),
      list: async (p = "") => (await vault.list(prefix + p)).map((k) => k.slice(prefix.length)),
    };
  }

  /**
   * Preview addresses contain a token derived from the master key, so that a
   * preview cannot be guessed from the project id.
   */
  async previewHost(projectId: string): Promise<string> {
    const token = createHmac("sha256", await this.config.masterKey.getKey())
      .update(`preview:${projectId}`)
      .digest("hex")
      .slice(0, 16);
    return `p-${projectId}-${token}.${this.config.previewDomain}`;
  }

  async previewUrl(projectId: string): Promise<string> {
    const base = new URL(this.config.publicUrl);
    return `${base.protocol}//${await this.previewHost(projectId)}${base.port ? `:${base.port}` : ""}`;
  }

  oauthSources(): OAuthClientSource[] {
    const vault = this.vault;
    return [
      envClientSource(this.config.env),
      this.githubApp.oauthSource(),
      dynamicRegistrationSource(
        {
          get: async (key) => {
            const raw = await vault.get(`oauth-client/${key}`);
            return raw ? JSON.parse(raw) : undefined;
          },
          set: (key, client) => vault.set(`oauth-client/${key}`, JSON.stringify(client)),
        },
        { clientName: "Lotse" },
      ),
    ];
  }

  async project(user: User, id: string): Promise<ProjectRow> {
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
    const project = rows[0];
    // Members see their own projects; admins and owners see all.
    if (!project || (project.ownerId !== user.id && user.role === "member")) throw new LotseError("NOT_FOUND", "There is no such project.");
    return project;
  }

  async updateProject(id: string, patch: Partial<ProjectRow>): Promise<void> {
    const { db, schema } = this.database;
    await db
      .update(schema.projects)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(schema.projects.id, id));
  }

  async close(): Promise<void> {
    await this.jobs.close();
    await this.database.close();
  }
}
