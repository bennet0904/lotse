/**
 * Vercel hosting adapter. Static sites are uploaded prebuilt; server apps are
 * uploaded as source and built by Vercel's own build system.
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
  hashFile,
  isLotseError,
  type LogLine,
  type LogOptions,
  LotseError,
  type Manifest,
  oauthCredentials,
  STATIC_SITE_IGNORE,
  sleep,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotseai/core";

const API = "https://api.vercel.com";

interface VercelProject {
  id: string;
  name: string;
  targets?: { production?: { id: string; readyState?: string; alias?: string[]; url?: string; createdAt?: number } | null };
}

interface VercelDeployment {
  id: string;
  url: string;
  readyState: "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED";
  alias?: string[];
  aliasAssigned?: boolean;
  projectId?: string;
  createdAt?: number;
  errorMessage?: string;
  inspectorUrl?: string;
}

const capabilities: Capabilities = {
  runtimes: ["static", "server"],
  languages: ["node", "python"],
  resources: [],
  customDomains: true,
  previewDeployments: true,
  rollback: "native",
};

export function createVercelAdapter(options: AdapterOptions = {}): HostingAdapter {
  const pollMs = Number(options.settings?.pollIntervalMs ?? 2000);

  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Vercel",
      baseUrl: (options.settings?.baseUrl as string | undefined) ?? API,
      headers: { authorization: `Bearer ${accessToken(conn)}` },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });
  const team = (conn: Connection) => (conn.settings.teamId ? { teamId: conn.settings.teamId } : {});

  async function findProject(conn: Connection, idOrName: string): Promise<VercelProject | undefined> {
    try {
      return await client(conn).get<VercelProject>(`/v9/projects/${encodeURIComponent(idOrName)}`, { query: team(conn) });
    } catch (err) {
      if (isLotseError(err) && err.code === "NOT_FOUND") return undefined;
      throw err;
    }
  }

  async function requireProject(app: AppRef): Promise<VercelProject> {
    const project = await findProject(app.connection, app.id ?? app.name);
    if (!project) throw new LotseError("NOT_FOUND", `There is no Vercel project "${app.name}".`);
    return project;
  }

  async function setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
    if (vars.length === 0) return;
    const body = vars.map((v) => ({
      key: v.name,
      value: v.value,
      type: v.secret ? "sensitive" : "plain",
      // Sensitive values cannot target the development environment.
      target: ["production", "preview"],
    }));
    await client(app.connection).post(`/v10/projects/${encodeURIComponent(app.id ?? app.name)}/env`, body, {
      query: { upsert: "true", ...team(app.connection) },
    });
  }

  return {
    id: "vercel",
    displayName: "Vercel",
    auth: ["oauth", "token"],
    capabilities,
    oauth: {
      authorizationEndpoint: "https://vercel.com/oauth/authorize",
      tokenEndpoint: "https://api.vercel.com/login/oauth/token",
      scopes: ["openid", "email", "profile", "offline_access"],
      loopbackRedirect: true,
      envPrefix: "LOTSE_OAUTH_VERCEL",
    },
    tokenSetup: {
      url: "https://vercel.com/account/settings/tokens",
      permissions: ["Scope: the personal account or team that should own the deployments", "Expiration: as short as practical"],
      steps: [
        "Open the token page and choose “Create Token”.",
        "Pick the scope (your account or a team) and an expiration date.",
        "Copy the token and paste it here. It is shown only once.",
      ],
      fields: [
        {
          name: "teamId",
          label: "Team ID",
          required: false,
          placeholder: "team_…",
          help: "Only needed when deploying to a team. Shown under Team Settings → General.",
        },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      if (input.method === "ssh") throw new LotseError("INVALID_INPUT", "Vercel does not support SSH sign-in.");
      const credentials = input.method === "token" ? { token: input.token } : oauthCredentials(input.tokens, input.client);
      const conn: Connection = {
        adapter: "vercel",
        method: input.method,
        account: { id: "", name: "" },
        credentials,
        settings: input.options?.teamId ? { teamId: input.options.teamId } : {},
        expiresAt: input.method === "oauth" ? input.tokens.expiresAt : undefined,
      };
      const { user } = await client(conn)
        .get<{ user: { id: string; username: string; defaultTeamId?: string | null } }>("/v2/user")
        .catch((err) => {
          // Vercel answers 403 for tokens it does not know.
          if (isLotseError(err) && (err.code === "AUTH_FAILED" || err.code === "PERMISSION_MISSING")) {
            throw new LotseError("AUTH_FAILED", "Vercel did not accept the token. Check that it was copied completely and has not expired.");
          }
          throw err;
        });
      conn.account = { id: user.id, name: user.username };
      if (conn.settings.teamId) {
        const t = await client(conn).get<{ id: string; slug: string; name?: string }>(`/v2/teams/${encodeURIComponent(conn.settings.teamId)}`);
        conn.account = { id: t.id, name: `${t.name ?? t.slug} (${user.username})` };
      }
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const result: VerifyResult = { ok: true, account: conn.account.name, missingPermissions: [], warnings: [] };
      try {
        await client(conn).get("/v2/user");
        await client(conn).get("/v9/projects", { query: { limit: 1, ...team(conn) } });
      } catch (err) {
        if (isLotseError(err) && err.code === "PERMISSION_MISSING") result.missingPermissions.push("Read and write access to projects and deployments");
        else if (isLotseError(err) && err.code === "AUTH_FAILED") result.warnings.push("The token is no longer valid.");
        else throw err;
        result.ok = false;
      }
      return result;
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      const project = await findProject(conn, manifest.name);
      const isStatic = manifest.runtime.kind === "static";
      const warnings: string[] = [];
      if (!isStatic) warnings.push("Vercel runs server apps as serverless functions: no background workers, local disk or long-lived connections.");
      return {
        adapter: "vercel",
        app: { adapter: "vercel", name: manifest.name, id: project?.id, connection: conn },
        manifest,
        artifact: isStatic ? "static" : "source",
        firstDeployment: !project,
        steps: [
          { id: "app", title: project ? `Use project ${project.name}` : `Create project ${manifest.name}`, action: project ? "noop" : "create" },
          { id: "env", title: "Set environment variables", action: "update" },
          { id: "deploy", title: isStatic ? "Upload the built site" : "Upload the source and build it on Vercel", action: "create" },
          ...manifest.domains.map((d) => ({ id: `domain:${d}`, title: `Attach domain ${d}`, action: "update" as const })),
        ],
        resources: [],
        warnings,
      };
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      const conn = ctx.connection;
      const http = client(conn);
      const manifest = plan.manifest;
      if (artifact.kind === "image") throw new LotseError("DEPLOY_FAILED", "Vercel cannot run container images.");
      throwIfAborted(ctx.signal);

      let projectId = plan.app.id;
      if (!projectId) {
        yield event.log("deploy", `Creating project ${manifest.name}`);
        const created = await http.post<VercelProject>("/v11/projects", { name: manifest.name }, { query: team(conn) });
        projectId = created.id;
      }
      const app: AppRef = { ...plan.app, id: projectId };
      await setEnv(app, ctx.env);

      const entries = await walkFiles(artifact.dir, { ignore: artifact.kind === "source" ? artifact.ignore : STATIC_SITE_IGNORE });
      const files = await Promise.all(entries.map(async (e) => ({ file: e.path, sha: await hashFile(e.abs, "sha1"), size: e.size, abs: e.abs })));
      const body = {
        name: manifest.name,
        project: projectId,
        files: files.map(({ file, sha, size }) => ({ file, sha, size })),
        ...(ctx.preview ? { meta: { lotsePreview: ctx.preview.id } } : { target: "production" }),
        projectSettings:
          artifact.kind === "static"
            ? { framework: null, buildCommand: null, installCommand: null, outputDirectory: null }
            : {
                ...(manifest.build.command ? { buildCommand: manifest.build.command } : {}),
                ...(manifest.build.output ? { outputDirectory: manifest.build.output } : {}),
              },
      };
      const query = { skipAutoDetectionConfirmation: 1, ...team(conn) };

      // Vercel answers with the list of files it does not have yet; only those are uploaded.
      let deployment: VercelDeployment;
      try {
        deployment = await http.post<VercelDeployment>("/v13/deployments", body, { query, signal: ctx.signal });
      } catch (err) {
        const missing = isLotseError(err) ? ((err.details.body as { error?: { code?: string; missing?: string[] } })?.error ?? {}) : {};
        if (missing.code !== "missing_files" || !missing.missing) throw err;
        const wanted = new Set(missing.missing);
        const uploads = files.filter((f) => wanted.has(f.sha)).filter((f, i, all) => all.findIndex((x) => x.sha === f.sha) === i);
        let done = 0;
        for (const f of uploads) {
          throwIfAborted(ctx.signal);
          await http.post("/v2/files", await readFile(f.abs), {
            contentType: "application/octet-stream",
            headers: { "x-vercel-digest": f.sha, "content-length": String(f.size) },
            query: team(conn),
            signal: ctx.signal,
          });
          yield event.progress("deploy", ++done, uploads.length, `Uploaded ${f.file}`);
        }
        deployment = await http.post<VercelDeployment>("/v13/deployments", body, { query, signal: ctx.signal });
      }
      yield event.log("deploy", `Deployment ${deployment.id} created${deployment.inspectorUrl ? ` (${deployment.inspectorUrl})` : ""}`);

      let state = deployment.readyState;
      while (state !== "READY") {
        if (state === "ERROR" || state === "CANCELED") {
          throw new LotseError(
            "DEPLOY_FAILED",
            `Vercel reported the deployment as ${state.toLowerCase()}${deployment.errorMessage ? `: ${deployment.errorMessage}` : ""}.`,
          );
        }
        try {
          await sleep(pollMs, ctx.signal);
        } catch (err) {
          // Production traffic only moves once a deployment is ready, so cancelling keeps the old version live.
          await http.patch(`/v12/deployments/${deployment.id}/cancel`, undefined, { query: team(conn) }).catch(() => {});
          throw err;
        }
        deployment = await http.get<VercelDeployment>(`/v13/deployments/${deployment.id}`, { query: team(conn) });
        if (deployment.readyState !== state) {
          state = deployment.readyState;
          yield event.log("deploy", `Vercel: ${state.toLowerCase()}`);
        }
      }

      const host = (!ctx.preview && deployment.alias?.[0]) || deployment.url;
      const ref: DeploymentRef = {
        id: deployment.id,
        app,
        url: `https://${host}`,
        createdAt: deployment.createdAt ?? Date.now(),
        version: deployment.id,
        preview: ctx.preview ? true : undefined,
      };
      yield event.status("deploy", "succeeded", ref.url, ref);
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      const projectId = target.app.id ?? (await requireProject(target.app)).id;
      await client(ctx.connection).post(`/v1/projects/${projectId}/rollback/${target.id}`, undefined, { query: team(ctx.connection) });
    },

    async destroy(app: AppRef): Promise<void> {
      try {
        await client(app.connection).delete(`/v9/projects/${encodeURIComponent(app.id ?? app.name)}`, { query: team(app.connection) });
      } catch (err) {
        if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
      }
    },

    setEnv,

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const http = client(app.connection);
      const project = encodeURIComponent(app.id ?? app.name);
      let verified = true;
      let verification: { type: string; domain: string; value: string }[] = [];
      try {
        const added = await http.post<{ verified: boolean; verification?: typeof verification }>(
          `/v10/projects/${project}/domains`,
          { name: domain },
          { query: team(app.connection) },
        );
        verified = added.verified;
        verification = added.verification ?? [];
      } catch (err) {
        // 409: the domain is already attached to this project.
        if (!(isLotseError(err) && err.code === "CONFLICT")) throw err;
      }
      const config = await http.get<{
        misconfigured: boolean;
        recommendedIPv4?: { rank: number; value: string[] }[];
        recommendedCNAME?: { rank: number; value: string }[];
      }>(`/v6/domains/${encodeURIComponent(domain)}/config`, { query: team(app.connection) });
      if (verified && !config.misconfigured) return { domain, state: "active", dnsRecords: [] };
      const apex = domain.split(".").length === 2;
      const dnsRecords: DomainStatus["dnsRecords"] = verification.map((v) => ({ type: "TXT", name: v.domain, value: v.value }));
      if (apex) dnsRecords.push({ type: "A", name: domain, value: config.recommendedIPv4?.[0]?.value[0] ?? "76.76.21.21" });
      else dnsRecords.push({ type: "CNAME", name: domain, value: config.recommendedCNAME?.[0]?.value ?? "cname.vercel-dns.com" });
      return { domain, state: "pending", dnsRecords, message: verified ? "DNS does not point to Vercel yet." : "Ownership of the domain must be verified." };
    },

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const http = client(app.connection);
      let deploymentId = opts.deployment;
      if (!deploymentId) {
        const project = await requireProject(app);
        deploymentId = project.targets?.production?.id;
        if (!deploymentId) return;
      }
      const events = await http.get<{ type?: string; created?: number; date?: number; text?: string; payload?: { text?: string; date?: number } }[]>(
        `/v3/deployments/${deploymentId}/events`,
        {
          query: { builds: 1, limit: opts.tail ?? 100, direction: "backward", ...(opts.since ? { since: opts.since } : {}), ...team(app.connection) },
          signal: opts.signal,
        },
      );
      const lines = (Array.isArray(events) ? events : [])
        .map((e) => ({
          at: e.created ?? e.date ?? e.payload?.date ?? 0,
          stream: e.type === "stderr" ? ("stderr" as const) : ("stdout" as const),
          line: e.text ?? e.payload?.text ?? "",
          source: "build",
        }))
        .filter((l) => l.line !== "")
        .sort((a, b) => a.at - b.at);
      yield* lines;
      if (!opts.follow) return;

      // Runtime logs arrive as a stream of JSON lines.
      const project = await requireProject(app);
      const res = await http.request<Response>("GET", `/v1/projects/${project.id}/deployments/${deploymentId}/runtime-logs`, {
        query: team(app.connection),
        raw: true,
        signal: opts.signal,
      });
      const decoder = new TextDecoder();
      let rest = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        rest += decoder.decode(chunk, { stream: true });
        const parts = rest.split("\n");
        rest = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const row = JSON.parse(part) as { message?: string; level?: string; timestampInMs?: number; source?: string };
            if (row.message)
              yield {
                at: row.timestampInMs ?? Date.now(),
                stream: row.level === "error" || row.level === "fatal" ? "stderr" : "stdout",
                line: row.message,
                source: row.source,
              };
          } catch {
            // ignore keep-alive lines
          }
        }
      }
    },

    async status(app: AppRef): Promise<AppStatus> {
      const project = await findProject(app.connection, app.id ?? app.name);
      if (!project) return { state: "not-found", domains: [] };
      const production = project.targets?.production;
      if (!production) return { state: "stopped", domains: [], message: "The project has no production deployment yet." };
      const domains = production.alias ?? [];
      const state =
        production.readyState === "READY" ? "running" : production.readyState === "ERROR" || production.readyState === "CANCELED" ? "failed" : "deploying";
      return {
        state,
        url: `https://${domains[0] ?? production.url}`,
        domains,
        deployment: { id: production.id, createdAt: production.createdAt },
      };
    },
  };
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createVercelAdapter };
export default pkg;
