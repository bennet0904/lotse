/**
 * Cloudflare hosting adapter, built on Workers with static assets. Static
 * sites become an assets-only Worker; server apps are deployed from a bundled
 * Worker module that the project's build produces.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
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
  contentType,
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
  LotseError,
  type Manifest,
  type ResourceRef,
  type ResourceSpec,
  STATIC_SITE_IGNORE,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotse/core";

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

const API = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2026-01-01";
/** Names of the bundled Worker module a server app's build may produce, in order of preference. */
const WORKER_ENTRIES = ["_worker.js", "worker.js", "index.js", "index.mjs"];

const capabilities: Capabilities = {
  runtimes: ["static", "server"],
  languages: ["node"],
  resources: ["object-storage"],
  customDomains: true,
  previewDeployments: false,
  rollback: "native",
};

/** Cloudflare identifies an asset by a hash of its base64 content and its extension. */
export function assetHash(content: Buffer, path: string): string {
  return createHash("sha256")
    .update(content.toString("base64") + extname(path).slice(1))
    .digest("hex")
    .slice(0, 32);
}

export function createCloudflareAdapter(options: AdapterOptions = {}): HostingAdapter {
  const http = (token: string) =>
    new HttpClient({ provider: "Cloudflare", baseUrl: API, headers: { authorization: `Bearer ${token}` }, fetch: options.fetch, retryDelayMs: 300 });
  const client = (conn: Connection) => http(accessToken(conn));
  const account = (conn: Connection) => conn.settings.accountId as string;
  const script = (conn: Connection, name: string) => `/accounts/${account(conn)}/workers/scripts/${name}`;

  async function exists(conn: Connection, name: string): Promise<boolean> {
    try {
      await client(conn).get(`${script(conn, name)}/settings`);
      return true;
    } catch (err) {
      if (isLotseError(err) && err.code === "NOT_FOUND") return false;
      throw err;
    }
  }

  async function workersDevUrl(conn: Connection, name: string): Promise<string> {
    const sub = await client(conn).get<Envelope<{ subdomain: string }>>(`/accounts/${account(conn)}/workers/subdomain`);
    return `https://${name}.${sub.result.subdomain}.workers.dev`;
  }

  async function currentVersion(conn: Connection, name: string): Promise<{ deployment: string; version: string; createdAt: number } | undefined> {
    const list = await client(conn).get<
      Envelope<{ deployments: { id: string; created_on: string; versions: { version_id: string; percentage: number }[] }[] }>
    >(`${script(conn, name)}/deployments`);
    const latest = list.result.deployments[0];
    return latest?.versions[0] ? { deployment: latest.id, version: latest.versions[0].version_id, createdAt: Date.parse(latest.created_on) } : undefined;
  }

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    auth: ["oauth", "token"],
    capabilities,
    oauth: {
      authorizationEndpoint: "https://dash.cloudflare.com/oauth2/auth",
      tokenEndpoint: "https://dash.cloudflare.com/oauth2/token",
      scopes: ["account:read", "user:read", "workers:write", "workers_scripts:write", "zone:read", "offline_access"],
      envPrefix: "LOTSE_OAUTH_CLOUDFLARE",
    },
    tokenSetup: {
      url: "https://dash.cloudflare.com/profile/api-tokens",
      permissions: [
        "Account · Workers Scripts · Edit",
        "Account · Account Settings · Read",
        "Account · Workers R2 Storage · Edit (only for object storage)",
        "Zone · Workers Routes · Edit and Zone · Zone · Read (only for custom domains)",
      ],
      steps: [
        "Choose “Create Token” and start from the template “Edit Cloudflare Workers”.",
        "Limit the token to the account that should own the apps.",
        "Copy the token and paste it here.",
      ],
      fields: [{ name: "accountId", label: "Account ID", required: false, help: "Only needed when the token can access several accounts." }],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("cloudflare", input);
      const api = client(conn);
      if (input.method === "token") {
        await api.get("/user/tokens/verify").catch((err) => {
          // Cloudflare answers 400 for malformed and 401 for unknown tokens.
          if (isLotseError(err) && [400, 401, 403].includes(err.details.status as number))
            throw new LotseError("AUTH_FAILED", "Cloudflare did not accept the token.");
          throw err;
        });
      }
      const accounts = (await api.get<Envelope<{ id: string; name: string }[]>>("/accounts")).result;
      const chosen = input.options?.accountId ? accounts.find((a) => a.id === input.options?.accountId) : accounts[0];
      if (!chosen)
        throw new LotseError(
          "PERMISSION_MISSING",
          input.options?.accountId ? `The token cannot access account ${input.options.accountId}.` : "The token cannot access any Cloudflare account.",
        );
      conn.settings.accountId = chosen.id;
      conn.account = { id: chosen.id, name: chosen.name };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      try {
        await client(conn).get(`/accounts/${account(conn)}/workers/subdomain`);
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND")
          result.warnings.push("The account has no workers.dev subdomain yet. Open “Workers & Pages” in the dashboard once to create it.");
        else if (isLotseError(err) && (err.code === "PERMISSION_MISSING" || err.code === "AUTH_FAILED")) {
          result.ok = false;
          result.missingPermissions.push("Account · Workers Scripts · Edit");
        } else throw err;
      }
      return result;
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const present = await exists(conn, manifest.name);
      const server = manifest.runtime.kind !== "static";
      return {
        adapter: "cloudflare",
        app: { adapter: "cloudflare", name: manifest.name, id: present ? manifest.name : undefined, connection: conn },
        manifest,
        artifact: "static",
        firstDeployment: !present,
        steps: [
          { id: "app", title: present ? `Update Worker ${manifest.name}` : `Create Worker ${manifest.name}`, action: present ? "update" : "create" },
          { id: "deploy", title: server ? "Upload the bundled Worker and its static assets" : "Upload the built site as static assets", action: "create" },
          ...manifest.domains.map((d) => ({ id: `domain:${d}`, title: `Attach domain ${d}`, action: "update" as const })),
        ],
        resources: [],
        warnings: server
          ? [
              `Cloudflare runs server code as a Worker: the build must produce one bundled module (${WORKER_ENTRIES.join(", ")}) in the output folder that exports a fetch handler.`,
            ]
          : [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "static") throw new LotseError("DEPLOY_FAILED", "Cloudflare needs the built files of the app.");
      throwIfAborted(ctx.signal);
      const conn = ctx.connection;
      const api = client(conn);
      const name = plan.manifest.name;
      const server = plan.manifest.runtime.kind !== "static";

      let entry: string | undefined;
      if (server) {
        for (const candidate of WORKER_ENTRIES) {
          if (
            await stat(join(artifact.dir, candidate)).then(
              (s) => s.isFile(),
              () => false,
            )
          ) {
            entry = candidate;
            break;
          }
        }
        if (!entry) throw new LotseError("DEPLOY_FAILED", `No Worker module found in the build output. Expected one of: ${WORKER_ENTRIES.join(", ")}.`);
      }

      const entries = (await walkFiles(artifact.dir, { ignore: STATIC_SITE_IGNORE })).filter((e) => e.path !== entry);
      const manifest: Record<string, { hash: string; size: number }> = {};
      const byHash = new Map<string, { path: string; content: Buffer }>();
      for (const e of entries) {
        const content = await readFile(e.abs);
        const hash = assetHash(content, e.path);
        manifest[`/${e.path}`] = { hash, size: e.size };
        byHash.set(hash, { path: e.path, content });
      }

      yield event.log("deploy", `Preparing ${entries.length} assets`);
      const session = await api.post<Envelope<{ jwt: string; buckets: string[][] }>>(
        `${script(conn, name)}/assets-upload-session`,
        { manifest },
        { signal: ctx.signal },
      );
      // With nothing to upload, the session token already is the completion token.
      let completion = session.result.jwt;
      let uploaded = 0;
      const total = session.result.buckets.flat().length;
      for (const bucket of session.result.buckets) {
        throwIfAborted(ctx.signal);
        const form = new FormData();
        for (const hash of bucket) {
          const file = byHash.get(hash);
          if (!file) continue;
          form.append(hash, new File([file.content.toString("base64")], hash, { type: contentType(file.path).split(";")[0] }), hash);
        }
        const res = await http(session.result.jwt).post<Envelope<{ jwt?: string }>>(`/accounts/${account(conn)}/workers/assets/upload`, form, {
          query: { base64: "true" },
          signal: ctx.signal,
        });
        uploaded += bucket.length;
        yield event.progress("deploy", uploaded, total, "Uploaded assets");
        if (res.result?.jwt) completion = res.result.jwt;
      }

      throwIfAborted(ctx.signal);
      const bindings = ctx.env.map((v) => ({ name: v.name, type: v.secret ? "secret_text" : "plain_text", text: v.value }));
      for (const r of ctx.resources.filter((x) => x.type === "object-storage"))
        bindings.push({ name: r.name.toUpperCase().replace(/-/g, "_"), type: "r2_bucket", bucket_name: r.id } as never);
      const metadata = {
        ...(entry ? { main_module: entry, compatibility_flags: ["nodejs_compat"] } : {}),
        compatibility_date: COMPATIBILITY_DATE,
        assets: { jwt: completion, config: { html_handling: "auto-trailing-slash", not_found_handling: server ? "none" : "single-page-application" } },
        bindings: entry ? [...bindings, { name: "ASSETS", type: "assets" }] : bindings,
      };
      const upload = new FormData();
      upload.append("metadata", JSON.stringify(metadata));
      if (entry) upload.append(entry, new File([await readFile(join(artifact.dir, entry))], entry, { type: "application/javascript+module" }), entry);
      await api.put(script(conn, name), upload, { signal: ctx.signal });
      yield event.log("deploy", "Worker version uploaded");
      await api.post(`${script(conn, name)}/subdomain`, { enabled: true, previews_enabled: false });

      const version = await currentVersion(conn, name);
      const ref: DeploymentRef = {
        id: version?.deployment ?? `${name}-${Date.now()}`,
        app: { ...plan.app, id: name },
        url: await workersDevUrl(conn, name),
        createdAt: version?.createdAt ?? Date.now(),
        version: version?.version,
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      if (!target.version) throw new LotseError("ROLLBACK_FAILED", `Deployment ${target.id} has no Worker version to return to.`);
      await client(ctx.connection).post(`${script(ctx.connection, target.app.name)}/deployments`, {
        strategy: "percentage",
        versions: [{ version_id: target.version, percentage: 100 }],
      });
    },

    async destroy(app: AppRef): Promise<void> {
      try {
        await client(app.connection).delete(script(app.connection, app.name), { query: { force: "true" } });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },

    async setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
      // Values set after a deployment are stored as Worker secrets; the next deployment writes them as bindings.
      for (const v of vars)
        await client(app.connection).put(`${script(app.connection, app.name)}/secrets`, { name: v.name, text: v.value, type: "secret_text" });
    },

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const api = client(app.connection);
      const apex = domain.split(".").slice(-2).join(".");
      const zones = await api.get<Envelope<{ id: string; name: string }[]>>("/zones", { query: { name: apex, "account.id": account(app.connection) } });
      const zone = zones.result[0];
      if (!zone) {
        return {
          domain,
          state: "error",
          dnsRecords: [],
          message: `${apex} is not a zone in this Cloudflare account. Custom domains for Workers need the domain's DNS to be managed by Cloudflare.`,
        };
      }
      await api.put(`/accounts/${account(app.connection)}/workers/domains`, {
        hostname: domain,
        service: app.name,
        environment: "production",
        zone_id: zone.id,
      });
      // Cloudflare creates the DNS record and the certificate itself.
      return { domain, state: "active", dnsRecords: [] };
    },

    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      if (res.type !== "object-storage")
        throw new LotseError("RESOURCE_UNSUPPORTED", `Cloudflare provides object-storage (R2) through this adapter, not ${res.type}.`);
      const bucket = `${app.name}-${res.name}`;
      try {
        await client(app.connection).post(`/accounts/${account(app.connection)}/r2/buckets`, { name: bucket });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "CONFLICT")) throw err;
      }
      const prefix = res.name.toUpperCase().replace(/-/g, "_");
      // The bucket is bound to the Worker by name; no credentials are involved.
      return { type: res.type, name: res.name, id: bucket, provider: "cloudflare", env: [{ name: `${prefix}_BUCKET`, value: bucket, secret: false }] };
    },

    async *logs(app: AppRef): AsyncIterable<LogLine> {
      yield {
        at: Date.now(),
        stream: "system",
        line: `Cloudflare shows Worker logs at https://dash.cloudflare.com/${account(app.connection)}/workers/services/view/${app.name}/production/observability/logs`,
      };
    },

    async status(app: AppRef): Promise<AppStatus> {
      if (!(await exists(app.connection, app.name))) return { state: "not-found", domains: [] };
      const url = await workersDevUrl(app.connection, app.name);
      const version = await currentVersion(app.connection, app.name);
      return {
        state: "running",
        url,
        domains: [new URL(url).host],
        deployment: version ? { id: version.deployment, createdAt: version.createdAt } : undefined,
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createCloudflareAdapter };
export default pkg;
