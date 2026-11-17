/**
 * Live tests (specification section 14.2): a real deployment of the reference
 * app with a test account. They run nightly and before every release, and are
 * skipped when the credentials for a provider are not in the environment.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBuilder } from "@lotse/build";
import {
  AdapterRegistry,
  type AppRef,
  type ConnectInput,
  type Connection,
  collectEvents,
  DeploymentEngine,
  formatEvent,
  type GitProvider,
  GitWorkspace,
  type HostingAdapter,
  loadManifest,
  MemoryStateStore,
  MemoryVault,
  type ResourceAdapter,
  type ResourceRef,
} from "@lotse/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_MARKER, writeReferenceServer, writeReferenceStaticSite } from "./reference.js";
import { RecordingTransport, saveCassette } from "./replay.js";

/** How a live test reaches the provider; with `LOTSE_RECORD` set, every interaction is recorded. */
export interface LiveTransport {
  /** Pass to the adapter. Undefined when not recording, so the adapter uses the global `fetch`. */
  fetch?: typeof fetch;
  /** Values that must not appear in the recording. */
  protect(...secrets: (string | undefined)[]): void;
  /** Writes the recording, if any. */
  save(): Promise<void>;
}

/**
 * Records a live run's API traffic into `<LOTSE_RECORD>/<adapter>.live.json`.
 * Maintainers turn the recording into the contract cassette's scenarios, so
 * that the contract tests replay what the provider really answers.
 */
export function liveTransport(adapter: string, env: NodeJS.ProcessEnv = process.env): LiveTransport {
  const dir = env.LOTSE_RECORD;
  if (!dir) return { protect: () => {}, save: async () => {} };
  const recording = new RecordingTransport();
  return {
    fetch: recording.fetch,
    protect: (...secrets) => void recording.protect(...secrets),
    save: () =>
      saveCassette(join(dir, `${adapter}.live.json`), {
        adapter,
        source: "live",
        recordedAt: new Date().toISOString(),
        notes: "Recorded by the live tests with credentials scrubbed. Review it, then copy the interactions into the scenarios of test/cassette.json.",
        scenarios: { live: recording.interactions },
      }),
  };
}

function inputSecrets(input: ConnectInput): (string | undefined)[] {
  const values = Object.values(input.secrets ?? {});
  if (input.method === "token") return [input.token, ...values];
  if (input.method === "oauth") return [input.tokens.accessToken, input.tokens.refreshToken, input.client?.clientSecret, ...values];
  return [input.password, input.privateKey, ...values];
}

export interface LiveOptions {
  adapter: HostingAdapter;
  /** Returns the sign-in input from the environment, or undefined to skip the test. */
  connect(env: NodeJS.ProcessEnv): ConnectInput | undefined;
  /** Which reference app to deploy. */
  app: "static" | "server";
  /** External resource providers the reference app's database comes from. */
  resources?: { adapter: ResourceAdapter; connect(env: NodeJS.ProcessEnv): ConnectInput | undefined }[];
  healthTimeoutMs?: number;
  /** Runs once after signing in, e.g. to create and set up a server. Returns the connection to deploy with. */
  prepare?(connection: Connection): Promise<Connection>;
  /** Runs at the very end, also after failures, e.g. to delete that server again. */
  cleanup?(connection: Connection): Promise<void>;
  /** The transport the adapter was created with, to record the run (see `liveTransport`). */
  transport?: LiveTransport;
}

/** Sign-in options from environment variables, leaving out those that are not set. */
export function envOptions(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  return res.text();
}

export function runLiveDeployment(options: LiveOptions): void {
  const { adapter } = options;
  const input = options.connect(process.env);

  describe.skipIf(!input)(`live deployment: ${adapter.id} (${options.app})`, () => {
    const name = `lotse-live-${randomBytes(4).toString("hex")}`;
    const registry = new AdapterRegistry().registerHosting(adapter);
    const engine = new DeploymentEngine({ registry, builder: new LocalBuilder(), state: new MemoryStateStore(), vault: new MemoryVault() });
    let dir = "";
    let connection: Connection;
    let deployed = false;

    const write = (version: string) => (options.app === "static" ? writeReferenceStaticSite(dir, name, version) : writeReferenceServer(dir, name, { version }));
    const deploy = async () => {
      const manifest = await loadManifest(dir);
      const target = { adapter: adapter.id, connection };
      const plan = await engine.plan(manifest, target);
      const { events, result } = await collectEvents(engine.deploy(plan, { ...target, workdir: dir, healthTimeoutMs: options.healthTimeoutMs ?? 300_000 }));
      if (!result.ok) console.error(events.map(formatEvent).join("\n"));
      return result;
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "lotse-live-"));
      options.transport?.protect(...inputSecrets(input as ConnectInput));
      connection = await adapter.connect(input as ConnectInput);
      options.transport?.protect(...Object.values(connection.credentials));
      if (options.prepare) connection = await options.prepare(connection);
      options.transport?.protect(...Object.values(connection.credentials));
    });

    afterAll(async () => {
      if (deployed)
        await engine
          .destroy(await loadManifest(dir), { adapter: adapter.id, connection, workdir: dir })
          .catch((err) => console.error(`cleanup failed: ${err}`));
      if (connection) await options.cleanup?.(connection).catch((err) => console.error(`cleanup failed: ${err}`));
      await options.transport?.save();
      await rm(dir, { recursive: true, force: true });
    });

    it("has the permissions deployments need", async () => {
      expect(await adapter.verify(connection)).toMatchObject({ ok: true, missingPermissions: [] });
    });

    it("deploys the reference app to a public URL", async () => {
      await write("1");
      const result = await deploy();
      deployed = true;
      expect(result.ok).toBe(true);
      const body = await fetchText(result.deployment?.url as string);
      expect(body).toContain(REFERENCE_MARKER);
      expect(body).toContain("version 1");
      expect((await engine.status(adapter.id, name, connection)).state).toBe("running");
    });

    it("deploys a new version and rolls back to the previous one", async () => {
      await write("2");
      const result = await deploy();
      expect(result.ok).toBe(true);
      expect(await fetchText(result.deployment?.url as string)).toContain("version 2");
      if (adapter.capabilities.rollback === "none") return;
      const manifest = await loadManifest(dir);
      const rollback = await collectEvents(engine.rollback(manifest, { adapter: adapter.id, connection, workdir: dir }));
      expect(rollback.result.ok).toBe(true);
      const url = (await engine.status(adapter.id, name, connection)).url ?? (rollback.result.deployment?.url as string);
      await expect.poll(() => fetchText(url), { timeout: 120_000, interval: 5000 }).toContain("version 1");
    });

    it("removes the app again", async () => {
      await engine.destroy(await loadManifest(dir), { adapter: adapter.id, connection, workdir: dir });
      deployed = false;
      expect(["not-found", "stopped", "unknown"]).toContain((await adapter.status({ adapter: adapter.id, name, connection })).state);
    });
  });
}

export interface LiveResourceOptions {
  adapter: ResourceAdapter;
  /** Returns the sign-in input from the environment, or undefined to skip the test. */
  connect(env: NodeJS.ProcessEnv): ConnectInput | undefined;
  /** Options passed to `provision`, e.g. a region close to the test runner. */
  options?: Record<string, string>;
  /** The transport the adapter was created with, to record the run (see `liveTransport`). */
  transport?: LiveTransport;
}

/** Live test of an external database provider: create a database, use it, remove it. */
export function runLiveResource(options: LiveResourceOptions): void {
  const { adapter } = options;
  const input = options.connect(process.env);

  describe.skipIf(!input)(`live resource: ${adapter.id}`, () => {
    const name = `lotse-live-${randomBytes(4).toString("hex")}`;
    let connection: Connection;
    let ref: ResourceRef | undefined;
    const app = (): AppRef => ({ adapter: adapter.id, name, connection });

    beforeAll(async () => {
      options.transport?.protect(...inputSecrets(input as ConnectInput));
      connection = await adapter.connect(input as ConnectInput);
      options.transport?.protect(...Object.values(connection.credentials));
    });

    afterAll(async () => {
      if (ref) await adapter.destroy(app(), ref).catch((err) => console.error(`cleanup failed: ${err}`));
      await options.transport?.save();
    });

    it("has the permissions provisioning needs", async () => {
      expect(await adapter.verify(connection)).toMatchObject({ ok: true, missingPermissions: [] });
    });

    it("creates a database that accepts connections with the returned values", async () => {
      ref = await adapter.provision(app(), { type: "postgres", name: "db", options: options.options });
      options.transport?.protect(...ref.env.filter((e) => e.secret).map((e) => e.value));
      expect(ref.env.length).toBeGreaterThan(0);
      await expect.poll(async () => (await adapter.status(app(), ref as ResourceRef)).state, { timeout: 300_000, interval: 5000 }).toBe("ready");
      for (const variable of ref.env) {
        const client = new pg.Client({ connectionString: variable.value, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 60_000 });
        await client.connect();
        try {
          await client.query("create table if not exists lotse_live (id int primary key, note text)");
          await client.query("insert into lotse_live values (1, $1) on conflict (id) do update set note = excluded.note", [variable.name]);
          expect((await client.query("select note from lotse_live where id = 1")).rows).toEqual([{ note: variable.name }]);
        } finally {
          await client.end();
        }
      }
    });

    it("removes the database again", async () => {
      await adapter.destroy(app(), ref as ResourceRef);
      await expect.poll(async () => (await adapter.status(app(), ref as ResourceRef)).state, { timeout: 120_000, interval: 5000 }).toBe("not-found");
      ref = undefined;
    });
  });
}

export interface LiveGitOptions {
  provider: GitProvider;
  /** Returns the sign-in input from the environment, or undefined to skip the test. */
  connect(env: NodeJS.ProcessEnv): ConnectInput | undefined;
  /**
   * `owner/name` of an existing, disposable test repository. The interface has
   * no way to delete repositories, so the live test does not create new ones.
   */
  repo(env: NodeJS.ProcessEnv): string | undefined;
  /** The transport the provider was created with, to record the run (see `liveTransport`). */
  transport?: LiveTransport;
}

/** Live test of a Git platform against a disposable test repository of a test account. */
export function runLiveGit(options: LiveGitOptions): void {
  const { provider } = options;
  const input = options.connect(process.env);
  const path = options.repo(process.env);

  describe.skipIf(!input || !path)(`live git: ${provider.id}`, () => {
    const marker = `lotse-live-${randomBytes(4).toString("hex")}`;
    let connection: Connection;
    let repo: Awaited<ReturnType<GitProvider["listRepos"]>>[number];
    let dir = "";

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "lotse-live-git-"));
      options.transport?.protect(...inputSecrets(input as ConnectInput), marker);
      connection = await provider.connect(input as ConnectInput);
      options.transport?.protect(...Object.values(connection.credentials));
    });

    afterAll(async () => {
      await options.transport?.save();
      await rm(dir, { recursive: true, force: true });
    });

    it("finds the test repository", async () => {
      const name = (path as string).split("/").pop() as string;
      const found = (await provider.listRepos(connection, name)).find((r) => `${r.owner}/${r.name}`.toLowerCase() === (path as string).toLowerCase());
      expect(found, `the account cannot see ${path}`).toBeDefined();
      repo = found as typeof repo;
    });

    it("pushes a commit and reads it back", async () => {
      const auth = await provider.remoteUrl(repo, connection);
      const ws = await GitWorkspace.clone(auth, join(dir, "work"), repo.defaultBranch);
      await writeFile(join(ws.dir, "lotse-live.txt"), `${marker}\n`);
      const sha = await ws.commitAll(`Live test ${marker}`);
      await ws.push(auth);
      const again = await GitWorkspace.clone(await provider.remoteUrl(repo, connection), join(dir, "check"), repo.defaultBranch);
      expect(await again.head()).toBe(sha);
    });

    it("stores a CI secret and writes the deploy workflow", async () => {
      await provider.setCiSecret?.(repo, "LOTSE_LIVE_TEST", marker);
      await provider.writeWorkflow?.(repo, { adapter: "ssh", branch: repo.defaultBranch, secrets: ["LOTSE_LIVE_TEST"], cliVersion: "0.1.0" });
      // Writing it a second time updates the file instead of failing.
      await provider.writeWorkflow?.(repo, { adapter: "ssh", branch: repo.defaultBranch, secrets: ["LOTSE_LIVE_TEST"], cliVersion: "0.1.1" });
    });
  });
}
