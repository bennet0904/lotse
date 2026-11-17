/**
 * Deployment engine (specification section 7.3): plan, build, deploy, verify,
 * finish or roll back. The engine knows nothing about language models or
 * user interfaces; the CLI and the builder server drive it through this API.
 */
import { errorMessage, isLotseError, LotseError } from "./errors.js";
import { event } from "./events.js";
import { type HealthChecker, waitForHealthy } from "./health.js";
import type { Manifest } from "./manifest.js";
import { planResources, resolveRuntime } from "./planning.js";
import { Redactor } from "./redact.js";
import type { AdapterRegistry } from "./registry.js";
import {
  type AppRecord,
  type DeploymentRecord,
  resourceVaultKey,
  type SecretVault,
  type StateStore,
  toAppRef,
  toDeploymentRecord,
  toDeploymentRef,
  toResourceRecord,
} from "./state.js";
import type {
  AppRef,
  AppStatus,
  ArtifactKind,
  BuildArtifact,
  Connection,
  DeployContext,
  DeployEvent,
  DeploymentPlan,
  DeploymentRef,
  DeployPhase,
  DomainStatus,
  EnvVar,
  HostingAdapter,
  LogLine,
  LogOptions,
  ResourceRef,
} from "./types.js";

export interface BuildRequest {
  manifest: Manifest;
  workdir: string;
  /** The artifact kind the hosting adapter asked for. */
  artifact: ArtifactKind;
  /** Public environment available at build time. */
  env: Record<string, string>;
  /** Target platform of images, e.g. `linux/arm64`, when the adapter knows it. */
  platform?: string;
  signal?: AbortSignal;
}

/** Implemented by `@lotse/build`. */
export interface Builder {
  build(request: BuildRequest): AsyncGenerator<DeployEvent, BuildArtifact, void>;
}

export interface EngineOptions {
  registry: AdapterRegistry;
  builder: Builder;
  state: StateStore;
  vault: SecretVault;
  health?: HealthChecker;
}

export interface TargetOptions {
  /** Hosting adapter id. */
  adapter: string;
  connection: Connection;
  /** Connections to external resource providers, keyed by adapter id. */
  resourceConnections?: Record<string, Connection>;
}

export interface DeployOptions extends TargetOptions {
  workdir: string;
  /** Values for the secrets named in the manifest. */
  secrets?: Record<string, string>;
  preview?: { id: string; branch?: string };
  /** The Git repository the project is linked to, if any. */
  repository?: { url: string; branch: string; commit?: string };
  signal?: AbortSignal;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export interface DeployOutcome {
  ok: boolean;
  deployment?: DeploymentRecord;
  /** True when the previous version was restored after a failed health check. */
  rolledBack: boolean;
  domains: DomainStatus[];
  error?: { code: string; message: string };
}

export class DeploymentEngine {
  readonly registry: AdapterRegistry;
  readonly #builder: Builder;
  readonly #state: StateStore;
  readonly #vault: SecretVault;
  readonly #health: HealthChecker;

  constructor(options: EngineOptions) {
    this.registry = options.registry;
    this.#builder = options.builder;
    this.#state = options.state;
    this.#vault = options.vault;
    this.#health = options.health ?? waitForHealthy;
  }

  /**
   * Step 1: compares the manifest with the adapter's capabilities and asks the
   * adapter what a deployment would change. Nothing is modified.
   */
  async plan(manifest: Manifest, target: TargetOptions): Promise<DeploymentPlan> {
    const adapter = this.registry.hosting(target.adapter);
    const resolution = resolveRuntime(manifest, adapter, this.registry);
    const record = await this.#state.getApp(adapter.id, manifest.name);
    const resources = planResources({
      manifest,
      adapter,
      registry: this.registry,
      connectedProviders: Object.keys(target.resourceConnections ?? {}),
      existing: record?.resources ?? [],
    });

    const plan = await adapter.plan(manifest, target.connection);
    plan.resources = resources;
    plan.warnings = [...resolution.notes, ...plan.warnings];
    const resourceSteps = resources
      .filter((r) => r.action === "create")
      .map((r) => ({
        id: `resource:${r.spec.name}`,
        title: `Create ${r.spec.type} "${r.spec.name}"`,
        detail: r.native ? `at ${adapter.displayName}` : `at ${this.registry.resource(r.provider).displayName} (external provider)`,
        action: "create" as const,
      }));
    plan.steps = [...resourceSteps, ...plan.steps];
    if (plan.firstDeployment) {
      for (const step of plan.steps) {
        if (step.action === "create" && step.id === "app") step.critical = true;
      }
    }
    return plan;
  }

  /** Steps 2 to 5. Yields the same events the CLI and the UI show. */
  async *deploy(plan: DeploymentPlan, options: DeployOptions): AsyncGenerator<DeployEvent, DeployOutcome, void> {
    const adapter = this.registry.hosting(plan.adapter);
    const manifest = plan.manifest;
    const redactor = new Redactor().addConnection(options.connection).add(...Object.values(options.secrets ?? {}));
    for (const conn of Object.values(options.resourceConnections ?? {})) redactor.addConnection(conn);
    const clean = (e: DeployEvent): DeployEvent => {
      if (e.type === "log") return { ...e, line: redactor.redact(e.line) };
      if (e.type === "error") return { ...e, message: redactor.redact(e.message) };
      if (e.type === "status" && e.message) return { ...e, message: redactor.redact(e.message) };
      return e;
    };
    const failure = (phase: DeployPhase, err: unknown, fallback: string): DeployEvent[] => {
      const code = isLotseError(err) ? err.code : fallback;
      return [clean(event.error(phase, code, errorMessage(err))), event.status(phase, "failed")];
    };
    const outcome = (err: unknown, fallback: string, extra: Partial<DeployOutcome> = {}): DeployOutcome => ({
      ok: false,
      rolledBack: false,
      domains: [],
      error: { code: isLotseError(err) ? err.code : fallback, message: redactor.redact(errorMessage(err)) },
      ...extra,
    });

    // Secrets named in the manifest need a value before anything is built.
    const missing = manifest.env.secrets.filter((name) => options.secrets?.[name] === undefined);
    if (missing.length > 0) {
      const err = new LotseError("INVALID_INPUT", `No value is stored for ${missing.length > 1 ? "secrets" : "secret"} ${missing.join(", ")}.`, {
        hints: [`Set ${missing.length > 1 ? "them" : "it"} with \`lotse env set ${missing[0]}\`.`],
      });
      yield* failure("plan", err, "INVALID_INPUT");
      return outcome(err, "INVALID_INPUT");
    }

    const history = await this.#state.listDeployments(adapter.id, manifest.name);
    const record = await this.#state.getApp(adapter.id, manifest.name);
    const previousRecord = history.find((d) => d.state === "live");
    const previous = previousRecord ? toDeploymentRef(previousRecord, options.connection, record?.meta) : undefined;

    // --- Build -------------------------------------------------------------
    let artifact: BuildArtifact;
    yield event.status("build", "started", `Building ${manifest.name} (${plan.artifact})`);
    try {
      if (options.signal?.aborted) throw new LotseError("ABORTED", "The deployment was aborted.");
      const build = this.#builder.build({
        manifest,
        workdir: options.workdir,
        artifact: plan.artifact,
        env: { ...manifest.env.public },
        platform: typeof plan.meta?.platform === "string" ? plan.meta.platform : undefined,
        signal: options.signal,
      });
      for (;;) {
        const next = await build.next();
        if (next.done) {
          artifact = next.value;
          break;
        }
        yield clean(next.value);
      }
      yield event.status("build", "succeeded");
    } catch (err) {
      yield* failure("build", err, "BUILD_FAILED");
      return outcome(err, "BUILD_FAILED");
    }

    // --- Provision resources ---------------------------------------------
    const resources: ResourceRef[] = [];
    const appForResources = toAppRef(record, adapter.id, manifest.name, options.connection);
    if (plan.resources.length > 0) {
      yield event.status("provision", "started");
      try {
        for (const planned of plan.resources) {
          if (options.signal?.aborted) throw new LotseError("ABORTED", "The deployment was aborted.");
          if (planned.action === "reuse") {
            const stored = record?.resources.find((r) => r.name === planned.spec.name);
            if (stored) {
              resources.push(await this.#loadResource(adapter.id, manifest.name, stored));
              yield event.log("provision", `Using existing ${planned.spec.type} "${planned.spec.name}"`);
              continue;
            }
          }
          yield event.log("provision", `Creating ${planned.spec.type} "${planned.spec.name}" at ${planned.provider}`);
          let ref: ResourceRef;
          if (planned.native) {
            if (!adapter.provision) throw new LotseError("RESOURCE_UNSUPPORTED", `${adapter.displayName} cannot create ${planned.spec.type}.`);
            ref = await adapter.provision(appForResources, planned.spec);
          } else {
            const conn = options.resourceConnections?.[planned.provider];
            if (!conn) throw new LotseError("AUTH_FAILED", `Not signed in to resource provider "${planned.provider}".`);
            ref = await this.registry.resource(planned.provider).provision({ adapter: planned.provider, name: manifest.name, connection: conn }, planned.spec);
          }
          redactor.addEnv(ref.env);
          await this.#storeResource(adapter.id, manifest.name, ref);
          resources.push(ref);
        }
        // Persist right away so that a later failure does not orphan the resources.
        await this.#state.saveApp({
          adapter: adapter.id,
          name: manifest.name,
          id: record?.id,
          meta: record?.meta,
          resources: mergeResources(record, resources),
          domains: record?.domains ?? [],
          updatedAt: Date.now(),
        });
        yield event.status("provision", "succeeded");
      } catch (err) {
        yield* failure("provision", err, "DEPLOY_FAILED");
        return outcome(err, "DEPLOY_FAILED");
      }
    }

    // --- Deploy ------------------------------------------------------------
    const env = resolveEnv(manifest, options.secrets ?? {}, resources);
    redactor.addEnv(env);
    const ctx: DeployContext = {
      connection: options.connection,
      workdir: options.workdir,
      env,
      resources,
      previous,
      preview: options.preview,
      repository: options.repository,
      signal: options.signal,
    };
    let deployment: DeploymentRef | undefined;
    try {
      for await (const e of adapter.deploy(plan, artifact, ctx)) {
        if (e.type === "status" && e.phase === "deploy" && e.state === "succeeded" && e.deployment) {
          deployment = e.deployment;
          continue; // re-emitted below once domains are attached
        }
        if (e.type === "status" && e.phase === "deploy" && e.state === "failed") {
          throw new LotseError("DEPLOY_FAILED", e.message ?? "The provider reported a failed deployment.");
        }
        yield clean(e);
      }
      if (!deployment) throw new LotseError("DEPLOY_FAILED", `${adapter.displayName} finished without reporting a deployment.`);
    } catch (err) {
      yield* failure("deploy", err, "DEPLOY_FAILED");
      return outcome(err, "DEPLOY_FAILED");
    }

    const app = deployment.app;
    const domains: DomainStatus[] = [];
    if (!options.preview && adapter.addDomain) {
      for (const domain of manifest.domains) {
        try {
          const status = await adapter.addDomain(app, domain);
          domains.push(status);
          if (status.state !== "active") {
            const records = status.dnsRecords.map((r) => `${r.type} ${r.name} -> ${r.value}`).join(", ");
            yield event.log(
              "deploy",
              `Domain ${domain} is ${status.state}${records ? `. Create these DNS records: ${records}` : ""}${status.message ? ` (${status.message})` : ""}`,
            );
          }
        } catch (err) {
          domains.push({ domain, state: "error", dnsRecords: [], message: redactor.redact(errorMessage(err)) });
          yield clean(event.log("deploy", `Domain ${domain} could not be attached: ${errorMessage(err)}`, "stderr"));
        }
      }
    }
    yield event.status("deploy", "succeeded", deployment.url, deployment);

    // --- Verify ------------------------------------------------------------
    const probeUrl = deployment.probe?.url ?? (deployment.url ? new URL(manifest.runtime.healthcheck, deployment.url).toString() : undefined);
    let healthy = true;
    let healthDetail = "";
    if (!probeUrl) {
      yield event.status("verify", "skipped", "The provider reported no URL to check.");
    } else {
      yield event.status("verify", "started", `Checking ${probeUrl}`);
      try {
        const result = await this.#health({
          url: probeUrl,
          headers: deployment.probe?.headers,
          timeoutMs: options.healthTimeoutMs,
          intervalMs: options.healthIntervalMs,
          signal: options.signal,
        });
        healthy = result.ok;
        healthDetail = result.detail ?? "";
      } catch (err) {
        healthy = false;
        healthDetail = errorMessage(err);
      }
    }

    if (healthy) {
      if (probeUrl) yield event.status("verify", "succeeded");
      const saved = toDeploymentRecord(deployment, options.preview ? "preview" : "live");
      if (!options.preview) {
        if (previousRecord && previousRecord.id !== saved.id) await this.#state.saveDeployment({ ...previousRecord, state: "superseded" });
        await this.#state.saveApp({
          adapter: adapter.id,
          name: manifest.name,
          id: app.id,
          meta: app.meta,
          resources: mergeResources(record, resources),
          domains: [...new Set([...(record?.domains ?? []), ...domains.filter((d) => d.state !== "error").map((d) => d.domain)])],
          updatedAt: Date.now(),
        });
      }
      await this.#state.saveDeployment(saved);
      yield event.status("finish", "succeeded", deployment.url, deployment);
      return { ok: true, deployment: saved, rolledBack: false, domains };
    }

    // --- Roll back ---------------------------------------------------------
    const failed = new LotseError("HEALTHCHECK_FAILED", `The health check at ${probeUrl} did not succeed${healthDetail ? ` (${healthDetail})` : ""}.`);
    yield* failure("verify", failed, "HEALTHCHECK_FAILED");
    await this.#state.saveDeployment(toDeploymentRecord(deployment, "failed"));
    // Remember the app even when its first deployment failed, so that it can be inspected or destroyed.
    if (!record && !options.preview) {
      await this.#state.saveApp({
        adapter: adapter.id,
        name: manifest.name,
        id: app.id,
        meta: app.meta,
        resources: mergeResources(record, resources),
        domains: [],
        updatedAt: Date.now(),
      });
    }

    let rolledBack = false;
    if (options.preview) {
      // Previews never replace the live version; nothing to restore.
    } else if (!previous) {
      yield event.status("rollback", "skipped", "There is no earlier version to restore.");
    } else if (adapter.capabilities.rollback === "none") {
      yield event.status("rollback", "skipped", `${adapter.displayName} does not support rollbacks.`);
    } else {
      yield event.status("rollback", "started", `Restoring ${previous.id}`);
      try {
        await adapter.rollback(previous, ctx);
        rolledBack = true;
        yield event.status("rollback", "succeeded", previous.url);
      } catch (err) {
        yield* failure("rollback", err, "ROLLBACK_FAILED");
      }
    }
    yield event.status("finish", "failed", failed.message);
    return { ...outcome(failed, "HEALTHCHECK_FAILED"), rolledBack, domains, deployment: toDeploymentRecord(deployment, "failed") };
  }

  /** Makes an earlier deployment live again. Defaults to the one before the current. */
  async *rollback(
    manifest: Manifest,
    options: TargetOptions & { to?: string; workdir: string; signal?: AbortSignal },
  ): AsyncGenerator<DeployEvent, DeployOutcome, void> {
    const adapter = this.registry.hosting(options.adapter);
    const fail = (err: LotseError): DeployOutcome => ({ ok: false, rolledBack: false, domains: [], error: { code: err.code, message: err.message } });
    if (adapter.capabilities.rollback === "none") {
      const err = new LotseError("ROLLBACK_UNSUPPORTED", `${adapter.displayName} does not support rollbacks.`);
      yield event.error("rollback", err.code, err.message);
      return fail(err);
    }
    const history = await this.#state.listDeployments(adapter.id, manifest.name);
    const record = await this.#state.getApp(adapter.id, manifest.name);
    const live = history.find((d) => d.state === "live");
    const target = options.to
      ? history.find((d) => d.id === options.to || d.id.startsWith(options.to as string))
      : history.find((d) => d.state === "superseded" || d.state === "rolled-back");
    if (!target || target.state === "failed" || target.state === "preview") {
      const err = new LotseError(
        "NOT_FOUND",
        options.to ? `No restorable deployment "${options.to}" found.` : "There is no earlier deployment to roll back to.",
      );
      yield event.error("rollback", err.code, err.message);
      return fail(err);
    }
    if (live && target.id === live.id) {
      const err = new LotseError("INVALID_INPUT", `Deployment ${target.id} is already live.`);
      yield event.error("rollback", err.code, err.message);
      return fail(err);
    }
    const resources = await Promise.all((record?.resources ?? []).map((r) => this.#loadResource(adapter.id, manifest.name, r)));
    const ctx: DeployContext = { connection: options.connection, workdir: options.workdir, env: [], resources, signal: options.signal };
    const ref = toDeploymentRef(target, options.connection, record?.meta);
    yield event.status("rollback", "started", `Restoring ${target.id}`);
    try {
      await adapter.rollback(ref, ctx);
    } catch (err) {
      yield event.error("rollback", isLotseError(err) ? err.code : "ROLLBACK_FAILED", errorMessage(err));
      yield event.status("rollback", "failed");
      return fail(isLotseError(err) ? err : new LotseError("ROLLBACK_FAILED", errorMessage(err)));
    }
    if (live) await this.#state.saveDeployment({ ...live, state: "rolled-back" });
    const restored: DeploymentRecord = { ...target, state: "live" };
    await this.#state.saveDeployment(restored);
    yield event.status("rollback", "succeeded", target.url, ref);
    return { ok: true, deployment: restored, rolledBack: true, domains: [] };
  }

  /** Removes the app at the provider. External resources are only removed when asked for. */
  async destroy(manifest: Manifest, options: TargetOptions & { workdir: string; withResources?: boolean }): Promise<void> {
    const adapter = this.registry.hosting(options.adapter);
    const record = await this.#state.getApp(adapter.id, manifest.name);
    const app = toAppRef(record, adapter.id, manifest.name, options.connection);
    const resources = await Promise.all((record?.resources ?? []).map((r) => this.#loadResource(adapter.id, manifest.name, r)));
    await adapter.destroy(app, { connection: options.connection, workdir: options.workdir, env: [], resources });
    for (const res of resources) {
      if (res.provider !== adapter.id && options.withResources) {
        const conn = options.resourceConnections?.[res.provider];
        if (!conn) throw new LotseError("AUTH_FAILED", `Not signed in to resource provider "${res.provider}"; "${res.name}" was not removed.`);
        await this.registry.resource(res.provider).destroy({ adapter: res.provider, name: manifest.name, connection: conn }, res);
      }
      if (res.provider === adapter.id || options.withResources) {
        for (const e of res.env) await this.#vault.delete(resourceVaultKey(adapter.id, manifest.name, res.name, e.name));
      }
    }
    await this.#state.deleteApp(adapter.id, manifest.name);
  }

  async app(adapterId: string, name: string, connection: Connection): Promise<AppRef> {
    return toAppRef(await this.#state.getApp(adapterId, name), adapterId, name, connection);
  }

  async status(adapterId: string, name: string, connection: Connection): Promise<AppStatus> {
    return this.registry.hosting(adapterId).status(await this.app(adapterId, name, connection));
  }

  async *logs(adapterId: string, name: string, connection: Connection, opts: LogOptions = {}): AsyncGenerator<LogLine, void, void> {
    const redactor = new Redactor().addConnection(connection);
    for await (const line of this.registry.hosting(adapterId).logs(await this.app(adapterId, name, connection), opts)) {
      yield { ...line, line: redactor.redact(line.line) };
    }
  }

  async setEnv(adapterId: string, name: string, connection: Connection, vars: EnvVar[]): Promise<void> {
    await this.registry.hosting(adapterId).setEnv(await this.app(adapterId, name, connection), vars);
  }

  async addDomain(adapterId: string, name: string, connection: Connection, domain: string): Promise<DomainStatus> {
    const adapter: HostingAdapter = this.registry.hosting(adapterId);
    if (!adapter.capabilities.customDomains || !adapter.addDomain) {
      throw new LotseError("DOMAINS_UNSUPPORTED", `${adapter.displayName} does not support custom domains.`);
    }
    const record = await this.#state.getApp(adapterId, name);
    const status = await adapter.addDomain(toAppRef(record, adapterId, name, connection), domain);
    if (record && !record.domains.includes(domain)) {
      await this.#state.saveApp({ ...record, domains: [...record.domains, domain], updatedAt: Date.now() });
    }
    return status;
  }

  history(adapterId: string, name: string): Promise<DeploymentRecord[]> {
    return this.#state.listDeployments(adapterId, name);
  }

  async #storeResource(adapterId: string, app: string, ref: ResourceRef): Promise<void> {
    for (const e of ref.env) await this.#vault.set(resourceVaultKey(adapterId, app, ref.name, e.name), JSON.stringify({ value: e.value, secret: e.secret }));
  }

  async #loadResource(adapterId: string, app: string, record: AppRecord["resources"][number]): Promise<ResourceRef> {
    const env: EnvVar[] = [];
    for (const name of record.envNames) {
      const raw = await this.#vault.get(resourceVaultKey(adapterId, app, record.name, name));
      if (raw === undefined) {
        throw new LotseError("NOT_FOUND", `The connection values of resource "${record.name}" are missing from the credential store.`);
      }
      const parsed = JSON.parse(raw) as { value: string; secret: boolean };
      env.push({ name, value: parsed.value, secret: parsed.secret });
    }
    return { type: record.type, name: record.name, id: record.id, provider: record.provider, env, meta: record.meta };
  }
}

function mergeResources(record: AppRecord | undefined, resources: ResourceRef[]): AppRecord["resources"] {
  const byName = new Map((record?.resources ?? []).map((r) => [r.name, r]));
  for (const ref of resources) byName.set(ref.name, toResourceRecord(ref));
  return [...byName.values()];
}

/** Environment of the running app: PORT, public values, resource connections, secrets. */
export function resolveEnv(manifest: Manifest, secrets: Record<string, string>, resources: ResourceRef[]): EnvVar[] {
  const vars = new Map<string, EnvVar>();
  if (manifest.runtime.kind !== "static" && manifest.runtime.port) {
    vars.set("PORT", { name: "PORT", value: String(manifest.runtime.port), secret: false });
  }
  for (const [name, value] of Object.entries(manifest.env.public)) vars.set(name, { name, value, secret: false });
  for (const res of resources) for (const e of res.env) vars.set(e.name, e);
  for (const name of manifest.env.secrets) {
    const value = secrets[name];
    if (value !== undefined) vars.set(name, { name, value, secret: true });
  }
  return [...vars.values()];
}
