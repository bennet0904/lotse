/**
 * Railway hosting adapter (GraphQL API). The source is uploaded and built by
 * Railway; with a container registry configured, a locally built image is
 * deployed instead.
 */
import { randomBytes } from "node:crypto";
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
  type LogLine,
  type LogOptions,
  LotseError,
  type Manifest,
  type ResourceRef,
  type ResourceSpec,
  redact,
  resourceEnvName,
  sleep,
  tarBuffer,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotse/core";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const UPLOAD = "https://backboard.railway.com";

interface Project {
  id: string;
  name: string;
  environments: { edges: { node: { id: string; name: string } }[] };
  services: { edges: { node: { id: string; name: string } }[] };
}

const PROJECT_FIELDS = "id name environments { edges { node { id name } } } services { edges { node { id name } } }";
const capabilities: Capabilities = {
  runtimes: ["server", "container"],
  languages: ["node", "python", "go", "php"],
  resources: ["postgres", "redis"],
  customDomains: true,
  previewDeployments: false,
  rollback: "native",
};
const DONE = new Set(["SUCCESS", "SLEEPING"]);
const FAILED = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

export function createRailwayAdapter(options: AdapterOptions = {}): HostingAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 3000);
  const fetchImpl = options.fetch ?? fetch;
  const images = () => options.images ?? cliImageTools();

  async function gql<T>(conn: Connection, query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken(conn)}` },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (res.status === 401 || body.errors?.some((e) => /not authorized|unauthorized|invalid.*token/i.test(e.message))) {
      throw new LotseError("AUTH_FAILED", `Railway did not accept the token${body.errors?.[0] ? `: ${body.errors[0].message}` : "."}`);
    }
    if (!res.ok || body.errors?.length) {
      throw new LotseError(
        "PROVIDER_ERROR",
        redact(`Railway responded with ${res.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "request failed"}`),
        { details: { status: res.status } },
      );
    }
    return body.data as T;
  }

  async function findProject(conn: Connection, name: string): Promise<Project | undefined> {
    const data = await gql<{ projects: { edges: { node: Project }[] } }>(conn, `query projects { projects { edges { node { ${PROJECT_FIELDS} } } } }`);
    return data.projects.edges.map((e) => e.node).find((p) => p.name === name);
  }

  interface Target {
    projectId: string;
    environmentId: string;
    serviceId: string;
  }

  async function target(app: AppRef): Promise<Target> {
    if (app.meta?.environmentId && app.meta.serviceId && app.id)
      return { projectId: app.id, environmentId: app.meta.environmentId, serviceId: app.meta.serviceId };
    const project = await findProject(app.connection, app.name);
    const environment = project?.environments.edges.find((e) => e.node.name === "production")?.node ?? project?.environments.edges[0]?.node;
    const service = project?.services.edges.find((e) => e.node.name === app.name)?.node;
    if (!project || !environment || !service) throw new LotseError("NOT_FOUND", `There is no Railway project "${app.name}".`);
    return { projectId: project.id, environmentId: environment.id, serviceId: service.id };
  }

  async function setVariables(conn: Connection, t: Target, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    await gql(conn, "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }", {
      input: {
        projectId: t.projectId,
        environmentId: t.environmentId,
        serviceId: t.serviceId,
        variables: Object.fromEntries(vars.map((v) => [v.name, v.value])),
        skipDeploys: true,
      },
    });
  }

  async function waitFor(
    conn: Connection,
    deploymentId: string,
    signal: AbortSignal | undefined,
    onStatus: (s: string) => void,
  ): Promise<{ status: string; staticUrl?: string | null }> {
    let last = "";
    for (;;) {
      const { deployment } = await gql<{ deployment: { status: string; staticUrl?: string | null } }>(
        conn,
        "query deployment($id: String!) { deployment(id: $id) { id status staticUrl } }",
        { id: deploymentId },
      );
      if (deployment.status !== last) {
        last = deployment.status;
        onStatus(last);
      }
      if (DONE.has(deployment.status)) return deployment;
      if (FAILED.has(deployment.status)) throw new LotseError("DEPLOY_FAILED", `Railway reported the deployment as ${deployment.status.toLowerCase()}.`);
      try {
        await sleep(pollMs, signal);
      } catch (err) {
        // Railway keeps the previous deployment active until a new one succeeds.
        await gql(conn, "mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }", { id: deploymentId }).catch(() => {});
        throw err;
      }
    }
  }

  return {
    id: "railway",
    displayName: "Railway",
    auth: ["oauth", "token"],
    capabilities,
    oauth: {
      authorizationEndpoint: "https://backboard.railway.com/oauth/auth",
      tokenEndpoint: "https://backboard.railway.com/oauth/token",
      // Railway supports dynamic client registration: the instance registers itself on the first connection attempt.
      registrationEndpoint: "https://backboard.railway.com/oauth/register",
      scopes: ["openid", "profile", "email", "offline_access", "workspace:member"],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_RAILWAY",
    },
    tokenSetup: {
      url: "https://railway.com/account/tokens",
      permissions: ["An account or workspace token (a project token is not enough: Lotse creates the project)"],
      steps: ["Create a new token; choose the workspace that should own the apps.", "Copy the token and paste it here."],
      fields: [
        {
          name: "registry",
          label: "Container registry",
          required: false,
          placeholder: "ghcr.io/acme",
          help: "Optional. Without a registry Railway builds the app from its source.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("railway", input, input.options);
      const { me } = await gql<{ me: { id: string; name?: string; email?: string } }>(conn, "query me { me { id name email } }");
      conn.account = { id: me.id, name: me.name || me.email || me.id };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      await gql(conn, "query projects { projects { edges { node { id name } } } }");
      return { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const project = await findProject(conn, manifest.name);
      const viaRegistry = Boolean(conn.settings.registry);
      return {
        adapter: "railway",
        app: { adapter: "railway", name: manifest.name, id: project?.id, connection: conn },
        manifest,
        artifact: viaRegistry ? "image" : "source",
        firstDeployment: !project,
        steps: [
          { id: "app", title: project ? `Use project ${project.name}` : `Create project ${manifest.name}`, action: project ? "noop" : "create" },
          { id: "env", title: "Set variables", action: "update" },
          {
            id: "deploy",
            title: viaRegistry ? `Push the image to ${conn.settings.registry} and deploy it` : "Upload the source; Railway builds and deploys it",
            action: "create",
          },
        ],
        resources: [],
        warnings: [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind === "static") throw new LotseError("DEPLOY_FAILED", "Railway deploys source code or images, not prebuilt folders.");
      throwIfAborted(ctx.signal);
      const conn = ctx.connection;
      const manifest = plan.manifest;

      let project = await findProject(conn, manifest.name);
      if (!project) {
        yield event.log("deploy", `Creating project ${manifest.name}`);
        project = (
          await gql<{ projectCreate: Project }>(
            conn,
            `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { ${PROJECT_FIELDS} } }`,
            { input: { name: manifest.name, description: "Deployed with Lotse" } },
          )
        ).projectCreate;
      }
      const environment = project.environments.edges.find((e) => e.node.name === "production")?.node ?? project.environments.edges[0]?.node;
      if (!environment) throw new LotseError("PROVIDER_ERROR", "The Railway project has no environment.");
      let serviceId = project.services.edges.find((e) => e.node.name === manifest.name)?.node.id;
      if (!serviceId) {
        serviceId = (
          await gql<{ serviceCreate: { id: string } }>(conn, "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }", {
            input: { projectId: project.id, name: manifest.name },
          })
        ).serviceCreate.id;
      }
      const t: Target = { projectId: project.id, environmentId: environment.id, serviceId };
      await setVariables(conn, t, ctx.env);

      let image: string | undefined;
      if (artifact.kind === "image") {
        image = `${(conn.settings.registry as string).replace(/\/+$/, "")}/${manifest.name}:${artifact.image.split(":").pop()}`;
        const auth = conn.credentials.registryPassword
          ? { registry: image.split("/")[0] as string, username: conn.credentials.registryUsername ?? "", password: conn.credentials.registryPassword }
          : undefined;
        yield* images().push(artifact.image, image, auth, ctx.signal);
      }
      await gql(
        conn,
        "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
        {
          serviceId,
          environmentId: environment.id,
          input: {
            healthcheckPath: manifest.runtime.healthcheck,
            ...(manifest.runtime.start ? { startCommand: manifest.runtime.start } : {}),
            ...(manifest.release ? { preDeployCommand: [manifest.release.command] } : {}),
            ...(image ? { source: { image } } : {}),
          },
        },
      );

      throwIfAborted(ctx.signal);
      let deploymentId: string;
      if (artifact.kind === "source") {
        const entries = await walkFiles(artifact.dir, { ignore: artifact.ignore });
        yield event.log("deploy", `Uploading ${entries.length} files`);
        const res = await fetchImpl(`${UPLOAD}/project/${project.id}/environment/${environment.id}/up?serviceId=${serviceId}`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken(conn)}`, "content-type": "application/gzip" },
          body: new Uint8Array(await tarBuffer(entries, { gzip: true })),
          signal: ctx.signal,
        });
        const up = (await res.json().catch(() => ({}))) as { deploymentId?: string; message?: string };
        if (!res.ok || !up.deploymentId)
          throw new LotseError("DEPLOY_FAILED", `Railway did not accept the upload (HTTP ${res.status}${up.message ? `: ${up.message}` : ""}).`);
        deploymentId = up.deploymentId;
      } else {
        deploymentId = (
          await gql<{ serviceInstanceDeployV2: string }>(
            conn,
            "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
            { serviceId, environmentId: environment.id },
          )
        ).serviceInstanceDeployV2;
      }
      yield event.log("deploy", `Deployment ${deploymentId} started`);
      const statuses: string[] = [];
      await waitFor(conn, deploymentId, ctx.signal, (s) => statuses.push(s));
      for (const s of statuses) yield event.log("deploy", `Railway: ${s.toLowerCase()}`);

      const domains = await gql<{ domains: { serviceDomains: { domain: string }[] } }>(
        conn,
        "query domains($projectId: String!, $environmentId: String!, $serviceId: String!) { domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { serviceDomains { domain } } }",
        t as unknown as Record<string, unknown>,
      );
      let domain = domains.domains.serviceDomains[0]?.domain;
      if (!domain) {
        domain = (
          await gql<{ serviceDomainCreate: { domain: string } }>(
            conn,
            "mutation serviceDomainCreate($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }",
            {
              input: {
                serviceId,
                environmentId: environment.id,
                targetPort: artifact.kind === "image" ? (artifact.port ?? manifest.runtime.port) : manifest.runtime.port,
              },
            },
          )
        ).serviceDomainCreate.domain;
      }
      const ref: DeploymentRef = {
        id: deploymentId,
        app: { ...plan.app, id: project.id, meta: { environmentId: environment.id, serviceId } },
        url: `https://${domain}`,
        createdAt: Date.now(),
        version: deploymentId,
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      await gql(ctx.connection, "mutation deploymentRollback($id: String!) { deploymentRollback(id: $id) }", { id: target.id });
    },

    async destroy(app: AppRef): Promise<void> {
      const id = app.id ?? (await findProject(app.connection, app.name))?.id;
      if (id) await gql(app.connection, "mutation projectDelete($id: String!) { projectDelete(id: $id) }", { id });
    },

    async setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
      const t = await target(app);
      await setVariables(app.connection, t, vars);
      // Variables take effect with the next deployment; trigger it so the running app picks them up.
      await gql(
        app.connection,
        "mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }",
        { serviceId: t.serviceId, environmentId: t.environmentId },
      );
    },

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const t = await target(app);
      const created = await gql<{
        customDomainCreate: { id: string; status: { dnsRecords: { hostlabel: string; requiredValue: string; recordType: string; zone: string }[] } };
      }>(
        app.connection,
        "mutation customDomainCreate($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id status { dnsRecords { hostlabel requiredValue recordType zone } } } }",
        { input: { ...t, domain } },
      );
      return {
        domain,
        state: "pending",
        dnsRecords: created.customDomainCreate.status.dnsRecords.map((r) => ({
          type: r.recordType.replace(/^DNS_RECORD_TYPE_/, "") as "CNAME",
          name: r.hostlabel ? `${r.hostlabel}.${r.zone}` : r.zone,
          value: r.requiredValue,
        })),
      };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "postgres" && res.type !== "redis")
        throw new LotseError("RESOURCE_UNSUPPORTED", `Railway provides postgres and redis through this adapter, not ${res.type}.`);
      const conn = app.connection;
      let project = await findProject(conn, app.name);
      project ??= (
        await gql<{ projectCreate: Project }>(
          conn,
          `mutation projectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { ${PROJECT_FIELDS} } }`,
          { input: { name: app.name, description: "Deployed with Lotse" } },
        )
      ).projectCreate;
      const environment = (project.environments.edges.find((e) => e.node.name === "production") ?? project.environments.edges[0])?.node;
      if (!environment) throw new LotseError("PROVIDER_ERROR", "The Railway project has no environment.");
      const name = `${app.name}-${res.name}`;
      const password = randomBytes(24).toString("base64url");
      const pg = res.type === "postgres";
      const service = (
        await gql<{ serviceCreate: { id: string } }>(conn, "mutation serviceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }", {
          input: { projectId: project.id, name, source: { image: pg ? "postgres:17-alpine" : "redis:7-alpine" } },
        })
      ).serviceCreate.id;
      await gql(conn, "mutation volumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }", {
        input: { projectId: project.id, environmentId: environment.id, serviceId: service, mountPath: pg ? "/var/lib/postgresql/data" : "/data" },
      });
      const t: Target = { projectId: project.id, environmentId: environment.id, serviceId: service };
      await setVariables(
        conn,
        t,
        pg
          ? [
              { name: "POSTGRES_USER", value: "app", secret: false },
              { name: "POSTGRES_DB", value: "app", secret: false },
              { name: "POSTGRES_PASSWORD", value: password, secret: true },
              { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata", secret: false },
            ]
          : [{ name: "REDIS_PASSWORD", value: password, secret: true }],
      );
      if (!pg)
        await gql(
          conn,
          "mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
          { serviceId: service, environmentId: environment.id, input: { startCommand: 'sh -c "exec redis-server --requirepass $REDIS_PASSWORD --dir /data"' } },
        );
      await gql(
        conn,
        "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
        { serviceId: service, environmentId: environment.id },
      );
      // Services of one project reach each other over Railway's private network.
      const host = `${name}.railway.internal`;
      const url = pg ? `postgres://app:${password}@${host}:5432/app` : `redis://:${password}@${host}:6379`;
      return {
        type: res.type,
        name: res.name,
        id: service,
        provider: "railway",
        env: [{ name: resourceEnvName(res.type, res.name), value: url, secret: true }],
      };
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const t = await target(app);
      const latest = await gql<{ deployments: { edges: { node: { id: string } }[] } }>(
        app.connection,
        "query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }",
        { input: t },
      );
      const id = opts.deployment ?? latest.deployments.edges[0]?.node.id;
      if (!id) return;
      const data = await gql<{ deploymentLogs: { message: string; timestamp: string; severity?: string }[] }>(
        app.connection,
        "query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message timestamp severity } }",
        { deploymentId: id, limit: opts.tail ?? 100 },
      );
      for (const l of data.deploymentLogs) yield { at: Date.parse(l.timestamp), stream: l.severity === "error" ? "stderr" : "stdout", line: l.message };
    },

    async status(app: AppRef): Promise<AppStatus> {
      let t: Target;
      try {
        t = await target(app);
      } catch (err) {
        if (err instanceof LotseError && err.code === "NOT_FOUND") return { state: "not-found", domains: [] };
        throw err;
      }
      const data = await gql<{ deployments: { edges: { node: { id: string; status: string; staticUrl?: string | null; createdAt?: string } }[] } }>(
        app.connection,
        "query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status staticUrl createdAt } } } }",
        { input: t },
      );
      const latest = data.deployments.edges[0]?.node;
      if (!latest) return { state: "stopped", domains: [] };
      const state = DONE.has(latest.status) ? "running" : FAILED.has(latest.status) ? "failed" : "deploying";
      return {
        state,
        url: latest.staticUrl ? `https://${latest.staticUrl}` : undefined,
        domains: latest.staticUrl ? [latest.staticUrl] : [],
        deployment: { id: latest.id, createdAt: latest.createdAt ? Date.parse(latest.createdAt) : undefined },
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createRailwayAdapter };
export default pkg;
