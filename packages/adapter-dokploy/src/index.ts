/**
 * Dokploy hosting adapter (self-hosted PaaS). The source is uploaded as an
 * archive and built by Dokploy on the user's server.
 *
 * Dokploy's API reference documents requests but not response bodies, so the
 * adapter reads identifiers back from `project.all` instead of relying on the
 * shape of create responses.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  type AppStatus,
  apiConnection,
  type BuildArtifact,
  type Capabilities,
  type ConnectInput,
  type Connection,
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
  type DomainStatus,
  type EnvVar,
  event,
  type HostingAdapter,
  HttpClient,
  type LogLine,
  type LogOptions,
  LotseError,
  type Manifest,
  type ResourceRef,
  type ResourceSpec,
  resourceEnvName,
  sleep,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotse/core";
import { zipSync } from "fflate";

interface DokployApp {
  applicationId: string;
  name: string;
  appName: string;
  applicationStatus?: "idle" | "running" | "done" | "error";
  env?: string | null;
  domains?: { host: string; https: boolean }[];
}

interface DokployProject {
  projectId: string;
  name: string;
  environments?: { environmentId: string; name: string; applications?: DokployApp[] }[];
}

const PROJECT = "lotse";
const capabilities: Capabilities = {
  runtimes: ["static", "server", "container"],
  languages: ["node", "python", "go", "php"],
  resources: ["postgres", "redis"],
  customDomains: true,
  previewDeployments: false,
  rollback: "none",
};

export function createDokployAdapter(options: AdapterOptions = {}): HostingAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 3000);
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Dokploy",
      baseUrl: `${(conn.settings.baseUrl as string).replace(/\/+$/, "")}/api`,
      headers: { "x-api-key": conn.credentials.token as string },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });

  const projects = (conn: Connection) => client(conn).get<DokployProject[]>("/project.all");

  async function findApp(conn: Connection, name: string): Promise<{ app?: DokployApp; environmentId?: string }> {
    const project = (await projects(conn)).find((p) => p.name === PROJECT);
    const environment = project?.environments?.find((e) => e.name === "production") ?? project?.environments?.[0];
    return { app: environment?.applications?.find((a) => a.name === name), environmentId: environment?.environmentId };
  }

  async function appId(app: AppRef): Promise<string> {
    const id = app.id ?? (await findApp(app.connection, app.name)).app?.applicationId;
    if (!id) throw new LotseError("NOT_FOUND", `There is no Dokploy application "${app.name}".`);
    return id;
  }

  async function ensureEnvironment(conn: Connection): Promise<string> {
    const found = await findApp(conn, "");
    if (found.environmentId) return found.environmentId;
    await client(conn).post("/project.create", { name: PROJECT, description: "Apps deployed with Lotse" });
    const created = await findApp(conn, "");
    if (!created.environmentId) throw new LotseError("PROVIDER_ERROR", "Dokploy created the project but reported no environment for it.");
    return created.environmentId;
  }

  const one = (conn: Connection, id: string) => client(conn).get<DokployApp>("/application.one", { query: { applicationId: id } });
  const envText = (vars: EnvVar[]) => vars.map((v) => `${v.name}=${/[\s"'#]/.test(v.value) ? JSON.stringify(v.value) : v.value}`).join("\n");

  return {
    id: "dokploy",
    displayName: "Dokploy",
    auth: ["token"],
    capabilities,
    tokenSetup: {
      url: "{baseUrl}/dashboard/settings/profile",
      permissions: ["An API key of a user who may create projects and applications"],
      steps: ["Open your profile in Dokploy and generate an API key.", "Copy the key and paste it here together with the address of your instance."],
      fields: [{ name: "baseUrl", label: "Instance address", required: true, placeholder: "https://dokploy.example.com" }],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      if (!input.options?.baseUrl) throw new LotseError("INVALID_INPUT", "Enter the address of your Dokploy instance.");
      const conn = apiConnection("dokploy", input, { baseUrl: input.options.baseUrl.replace(/\/+$/, "") });
      const me = await client(conn).get<{ user?: { email?: string }; email?: string; id?: string; userId?: string } | undefined>("/user.get");
      const host = new URL(conn.settings.baseUrl as string).host;
      conn.account = { id: me?.userId ?? me?.id ?? host, name: `${me?.user?.email ?? me?.email ?? "Dokploy"} @ ${host}` };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      await projects(conn);
      return {
        ok: true,
        account: conn.account.name,
        missingPermissions: [],
        warnings: ["Dokploy does not offer rollbacks through its API; a failed deployment is not reverted automatically."],
      };
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const { app } = await findApp(conn, manifest.name);
      return {
        adapter: "dokploy",
        app: { adapter: "dokploy", name: manifest.name, id: app?.applicationId, connection: conn },
        manifest,
        artifact: "source",
        firstDeployment: !app,
        steps: [
          { id: "app", title: app ? `Update application ${manifest.name}` : `Create application ${manifest.name}`, action: app ? "update" : "create" },
          { id: "env", title: "Set environment variables", action: "update" },
          { id: "deploy", title: "Upload the source; Dokploy builds and deploys it", action: "create" },
        ],
        resources: [],
        warnings: manifest.release ? [`Dokploy does not run the release command "${manifest.release.command}"; run it when the app starts.`] : [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "source") throw new LotseError("DEPLOY_FAILED", "Dokploy builds from the uploaded source.");
      throwIfAborted(ctx.signal);
      const conn = ctx.connection;
      const api = client(conn);
      const manifest = plan.manifest;

      let id = plan.app.id;
      if (!id) {
        yield event.log("deploy", `Creating application ${manifest.name}`);
        await api.post("/application.create", { name: manifest.name, environmentId: await ensureEnvironment(conn) });
        id = (await findApp(conn, manifest.name)).app?.applicationId;
        if (!id) throw new LotseError("PROVIDER_ERROR", "Dokploy created the application but did not list it afterwards.");
      }
      const isStatic = manifest.runtime.kind === "static";
      await api.post("/application.saveBuildType", {
        applicationId: id,
        buildType: manifest.build.strategy === "dockerfile" ? "dockerfile" : isStatic && !manifest.build.command ? "static" : "railpack",
        dockerfile: manifest.build.dockerfile ?? "Dockerfile",
        dockerContextPath: "",
        dockerBuildStage: "",
        herokuVersion: "",
        railpackVersion: "",
        publishDirectory: isStatic ? (manifest.build.output ?? ".") : undefined,
        isStaticSpa: isStatic,
      });
      await api.post("/application.saveEnvironment", { applicationId: id, env: envText(ctx.env), buildArgs: "", buildSecrets: "", createEnvFile: true });

      const current = await one(conn, id);
      let host = current.domains?.[0]?.host;
      let https = current.domains?.[0]?.https ?? false;
      if (!host) {
        host = await api.post<string>("/domain.generateDomain", { appName: current.appName });
        https = false;
        await api.post("/domain.create", {
          host,
          port: isStatic ? 80 : (manifest.runtime.port ?? 3000),
          https,
          applicationId: id,
          certificateType: "none",
          domainType: "application",
        });
      }

      throwIfAborted(ctx.signal);
      const entries = await walkFiles(artifact.dir, { ignore: artifact.ignore });
      const files: Record<string, Uint8Array> = {};
      for (const e of entries) files[e.path] = new Uint8Array(await readFile(e.abs));
      yield event.log("deploy", `Uploading ${entries.length} files`);
      const form = new FormData();
      form.append("applicationId", id);
      form.append("zip", new File([Buffer.from(zipSync(files))], `${manifest.name}.zip`, { type: "application/zip" }));
      await api.post("/application.dropDeployment", form, { signal: ctx.signal });

      let status = "";
      for (;;) {
        const app = await one(conn, id);
        if (app.applicationStatus !== status) {
          status = app.applicationStatus ?? "idle";
          yield event.log("deploy", `Dokploy: ${status}`);
        }
        if (status === "done") break;
        if (status === "error") throw new LotseError("DEPLOY_FAILED", "Dokploy reported the deployment as failed. Its dashboard shows the build log.");
        await sleep(pollMs, ctx.signal);
      }
      const ref: DeploymentRef = {
        id: `${id}-${Date.now().toString(36)}`,
        app: { ...plan.app, id },
        url: `${https ? "https" : "http"}://${host}`,
        createdAt: Date.now(),
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(): Promise<void> {
      throw new LotseError("ROLLBACK_UNSUPPORTED", "Dokploy does not offer rollbacks through its API. Deploy the earlier version again.");
    },

    async destroy(app: AppRef): Promise<void> {
      const id = app.id ?? (await findApp(app.connection, app.name)).app?.applicationId;
      if (id) await client(app.connection).post("/application.delete", { applicationId: id });
    },

    async setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
      const id = await appId(app);
      const api = client(app.connection);
      const current = await one(app.connection, id);
      const merged = new Map<string, string>();
      for (const line of (current.env ?? "").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) merged.set(line.slice(0, i), line.slice(i + 1));
      }
      for (const line of envText(vars).split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) merged.set(line.slice(0, i), line.slice(i + 1));
      }
      await api.post("/application.saveEnvironment", {
        applicationId: id,
        env: [...merged].map(([k, v]) => `${k}=${v}`).join("\n"),
        buildArgs: "",
        buildSecrets: "",
        createEnvFile: true,
      });
      await api.post("/application.redeploy", { applicationId: id });
    },

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const id = await appId(app);
      const current = await one(app.connection, id);
      if (!current.domains?.some((d) => d.host === domain)) {
        await client(app.connection).post("/domain.create", {
          host: domain,
          https: true,
          applicationId: id,
          certificateType: "letsencrypt",
          domainType: "application",
        });
      }
      const server = new URL(app.connection.settings.baseUrl as string).hostname;
      return {
        domain,
        state: "pending",
        dnsRecords: [/^\d+\.\d+\.\d+\.\d+$/.test(server) ? { type: "A", name: domain, value: server } : { type: "CNAME", name: domain, value: server }],
        message: "Point the domain to the Dokploy server; the certificate is issued on the next deployment.",
      };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "postgres" && res.type !== "redis")
        throw new LotseError("RESOURCE_UNSUPPORTED", `Dokploy provides postgres and redis through this adapter, not ${res.type}.`);
      const conn = app.connection;
      const api = client(conn);
      const environmentId = await ensureEnvironment(conn);
      const name = `${app.name}-${res.name}`;
      const appName = `${name}-${randomBytes(3).toString("hex")}`;
      const password = randomBytes(24).toString("base64url");
      const kind = res.type === "postgres" ? "postgres" : "redis";
      await api.post(
        `/${kind}.create`,
        kind === "postgres"
          ? { name, appName, databaseName: "app", databaseUser: "app", databasePassword: password, environmentId }
          : { name, appName, databasePassword: password, environmentId },
      );
      // Read the identifier back: the create response is not specified.
      const project = (await projects(conn)).find((p) => p.name === PROJECT) as unknown as {
        environments?: Record<string, { name: string; appName: string; postgresId?: string; redisId?: string }[]>[];
      };
      const created = project?.environments?.flatMap((e) => e[kind] ?? []).find((d) => d.name === name);
      const id = created?.postgresId ?? created?.redisId;
      if (!created || !id) throw new LotseError("PROVIDER_ERROR", `Dokploy created the ${kind} database but did not list it afterwards.`);
      await api.post(`/${kind}.deploy`, { [`${kind}Id`]: id });
      const url = kind === "postgres" ? `postgres://app:${password}@${created.appName}:5432/app` : `redis://default:${password}@${created.appName}:6379`;
      return { type: res.type, name: res.name, id, provider: "dokploy", env: [{ name: resourceEnvName(res.type, res.name), value: url, secret: true }] };
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const id = await appId(app);
      const raw = await client(app.connection).get<string | string[] | { logs?: string }>("/application.readLogs", {
        query: { applicationId: id, tail: opts.tail ?? 100 },
        signal: opts.signal,
      });
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("\n") : (raw?.logs ?? "");
      for (const line of text.split("\n")) if (line.trim()) yield { at: Date.now(), stream: "stdout", line };
    },

    async status(app: AppRef): Promise<AppStatus> {
      const id = app.id ?? (await findApp(app.connection, app.name)).app?.applicationId;
      if (!id) return { state: "not-found", domains: [] };
      const current = await one(app.connection, id);
      const domain = current.domains?.[0];
      const state =
        current.applicationStatus === "done"
          ? "running"
          : current.applicationStatus === "running"
            ? "deploying"
            : current.applicationStatus === "error"
              ? "failed"
              : "stopped";
      return { state, url: domain ? `${domain.https ? "https" : "http"}://${domain.host}` : undefined, domains: (current.domains ?? []).map((d) => d.host) };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createDokployAdapter };
export default pkg;
