/**
 * The shared contract test suite (specification section 14.2). Every hosting
 * adapter, Git provider and resource adapter MUST pass it. It runs against
 * recorded API responses on every pull request.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type AppRef,
  type ArtifactKind,
  assertHostingAdapter,
  type BuildArtifact,
  type ConnectInput,
  type Connection,
  DEFAULT_IGNORE,
  type DeployContext,
  type DeployEvent,
  type DeploymentRef,
  event,
  type GitProvider,
  type HostingAdapter,
  type ImageTools,
  isLotseError,
  parseManifest,
  type RegistryAuth,
  type RepoRef,
  type ResourceAdapter,
  type ResourceRef,
} from "@lotse/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Cassette, type Interaction, ReplayTransport } from "./replay.js";

export interface FakeImageTools extends ImageTools {
  pushed: { image: string; target: string; auth?: RegistryAuth }[];
  saved: string[];
}

export function fakeImageTools(): FakeImageTools {
  const tools: FakeImageTools = {
    pushed: [],
    saved: [],
    async *push(image, target, auth) {
      tools.pushed.push({ image, target, auth });
      yield event.log("deploy", `Pushing ${target}`);
      return target;
    },
    save(image) {
      tools.saved.push(image);
      return Readable.from([Buffer.from("fake image tar")]);
    },
  };
  return tools;
}

export interface Scenario {
  name: string;
  interactions: Interaction[];
  transport: ReplayTransport;
  fetch: typeof fetch;
  images: FakeImageTools;
}

export function scenarioOf(cassette: Cassette, name: string): Scenario {
  const interactions = cassette.scenarios[name];
  if (!interactions) throw new Error(`The cassette for "${cassette.adapter}" has no scenario "${name}".`);
  const transport = new ReplayTransport(interactions, `${cassette.adapter}/${name}`);
  return { name, interactions, transport, fetch: transport.fetch, images: fakeImageTools() };
}

async function drain(iterable: AsyncIterable<DeployEvent>): Promise<{ events: DeployEvent[]; error?: unknown }> {
  const events: DeployEvent[] = [];
  try {
    for await (const e of iterable) events.push(e);
  } catch (error) {
    return { events, error };
  }
  return { events };
}

function secretsOf(conn: Connection): string[] {
  return Object.values(conn.credentials).filter((v) => v.length >= 6);
}

export interface HostingContractOptions {
  cassette: Cassette;
  /** Creates the adapter for one scenario, wired to that scenario's transport. */
  create(scenario: Scenario): HostingAdapter;
  connectInput: ConnectInput;
  invalidConnectInput: ConnectInput;
  /** YAML of the reference app's manifest. */
  manifest: string;
  /** Provider-side identifiers the recorded responses refer to. */
  fixtures: {
    appId: string;
    appMeta?: Record<string, string>;
    previousDeployment: { id: string; version?: string; url?: string; meta?: Record<string, string> };
    domain?: string;
  };
  /** State-changing operations a scenario performed. Defaults to non-GET HTTP requests. */
  mutations?(scenario: Scenario): number;
  /** Extra check after each scenario, e.g. that a scripted SSH transcript was consumed. */
  afterScenario?(scenario: Scenario): void;
}

const RUNTIMES = ["static", "server", "container"];

export function runHostingContract(options: HostingContractOptions): void {
  const { cassette, fixtures } = options;
  const manifest = parseManifest(options.manifest);
  let dir = "";
  let connection: Connection;

  const open = (name: string) => {
    const scenario = scenarioOf(cassette, name);
    return { scenario, adapter: options.create(scenario) };
  };
  const finish = (scenario: Scenario) => {
    expect(scenario.transport.unused(), "recorded interactions that were never requested").toEqual([]);
    options.afterScenario?.(scenario);
  };
  const mutations = (scenario: Scenario) => options.mutations?.(scenario) ?? scenario.transport.mutations().length;
  const app = (): AppRef => ({ adapter: cassette.adapter, name: manifest.name, id: fixtures.appId, meta: fixtures.appMeta, connection });
  const context = (extra: Partial<DeployContext> = {}): DeployContext => ({
    connection,
    workdir: dir,
    env: [
      { name: "APP_NAME", value: "Reference", secret: false },
      { name: "API_KEY", value: "contract-secret-value", secret: true },
    ],
    resources: [],
    ...extra,
  });
  const artifact = (kind: ArtifactKind): BuildArtifact =>
    kind === "static"
      ? { kind, dir, files: 2, bytes: 64 }
      : kind === "source"
        ? { kind, dir, ignore: DEFAULT_IGNORE }
        : { kind, image: `lotse/${manifest.name}:contract`, digest: "sha256:0000", platform: "linux/amd64", runtime: "docker", port: manifest.runtime.port };

  describe(`hosting adapter contract: ${cassette.adapter}`, () => {
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "lotse-contract-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>Reference</title><h1>Lotse reference app</h1>\n");
      await writeFile(join(dir, "health"), "ok\n");
      const { adapter } = open("connect");
      connection = await adapter.connect(options.connectInput);
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("declares valid metadata and capabilities", () => {
      const { adapter } = open("connect");
      expect(() => assertHostingAdapter(adapter)).not.toThrow();
      expect(adapter.id).toBe(cassette.adapter);
      const caps = adapter.capabilities;
      expect(caps.runtimes.length).toBeGreaterThan(0);
      expect(caps.runtimes.every((r) => RUNTIMES.includes(r))).toBe(true);
      expect(["native", "redeploy", "none"]).toContain(caps.rollback);
      expect(typeof caps.customDomains).toBe("boolean");
      expect(typeof caps.previewDeployments).toBe("boolean");
      expect(Boolean(adapter.addDomain), "addDomain must exist exactly when customDomains is reported").toBe(caps.customDomains);
      expect(caps.resources.length === 0 || typeof adapter.provision === "function").toBe(true);
      if (adapter.auth.includes("oauth")) {
        expect(adapter.oauth?.authorizationEndpoint).toMatch(/^https:\/\//);
        expect(adapter.oauth?.tokenEndpoint).toMatch(/^https:\/\//);
        expect(adapter.oauth?.envPrefix).toMatch(/^LOTSE_OAUTH_[A-Z_]+$/);
      }
      if (adapter.auth.includes("token")) {
        expect(adapter.tokenSetup?.url ?? "").toMatch(/^https?:\/\/|^\{/);
        expect(adapter.tokenSetup?.permissions.length).toBeGreaterThan(0);
        expect(adapter.tokenSetup?.steps.length).toBeGreaterThan(0);
      }
    });

    it("connects and returns a storable connection", async () => {
      const { scenario, adapter } = open("connect");
      const conn = await adapter.connect(options.connectInput);
      expect(conn.adapter).toBe(cassette.adapter);
      expect(conn.method).toBe(options.connectInput.method);
      expect(conn.account.id).toBeTruthy();
      expect(conn.account.name).toBeTruthy();
      expect(Object.keys(conn.credentials).length).toBeGreaterThan(0);
      // Plain data, so that it survives the encrypted store.
      expect(JSON.parse(JSON.stringify(conn))).toEqual(conn);
      // Secrets belong in `credentials`, never in `settings`.
      for (const secret of secretsOf(conn)) expect(JSON.stringify(conn.settings)).not.toContain(secret);
      finish(scenario);
    });

    it("rejects invalid credentials with AUTH_FAILED", async () => {
      const { scenario, adapter } = open("connect-invalid");
      const err = await adapter.connect(options.invalidConnectInput).catch((e) => e);
      expect(isLotseError(err), `expected a LotseError, got ${String(err)}`).toBe(true);
      expect(["AUTH_FAILED", "PERMISSION_MISSING"], err.message).toContain(err.code);
      finish(scenario);
    });

    it("verifies the permissions deployments need", async () => {
      const { scenario, adapter } = open("verify");
      const result = await adapter.verify(connection);
      expect(result).toMatchObject({ ok: true, missingPermissions: [] });
      expect(Array.isArray(result.warnings)).toBe(true);
      finish(scenario);
    });

    it("plans without changing anything", async () => {
      const { scenario, adapter } = open("plan");
      const plan = await adapter.plan(manifest, connection);
      expect(plan.adapter).toBe(cassette.adapter);
      expect(plan.app.name).toBe(manifest.name);
      expect(plan.manifest).toEqual(manifest);
      expect(["static", "image", "source"]).toContain(plan.artifact);
      expect(plan.firstDeployment).toBe(true);
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.every((s) => s.id && s.title && ["create", "update", "noop", "delete"].includes(s.action))).toBe(true);
      expect(mutations(scenario), "plan() must not modify anything at the provider").toBe(0);
      finish(scenario);
    });

    it("deploys and reports the deployment through events", async () => {
      const { scenario, adapter } = open("deploy");
      const plan = await adapter.plan(manifest, connection);
      const { events, error } = await drain(adapter.deploy(plan, artifact(plan.artifact), context()));
      expect(error, `deploy() threw: ${String(error)}`).toBeUndefined();
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(["status", "progress", "log", "error"]).toContain(e.type);
        expect(typeof e.at).toBe("number");
        expect(typeof e.phase).toBe("string");
      }
      const last = events.at(-1) as DeployEvent;
      expect(last).toMatchObject({ type: "status", phase: "deploy", state: "succeeded" });
      const deployment = (last as { deployment?: DeploymentRef }).deployment as DeploymentRef;
      expect(deployment.id).toBeTruthy();
      expect(deployment.app.name).toBe(manifest.name);
      expect(deployment.app.id).toBeTruthy();
      expect(deployment.url ?? deployment.probe?.url).toMatch(/^https?:\/\//);
      expect(typeof deployment.createdAt).toBe("number");
      // Credentials and secret values never appear in events.
      const text = JSON.stringify(events.map((e) => (e.type === "status" ? { ...e, deployment: undefined } : e)));
      for (const secret of [...secretsOf(connection), "contract-secret-value"]) expect(text).not.toContain(secret);
      finish(scenario);
    });

    it("leaves the running version untouched when aborted", async () => {
      const { scenario, adapter } = open("deploy");
      const plan = await adapter.plan(manifest, connection);
      const before = mutations(scenario);
      const { events, error } = await drain(adapter.deploy(plan, artifact(plan.artifact), context({ signal: AbortSignal.abort() })));
      const last = events.at(-1);
      const reported = isLotseError(error) ? error.code === "ABORTED" : last?.type === "status" && last.state === "failed";
      expect(reported, "an aborted deployment must throw ABORTED or end with a failed status").toBe(true);
      expect(mutations(scenario) - before, "an aborted deployment must not change anything").toBe(0);
    });

    it.runIf(Boolean(cassette.scenarios["deploy-failed"]))("reports a deployment the provider failed", async () => {
      const { scenario, adapter } = open("deploy-failed");
      const plan = await adapter.plan(manifest, connection);
      const { events, error } = await drain(adapter.deploy(plan, artifact(plan.artifact), context()));
      const last = events.at(-1);
      if (error) {
        expect(isLotseError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("DEPLOY_FAILED");
      } else {
        expect(last).toMatchObject({ type: "status", phase: "deploy", state: "failed" });
      }
      finish(scenario);
    });

    it("reports the app status", async () => {
      const { scenario, adapter } = open("status");
      const status = await adapter.status(app());
      expect(["running", "deploying", "stopped", "failed", "unknown"]).toContain(status.state);
      expect(Array.isArray(status.domains)).toBe(true);
      if (status.url) expect(status.url).toMatch(/^https?:\/\//);
      finish(scenario);
    });

    it("streams logs", async () => {
      const { scenario, adapter } = open("logs");
      const lines = [];
      for await (const line of adapter.logs(app(), { tail: 50 })) lines.push(line);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(typeof line.at).toBe("number");
        expect(["stdout", "stderr", "system"]).toContain(line.stream);
        expect(typeof line.line).toBe("string");
      }
      finish(scenario);
    });

    it("sets environment variables", async () => {
      const { scenario, adapter } = open("set-env");
      await adapter.setEnv(app(), context().env);
      // Hosts that only serve static files have no runtime environment to change.
      if (adapter.capabilities.runtimes.some((r) => r !== "static")) expect(mutations(scenario)).toBeGreaterThan(0);
      finish(scenario);
    });

    it("attaches custom domains exactly when it reports support for them", async () => {
      const { scenario, adapter } = open(cassette.scenarios["add-domain"] ? "add-domain" : "connect");
      if (!adapter.capabilities.customDomains) {
        expect(adapter.addDomain).toBeUndefined();
        return;
      }
      const domain = fixtures.domain ?? "app.example.com";
      const status = await (adapter.addDomain as NonNullable<HostingAdapter["addDomain"]>)(app(), domain);
      expect(status.domain).toBe(domain);
      expect(["active", "pending", "error"]).toContain(status.state);
      if (status.state === "pending") expect(status.dnsRecords.length).toBeGreaterThan(0);
      finish(scenario);
    });

    it("rolls back exactly when it reports support for it", async () => {
      const { scenario, adapter } = open(cassette.scenarios.rollback ? "rollback" : "connect");
      const target: DeploymentRef = { ...fixtures.previousDeployment, app: app(), createdAt: 1_700_000_000_000 };
      if (adapter.capabilities.rollback === "none") {
        await expect(adapter.rollback(target, context())).rejects.toMatchObject({ code: "ROLLBACK_UNSUPPORTED" });
        return;
      }
      await adapter.rollback(target, context());
      expect(mutations(scenario)).toBeGreaterThan(0);
      finish(scenario);
    });

    it("destroys the app", async () => {
      const { scenario, adapter } = open("destroy");
      await adapter.destroy(app(), context());
      expect(mutations(scenario)).toBeGreaterThan(0);
      finish(scenario);
    });
  });
}

// ---------------------------------------------------------------------------
// Git providers
// ---------------------------------------------------------------------------

export interface GitContractOptions {
  cassette: Cassette;
  create(scenario: Scenario): GitProvider;
  connectInput: ConnectInput;
  invalidConnectInput: ConnectInput;
  /** A repository that exists in the recorded responses. */
  repo: Omit<RepoRef, "connection">;
  newRepoName: string;
}

export function runGitContract(options: GitContractOptions): void {
  const { cassette } = options;
  let connection: Connection;
  const open = (name: string) => {
    const scenario = scenarioOf(cassette, name);
    return { scenario, provider: options.create(scenario) };
  };
  const finish = (scenario: Scenario) => expect(scenario.transport.unused(), "recorded interactions that were never requested").toEqual([]);
  const repo = (): RepoRef => ({ ...options.repo, connection });

  describe(`git provider contract: ${cassette.adapter}`, () => {
    beforeAll(async () => {
      connection = await open("connect").provider.connect(options.connectInput);
    });

    it("declares valid metadata", () => {
      const { provider } = open("connect");
      expect(provider.id).toBe(cassette.adapter);
      expect(provider.displayName).toBeTruthy();
      expect(provider.auth.length).toBeGreaterThan(0);
      if (provider.auth.includes("oauth")) expect(provider.oauth?.tokenEndpoint).toBeTruthy();
      if (provider.auth.includes("token")) expect(provider.tokenSetup?.permissions.length).toBeGreaterThan(0);
      if (provider.pages) expect(() => assertHostingAdapter(provider.pages as HostingAdapter)).not.toThrow();
    });

    it("connects and returns a storable connection", async () => {
      const { scenario, provider } = open("connect");
      const conn = await provider.connect(options.connectInput);
      expect(conn.adapter).toBe(cassette.adapter);
      expect(conn.account.name).toBeTruthy();
      expect(JSON.parse(JSON.stringify(conn))).toEqual(conn);
      finish(scenario);
    });

    it("rejects invalid credentials with AUTH_FAILED", async () => {
      const { scenario, provider } = open("connect-invalid");
      await expect(provider.connect(options.invalidConnectInput)).rejects.toMatchObject({ code: "AUTH_FAILED" });
      finish(scenario);
    });

    it("lists repositories", async () => {
      const { scenario, provider } = open("list-repos");
      const repos = await provider.listRepos(connection);
      expect(repos.length).toBeGreaterThan(0);
      for (const r of repos) {
        expect(r.provider).toBe(cassette.adapter);
        expect(r.owner && r.name && r.defaultBranch).toBeTruthy();
        expect(r.cloneUrl).toMatch(/^https:\/\/[^@]+$/);
        expect(r.connection).toBe(connection);
      }
      finish(scenario);
    });

    it("creates a repository", async () => {
      const { scenario, provider } = open("create-repo");
      const created = await provider.createRepo(connection, { name: options.newRepoName, private: true, description: "Created by the contract tests" });
      expect(created.name).toBe(options.newRepoName);
      expect(created.private).toBe(true);
      expect(created.cloneUrl).toMatch(/^https:\/\//);
      finish(scenario);
    });

    it("returns a clone URL with credentials kept apart", async () => {
      const { scenario, provider } = open("remote-url");
      const auth = await provider.remoteUrl(repo(), connection);
      expect(auth.url).toBe(options.repo.cloneUrl);
      expect(auth.username).toBeTruthy();
      expect(auth.password).toBeTruthy();
      expect(auth.url).not.toContain(auth.password);
      finish(scenario);
    });

    it("stores CI secrets, writes the deploy workflow and comments on requests", async () => {
      const provider0 = open("connect").provider;
      if (provider0.setCiSecret) {
        const { scenario, provider } = open("set-ci-secret");
        await provider.setCiSecret?.(repo(), "LOTSE_SSH_KEY", "contract-secret-value");
        const sent = JSON.stringify(scenario.transport.requests.map((r) => r.url));
        expect(sent).not.toContain("contract-secret-value");
        finish(scenario);
      }
      if (provider0.writeWorkflow) {
        const { scenario, provider } = open("write-workflow");
        await provider.writeWorkflow?.(repo(), { adapter: "ssh", branch: "main", secrets: ["LOTSE_SSH_KEY"], cliVersion: "0.1.0" });
        expect(scenario.transport.mutations().length).toBeGreaterThan(0);
        finish(scenario);
      }
      if (provider0.comment) {
        const { scenario, provider } = open("comment");
        await provider.comment?.(repo(), 7, "Preview: https://preview.example.test");
        expect(JSON.stringify(scenario.transport.requests.at(-1)?.body)).toContain("https://preview.example.test");
        finish(scenario);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Resource adapters
// ---------------------------------------------------------------------------

export interface ResourceContractOptions {
  cassette: Cassette;
  create(scenario: Scenario): ResourceAdapter;
  connectInput: ConnectInput;
  invalidConnectInput: ConnectInput;
  appName: string;
  resourceName: string;
}

export function runResourceContract(options: ResourceContractOptions): void {
  const { cassette } = options;
  let connection: Connection;
  let provisioned: ResourceRef;
  const open = (name: string) => {
    const scenario = scenarioOf(cassette, name);
    return { scenario, adapter: options.create(scenario) };
  };
  const finish = (scenario: Scenario) => expect(scenario.transport.unused(), "recorded interactions that were never requested").toEqual([]);
  const app = (): AppRef => ({ adapter: cassette.adapter, name: options.appName, connection });

  describe(`resource adapter contract: ${cassette.adapter}`, () => {
    beforeAll(async () => {
      connection = await open("connect").adapter.connect(options.connectInput);
      const { adapter } = open("provision");
      provisioned = await adapter.provision(app(), { type: adapter.resources[0] as string, name: options.resourceName });
    });

    it("declares what it provides", () => {
      const { adapter } = open("connect");
      expect(adapter.id).toBe(cassette.adapter);
      expect(adapter.resources.length).toBeGreaterThan(0);
      expect(adapter.auth.length).toBeGreaterThan(0);
    });

    it("rejects invalid credentials and verifies valid ones", async () => {
      const invalid = open("connect-invalid");
      await expect(invalid.adapter.connect(options.invalidConnectInput)).rejects.toMatchObject({ code: "AUTH_FAILED" });
      const verify = open("verify");
      expect(await verify.adapter.verify(connection)).toMatchObject({ ok: true, missingPermissions: [] });
      finish(verify.scenario);
    });

    it("provisions the resource and returns its connection values as secrets", async () => {
      const { scenario, adapter } = open("provision");
      const ref = await adapter.provision(app(), { type: adapter.resources[0] as string, name: options.resourceName });
      expect(ref).toMatchObject({ provider: cassette.adapter, name: options.resourceName });
      expect(ref.id).toBeTruthy();
      expect(ref.env.length).toBeGreaterThan(0);
      expect(ref.env.some((e) => e.secret)).toBe(true);
      // Connection strings must not leak into non-secret metadata.
      for (const e of ref.env.filter((v) => v.secret)) expect(JSON.stringify(ref.meta ?? {})).not.toContain(e.value);
      finish(scenario);
    });

    it("reports the status and destroys the resource", async () => {
      const status = open("status");
      expect(["ready", "creating"]).toContain((await status.adapter.status(app(), provisioned)).state);
      finish(status.scenario);
      const destroy = open("destroy");
      await destroy.adapter.destroy(app(), provisioned);
      expect(destroy.scenario.transport.mutations().length).toBeGreaterThan(0);
      finish(destroy.scenario);
    });
  });
}
