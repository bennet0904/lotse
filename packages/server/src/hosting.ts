/**
 * Hosting from inside the builder. It uses the hosting core through the same
 * public API as the CLI and has no privileged access to it
 * (specification section 12). Critical actions need the user's approval.
 */
import { generateSshKeyPair } from "@lotseai/adapter-ssh";
import { LocalBuilder } from "@lotseai/build";
import {
  type AuthMethod,
  availableAuthMethods,
  buildAuthorizationUrl,
  type ConnectInput,
  type Connection,
  connectionSecretName,
  DeploymentEngine,
  type DeploymentPlan,
  type DeploymentRecord,
  exchangeCode,
  GitWorkspace,
  type HostingAdapter,
  LotseError,
  loadManifest,
  type OAuthProviderConfig,
  type RepoRef,
  resolveOAuthClient,
  serializeEvent,
  type TokenSetupGuide,
  toRepoRecord,
} from "@lotseai/core";
import { hasRole, newId, type User } from "./auth.js";
import { eq } from "./db/index.js";
import type { JobContext } from "./jobs.js";
import type { ProjectService } from "./projects.js";
import type { ProjectRow, Services } from "./services.js";

export interface AccountView {
  id: string;
  adapter: string;
  kind: string;
  label: string;
  scope: "user" | "team";
  ownerId: string;
  method: string;
  account: string;
  mine: boolean;
  createdAt: number;
}

interface Connectable {
  id: string;
  displayName: string;
  auth: AuthMethod[];
  oauth?: OAuthProviderConfig;
  tokenSetup?: TokenSetupGuide;
  connect(input: ConnectInput): Promise<Connection>;
}

function planView(plan: DeploymentPlan) {
  return {
    adapter: plan.adapter,
    app: plan.app.name,
    artifact: plan.artifact,
    firstDeployment: plan.firstDeployment,
    steps: plan.steps,
    resources: plan.resources,
    warnings: plan.warnings,
  };
}

export class HostingService {
  readonly #oauthPending = new Map<
    string,
    {
      adapter: string;
      verifier: string;
      redirectUri: string;
      userId: string;
      scope: "user" | "team";
      label?: string;
      clientId: string;
      clientSecret?: string;
      createdAt: number;
    }
  >();

  constructor(
    readonly services: Services,
    readonly projects: ProjectService,
  ) {
    services.jobs.register("deploy", (input, ctx) => this.#deployJob(input, ctx));
    services.jobs.register("rollback", (input, ctx) => this.#rollbackJob(input, ctx));
    services.jobs.register("server-setup", (input, ctx) => this.#setupJob(input, ctx));
  }

  #find(id: string): { adapter: Connectable; kind: "hosting" | "git" | "resource" } {
    const { registry } = this.services;
    const hosting = registry.listHosting().find((a) => a.id === id);
    if (hosting) return { adapter: hosting, kind: "hosting" };
    const git = registry.listGit().find((a) => a.id === id);
    if (git) return { adapter: git, kind: "git" };
    const resource = registry.listResources().find((a) => a.id === id);
    if (resource) return { adapter: resource, kind: "resource" };
    throw new LotseError("ADAPTER_NOT_FOUND", `No adapter "${id}" is installed.`);
  }

  /** What the UI needs to offer providers: capabilities, sign-in methods, guided token setup. */
  adapters() {
    const { registry } = this.services;
    const sources = this.services.oauthSources();
    const base = (a: Connectable) => ({ id: a.id, name: a.displayName, auth: availableAuthMethods(a, sources), tokenSetup: a.tokenSetup ?? null });
    return {
      hosting: registry.listHosting().map((a) => ({ ...base(a), capabilities: a.capabilities, serverSetup: Boolean(a.server), backups: Boolean(a.backups) })),
      git: registry.listGit().map((g) => ({ ...base(g), pages: g.pages?.id ?? null, ci: Boolean(g.writeWorkflow && g.setCiSecret) })),
      resources: registry.listResources().map((r) => ({ ...base(r), resources: r.resources })),
    };
  }

  // --- accounts ------------------------------------------------------------

  async #accountRow(user: User, id: string, forChange = false) {
    const { db, schema } = this.services.database;
    const row = (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)))[0];
    // Team accounts can be used by every member; personal ones only by their owner.
    if (!row || (row.scope !== "team" && row.ownerId !== user.id)) throw new LotseError("NOT_FOUND", "There is no such provider account.");
    if (forChange && row.ownerId !== user.id && !hasRole(user, "admin"))
      throw new LotseError("PERMISSION_MISSING", "Only the person who connected the account or an admin can change it.");
    return row;
  }

  async #accountView(
    user: User,
    row: { id: string; adapter: string; kind: string; label: string; scope: string; ownerId: string; method: string; createdAt: number },
  ): Promise<AccountView> {
    // Team members can deploy with an account without ever seeing its credentials.
    const conn = await this.services.connections.get(row.id);
    return { ...row, scope: row.scope as "user" | "team", account: conn?.account.name ?? "", mine: row.ownerId === user.id };
  }

  async listAccounts(user: User): Promise<AccountView[]> {
    const { db, schema } = this.services.database;
    const rows = (await db.select().from(schema.accounts)).filter((r) => r.scope === "team" || r.ownerId === user.id);
    return Promise.all(rows.sort((a, b) => a.createdAt - b.createdAt).map((r) => this.#accountView(user, r)));
  }

  /** Checked before the provider is contacted, so that a refused request never sends a token anywhere. */
  #assertScope(user: User, scope: "user" | "team"): void {
    if (scope === "team" && this.services.config.auth === "oidc" && !hasRole(user, "admin")) {
      throw new LotseError("PERMISSION_MISSING", "Only admins can connect accounts for the whole team.");
    }
  }

  async #store(user: User, adapterId: string, kind: string, conn: Connection, scope: "user" | "team", label?: string, ip?: string): Promise<AccountView> {
    this.#assertScope(user, scope);
    const { db, schema } = this.services.database;
    const row = {
      id: newId("acc_"),
      adapter: adapterId,
      kind,
      label: label?.trim() || conn.account.name,
      scope,
      ownerId: user.id,
      method: conn.method,
      createdAt: Date.now(),
    };
    await this.services.connections.save(row.id, conn);
    await db.insert(schema.accounts).values(row);
    await this.services.auth.audit({
      userId: user.id,
      action: "credentials.added",
      target: row.id,
      detail: { adapter: adapterId, scope, method: conn.method, account: conn.account.name },
      ip,
    });
    return this.#accountView(user, row);
  }

  /** Guided token setup and SSH: connects, verifies and stores the account. */
  async connect(
    user: User,
    input: {
      adapter: string;
      method?: "token" | "ssh";
      token?: string;
      options?: Record<string, string>;
      secrets?: Record<string, string>;
      scope?: "user" | "team";
      label?: string;
      host?: string;
      user?: string;
      port?: number;
      password?: string;
      keyId?: string;
    },
    ip?: string,
  ): Promise<{ account: AccountView; verify: { ok: boolean; missingPermissions: string[]; warnings: string[] } | null }> {
    const { adapter, kind } = this.#find(input.adapter);
    this.#assertScope(user, input.scope ?? "user");
    let connectInput: ConnectInput;
    if (adapter.auth.includes("ssh")) {
      if (!input.host) throw new LotseError("INVALID_INPUT", "Enter the address of the server.");
      const privateKey = input.keyId ? await this.services.vault.get(`pending-key/${user.id}/${input.keyId}`) : undefined;
      if (input.keyId && !privateKey) throw new LotseError("INVALID_INPUT", "The generated key has expired. Start again.");
      connectInput = {
        method: "ssh",
        host: input.host,
        user: input.user || "root",
        port: input.port,
        privateKey,
        password: input.password || undefined,
        options: input.options,
        secrets: input.secrets,
      };
    } else {
      if (!input.token) throw new LotseError("INVALID_INPUT", "Paste the token.");
      connectInput = { method: "token", token: input.token, options: input.options, secrets: input.secrets };
    }
    const conn = await adapter.connect(connectInput);
    if (input.keyId) await this.services.vault.delete(`pending-key/${user.id}/${input.keyId}`);
    const account = await this.#store(user, adapter.id, kind, conn, input.scope ?? "user", input.label, ip);
    // The automatic check: missing permissions are reported before the first deployment.
    const verify = kind === "hosting" ? await this.services.registry.hosting(adapter.id).verify(conn) : null;
    return { account, verify };
  }

  /** The framework generates the SSH key pair; the user installs the public key or enters a password once. */
  async createSshKey(user: User, host: string): Promise<{ keyId: string; publicKey: string }> {
    const pair = generateSshKeyPair(`lotse@${host || "server"}`);
    const keyId = newId("key_");
    await this.services.vault.set(`pending-key/${user.id}/${keyId}`, pair.privateKey);
    return { keyId, publicKey: pair.publicKey };
  }

  get oauthRedirectUri(): string {
    return `${this.services.config.publicUrl}/api/v1/oauth/callback`;
  }

  /** "Connect to provider" button: returns the provider's consent page. */
  async beginOAuth(user: User, input: { adapter: string; scope?: "user" | "team"; label?: string }): Promise<{ url: string }> {
    const { adapter } = this.#find(input.adapter);
    this.#assertScope(user, input.scope ?? "user");
    const sources = this.services.oauthSources();
    if (!adapter.oauth || !availableAuthMethods(adapter, sources).includes("oauth")) {
      throw new LotseError("UNSUPPORTED", `OAuth is not set up for ${adapter.displayName} on this instance. Use a token instead.`);
    }
    const client = await resolveOAuthClient(sources, { adapter: adapter.id, config: adapter.oauth, redirectUri: this.oauthRedirectUri });
    if (!client) throw new LotseError("UNSUPPORTED", `No OAuth app is available for ${adapter.displayName}.`);
    const request = buildAuthorizationUrl(adapter.oauth, client, this.oauthRedirectUri);
    for (const [key, value] of this.#oauthPending) if (Date.now() - value.createdAt > 600_000) this.#oauthPending.delete(key);
    this.#oauthPending.set(request.state, {
      adapter: adapter.id,
      verifier: request.verifier,
      redirectUri: request.redirectUri,
      userId: user.id,
      scope: input.scope ?? "user",
      label: input.label,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      createdAt: Date.now(),
    });
    return { url: request.url };
  }

  async completeOAuth(user: User, code: string, state: string, ip?: string): Promise<AccountView> {
    const pending = this.#oauthPending.get(state);
    this.#oauthPending.delete(state);
    if (!pending || pending.userId !== user.id) throw new LotseError("AUTH_FAILED", "The sign-in attempt is unknown or has expired. Please try again.");
    const { adapter, kind } = this.#find(pending.adapter);
    const client = { clientId: pending.clientId, clientSecret: pending.clientSecret };
    const tokens = await exchangeCode(adapter.oauth as OAuthProviderConfig, client, { code, verifier: pending.verifier, redirectUri: pending.redirectUri });
    const conn = await adapter.connect({ method: "oauth", tokens, client });
    return this.#store(user, adapter.id, kind, conn, pending.scope, pending.label, ip);
  }

  async #connection(user: User, accountId: string): Promise<{ conn: Connection; adapterId: string }> {
    const row = await this.#accountRow(user, accountId);
    const oauth = this.#find(row.adapter).adapter.oauth;
    // OAuth tokens are refreshed before they expire; a failed refresh asks the user to sign in again.
    return { conn: await this.services.connections.fresh(row.id, oauth), adapterId: row.adapter };
  }

  async verifyAccount(user: User, accountId: string) {
    const { conn, adapterId } = await this.#connection(user, accountId);
    return this.services.registry.hosting(adapterId).verify(conn);
  }

  async removeAccount(user: User, accountId: string, ip?: string): Promise<void> {
    const row = await this.#accountRow(user, accountId, true);
    const { db, schema } = this.services.database;
    await db.delete(schema.accounts).where(eq(schema.accounts.id, row.id));
    await this.services.connections.delete(row.id);
    await this.services.auth.audit({ userId: user.id, action: "credentials.removed", target: row.id, detail: { adapter: row.adapter }, ip });
  }

  // --- server setup --------------------------------------------------------

  async setupPlan(user: User, accountId: string) {
    const { conn, adapterId } = await this.#connection(user, accountId);
    const adapter = this.services.registry.hosting(adapterId);
    if (!adapter.server) throw new LotseError("UNSUPPORTED", `${adapter.displayName} has no server setup.`);
    return adapter.server.planSetup(conn);
  }

  /** Setting up a server is a critical action: it never runs without explicit approval. */
  async startSetup(user: User, accountId: string, approved: boolean): Promise<{ jobId: string }> {
    if (approved !== true) throw new LotseError("APPROVAL_REQUIRED", "Setting up a server must be approved explicitly.");
    await this.#accountRow(user, accountId, true);
    const job = await this.services.jobs.enqueue("server-setup", { accountId, userId: user.id }, { userId: user.id });
    return { jobId: job.id };
  }

  async #setupJob(input: { accountId: string; userId: string }, ctx: JobContext): Promise<unknown> {
    const conn = await this.services.connections.require(input.accountId);
    const adapter = this.services.registry.hosting(conn.adapter);
    const setup = adapter.server as NonNullable<HostingAdapter["server"]>;
    const plan = await setup.planSetup(conn);
    const run = setup.runSetup(conn, plan, { approved: true, signal: ctx.signal });
    for (;;) {
      const next = await run.next();
      if (next.done) {
        await this.services.connections.save(input.accountId, next.value);
        break;
      }
      ctx.emit({ kind: "deploy", event: serializeEvent(next.value) });
    }
    await this.services.auth.audit({ userId: input.userId, action: "server.setup", target: input.accountId, detail: { host: plan.host } });
    return { host: plan.host };
  }

  // --- deployments ---------------------------------------------------------

  async #engine(project: ProjectRow): Promise<DeploymentEngine> {
    const { services } = this;
    const { DbStateStore } = await import("./db/index.js");
    return new DeploymentEngine({
      registry: services.registry,
      // Generated code is untrusted: its build commands run inside the project's sandbox.
      builder: new LocalBuilder({
        skipInstall: true,
        runner: {
          run: async (command, options) => {
            const sandbox = await this.projects.ensureSandbox(project);
            return (await sandbox.exec(command, { env: options.env, signal: options.signal, timeoutMs: 900_000, onOutput: options.onOutput })).code;
          },
        },
      }),
      state: new DbStateStore(services.database, project.id),
      vault: services.projectVault(project.id),
    });
  }

  async #target(user: User, project: ProjectRow, accountId?: string) {
    const id = accountId ?? (project.target ? (JSON.parse(project.target) as { accountId: string }).accountId : undefined);
    if (!id) throw new LotseError("INVALID_INPUT", "Choose where to publish the app.");
    const { conn, adapterId } = await this.#connection(user, id);
    const resourceConnections: Record<string, Connection> = {};
    for (const account of await this.listAccounts(user)) {
      if (account.kind === "resource") resourceConnections[account.adapter] = (await this.#connection(user, account.id)).conn;
    }
    return { accountId: id, target: { adapter: adapterId, connection: conn, resourceConnections } };
  }

  async #secrets(projectId: string, names: string[]): Promise<Record<string, string>> {
    const vault = this.services.projectVault(projectId);
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = await vault.get(`env/${name}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  /** What publishing would change. Changes nothing. */
  async deployPlan(user: User, projectId: string, accountId?: string) {
    const project = await this.services.project(user, projectId);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    const { target } = await this.#target(user, project, accountId);
    const engine = await this.#engine(project);
    const plan = planView(await engine.plan(manifest, target));
    const stored = await this.#secrets(projectId, manifest.env.secrets);
    return { ...plan, missingSecrets: manifest.env.secrets.filter((s) => !(s in stored)) };
  }

  /** One-click deploy. The first deployment to a new target needs the user's approval. */
  async deploy(user: User, projectId: string, input: { accountId?: string; approved?: boolean }, ip?: string): Promise<{ jobId: string }> {
    const project = await this.services.project(user, projectId);
    const plan = await this.deployPlan(user, projectId, input.accountId);
    if (plan.firstDeployment && input.approved !== true) {
      throw new LotseError("APPROVAL_REQUIRED", "The first deployment to a new target needs your approval.", { details: { plan } });
    }
    const { accountId } = await this.#target(user, project, input.accountId);
    await this.services.auth.audit({
      userId: user.id,
      action: "deploy.started",
      target: projectId,
      detail: { adapter: plan.adapter, accountId, first: plan.firstDeployment },
      ip,
    });
    const job = await this.services.jobs.enqueue("deploy", { accountId, userId: user.id }, { projectId, userId: user.id });
    return { jobId: job.id };
  }

  async #jobProject(ctx: JobContext): Promise<ProjectRow> {
    const { db, schema } = this.services.database;
    return (
      await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, ctx.job.projectId as string))
    )[0] as ProjectRow;
  }

  async #jobUser(userId: string): Promise<User> {
    const user = (await this.services.auth.listUsers()).find((u) => u.id === userId);
    if (!user) throw new LotseError("NOT_FOUND", "The user who started this no longer exists.");
    return user;
  }

  async #deployJob(input: { accountId: string; userId: string }, ctx: JobContext): Promise<unknown> {
    const project = await this.#jobProject(ctx);
    const user = await this.#jobUser(input.userId);
    const dir = this.services.projectDir(project.id);
    const manifest = await loadManifest(dir);
    const { target } = await this.#target(user, project, input.accountId);
    const engine = await this.#engine(project);
    const plan = await engine.plan(manifest, target);
    const git = project.git ? (JSON.parse(project.git) as { repo: { cloneUrl: string; defaultBranch: string } }) : undefined;
    const run = engine.deploy(plan, {
      ...target,
      workdir: dir,
      secrets: await this.#secrets(project.id, manifest.env.secrets),
      repository: git ? { url: git.repo.cloneUrl, branch: git.repo.defaultBranch } : undefined,
      signal: ctx.signal,
    });
    for (;;) {
      const next = await run.next();
      if (next.done) {
        const outcome = next.value;
        await this.services.auth.audit({
          userId: user.id,
          action: outcome.ok ? "deploy.succeeded" : "deploy.failed",
          target: project.id,
          detail: { adapter: plan.adapter, url: outcome.deployment?.url, error: outcome.error?.code, rolledBack: outcome.rolledBack },
        });
        if (!outcome.ok)
          throw new LotseError(
            "DEPLOY_FAILED",
            `${outcome.error?.message ?? "The deployment failed."}${outcome.rolledBack ? " The previous version was restored." : ""}`,
          );
        await this.services.updateProject(project.id, { target: JSON.stringify({ adapter: plan.adapter, accountId: input.accountId }) });
        await this.projects.addMessage(
          project.id,
          "system",
          `Published to ${engine.registry.hosting(plan.adapter).displayName}: ${outcome.deployment?.url ?? ""}`,
          { kind: "deployment", url: outcome.deployment?.url, deployment: outcome.deployment?.id },
        );
        return { url: outcome.deployment?.url, deployment: outcome.deployment?.id, domains: outcome.domains };
      }
      ctx.emit({ kind: "deploy", event: serializeEvent(next.value) });
    }
  }

  async deployments(user: User, projectId: string): Promise<DeploymentRecord[]> {
    const project = await this.services.project(user, projectId);
    if (!project.target) return [];
    const { adapter } = JSON.parse(project.target) as { adapter: string };
    const manifest = await loadManifest(this.services.projectDir(projectId));
    return (await this.#engine(project)).history(adapter, manifest.name);
  }

  async rollback(user: User, projectId: string, to?: string, ip?: string): Promise<{ jobId: string }> {
    const project = await this.services.project(user, projectId);
    if (!project.target) throw new LotseError("CONFLICT", "The app has not been published yet.");
    await this.services.auth.audit({ userId: user.id, action: "deploy.rollback", target: projectId, detail: { to }, ip });
    const job = await this.services.jobs.enqueue("rollback", { to, userId: user.id }, { projectId, userId: user.id });
    return { jobId: job.id };
  }

  async #rollbackJob(input: { to?: string; userId: string }, ctx: JobContext): Promise<unknown> {
    const project = await this.#jobProject(ctx);
    const user = await this.#jobUser(input.userId);
    const dir = this.services.projectDir(project.id);
    const { target } = await this.#target(user, project);
    const run = (await this.#engine(project)).rollback(await loadManifest(dir), { ...target, workdir: dir, to: input.to, signal: ctx.signal });
    for (;;) {
      const next = await run.next();
      if (next.done) {
        if (!next.value.ok) throw new LotseError("ROLLBACK_FAILED", next.value.error?.message ?? "The rollback failed.");
        await this.projects.addMessage(project.id, "system", `Rolled back to deployment ${next.value.deployment?.id}.`, { kind: "rollback" });
        return { deployment: next.value.deployment?.id, url: next.value.deployment?.url };
      }
      ctx.emit({ kind: "deploy", event: serializeEvent(next.value) });
    }
  }

  async status(user: User, projectId: string) {
    const project = await this.services.project(user, projectId);
    if (!project.target) return { state: "not-published" as const, domains: [] };
    const { target } = await this.#target(user, project);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    return (await this.#engine(project)).status(target.adapter, manifest.name, target.connection);
  }

  async logs(user: User, projectId: string, tail = 200) {
    const project = await this.services.project(user, projectId);
    if (!project.target) return [];
    const { target } = await this.#target(user, project);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    const lines = [];
    for await (const line of (await this.#engine(project)).logs(target.adapter, manifest.name, target.connection, { tail })) lines.push(line);
    return lines;
  }

  /** Changing domains is a critical action. */
  async addDomain(user: User, projectId: string, domain: string, approved: boolean, ip?: string) {
    if (approved !== true) throw new LotseError("APPROVAL_REQUIRED", "Changing domains must be approved explicitly.");
    const project = await this.services.project(user, projectId);
    const { target } = await this.#target(user, project);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    const status = await (await this.#engine(project)).addDomain(target.adapter, manifest.name, target.connection, domain.trim().toLowerCase());
    await this.services.auth.audit({ userId: user.id, action: "domain.added", target: projectId, detail: { domain }, ip });
    return status;
  }

  /** Deleting an app is a critical action. */
  async destroyApp(user: User, projectId: string, input: { approved?: boolean; withResources?: boolean }, ip?: string): Promise<void> {
    if (input.approved !== true) throw new LotseError("APPROVAL_REQUIRED", "Deleting a published app must be approved explicitly.");
    const project = await this.services.project(user, projectId);
    if (!project.target) throw new LotseError("CONFLICT", "The app has not been published.");
    const { target } = await this.#target(user, project);
    const dir = this.services.projectDir(projectId);
    await (await this.#engine(project)).destroy(await loadManifest(dir), { ...target, workdir: dir, withResources: Boolean(input.withResources) });
    await this.services.updateProject(projectId, { target: null });
    await this.services.auth.audit({ userId: user.id, action: "app.deleted", target: projectId, detail: { adapter: target.adapter }, ip });
    await this.projects.addMessage(projectId, "system", "The published app was removed.", { kind: "destroyed" });
  }

  // --- secrets -------------------------------------------------------------

  async listSecrets(user: User, projectId: string): Promise<{ name: string; set: boolean }[]> {
    await this.services.project(user, projectId);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    const stored = await this.#secrets(projectId, manifest.env.secrets);
    return manifest.env.secrets.map((name) => ({ name, set: name in stored }));
  }

  /** Values go straight into the encrypted store; they are never returned and never shown to the model. */
  async setSecret(user: User, projectId: string, name: string, value: string, ip?: string): Promise<void> {
    await this.services.project(user, projectId);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new LotseError("INVALID_INPUT", "Not a valid secret name.");
    if (!value) throw new LotseError("INVALID_INPUT", "Enter a value.");
    await this.services.projectVault(projectId).set(`env/${name}`, value);
    await this.services.auth.audit({ userId: user.id, action: "secret.set", target: projectId, detail: { name }, ip });
  }

  // --- backups -------------------------------------------------------------

  async #backups(user: User, projectId: string) {
    const project = await this.services.project(user, projectId);
    if (!project.target) throw new LotseError("CONFLICT", "The app has not been published yet.");
    const { target } = await this.#target(user, project);
    const adapter = this.services.registry.hosting(target.adapter);
    if (!adapter.backups) throw new LotseError("UNSUPPORTED", `${adapter.displayName} manages backups itself.`);
    const manifest = await loadManifest(this.services.projectDir(projectId));
    return { backups: adapter.backups, app: await (await this.#engine(project)).app(target.adapter, manifest.name, target.connection) };
  }

  /** The app's databases whose backups the hosting provider manages through Lotse, e.g. on an own server. */
  async backupResources(user: User, projectId: string): Promise<{ supported: boolean; resources: { name: string; type: string }[] }> {
    const project = await this.services.project(user, projectId);
    if (!project.target) return { supported: false, resources: [] };
    const { target } = await this.#target(user, project);
    const adapter = this.services.registry.hosting(target.adapter);
    if (!adapter.backups) return { supported: false, resources: [] };
    const manifest = await loadManifest(this.services.projectDir(projectId));
    const native = manifest.resources.filter(
      (r) => adapter.capabilities.resources.includes(r.type) && (!r.options?.provider || r.options.provider === adapter.id),
    );
    return { supported: true, resources: native.map((r) => ({ name: r.name, type: r.type })) };
  }

  async listBackups(user: User, projectId: string, resource: string) {
    const { backups, app } = await this.#backups(user, projectId);
    return backups.listBackups(app, resource);
  }

  async createBackup(user: User, projectId: string, resource: string) {
    const { backups, app } = await this.#backups(user, projectId);
    return backups.createBackup(app, resource);
  }

  async restoreBackup(user: User, projectId: string, resource: string, backupId: string, approved: boolean, ip?: string): Promise<void> {
    if (approved !== true) throw new LotseError("APPROVAL_REQUIRED", "Restoring a backup replaces the current data and must be approved explicitly.");
    const { backups, app } = await this.#backups(user, projectId);
    await backups.restoreBackup(app, resource, backupId);
    await this.services.auth.audit({ userId: user.id, action: "backup.restored", target: projectId, detail: { resource, backupId }, ip });
  }

  // --- git platforms -------------------------------------------------------

  async repos(user: User, accountId: string, query?: string) {
    const { conn, adapterId } = await this.#connection(user, accountId);
    return (await this.services.registry.git(adapterId).listRepos(conn, query)).map(toRepoRecord);
  }

  /** Links the project to a repository (existing or new) and pushes the current state. */
  async linkRepo(
    user: User,
    projectId: string,
    input: { accountId: string; repo?: string; create?: boolean; private?: boolean },
  ): Promise<{ repo: ReturnType<typeof toRepoRecord> }> {
    const project = await this.services.project(user, projectId);
    const { conn, adapterId } = await this.#connection(user, input.accountId);
    const provider = this.services.registry.git(adapterId);
    let repo: RepoRef | undefined;
    if (input.create) {
      const [owner, name] = (input.repo ?? project.name).includes("/")
        ? ((input.repo as string).split("/") as [string, string])
        : [undefined, input.repo ?? project.name];
      repo = await provider.createRepo(conn, { name, owner, private: input.private !== false, description: project.title });
    } else {
      const full = (input.repo ?? "").toLowerCase();
      repo = (await provider.listRepos(conn, full.split("/").pop())).find((r) => `${r.owner}/${r.name}`.toLowerCase() === full);
      if (!repo) throw new LotseError("NOT_FOUND", `Repository ${input.repo} was not found.`);
    }
    const record = toRepoRecord(repo);
    await this.services.updateProject(projectId, { git: JSON.stringify({ provider: provider.id, accountId: input.accountId, repo: record }) });
    const git = new GitWorkspace(this.services.projectDir(projectId));
    if (await git.head()) {
      const auth = await provider.remoteUrl(repo, conn);
      // An existing repository may already contain commits; they are merged, never overwritten.
      await git.pull(auth, repo.defaultBranch);
      await git.push(auth, repo.defaultBranch);
    }
    return { repo: record };
  }

  /** Push-to-deploy for targets without their own Git integration: workflow plus CI secrets. */
  async setupCi(user: User, projectId: string, previews = false): Promise<{ secrets: string[] }> {
    const project = await this.services.project(user, projectId);
    if (!project.git) throw new LotseError("CONFLICT", "Link the project to a repository first.");
    if (!project.target) throw new LotseError("CONFLICT", "Publish the app once before setting up automatic deployments.");
    const link = JSON.parse(project.git) as { provider: string; accountId: string; repo: Omit<RepoRef, "connection"> };
    const provider = this.services.registry.git(link.provider);
    if (!provider.writeWorkflow || !provider.setCiSecret) throw new LotseError("UNSUPPORTED", `${provider.displayName} does not support generated pipelines.`);
    const gitConn = (await this.#connection(user, link.accountId)).conn;
    const repo: RepoRef = { ...link.repo, connection: gitConn };
    const { target } = await this.#target(user, project);

    const secrets: Record<string, string> = {
      [connectionSecretName(target.adapter)]: Buffer.from(JSON.stringify(target.connection), "utf8").toString("base64"),
    };
    const vault = this.services.projectVault(projectId);
    const entries: Record<string, string> = {};
    for (const key of await vault.list()) {
      const value = await vault.get(key);
      if (value !== undefined) entries[key.startsWith("env/") ? `env/${project.name}/${key.slice(4)}` : key] = value;
    }
    if (Object.keys(entries).length > 0) secrets.LOTSE_VAULT = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
    for (const [name, value] of Object.entries(secrets)) await provider.setCiSecret(repo, name, value);
    await provider.writeWorkflow(repo, { adapter: target.adapter, branch: repo.defaultBranch, secrets: Object.keys(secrets), previews });
    await this.services.auth.audit({
      userId: user.id,
      action: "ci.configured",
      target: projectId,
      detail: { provider: provider.id, repo: `${repo.owner}/${repo.name}`, secrets: Object.keys(secrets) },
    });
    return { secrets: Object.keys(secrets) };
  }
}
