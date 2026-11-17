import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppRef, Connection, DeploymentRef, RepoRecord, RepoRef, ResourceRef } from "./types.js";

/** Stored form of a resource: connection values are kept in the vault, not here. */
export interface ResourceRecord {
  type: string;
  name: string;
  id: string;
  provider: string;
  envNames: string[];
  meta?: Record<string, string>;
}

export interface AppRecord {
  adapter: string;
  name: string;
  id?: string;
  meta?: Record<string, string>;
  resources: ResourceRecord[];
  domains: string[];
  updatedAt: number;
}

export type DeploymentState = "live" | "superseded" | "failed" | "rolled-back" | "preview";

export interface DeploymentRecord {
  id: string;
  adapter: string;
  app: string;
  appId?: string;
  url?: string;
  createdAt: number;
  version?: string;
  probe?: { url: string; headers?: Record<string, string> };
  meta?: Record<string, string>;
  state: DeploymentState;
}

/** Persistence of what was deployed where. The CLI keeps it in `.lotse/state.json`, the server in its database. */
export interface StateStore {
  getApp(adapter: string, name: string): Promise<AppRecord | undefined>;
  saveApp(app: AppRecord): Promise<void>;
  deleteApp(adapter: string, name: string): Promise<void>;
  /** Newest first. */
  listDeployments(adapter: string, name: string): Promise<DeploymentRecord[]>;
  saveDeployment(deployment: DeploymentRecord): Promise<void>;
}

/** Key-value store for secret values. Implemented by `@lotseai/secrets`. */
export interface SecretVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function toDeploymentRecord(ref: DeploymentRef, state: DeploymentState): DeploymentRecord {
  return {
    id: ref.id,
    adapter: ref.app.adapter,
    app: ref.app.name,
    appId: ref.app.id,
    url: ref.url,
    createdAt: ref.createdAt,
    version: ref.version,
    probe: ref.probe,
    meta: ref.meta,
    state,
  };
}

export function toDeploymentRef(record: DeploymentRecord, connection: Connection, appMeta?: Record<string, string>): DeploymentRef {
  return {
    id: record.id,
    app: { adapter: record.adapter, name: record.app, id: record.appId, connection, meta: appMeta },
    url: record.url,
    createdAt: record.createdAt,
    version: record.version,
    probe: record.probe,
    meta: record.meta,
    preview: record.state === "preview" ? true : undefined,
  };
}

export function toAppRef(record: AppRecord | undefined, adapter: string, name: string, connection: Connection): AppRef {
  return { adapter, name, id: record?.id, meta: record?.meta, connection };
}

export function toResourceRecord(ref: ResourceRef): ResourceRecord {
  return { type: ref.type, name: ref.name, id: ref.id, provider: ref.provider, envNames: ref.env.map((e) => e.name), meta: ref.meta };
}

export function toRepoRecord(repo: RepoRef): RepoRecord {
  const { connection: _connection, ...record } = repo;
  return record;
}

export function resourceVaultKey(adapter: string, app: string, resource: string, envName: string): string {
  return `resource/${adapter}/${app}/${resource}/${envName}`;
}

interface StateFile {
  version: 1;
  apps: Record<string, AppRecord>;
  deployments: Record<string, DeploymentRecord[]>;
}

const key = (adapter: string, name: string) => `${adapter}/${name}`;

/** How many deployment records are kept per app. */
const HISTORY_LIMIT = 50;

export class MemoryStateStore implements StateStore {
  protected data: StateFile = { version: 1, apps: {}, deployments: {} };

  async getApp(adapter: string, name: string): Promise<AppRecord | undefined> {
    await this.load();
    return this.data.apps[key(adapter, name)];
  }

  async saveApp(app: AppRecord): Promise<void> {
    await this.load();
    this.data.apps[key(app.adapter, app.name)] = app;
    await this.persist();
  }

  async deleteApp(adapter: string, name: string): Promise<void> {
    await this.load();
    delete this.data.apps[key(adapter, name)];
    delete this.data.deployments[key(adapter, name)];
    await this.persist();
  }

  async listDeployments(adapter: string, name: string): Promise<DeploymentRecord[]> {
    await this.load();
    return [...(this.data.deployments[key(adapter, name)] ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  async saveDeployment(deployment: DeploymentRecord): Promise<void> {
    await this.load();
    const k = key(deployment.adapter, deployment.app);
    const list = (this.data.deployments[k] ?? []).filter((d) => d.id !== deployment.id);
    list.push(deployment);
    list.sort((a, b) => b.createdAt - a.createdAt);
    this.data.deployments[k] = list.slice(0, HISTORY_LIMIT);
    await this.persist();
  }

  protected async load(): Promise<void> {}
  protected async persist(): Promise<void> {}
}

/** JSON file store used by the CLI. Contains no secrets and may be committed. */
export class FileStateStore extends MemoryStateStore {
  #loaded = false;
  constructor(readonly path: string) {
    super();
  }

  protected override async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StateFile;
      this.data = { version: 1, apps: parsed.apps ?? {}, deployments: parsed.deployments ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.#loaded = true;
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }
}

export class MemoryVault implements SecretVault {
  readonly #values = new Map<string, string>();
  async get(k: string): Promise<string | undefined> {
    return this.#values.get(k);
  }
  async set(k: string, value: string): Promise<void> {
    this.#values.set(k, value);
  }
  async delete(k: string): Promise<void> {
    this.#values.delete(k);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.#values.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
