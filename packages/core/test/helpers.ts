import {
  type AppRef,
  type BuildArtifact,
  type Builder,
  type Capabilities,
  type Connection,
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
  type EnvVar,
  event,
  type HostingAdapter,
  type Manifest,
  parseManifest,
  type ResourceAdapter,
  type ResourceRef,
  type ResourceSpec,
} from "../src/index.js";

export const connection: Connection = {
  adapter: "fake",
  method: "token",
  account: { id: "acct-1", name: "Test account" },
  credentials: { token: "super-secret-token-123" },
  settings: {},
};

export function manifest(yaml: string): Manifest {
  return parseManifest(yaml);
}

export const serverManifest = `version: 1
name: demo
runtime:
  kind: server
  language: node
  port: 3000
  healthcheck: /health
`;

export interface FakeAdapter extends HostingAdapter {
  calls: string[];
  lastContext?: DeployContext;
  deployments: DeploymentRef[];
  failDeploy?: string;
}

export function fakeAdapter(overrides: Partial<Capabilities> = {}, id = "fake"): FakeAdapter {
  let counter = 0;
  const adapter: FakeAdapter = {
    id,
    displayName: `Fake (${id})`,
    auth: ["token"],
    capabilities: {
      runtimes: ["static", "server", "container"],
      languages: ["node"],
      resources: [],
      customDomains: true,
      previewDeployments: true,
      rollback: "native",
      ...overrides,
    },
    tokenSetup: { url: "https://example.com/tokens", permissions: ["deploy"], steps: ["Create a token"] },
    calls: [],
    deployments: [],
    async connect() {
      return connection;
    },
    async verify() {
      return { ok: true, missingPermissions: [], warnings: [] };
    },
    async plan(m: Manifest, conn: Connection): Promise<DeploymentPlan> {
      adapter.calls.push("plan");
      return {
        adapter: id,
        app: { adapter: id, name: m.name, connection: conn },
        manifest: m,
        artifact: m.runtime.kind === "static" ? "static" : "image",
        firstDeployment: adapter.deployments.length === 0,
        steps: [{ id: "app", title: `Create app ${m.name}`, action: "create" }],
        resources: [],
        warnings: [],
      };
    },
    async *deploy(plan: DeploymentPlan, _artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      adapter.calls.push("deploy");
      adapter.lastContext = ctx;
      yield event.log("deploy", `uploading with ${ctx.connection.credentials.token}`);
      if (adapter.failDeploy) throw new Error(adapter.failDeploy);
      counter++;
      const ref: DeploymentRef = {
        id: `dep-${counter}`,
        app: { ...plan.app, id: "app-1" },
        url: `https://demo-${counter}.example.test`,
        createdAt: 1_700_000_000_000 + counter,
        version: `v${counter}`,
      };
      adapter.deployments.push(ref);
      yield event.status("deploy", "succeeded", ref.url, ref);
    },
    async rollback(target: DeploymentRef) {
      adapter.calls.push(`rollback:${target.id}`);
    },
    async destroy(app: AppRef) {
      adapter.calls.push(`destroy:${app.name}`);
    },
    async setEnv(_app: AppRef, vars: EnvVar[]) {
      adapter.calls.push(`setEnv:${vars.map((v) => v.name).join(",")}`);
    },
    async addDomain(_app: AppRef, domain: string) {
      adapter.calls.push(`addDomain:${domain}`);
      return { domain, state: "pending" as const, dnsRecords: [{ type: "CNAME" as const, name: domain, value: "cname.example.test" }] };
    },
    async *logs() {
      yield { at: 1, stream: "stdout" as const, line: "hello super-secret-token-123" };
    },
    async status() {
      return { state: "running" as const, domains: [] };
    },
  };
  return adapter;
}

export function fakeResourceAdapter(id = "fakedb"): ResourceAdapter & { calls: string[] } {
  const adapter = {
    id,
    displayName: "Fake DB",
    auth: ["token" as const],
    resources: ["postgres"],
    calls: [] as string[],
    async connect() {
      return { ...connection, adapter: id };
    },
    async verify() {
      return { ok: true, missingPermissions: [], warnings: [] };
    },
    async provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
      adapter.calls.push(`provision:${app.name}:${res.name}`);
      return {
        type: res.type,
        name: res.name,
        id: "db-123",
        provider: id,
        env: [{ name: "DATABASE_URL", value: "postgres://user:pw-very-secret@db.example.test/app", secret: true }],
      };
    },
    async destroy(_app: AppRef, res: ResourceRef) {
      adapter.calls.push(`destroy:${res.name}`);
    },
    async status() {
      return { state: "ready" as const };
    },
  };
  return adapter;
}

export function fakeBuilder(): Builder & { requests: string[] } {
  const builder = {
    requests: [] as string[],
    async *build(request: Parameters<Builder["build"]>[0]): AsyncGenerator<DeployEvent, BuildArtifact, void> {
      builder.requests.push(request.artifact);
      yield event.log("build", "compiling");
      if (request.artifact === "static") return { kind: "static", dir: "/tmp/out", files: 1, bytes: 10 };
      if (request.artifact === "source") return { kind: "source", dir: request.workdir, ignore: [] };
      return { kind: "image", image: "demo:1", platform: "linux/amd64", runtime: "docker" };
    },
  };
  return builder;
}
