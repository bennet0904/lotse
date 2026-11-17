/**
 * Supabase as an external resource provider: a Postgres database for apps
 * whose hosting provider has none of its own. Every database resource of an
 * app is one Supabase project.
 */
import { randomBytes } from "node:crypto";
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

type ProjectStatus =
  | "INACTIVE"
  | "ACTIVE_HEALTHY"
  | "ACTIVE_UNHEALTHY"
  | "COMING_UP"
  | "UNKNOWN"
  | "GOING_DOWN"
  | "INIT_FAILED"
  | "REMOVED"
  | "RESTORING"
  | "UPGRADING"
  | "PAUSING"
  | "RESTORE_FAILED";

interface SbProject {
  id: string;
  ref: string;
  organization_slug: string;
  name: string;
  region: string;
  status: ProjectStatus;
  database?: { host: string; version: string };
}

interface SbOrganization {
  id: string;
  slug: string;
  name: string;
}

interface PoolerConfig {
  database_type: "PRIMARY" | "READ_REPLICA";
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
}

const SMART_GROUPS = new Set(["americas", "emea", "apac"]);
const FAILED = new Set<ProjectStatus>(["INIT_FAILED", "RESTORE_FAILED", "REMOVED", "GOING_DOWN"]);

export function createSupabaseAdapter(options: AdapterOptions = {}): ResourceAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 5000);
  const defaultRegion = (options.settings?.region as string | undefined) ?? options.env?.LOTSE_SUPABASE_REGION;
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Supabase",
      baseUrl: "https://api.supabase.com/v1",
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });
  const projectName = (app: AppRef, res: { name: string }) => `${app.name}-${res.name}`;
  const url = (user: string, password: string, host: string, port: number, database: string) =>
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

  return {
    id: "supabase",
    displayName: "Supabase",
    auth: ["oauth", "token"],
    resources: ["postgres"],
    // The scopes of a Supabase OAuth app are fixed when the app is registered, not requested per sign-in.
    oauth: {
      authorizationEndpoint: "https://api.supabase.com/v1/oauth/authorize",
      tokenEndpoint: "https://api.supabase.com/v1/oauth/token",
      scopes: [],
      envPrefix: "LOTSE_OAUTH_SUPABASE",
    },
    tokenSetup: {
      url: "https://supabase.com/dashboard/account/tokens",
      permissions: ["Personal access token (create, read and delete projects in your organizations)"],
      steps: ['Generate a new access token and give it a name such as "Lotse".', "Copy the token right away; Supabase shows it only once.", "Paste it here."],
      fields: [
        {
          name: "organization",
          label: "Organization slug",
          required: false,
          help: "Only needed when your account belongs to more than one organization. It is the last part of the organization's address in the dashboard.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("supabase", input);
      const http = client(conn);
      const orgs = await http.get<SbOrganization[]>("/organizations");
      const wanted = input.options?.organization;
      const org = wanted ? orgs.find((o) => o.slug === wanted || o.id === wanted) : orgs[0];
      if (!org) {
        throw new LotseError(
          "INVALID_INPUT",
          wanted
            ? `Your Supabase account has no organization "${wanted}".`
            : "Your Supabase account has no organization yet. Create one in the Supabase dashboard first.",
          {
            hints: orgs.length > 0 ? [`Organizations of this account: ${orgs.map((o) => `${o.name} (${o.slug})`).join(", ")}`] : [],
          },
        );
      }
      conn.settings.organization = org.slug;
      conn.settings.organizationName = org.name;
      if (!wanted && orgs.length > 1) conn.settings.organizationChoice = "first";
      try {
        const profile = await http.get<{ gotrue_id: string; primary_email: string; username: string }>("/profile");
        conn.account = { id: profile.gotrue_id, name: profile.primary_email || profile.username };
      } catch (err) {
        // OAuth apps without access to the profile still identify by their organization.
        if (!isLotseError(err) || err.code === "AUTH_FAILED") throw err;
        conn.account = { id: org.id, name: org.name };
      }
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const orgs = await client(conn).get<SbOrganization[]>("/organizations");
      if (!orgs.some((o) => o.slug === conn.settings.organization)) {
        return { ok: false, account: conn.account.name, missingPermissions: [`access to the organization "${conn.settings.organization}"`], warnings: [] };
      }
      const warnings =
        conn.settings.organizationChoice === "first"
          ? [
              `Your account belongs to several organizations. Databases are created in "${conn.settings.organizationName}"; sign in again with an organization slug to choose another.`,
            ]
          : [];
      return { ok: true, account: conn.account.name, missingPermissions: [], warnings };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "postgres") throw new LotseError("RESOURCE_UNSUPPORTED", `Supabase provides Postgres databases, not ${res.type}.`);
      const conn = app.connection;
      const http = client(conn);
      const name = projectName(app, res);
      const existing = (await http.get<SbProject[]>("/projects")).find(
        (p) => p.name === name && p.organization_slug === conn.settings.organization && p.status !== "REMOVED",
      );
      if (existing) {
        // The database password is only known when a project is created, so an existing one cannot be adopted.
        throw new LotseError("CONFLICT", `The Supabase project "${name}" already exists, but Lotse does not know its database password.`, {
          hints: ["Delete the project in the Supabase dashboard, or give the resource another name in lotse.yaml."],
          details: { project: existing.ref },
        });
      }

      const region = res.options?.region ?? defaultRegion;
      const password = randomBytes(24).toString("base64url");
      const created = await http.post<SbProject>("/projects", {
        name,
        organization_slug: conn.settings.organization,
        db_pass: password,
        ...(region ? { region_selection: { type: SMART_GROUPS.has(region) ? "smartGroup" : "specific", code: region } } : {}),
      });
      const ready = await poll(
        () => http.get<SbProject>(`/projects/${created.ref}`),
        (p) => p.status === "ACTIVE_HEALTHY" || FAILED.has(p.status),
        { intervalMs: pollMs, timeoutMs: 10 * 60_000, description: "the Supabase project to start" },
      );
      if (ready.status !== "ACTIVE_HEALTHY")
        throw new LotseError("PROVIDER_ERROR", `Supabase could not start the project "${name}" (${ready.status}).`, { details: { project: created.ref } });

      // The connection pooler is reachable over IPv4 everywhere; the database's own address is IPv6 on most plans.
      const pooler = (await http.get<PoolerConfig[]>(`/projects/${created.ref}/config/database/pooler`)).find((c) => c.database_type === "PRIMARY");
      const direct = url("postgres", password, ready.database?.host ?? `db.${created.ref}.supabase.co`, 5432, "postgres");
      const envName = resourceEnvName(res.type, res.name);
      return {
        type: res.type,
        name: res.name,
        id: created.ref,
        provider: "supabase",
        // Transaction pooling by default, as serverless hosts open many short connections;
        // the session connection (port 5432) is for migrations and prepared statements.
        env: pooler
          ? [
              { name: envName, value: url(pooler.db_user, password, pooler.db_host, pooler.db_port, pooler.db_name), secret: true },
              { name: `${envName}_UNPOOLED`, value: url(pooler.db_user, password, pooler.db_host, 5432, pooler.db_name), secret: true },
            ]
          : [
              { name: envName, value: direct, secret: true },
              { name: `${envName}_UNPOOLED`, value: direct, secret: true },
            ],
        meta: { project: name, region: ready.region, api: `https://${created.ref}.supabase.co` },
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
      let project: SbProject;
      try {
        project = await client(app.connection).get<SbProject>(`/projects/${res.id}`);
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return { state: "not-found" };
        throw err;
      }
      switch (project.status) {
        case "ACTIVE_HEALTHY":
          return { state: "ready" };
        case "COMING_UP":
        case "RESTORING":
        case "UPGRADING":
        case "UNKNOWN":
          return { state: "creating", message: project.status === "COMING_UP" ? undefined : `Supabase reports ${project.status}.` };
        case "REMOVED":
        case "GOING_DOWN":
          return { state: "not-found" };
        case "INACTIVE":
        case "PAUSING":
          return { state: "failed", message: "The project is paused. Restore it in the Supabase dashboard." };
        default:
          return { state: "failed", message: `Supabase reports ${project.status}.` };
      }
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, resource: createSupabaseAdapter };
export default pkg;
