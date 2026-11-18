import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ADAPTER_API_VERSION, type AdapterPackage, type DeployContext, type DeploymentRef, event, type HostingAdapter, LotseError } from "@lotseai/core";

// A real local endpoint, so that the engine's health check has something to call.
const server = createServer((_req, res) => res.writeHead(200).end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
export const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** In-memory provider used by the CLI tests. */
export const provider = {
  apps: new Map<string, { deployments: string[]; live?: string }>(),
  contexts: [] as DeployContext[],
  calls: [] as string[],
  reset() {
    this.apps.clear();
    this.contexts.length = 0;
    this.calls.length = 0;
  },
};

const adapter: HostingAdapter = {
  id: "fake",
  displayName: "Fake Cloud",
  auth: ["token"],
  capabilities: { runtimes: ["static", "server"], languages: ["node"], resources: [], customDomains: true, previewDeployments: true, rollback: "native" },
  tokenSetup: { url: "https://fake.example/tokens", permissions: ["deploy"], steps: ["Create a token."] },
  async connect(input) {
    if (input.method !== "token" || !input.token.startsWith("fake-")) throw new LotseError("AUTH_FAILED", "Fake Cloud did not accept the token.");
    return {
      adapter: "fake",
      method: "token",
      account: { id: "u1", name: "ada" },
      credentials: { token: input.token, ...input.secrets },
      settings: { ...input.options },
    };
  },
  async verify() {
    return { ok: true, account: "ada", missingPermissions: [], warnings: [] };
  },
  async plan(manifest, connection) {
    const app = provider.apps.get(manifest.name);
    return {
      adapter: "fake",
      app: { adapter: "fake", name: manifest.name, id: app ? manifest.name : undefined, connection },
      manifest,
      artifact: manifest.runtime.kind === "static" ? "static" : "source",
      firstDeployment: !app,
      steps: [{ id: "app", title: app ? `Update ${manifest.name}` : `Create ${manifest.name}`, action: app ? "update" : "create" }],
      resources: [],
      warnings: [],
    };
  },
  async *deploy(plan, _artifact, ctx) {
    provider.contexts.push(ctx);
    const app = provider.apps.get(plan.manifest.name) ?? { deployments: [] };
    const id = `dep-${app.deployments.length + 1}`;
    yield event.log("deploy", `uploading with token ${ctx.connection.credentials.token}`);
    app.deployments.push(id);
    if (!ctx.preview) app.live = id;
    provider.apps.set(plan.manifest.name, app);
    const ref: DeploymentRef = {
      id,
      app: { ...plan.app, id: plan.manifest.name },
      url: `${baseUrl}/${ctx.preview ? `?preview=${ctx.preview.id}` : `?app=${plan.manifest.name}`}`,
      createdAt: Date.now() + app.deployments.length,
      version: id,
    };
    yield event.status("deploy", "succeeded", ref.url, ref);
  },
  async rollback(target) {
    const app = provider.apps.get(target.app.name);
    if (app) app.live = target.id;
    provider.calls.push(`rollback:${target.id}`);
  },
  async destroy(app) {
    provider.apps.delete(app.name);
    provider.calls.push(`destroy:${app.name}`);
  },
  async setEnv(_app, vars) {
    provider.calls.push(`setEnv:${vars.map((v) => v.name).join(",")}`);
  },
  async addDomain(_app, domain) {
    return { domain, state: "pending", dnsRecords: [{ type: "CNAME", name: domain, value: "edge.fake.example" }] };
  },
  async *logs() {
    yield { at: 1794830000000, stream: "stdout" as const, line: "GET / 200" };
  },
  async status(app) {
    const a = provider.apps.get(app.name);
    return a ? { state: "running", url: `${baseUrl}/?app=${app.name}`, domains: [], deployment: { id: a.live ?? "" } } : { state: "not-found", domains: [] };
  },
};

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: () => adapter };
export default pkg;
