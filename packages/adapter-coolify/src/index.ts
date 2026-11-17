/**
 * Coolify hosting adapter (self-hosted PaaS). Apps are deployed either as a
 * container image from a registry or, when no registry is configured, built
 * by Coolify from the project's Git repository.
 */
import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  type AppStatus,
  accessToken,
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
  type ResourceRef,
  type ResourceSpec,
  resourceEnvName,
  sleep,
  throwIfAborted,
  type VerifyResult,
} from "@lotseai/core";

interface CoolifyApp {
  uuid: string;
  name: string;
  fqdn?: string | null;
  status?: string;
  docker_registry_image_tag?: string | null;
}

interface CoolifyDeployment {
  deployment_uuid: string;
  status: string;
  commit?: string | null;
  logs?: string | null;
}

const capabilities: Capabilities = {
  runtimes: ["static", "server", "container"],
  languages: ["node", "python", "go", "php"],
  resources: ["postgres", "redis"],
  customDomains: true,
  previewDeployments: false,
  rollback: "native",
};

const PROJECT_NAME = "lotse";

export function createCoolifyAdapter(options: AdapterOptions & { resolve?: (domain: string) => Promise<string[]> } = {}): HostingAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 3000);
  const images = () => options.images ?? cliImageTools();

  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Coolify",
      baseUrl: `${(conn.settings.baseUrl ?? "https://app.coolify.io").replace(/\/+$/, "")}/api/v1`,
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });

  async function findApp(conn: Connection, name: string): Promise<CoolifyApp | undefined> {
    const apps = await client(conn).get<CoolifyApp[]>("/applications");
    return apps.find((a) => a.name === name);
  }

  async function requireApp(app: AppRef): Promise<CoolifyApp> {
    const http = client(app.connection);
    if (app.id) return http.get<CoolifyApp>(`/applications/${app.id}`);
    const found = await findApp(app.connection, app.name);
    if (!found) throw new LotseError("NOT_FOUND", `There is no Coolify application "${app.name}".`);
    return found;
  }

  async function ensureProject(conn: Connection): Promise<string> {
    if (conn.settings.projectUuid) return conn.settings.projectUuid;
    const http = client(conn);
    const projects = await http.get<{ uuid: string; name: string }[]>("/projects");
    const existing = projects.find((p) => p.name === PROJECT_NAME);
    if (existing) return existing.uuid;
    return (await http.post<{ uuid: string }>("/projects", { name: PROJECT_NAME, description: "Apps deployed with Lotse" })).uuid;
  }

  async function waitForDeployment(conn: Connection, uuid: string, signal: AbortSignal | undefined, onState: (s: string) => void): Promise<CoolifyDeployment> {
    const http = client(conn);
    let last = "";
    for (;;) {
      const d = await http.get<CoolifyDeployment>(`/deployments/${uuid}`);
      if (d.status !== last) {
        last = d.status;
        onState(d.status);
      }
      if (d.status === "finished") return d;
      if (d.status === "failed" || d.status.startsWith("cancelled")) {
        const tail = lastLogLines(d.logs);
        throw new LotseError("DEPLOY_FAILED", `Coolify reported the deployment as ${d.status}${tail ? `:\n${tail}` : "."}`);
      }
      try {
        await sleep(pollMs, signal);
      } catch (err) {
        await http.post(`/deployments/${uuid}/cancel`).catch(() => {});
        throw err;
      }
    }
  }

  async function setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    const uuid = app.id ?? (await requireApp(app)).uuid;
    await client(app.connection).patch(`/applications/${uuid}/envs/bulk`, {
      data: vars.map((v) => ({ key: v.name, value: v.value, is_literal: true, is_multiline: v.value.includes("\n"), is_shown_once: v.secret })),
    });
  }

  const firstUrl = (fqdn?: string | null) => fqdn?.split(",")[0]?.trim() || undefined;

  return {
    id: "coolify",
    displayName: "Coolify",
    auth: ["token"],
    capabilities,
    tokenSetup: {
      url: "{baseUrl}/security/api-tokens",
      permissions: ["read", "write", "deploy"],
      steps: [
        "Open “Keys & Tokens” → “API tokens” in your Coolify instance.",
        "Create a token with the permissions read, write and deploy. A root token is not needed.",
        "Copy the token and paste it here together with the address of your instance.",
      ],
      fields: [
        { name: "baseUrl", label: "Instance address", required: true, placeholder: "https://coolify.example.com" },
        { name: "serverUuid", label: "Server UUID", required: false, help: "Defaults to the first server of the instance." },
        {
          name: "registry",
          label: "Container registry",
          required: false,
          placeholder: "ghcr.io/acme",
          help: "Without a registry, Coolify builds from the linked Git repository.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      if (input.method !== "token") throw new LotseError("INVALID_INPUT", "Coolify is connected with an API token.");
      const baseUrl = (input.options?.baseUrl ?? "https://app.coolify.io").replace(/\/+$/, "");
      const conn: Connection = {
        adapter: "coolify",
        method: "token",
        account: { id: "", name: "" },
        credentials: { token: input.token, ...input.secrets },
        settings: { ...input.options, baseUrl },
      };
      const http = client(conn);
      const team = await http.get<{ id: number; name: string }>("/team");
      const servers = await http.get<{ uuid: string; name: string; ip?: string }[]>("/servers");
      const server = conn.settings.serverUuid ? servers.find((s) => s.uuid === conn.settings.serverUuid) : servers[0];
      if (!server) {
        throw new LotseError(
          "INVALID_INPUT",
          conn.settings.serverUuid
            ? `The Coolify instance has no server ${conn.settings.serverUuid}.`
            : "The Coolify instance has no server yet. Add one in Coolify first.",
        );
      }
      conn.settings.serverUuid = server.uuid;
      if (server.ip) conn.settings.serverIp = server.ip;
      conn.account = { id: String(team.id), name: `${team.name} @ ${new URL(baseUrl).host}` };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      const http = client(conn);
      try {
        await http.get("/team");
        await http.get("/projects");
        await http.get("/servers");
      } catch (err) {
        if (!(isLotseError(err) && (err.code === "PERMISSION_MISSING" || err.code === "AUTH_FAILED"))) throw err;
        result.ok = false;
        result.missingPermissions.push(err.code === "AUTH_FAILED" ? "A valid API token" : "read");
        return result;
      }
      result.warnings.push("Coolify does not report token permissions; make sure the token has read, write and deploy.");
      if (!conn.settings.registry) result.warnings.push("No container registry is configured: apps are built by Coolify from the linked Git repository.");
      return result;
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const app = await findApp(conn, manifest.name);
      const viaRegistry = Boolean(conn.settings.registry);
      return {
        adapter: "coolify",
        app: { adapter: "coolify", name: manifest.name, id: app?.uuid, connection: conn },
        manifest,
        artifact: viaRegistry ? "image" : "source",
        firstDeployment: !app,
        steps: [
          { id: "app", title: app ? `Update application ${manifest.name}` : `Create application ${manifest.name}`, action: app ? "update" : "create" },
          { id: "env", title: "Set environment variables", action: "update" },
          viaRegistry
            ? { id: "deploy", title: `Push the image to ${conn.settings.registry} and deploy it`, action: "create" }
            : { id: "deploy", title: "Let Coolify build the linked Git repository and deploy it", action: "create" },
        ],
        resources: [],
        warnings: viaRegistry ? [] : ["Coolify builds from Git: only commits that were pushed to the repository are deployed."],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      const conn = ctx.connection;
      const http = client(conn);
      const manifest = plan.manifest;
      throwIfAborted(ctx.signal);
      if (artifact.kind === "static") throw new LotseError("DEPLOY_FAILED", "Coolify needs an image or a Git repository, not a prebuilt folder.");
      if (artifact.kind === "source" && !ctx.repository) {
        throw new LotseError("DEPLOY_FAILED", "Coolify builds from Git, but this project is not linked to a Git repository.", {
          hints: ["Link the project to GitHub, GitLab or Forgejo, or configure a container registry for the Coolify connection."],
        });
      }

      const port = artifact.kind === "image" ? (artifact.port ?? manifest.runtime.port ?? 3000) : (manifest.runtime.port ?? 80);
      const common = {
        ports_exposes: String(port),
        health_check_enabled: true,
        health_check_path: manifest.runtime.healthcheck,
        ...(manifest.release ? { pre_deployment_command: manifest.release.command } : {}),
      };

      let tag: string | undefined;
      let imageName: string | undefined;
      if (artifact.kind === "image") {
        tag = artifact.image.split(":").pop() as string;
        imageName = `${(conn.settings.registry as string).replace(/\/+$/, "")}/${manifest.name}`;
        const auth = conn.credentials.registryPassword
          ? { registry: imageName.split("/")[0] as string, username: conn.credentials.registryUsername ?? "", password: conn.credentials.registryPassword }
          : undefined;
        yield* images().push(artifact.image, `${imageName}:${tag}`, auth, ctx.signal);
      }

      let uuid = plan.app.id;
      if (!uuid) {
        yield event.log("deploy", `Creating application ${manifest.name}`);
        const base = {
          project_uuid: await ensureProject(conn),
          server_uuid: conn.settings.serverUuid,
          environment_name: conn.settings.environmentName ?? "production",
          name: manifest.name,
          instant_deploy: false,
          autogenerate_domain: true,
          ...common,
        };
        if (artifact.kind === "image") {
          uuid = (
            await http.post<{ uuid: string }>("/applications/dockerimage", { ...base, docker_registry_image_name: imageName, docker_registry_image_tag: tag })
          ).uuid;
        } else {
          const repo = ctx.repository as NonNullable<DeployContext["repository"]>;
          const isStatic = manifest.runtime.kind === "static";
          const git = {
            ...base,
            git_repository: repo.url,
            git_branch: repo.branch,
            build_pack: manifest.build.strategy === "dockerfile" ? "dockerfile" : isStatic && !manifest.build.command ? "static" : "nixpacks",
            ...(isStatic ? { is_static: true, publish_directory: `/${(manifest.build.output ?? ".").replace(/^\.?\/?/, "")}` } : {}),
            ...(manifest.build.command ? { build_command: manifest.build.command } : {}),
            ...(manifest.runtime.start ? { start_command: manifest.runtime.start } : {}),
          };
          const endpoint = conn.settings.githubAppUuid
            ? "/applications/private-github-app"
            : conn.settings.privateKeyUuid
              ? "/applications/private-deploy-key"
              : "/applications/public";
          const extra = conn.settings.githubAppUuid
            ? { github_app_uuid: conn.settings.githubAppUuid }
            : conn.settings.privateKeyUuid
              ? { private_key_uuid: conn.settings.privateKeyUuid }
              : {};
          uuid = (await http.post<{ uuid: string }>(endpoint, { ...git, ...extra })).uuid;
        }
      } else {
        await http.patch(
          `/applications/${uuid}`,
          artifact.kind === "image" ? { ...common, docker_registry_image_name: imageName, docker_registry_image_tag: tag } : common,
        );
      }
      const app: AppRef = { ...plan.app, id: uuid };
      await setEnv(
        app,
        ctx.env.filter((v) => v.name !== "PORT"),
      );

      throwIfAborted(ctx.signal);
      const started = await http.post<{ deployments: { deployment_uuid: string }[] }>("/deploy", undefined, {
        query: { uuid, ...(tag ? { docker_tag: tag } : {}) },
      });
      const deploymentUuid = started.deployments[0]?.deployment_uuid;
      if (!deploymentUuid) throw new LotseError("DEPLOY_FAILED", "Coolify did not start a deployment.");
      yield event.log("deploy", `Deployment ${deploymentUuid} queued`);
      const states: string[] = [];
      const finished = await waitForDeployment(conn, deploymentUuid, ctx.signal, (s) => states.push(s));
      for (const s of states) yield event.log("deploy", `Coolify: ${s.replace(/_/g, " ")}`);

      const current = await http.get<CoolifyApp>(`/applications/${uuid}`);
      const ref: DeploymentRef = {
        id: deploymentUuid,
        app,
        url: firstUrl(current.fqdn),
        createdAt: Date.now(),
        version: tag ?? finished.commit ?? undefined,
      };
      if (!ref.url) throw new LotseError("DEPLOY_FAILED", "Coolify deployed the app but assigned no address. Add a domain to the application.");
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      if (!target.version) throw new LotseError("ROLLBACK_FAILED", `Deployment ${target.id} has no image tag or commit to roll back to.`);
      const uuid = target.app.id ?? (await requireApp(target.app)).uuid;
      const res = await client(ctx.connection).post<{ deployment_uuid?: string }>(`/applications/${uuid}/rollback`, { commit: target.version });
      if (res.deployment_uuid) await waitForDeployment(ctx.connection, res.deployment_uuid, ctx.signal, () => {});
    },

    async destroy(app: AppRef): Promise<void> {
      const uuid = app.id ?? (await findApp(app.connection, app.name))?.uuid;
      if (!uuid) return;
      await client(app.connection).delete(`/applications/${uuid}`, { query: { delete_configurations: true, delete_volumes: true, docker_cleanup: true } });
    },

    setEnv,

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const http = client(app.connection);
      const current = await requireApp(app);
      const urls = (current.fqdn ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      if (!urls.some((u) => new URL(u).host === domain)) {
        await http.patch(`/applications/${current.uuid}`, { domains: [...urls, `https://${domain}`].join(",") });
      }
      const ip = app.connection.settings.serverIp;
      const resolved = await (options.resolve ?? resolve4)(domain).catch(() => [] as string[]);
      if (ip && resolved.includes(ip)) return { domain, state: "active", dnsRecords: [] };
      return {
        domain,
        state: "pending",
        dnsRecords: ip ? [{ type: "A", name: domain, value: ip }] : [],
        message: "Point the domain to the Coolify server, then redeploy so the proxy picks it up.",
      };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "postgres" && res.type !== "redis")
        throw new LotseError("RESOURCE_UNSUPPORTED", `Coolify provides postgres and redis through this adapter, not ${res.type}.`);
      const conn = app.connection;
      const http = client(conn);
      const password = randomBytes(24).toString("base64url");
      const name = `${app.name}-${res.name}`;
      const base = {
        server_uuid: conn.settings.serverUuid,
        project_uuid: await ensureProject(conn),
        environment_name: conn.settings.environmentName ?? "production",
        name,
        instant_deploy: true,
      };
      const created =
        res.type === "postgres"
          ? await http.post<{ uuid: string; internal_db_url?: string }>("/databases/postgresql", {
              ...base,
              postgres_user: "app",
              postgres_password: password,
              postgres_db: "app",
            })
          : await http.post<{ uuid: string; internal_db_url?: string }>("/databases/redis", { ...base, redis_password: password });
      const url = created.internal_db_url ?? (await http.get<{ internal_db_url?: string }>(`/databases/${created.uuid}`)).internal_db_url;
      if (!url) throw new LotseError("PROVIDER_ERROR", `Coolify created the ${res.type} database but returned no connection URL.`);
      return {
        type: res.type,
        name: res.name,
        id: created.uuid,
        provider: "coolify",
        env: [{ name: resourceEnvName(res.type, res.name), value: url, secret: true }],
      };
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const uuid = app.id ?? (await requireApp(app)).uuid;
      const { logs } = await client(app.connection).get<{ logs: string }>(`/applications/${uuid}/logs`, {
        query: { lines: opts.tail ?? 100, show_timestamps: true },
        signal: opts.signal,
      });
      for (const raw of (logs ?? "").split("\n")) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z?)\s(.*)$/);
        yield { at: m ? Date.parse(m[1] as string) : Date.now(), stream: "stdout", line: m ? (m[2] as string) : raw };
      }
    },

    async status(app: AppRef): Promise<AppStatus> {
      let current: CoolifyApp | undefined;
      try {
        current = app.id ? await client(app.connection).get<CoolifyApp>(`/applications/${app.id}`) : await findApp(app.connection, app.name);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
      if (!current) return { state: "not-found", domains: [] };
      const status = current.status ?? "unknown";
      const domains = (current.fqdn ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => new URL(u).host);
      const state = status.startsWith("running")
        ? "running"
        : status.startsWith("exited") || status.startsWith("stopped")
          ? "stopped"
          : /start|restart|progress/.test(status)
            ? "deploying"
            : status.includes("unhealthy") || status.startsWith("degraded")
              ? "failed"
              : "unknown";
      return { state, url: firstUrl(current.fqdn), domains, message: state === "running" ? undefined : `Coolify reports "${status}".` };
    },
  };
}

function lastLogLines(logs?: string | null): string {
  if (!logs) return "";
  try {
    // Coolify stores deployment logs as a JSON array of { output, type, hidden } entries.
    const entries = JSON.parse(logs) as { output?: string; hidden?: boolean }[];
    return entries
      .filter((e) => !e.hidden && e.output)
      .slice(-8)
      .map((e) => e.output)
      .join("\n");
  } catch {
    return logs.split("\n").slice(-8).join("\n");
  }
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createCoolifyAdapter };
export default pkg;
