/**
 * Netlify hosting adapter. Static sites are uploaded with Netlify's
 * file-digest deploy API; server code runs as Netlify Functions.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
  type DomainStatus,
  type EnvVar,
  event,
  type HostingAdapter,
  HttpClient,
  hashBuffer,
  hashFile,
  isLotseError,
  type LogLine,
  LotseError,
  type Manifest,
  STATIC_SITE_IGNORE,
  sleep,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotse/core";
import { zipSync } from "fflate";

interface Site {
  id: string;
  name: string;
  url: string;
  ssl_url?: string;
  account_id?: string;
  account_slug?: string;
  custom_domain?: string | null;
  domain_aliases?: string[];
  published_deploy?: { id: string; state: string; created_at?: string } | null;
}

interface Deploy {
  id: string;
  state: string;
  required?: string[];
  required_functions?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  error_message?: string;
}

const capabilities: Capabilities = {
  runtimes: ["static", "server"],
  languages: ["node"],
  resources: [],
  customDomains: true,
  previewDeployments: true,
  rollback: "native",
};
const FUNCTIONS_DIR = "netlify/functions";

export function createNetlifyAdapter(options: AdapterOptions = {}): HostingAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 2000);
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Netlify",
      baseUrl: "https://api.netlify.com/api/v1",
      headers: { authorization: `Bearer ${accessToken(conn)}`, "user-agent": "lotse" },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });

  async function findSite(conn: Connection, name: string): Promise<Site | undefined> {
    const sites = await client(conn).get<Site[]>("/sites", { query: { name, filter: "all" } });
    return sites.find((s) => s.name === name);
  }
  async function site(app: AppRef): Promise<Site> {
    const found = app.id ? await client(app.connection).get<Site>(`/sites/${app.id}`) : await findSite(app.connection, app.name);
    if (!found) throw new LotseError("NOT_FOUND", `There is no Netlify site "${app.name}".`);
    return found;
  }

  async function setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    const http = client(app.connection);
    const s = await site(app);
    const account = s.account_id ?? s.account_slug;
    for (const v of vars) {
      const body = {
        key: v.name,
        is_secret: v.secret,
        scopes: ["builds", "functions", "runtime", "post-processing"],
        values: [{ value: v.value, context: "all" }],
      };
      try {
        await http.put(`/accounts/${account}/env/${encodeURIComponent(v.name)}`, body, { query: { site_id: s.id } });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
        await http.post(`/accounts/${account}/env`, [body], { query: { site_id: s.id } });
      }
    }
  }

  return {
    id: "netlify",
    displayName: "Netlify",
    auth: ["oauth", "token"],
    capabilities,
    oauth: {
      authorizationEndpoint: "https://app.netlify.com/authorize",
      tokenEndpoint: "https://api.netlify.com/oauth/token",
      scopes: [],
      envPrefix: "LOTSE_OAUTH_NETLIFY",
    },
    tokenSetup: {
      url: "https://app.netlify.com/user/applications#personal-access-tokens",
      permissions: ["A personal access token of the account that should own the sites"],
      steps: ["Choose “New access token”, give it a name and an expiration date.", "Copy the token and paste it here. It is shown only once."],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const conn = apiConnection("netlify", input);
      const user = await client(conn).get<{ id: string; full_name?: string; email?: string }>("/user");
      conn.account = { id: user.id, name: user.full_name || user.email || user.id };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      try {
        await client(conn).get("/sites", { query: { per_page: 1 } });
      } catch (err) {
        if (!(isLotseError(err) && (err.code === "PERMISSION_MISSING" || err.code === "AUTH_FAILED"))) throw err;
        result.ok = false;
        result.missingPermissions.push("Access to the account's sites");
      }
      return result;
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const existing = await findSite(conn, manifest.name);
      const server = manifest.runtime.kind !== "static";
      return {
        adapter: "netlify",
        app: { adapter: "netlify", name: manifest.name, id: existing?.id, connection: conn },
        manifest,
        artifact: "static",
        firstDeployment: !existing,
        steps: [
          {
            id: "app",
            title: existing ? `Use site ${existing.name}` : `Create site ${manifest.name}`,
            detail: `https://${manifest.name}.netlify.app`,
            action: existing ? "noop" : "create",
          },
          { id: "deploy", title: server ? "Upload the build output and the functions" : "Upload the built site", action: "create" },
          ...manifest.domains.map((d) => ({ id: `domain:${d}`, title: `Attach domain ${d}`, action: "update" as const })),
        ],
        resources: [],
        warnings: server
          ? [
              `Netlify runs server code as Functions: the JavaScript files in ${FUNCTIONS_DIR}/ are deployed as functions, everything in the output folder as static files.`,
            ]
          : [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "static") throw new LotseError("DEPLOY_FAILED", "Netlify needs the built files of the site.");
      throwIfAborted(ctx.signal);
      const conn = ctx.connection;
      const http = client(conn);
      let siteId = plan.app.id;
      if (!siteId) {
        yield event.log("deploy", `Creating site ${plan.manifest.name}`);
        try {
          siteId = (await http.post<Site>("/sites", { name: plan.manifest.name })).id;
        } catch (err) {
          if (isLotseError(err) && (err.details.status === 422 || err.code === "CONFLICT")) {
            throw new LotseError("CONFLICT", `The site name "${plan.manifest.name}" is already taken on Netlify. Site names are unique across all accounts.`, {
              hints: ["Choose another `name` in lotse.yaml."],
            });
          }
          throw err;
        }
      }
      const app: AppRef = { ...plan.app, id: siteId };
      await setEnv(app, ctx.env);

      const entries = await walkFiles(artifact.dir, { ignore: STATIC_SITE_IGNORE });
      const files: Record<string, string> = {};
      const byDigest = new Map<string, string>();
      for (const e of entries) {
        const sha = await hashFile(e.abs, "sha1");
        files[`/${e.path}`] = sha;
        byDigest.set(sha, e.abs);
      }
      // Functions: every JavaScript file in netlify/functions becomes one function, uploaded as a zip.
      const functions: Record<string, string> = {};
      const functionZips = new Map<string, Uint8Array>();
      for (const file of await readdir(join(ctx.workdir, FUNCTIONS_DIR)).catch(() => [] as string[])) {
        const match = file.match(/^(.+)\.(m?js|cjs)$/);
        if (!match) continue;
        const zip = zipSync({ [file]: new Uint8Array(await readFile(join(ctx.workdir, FUNCTIONS_DIR, file))) });
        functions[match[1] as string] = hashBuffer(Buffer.from(zip), "sha256");
        functionZips.set(match[1] as string, zip);
      }

      let deploy = await http.post<Deploy>(
        `/sites/${siteId}/deploys`,
        { files, ...(functionZips.size ? { functions } : {}), draft: Boolean(ctx.preview), ...(ctx.preview ? { branch: ctx.preview.id } : {}) },
        { signal: ctx.signal },
      );
      yield event.log("deploy", `Deploy ${deploy.id} created`);
      const required = deploy.required ?? [];
      let done = 0;
      for (const sha of required) {
        throwIfAborted(ctx.signal);
        const abs = byDigest.get(sha);
        if (!abs) continue;
        const path = Object.keys(files).find((p) => files[p] === sha) as string;
        await http.put(`/deploys/${deploy.id}/files${path.split("/").map(encodeURIComponent).join("/")}`, await readFile(abs), {
          contentType: "application/octet-stream",
          signal: ctx.signal,
        });
        yield event.progress("deploy", ++done, required.length, `Uploaded ${path}`);
      }
      for (const name of deploy.required_functions?.length
        ? [...functionZips.keys()].filter((n) => deploy.required_functions?.includes(functions[n] as string))
        : []) {
        await http.put(`/deploys/${deploy.id}/functions/${encodeURIComponent(name)}`, Buffer.from(functionZips.get(name) as Uint8Array), {
          contentType: "application/zip",
          query: { runtime: "js" },
          signal: ctx.signal,
        });
        yield event.log("deploy", `Uploaded function ${name}`);
      }

      while (deploy.state !== "ready") {
        if (deploy.state === "error")
          throw new LotseError("DEPLOY_FAILED", `Netlify reported the deploy as failed${deploy.error_message ? `: ${deploy.error_message}` : "."}`);
        try {
          await sleep(pollMs, ctx.signal);
        } catch (err) {
          // A deploy that never became ready is never published; cancelling keeps the live version.
          await http.post(`/deploys/${deploy.id}/cancel`).catch(() => {});
          throw err;
        }
        const next = await http.get<Deploy>(`/deploys/${deploy.id}`);
        if (next.state !== deploy.state) yield event.log("deploy", `Netlify: ${next.state}`);
        deploy = next;
      }
      const ref: DeploymentRef = {
        id: deploy.id,
        app,
        url: (ctx.preview ? deploy.deploy_ssl_url : deploy.ssl_url) ?? deploy.deploy_ssl_url,
        createdAt: Date.now(),
        version: deploy.id,
        preview: ctx.preview ? true : undefined,
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      const s = await site(target.app);
      await client(ctx.connection).post(`/sites/${s.id}/deploys/${target.id}/restore`);
    },

    async destroy(app: AppRef): Promise<void> {
      const id = app.id ?? (await findSite(app.connection, app.name))?.id;
      if (id) await client(app.connection).delete(`/sites/${id}`);
    },

    setEnv,

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const s = await site(app);
      const names = [s.custom_domain, ...(s.domain_aliases ?? [])].filter(Boolean) as string[];
      if (!names.includes(domain)) {
        await client(app.connection).patch(
          `/sites/${s.id}`,
          s.custom_domain ? { domain_aliases: [...(s.domain_aliases ?? []), domain] } : { custom_domain: domain },
        );
      }
      const apex = domain.split(".").length === 2;
      return {
        domain,
        state: "pending",
        dnsRecords: [apex ? { type: "A", name: domain, value: "75.2.60.5" } : { type: "CNAME", name: domain, value: `${s.name}.netlify.app` }],
        message: "Netlify issues the certificate once the DNS record is in place.",
      };
    },

    async *logs(app: AppRef): AsyncIterable<LogLine> {
      const s = await site(app);
      yield { at: Date.now(), stream: "system", line: `Netlify shows deploy and function logs at https://app.netlify.com/sites/${s.name}/logs` };
    },

    async status(app: AppRef): Promise<AppStatus> {
      let s: Site | undefined;
      try {
        s = app.id ? await client(app.connection).get<Site>(`/sites/${app.id}`) : await findSite(app.connection, app.name);
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
      if (!s) return { state: "not-found", domains: [] };
      const state = s.published_deploy?.state;
      return {
        state: !state ? "stopped" : state === "ready" ? "running" : state === "error" ? "failed" : "deploying",
        url: s.ssl_url ?? s.url,
        domains: [`${s.name}.netlify.app`, ...([s.custom_domain, ...(s.domain_aliases ?? [])].filter(Boolean) as string[])],
        deployment: s.published_deploy ? { id: s.published_deploy.id } : undefined,
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createNetlifyAdapter };
export default pkg;
