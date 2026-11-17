/**
 * Neon as an external resource provider: a serverless Postgres database for
 * apps whose hosting provider has none of its own. Every database resource
 * of an app is one Neon project, so that removing it leaves nothing behind.
 */
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  accessToken,
  apiConnection,
  type ConnectInput,
  type Connection,
  HttpClient,
  isLotseError,
  LotseError,
  poll,
  type ResourceAdapter,
  type ResourceRef,
  type ResourceSpec,
  type ResourceStatus,
  resourceEnvName,
  type VerifyResult,
} from "@lotseai/core";

interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  pg_version: number;
  org_id?: string;
}

interface NeonOperation {
  id: string;
  action: string;
  status: "scheduling" | "running" | "finished" | "failed" | "error" | "cancelling" | "cancelled" | "skipped";
  error?: string;
}

interface NeonEndpoint {
  id: string;
  type: "read_only" | "read_write";
  current_state: "init" | "active" | "idle";
  disabled?: boolean;
}

interface CreatedProject {
  project: NeonProject;
  connection_uris: { connection_uri: string }[];
  operations: NeonOperation[];
}

/** Fixed names, so that the connection values can be fetched again later. */
const DATABASE = "app";
const ROLE = "app_owner";
const SETTLED = new Set<NeonOperation["status"]>(["finished", "skipped", "cancelled"]);
const BROKEN = new Set<NeonOperation["status"]>(["failed", "error"]);

export function createNeonAdapter(options: AdapterOptions = {}): ResourceAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 1500);
  const defaultRegion = (options.settings?.region as string | undefined) ?? options.env?.LOTSE_NEON_REGION;
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Neon",
      baseUrl: "https://console.neon.tech/api/v2",
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });
  const projectName = (app: AppRef, res: { name: string }) => `${app.name}-${res.name}`;

  async function findProject(conn: Connection, name: string): Promise<NeonProject | undefined> {
    const { projects } = await client(conn).get<{ projects: NeonProject[] }>("/projects", { query: { search: name, limit: 100, org_id: conn.settings.orgId } });
    return projects.find((p) => p.name === name);
  }

  async function connectionUri(conn: Connection, project: string, pooled: boolean): Promise<string> {
    return (await client(conn).get<{ uri: string }>(`/projects/${project}/connection_uri`, { query: { database_name: DATABASE, role_name: ROLE, pooled } }))
      .uri;
  }

  /** Neon creates projects asynchronously; the database accepts connections once these operations are done. */
  async function waitForOperations(conn: Connection, project: string, operations: NeonOperation[]): Promise<void> {
    for (const op of operations) {
      const done =
        SETTLED.has(op.status) || BROKEN.has(op.status)
          ? op
          : await poll(
              async () => (await client(conn).get<{ operation: NeonOperation }>(`/projects/${project}/operations/${op.id}`)).operation,
              (o) => SETTLED.has(o.status) || BROKEN.has(o.status),
              { intervalMs: pollMs, timeoutMs: 5 * 60_000, description: "the Neon database to become ready" },
            );
      if (BROKEN.has(done.status))
        throw new LotseError("PROVIDER_ERROR", `Neon could not set up the database (${done.action}${done.error ? `: ${done.error}` : ""}).`);
    }
  }

  return {
    id: "neon",
    displayName: "Neon",
    auth: ["oauth", "token"],
    resources: ["postgres"],
    // Neon issues OAuth clients to registered partner applications only; the operator supplies one.
    oauth: {
      authorizationEndpoint: "https://oauth2.neon.tech/oauth2/auth",
      tokenEndpoint: "https://oauth2.neon.tech/oauth2/token",
      scopes: [
        "openid",
        "offline",
        "offline_access",
        "urn:neoncloud:projects:create",
        "urn:neoncloud:projects:read",
        "urn:neoncloud:projects:update",
        "urn:neoncloud:projects:delete",
        "urn:neoncloud:orgs:read",
      ],
      envPrefix: "LOTSE_OAUTH_NEON",
    },
    tokenSetup: {
      url: "https://console.neon.tech/app/settings/api-keys",
      permissions: ["Personal API key, or an organization API key (create, read and delete projects)"],
      steps: ['Create a new API key and give it a name such as "Lotse".', "Copy the key right away; Neon shows it only once.", "Paste it here."],
      fields: [
        {
          name: "orgId",
          label: "Organization ID",
          required: false,
          placeholder: "org-…",
          help: "Only needed when your account belongs to more than one organization.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("neon", input);
      const http = client(conn);
      let orgs: { id: string; name: string }[] = [];
      try {
        const user = await http.get<{ id: string; login?: string; email?: string; name?: string }>("/users/me");
        conn.account = { id: user.id, name: user.email ?? user.login ?? user.name ?? user.id };
        orgs = (await http.get<{ organizations: { id: string; name: string }[] }>("/users/me/organizations")).organizations;
      } catch (err) {
        // Organization API keys belong to no user; they are checked by listing the projects instead.
        if (!isLotseError(err) || err.code === "AUTH_FAILED") throw err;
        await http.get("/projects", { query: { limit: 1 } });
        conn.account = { id: input.options?.orgId ?? "organization", name: input.options?.orgId ?? "Neon organization" };
      }
      const wanted = input.options?.orgId;
      const org = wanted ? (orgs.find((o) => o.id === wanted) ?? { id: wanted, name: wanted }) : orgs[0];
      if (org) {
        conn.settings.orgId = org.id;
        conn.settings.orgName = org.name;
        if (!wanted && orgs.length > 1) conn.settings.orgChoice = "first";
      }
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      await client(conn).get("/projects", { query: { limit: 1, org_id: conn.settings.orgId } });
      const warnings =
        conn.settings.orgChoice === "first"
          ? [
              `Your account belongs to several organizations. Databases are created in "${conn.settings.orgName}"; sign in again with an organization ID to choose another.`,
            ]
          : [];
      return { ok: true, account: conn.account.name, missingPermissions: [], warnings };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "postgres") throw new LotseError("RESOURCE_UNSUPPORTED", `Neon provides Postgres databases, not ${res.type}.`);
      const conn = app.connection;
      const name = projectName(app, res);
      let project = await findProject(conn, name);
      let direct: string | undefined;
      if (!project) {
        const version = res.options?.version ? Number(res.options.version) : undefined;
        if (version !== undefined && !Number.isInteger(version))
          throw new LotseError("INVALID_INPUT", `"${res.options?.version}" is not a Postgres major version.`);
        const created = await client(conn).post<CreatedProject>("/projects", {
          project: {
            name,
            ...(conn.settings.orgId ? { org_id: conn.settings.orgId } : {}),
            ...((res.options?.region ?? defaultRegion) ? { region_id: res.options?.region ?? defaultRegion } : {}),
            ...(version ? { pg_version: version } : {}),
            branch: { database_name: DATABASE, role_name: ROLE },
          },
        });
        project = created.project;
        direct = created.connection_uris[0]?.connection_uri;
        await waitForOperations(conn, project.id, created.operations);
      }
      direct ??= await connectionUri(conn, project.id, false);
      const pooled = await connectionUri(conn, project.id, true);
      const envName = resourceEnvName(res.type, res.name);
      return {
        type: res.type,
        name: res.name,
        id: project.id,
        provider: "neon",
        // Pooled by default, as serverless hosts open many short connections; migrations use the direct one.
        env: [
          { name: envName, value: pooled, secret: true },
          { name: `${envName}_UNPOOLED`, value: direct, secret: true },
        ],
        meta: { project: project.name, region: project.region_id, postgres: String(project.pg_version) },
      };
    },

    async destroy(app: AppRef, res: ResourceRef): Promise<void> {
      try {
        await client(app.connection).delete(`/projects/${res.id}`);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },

    async status(app: AppRef, res: ResourceRef): Promise<ResourceStatus> {
      let endpoints: NeonEndpoint[];
      try {
        endpoints = (await client(app.connection).get<{ endpoints: NeonEndpoint[] }>(`/projects/${res.id}/endpoints`)).endpoints;
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return { state: "not-found" };
        throw err;
      }
      const primary = endpoints.find((e) => e.type === "read_write");
      if (!primary || primary.current_state === "init") return { state: "creating" };
      if (primary.disabled) return { state: "failed", message: "The database's compute endpoint is disabled." };
      // An idle endpoint is suspended and starts again with the next connection.
      return { state: "ready", message: primary.current_state === "idle" ? "Suspended; starts with the next connection." : undefined };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, resource: createNeonAdapter };
export default pkg;
