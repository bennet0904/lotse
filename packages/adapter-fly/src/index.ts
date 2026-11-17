/**
 * Fly.io hosting adapter (Machines API). The image is pushed to Fly's
 * registry; a new machine starts next to the running one and replaces it once
 * it is healthy.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  type AppStatus,
  accessToken,
  apiConnection,
  type BuildArtifact,
  type Capabilities,
  type ConnectInput,
  type Connection,
  cliImageTools,
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
  type DomainStatus,
  type EnvVar,
  event,
  type HostingAdapter,
  HttpClient,
  isLotseError,
  type LogLine,
  type LogOptions,
  LotseError,
  type Manifest,
  throwIfAborted,
  type VerifyResult,
} from "@lotse/core";

interface Machine {
  id: string;
  name?: string;
  state: string;
  region?: string;
  created_at?: string;
  config: { image: string; env?: Record<string, string>; metadata?: Record<string, string>; [key: string]: unknown };
}

const capabilities: Capabilities = {
  runtimes: ["server", "container"],
  languages: ["node", "python", "go", "php"],
  resources: [],
  customDomains: true,
  previewDeployments: false,
  rollback: "redeploy",
};

export function createFlyAdapter(options: AdapterOptions = {}): HostingAdapter {
  const images = () => options.images ?? cliImageTools();
  const waitSeconds = Number(options.settings?.waitSeconds ?? 60);
  const machines = (conn: Connection) =>
    new HttpClient({
      provider: "Fly.io",
      baseUrl: "https://api.machines.dev/v1",
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: 300,
    });
  const platform = (conn: Connection) =>
    new HttpClient({
      provider: "Fly.io",
      baseUrl: "https://api.fly.io",
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: 300,
    });

  async function graphql<T>(conn: Connection, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await platform(conn).post<{ data?: T; errors?: { message: string }[] }>("/graphql", { query, variables });
    if (res.errors?.length) throw new LotseError("PROVIDER_ERROR", `Fly.io: ${res.errors.map((e) => e.message).join("; ")}`);
    return res.data as T;
  }

  async function appExists(conn: Connection, name: string): Promise<boolean> {
    try {
      await machines(conn).get(`/apps/${name}`);
      return true;
    } catch (err) {
      if (isLotseError(err) && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  const list = (conn: Connection, name: string) => machines(conn).get<Machine[]>(`/apps/${name}/machines`);
  const current = (all: Machine[]) => all.filter((m) => m.config.metadata?.lotse === "app" && m.state !== "destroyed");

  function machineConfig(manifest: { port: number; healthcheck: string }, image: string, env: Record<string, string>) {
    return {
      image,
      env,
      metadata: { lotse: "app" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
      restart: { policy: "always" },
      services: [
        {
          protocol: "tcp",
          internal_port: manifest.port,
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"], force_https: true },
          ],
        },
      ],
      checks: { http: { type: "http", port: manifest.port, path: manifest.healthcheck, interval: "10s", timeout: "5s", grace_period: "10s" } },
    };
  }

  /** Starts a machine with the new configuration, waits for it and then removes the old machines. */
  async function replace(conn: Connection, app: string, config: Record<string, unknown>, signal?: AbortSignal): Promise<Machine> {
    const api = machines(conn);
    const old = current(await list(conn, app));
    throwIfAborted(signal);
    const created = await api.post<Machine>(`/apps/${app}/machines`, { region: conn.settings.region || undefined, config }, { signal });
    try {
      await api.get(`/apps/${app}/machines/${created.id}/wait`, { query: { state: "started", timeout: waitSeconds }, signal });
    } catch (err) {
      // The new machine never came up: remove it and leave the running ones alone.
      await api.delete(`/apps/${app}/machines/${created.id}`, { query: { force: "true" } }).catch(() => {});
      throw new LotseError(
        "DEPLOY_FAILED",
        `The new machine did not start${isLotseError(err) ? `: ${err.message}` : "."} The running version was not changed.`,
      );
    }
    for (const m of old) await api.delete(`/apps/${app}/machines/${m.id}`, { query: { force: "true" } }).catch(() => {});
    return created;
  }

  return {
    id: "fly",
    displayName: "Fly.io",
    auth: ["token"],
    capabilities,
    tokenSetup: {
      url: "https://fly.io/tokens/create",
      permissions: ["An organization token for the organization that should own the apps (a deploy token of one app is not enough: Lotse creates the app)"],
      steps: ["Create an org token, for example with `fly tokens create org`.", "Copy the token (starting with “FlyV1”) and paste it here."],
      fields: [
        { name: "org", label: "Organization", required: false, placeholder: "personal" },
        { name: "region", label: "Region", required: false, placeholder: "fra", help: "Defaults to the region nearest to Fly's API." },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const org = input.options?.org || "personal";
      const conn = apiConnection("fly", input, { org, ...(input.options?.region ? { region: input.options.region } : {}) });
      await machines(conn).get("/apps", { query: { org_slug: org } });
      conn.account = { id: org, name: `Fly.io (${org})` };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      try {
        await machines(conn).get("/apps", { query: { org_slug: conn.settings.org } });
      } catch (err) {
        if (!(isLotseError(err) && (err.code === "PERMISSION_MISSING" || err.code === "AUTH_FAILED"))) throw err;
        result.ok = false;
        result.missingPermissions.push(`Access to the organization "${conn.settings.org}"`);
      }
      return result;
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const exists = await appExists(conn, manifest.name);
      return {
        adapter: "fly",
        app: { adapter: "fly", name: manifest.name, id: exists ? manifest.name : undefined, connection: conn },
        manifest,
        artifact: "image",
        firstDeployment: !exists,
        steps: [
          {
            id: "app",
            title: exists ? `Use app ${manifest.name}` : `Create app ${manifest.name}`,
            detail: `https://${manifest.name}.fly.dev`,
            action: exists ? "noop" : "create",
          },
          { id: "push", title: "Push the image to registry.fly.io", action: "create" },
          { id: "deploy", title: "Start a new machine and replace the old one once it is healthy", action: "update" },
        ],
        resources: [],
        warnings: manifest.release
          ? [`Fly.io does not run the release command "${manifest.release.command}" through this adapter; run it when the app starts.`]
          : [],
        meta: { platform: "linux/amd64" },
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "image") throw new LotseError("DEPLOY_FAILED", "Fly.io runs container images.");
      throwIfAborted(ctx.signal);
      const conn = ctx.connection;
      const name = plan.manifest.name;
      if (!plan.app.id) {
        yield event.log("deploy", `Creating app ${name}`);
        try {
          await machines(conn).post("/apps", { app_name: name, org_slug: conn.settings.org });
        } catch (err) {
          if (isLotseError(err) && (err.details.status === 422 || err.code === "CONFLICT")) {
            throw new LotseError("CONFLICT", `The app name "${name}" is already taken on Fly.io. App names are unique across all accounts.`, {
              hints: ["Choose another `name` in lotse.yaml."],
            });
          }
          throw err;
        }
        // A shared IPv4 and an IPv6 address make the app reachable at <name>.fly.dev.
        for (const type of ["shared_v4", "v6"]) {
          await graphql(conn, "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address } } }", {
            input: { appId: name, type },
          });
        }
      }
      const tag = artifact.image.split(":").pop() as string;
      const image = `registry.fly.io/${name}:${tag}`;
      yield* images().push(artifact.image, image, { registry: "registry.fly.io", username: "x", password: accessToken(conn) }, ctx.signal);

      const port = artifact.port ?? plan.manifest.runtime.port ?? 3000;
      const env = Object.fromEntries(ctx.env.map((v) => [v.name, v.value]));
      yield event.log("deploy", "Starting a new machine");
      const machine = await replace(
        conn,
        name,
        machineConfig({ port, healthcheck: plan.manifest.runtime.healthcheck }, image, { ...env, PORT: String(port) }),
        ctx.signal,
      );
      yield event.log("deploy", `Machine ${machine.id} is running; older machines were removed.`);
      const ref: DeploymentRef = { id: machine.id, app: { ...plan.app, id: name }, url: `https://${name}.fly.dev`, createdAt: Date.now(), version: image };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    /** Fly.io has no rollback of its own: the previous image is deployed again. */
    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      if (!target.version) throw new LotseError("ROLLBACK_FAILED", `Deployment ${target.id} has no image to return to.`);
      const running = current(await list(ctx.connection, target.app.name))[0];
      if (!running) throw new LotseError("ROLLBACK_FAILED", "The app has no running machine to take the configuration from.");
      await replace(ctx.connection, target.app.name, { ...running.config, image: target.version }, ctx.signal);
    },

    async destroy(app: AppRef): Promise<void> {
      try {
        await machines(app.connection).delete(`/apps/${app.name}`, { query: { force: "true" } });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },

    async setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
      const running = current(await list(app.connection, app.name))[0];
      if (!running) throw new LotseError("NOT_FOUND", `The app "${app.name}" has no running machine.`);
      await replace(app.connection, app.name, { ...running.config, env: { ...running.config.env, ...Object.fromEntries(vars.map((v) => [v.name, v.value])) } });
    },

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const data = await graphql<{ addCertificate: { certificate: { configured: boolean; dnsValidationHostname?: string; dnsValidationTarget?: string } } }>(
        app.connection,
        "mutation($appId: ID!, $hostname: String!) { addCertificate(appId: $appId, hostname: $hostname) { certificate { configured dnsValidationHostname dnsValidationTarget } } }",
        { appId: app.name, hostname: domain },
      );
      const cert = data.addCertificate.certificate;
      if (cert.configured) return { domain, state: "active", dnsRecords: [] };
      return {
        domain,
        state: "pending",
        dnsRecords: [
          { type: "CNAME", name: domain, value: `${app.name}.fly.dev` },
          ...(cert.dnsValidationHostname && cert.dnsValidationTarget
            ? [{ type: "CNAME" as const, name: cert.dnsValidationHostname, value: cert.dnsValidationTarget }]
            : []),
        ],
      };
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const res = await platform(app.connection).get<{ data: { attributes: { timestamp: string; message: string; level?: string } }[] }>(
        `/api/v1/apps/${app.name}/logs`,
        { signal: opts.signal },
      );
      for (const entry of (res.data ?? []).slice(-(opts.tail ?? 100))) {
        yield { at: Date.parse(entry.attributes.timestamp), stream: entry.attributes.level === "error" ? "stderr" : "stdout", line: entry.attributes.message };
      }
    },

    async status(app: AppRef): Promise<AppStatus> {
      if (!(await appExists(app.connection, app.name))) return { state: "not-found", domains: [] };
      const all = current(await list(app.connection, app.name));
      const started = all.find((m) => m.state === "started");
      const state = started
        ? "running"
        : all.some((m) => ["created", "starting", "replacing"].includes(m.state))
          ? "deploying"
          : all.length
            ? "stopped"
            : "stopped";
      const machine = started ?? all[0];
      return {
        state,
        url: `https://${app.name}.fly.dev`,
        domains: [`${app.name}.fly.dev`],
        deployment: machine ? { id: machine.id, createdAt: machine.created_at ? Date.parse(machine.created_at) : undefined } : undefined,
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createFlyAdapter };
export default pkg;
