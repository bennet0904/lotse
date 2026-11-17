/**
 * Lotse hosting adapter for __DISPLAY__.
 *
 * The code below talks to an example API so that the contract tests pass as
 * generated. Replace the requests with the real API of the provider.
 */
import { readFile } from "node:fs/promises";
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  type AppStatus,
  accessToken,
  type BuildArtifact,
  type ConnectInput,
  type Connection,
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
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
  walkFiles,
} from "@lotse/core";

const API = "https://api.example.com/v1";

interface Site {
  id: string;
  name: string;
  url: string;
  state: "ready" | "building" | "error";
  current_deploy?: string;
}

export function create__CLASS__Adapter(options: AdapterOptions = {}): HostingAdapter {
  const client = (conn: Connection) =>
    new HttpClient({ provider: "__DISPLAY__", baseUrl: API, headers: { authorization: `Bearer ${accessToken(conn)}` }, fetch: options.fetch });

  async function findSite(conn: Connection, name: string): Promise<Site | undefined> {
    const sites = await client(conn).get<Site[]>("/sites", { query: { name } });
    return sites.find((s) => s.name === name);
  }

  async function siteId(app: AppRef): Promise<string> {
    const id = app.id ?? (await findSite(app.connection, app.name))?.id;
    if (!id) throw new LotseError("NOT_FOUND", `There is no site "${app.name}" at __DISPLAY__.`);
    return id;
  }

  return {
    id: "__ID__",
    displayName: "__DISPLAY__",
    auth: ["token"],
    // Report only what the provider really supports.
    capabilities: { runtimes: ["static"], languages: [], resources: [], customDomains: false, previewDeployments: false, rollback: "native" },
    tokenSetup: {
      url: "https://example.com/account/tokens",
      permissions: ["Sites: read and write"],
      steps: ["Create a token with the permissions listed here.", "Copy the token and paste it."],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      if (input.method !== "token") throw new LotseError("INVALID_INPUT", "__DISPLAY__ is connected with an API token.");
      const conn: Connection = { adapter: "__ID__", method: "token", account: { id: "", name: "" }, credentials: { token: input.token }, settings: {} };
      const account = await client(conn).get<{ id: string; name: string }>("/account");
      conn.account = { id: account.id, name: account.name };
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      try {
        await client(conn).get("/sites");
      } catch (err) {
        if (!(isLotseError(err) && err.code === "PERMISSION_MISSING")) throw err;
        result.ok = false;
        result.missingPermissions.push("Sites: read and write");
      }
      return result;
    },

    // plan() only reads. It must never change anything at the provider.
    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const site = await findSite(conn, manifest.name);
      return {
        adapter: "__ID__",
        app: { adapter: "__ID__", name: manifest.name, id: site?.id, connection: conn },
        manifest,
        artifact: "static",
        firstDeployment: !site,
        steps: [
          { id: "app", title: site ? `Use site ${site.name}` : `Create site ${manifest.name}`, action: site ? "noop" : "create" },
          { id: "deploy", title: "Upload the built site", action: "create" },
        ],
        resources: [],
        warnings: [],
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      if (artifact.kind !== "static") throw new LotseError("DEPLOY_FAILED", "__DISPLAY__ only hosts static sites.");
      // An aborted deployment must leave the running version untouched.
      throwIfAborted(ctx.signal);
      const http = client(ctx.connection);
      let id = plan.app.id;
      if (!id) {
        yield event.log("deploy", `Creating site ${plan.manifest.name}`);
        id = (await http.post<Site>("/sites", { name: plan.manifest.name })).id;
      }
      const files: Record<string, string> = {};
      for (const entry of await walkFiles(artifact.dir)) files[entry.path] = (await readFile(entry.abs)).toString("base64");
      yield event.log("deploy", `Uploading ${Object.keys(files).length} files`);
      const deploy = await http.post<{ id: string; state: string; url: string }>(`/sites/${id}/deploys`, { files }, { signal: ctx.signal });
      if (deploy.state !== "ready") throw new LotseError("DEPLOY_FAILED", `__DISPLAY__ reported the deployment as ${deploy.state}.`);
      const ref: DeploymentRef = { id: deploy.id, app: { ...plan.app, id }, url: deploy.url, createdAt: Date.now(), version: deploy.id };
      // The stream must end with exactly this event.
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      await client(ctx.connection).post(`/sites/${await siteId(target.app)}/rollback`, { deploy_id: target.id });
    },

    async destroy(app: AppRef): Promise<void> {
      await client(app.connection).delete(`/sites/${await siteId(app)}`);
    },

    async setEnv(_app: AppRef, _vars: EnvVar[]): Promise<void> {
      // Static hosting has no runtime environment.
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const { lines } = await client(app.connection).get<{ lines: { at: number; text: string }[] }>(`/sites/${await siteId(app)}/logs`, {
        query: { limit: opts.tail ?? 100 },
      });
      for (const line of lines) yield { at: line.at, stream: "stdout", line: line.text };
    },

    async status(app: AppRef): Promise<AppStatus> {
      const site = await findSite(app.connection, app.name);
      if (!site) return { state: "not-found", domains: [] };
      return {
        state: site.state === "ready" ? "running" : site.state === "error" ? "failed" : "deploying",
        url: site.url,
        domains: [new URL(site.url).host],
        deployment: site.current_deploy ? { id: site.current_deploy } : undefined,
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: create__CLASS__Adapter };
export default pkg;
