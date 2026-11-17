import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BUILT_IN_ADAPTERS } from "@lotseai/adapters";
import { LocalBuilder } from "@lotseai/build";
import {
  type AdapterPackage,
  AdapterRegistry,
  type Connection,
  connectionSecretName,
  DeploymentEngine,
  dynamicRegistrationSource,
  envClientSource,
  FileStateStore,
  LotseError,
  loadAdapters,
  loadManifest,
  type Manifest,
  type OAuthClientSource,
  type RepoRecord,
  type SecretVault,
} from "@lotseai/core";
import {
  ConnectionStore,
  envKeyProvider,
  FileBackend,
  fileKeyProvider,
  firstAvailableKeyProvider,
  type MasterKeyProvider,
  SecretStore,
  vaultKeyProviderFromEnv,
} from "@lotseai/secrets";
import type { Io } from "./io.js";

/** Adapters that ship with the CLI. More are loaded from the configuration. */
export const BUILT_IN: AdapterPackage[] = BUILT_IN_ADAPTERS;

export interface ProjectConfig {
  /** Default hosting adapter for this project. */
  target?: string;
  /** Extra adapter packages, e.g. `lotse-adapter-acme`. */
  adapters?: string[];
  git?: { provider: string; repo: RepoRecord; connection: string };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new LotseError("INVALID_INPUT", `${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** A vault that answers from `LOTSE_VAULT` (CI) first and from the project's encrypted store otherwise. */
class LayeredVault implements SecretVault {
  constructor(
    readonly overlay: Record<string, string>,
    readonly store: SecretVault,
  ) {}
  async get(key: string): Promise<string | undefined> {
    return this.overlay[key] ?? (await this.store.get(key));
  }
  set(key: string, value: string): Promise<void> {
    return this.store.set(key, value);
  }
  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...new Set([...Object.keys(this.overlay).filter((k) => k.startsWith(prefix)), ...(await this.store.list(prefix))])].sort();
  }
}

export class Context {
  readonly projectDir: string;
  readonly configDir: string;
  #registry?: Promise<AdapterRegistry>;
  #config?: ProjectConfig;
  #keys?: MasterKeyProvider;

  constructor(
    readonly io: Io,
    options: { dir?: string } = {},
  ) {
    this.projectDir = resolve(io.cwd, options.dir ?? ".");
    this.configDir = io.env.LOTSE_CONFIG_DIR ?? join(io.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lotse");
  }

  get stateDir(): string {
    return join(this.projectDir, ".lotse");
  }

  keys(): MasterKeyProvider {
    const fromVault = vaultKeyProviderFromEnv(this.io.env);
    this.#keys ??= firstAvailableKeyProvider([
      ...(this.io.env.LOTSE_MASTER_KEY ? [envKeyProvider(this.io.env)] : []),
      ...(fromVault ? [fromVault] : []),
      fileKeyProvider(join(this.configDir, "master.key")),
    ]);
    return this.#keys;
  }

  /** Provider accounts, shared by all projects of this user. */
  connections(): ConnectionStore {
    return new ConnectionStore(new SecretStore(new FileBackend(join(this.configDir, "credentials.json")), this.keys()));
  }

  /** Secrets of this project: app secrets and resource connection values. */
  vault(): SecretVault {
    const store = new SecretStore(new FileBackend(join(this.stateDir, "secrets.json")), this.keys());
    const raw = this.io.env.LOTSE_VAULT;
    if (!raw) return store;
    try {
      return new LayeredVault(JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, string>, store);
    } catch {
      throw new LotseError("INVALID_INPUT", "LOTSE_VAULT is not valid. Create it with `lotse git ci`.");
    }
  }

  async config(): Promise<ProjectConfig> {
    this.#config ??= await readJson<ProjectConfig>(join(this.stateDir, "config.json"), {});
    return this.#config;
  }

  async saveConfig(patch: Partial<ProjectConfig>): Promise<void> {
    const next = { ...(await this.config()), ...patch };
    this.#config = next;
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(join(this.stateDir, "config.json"), `${JSON.stringify(next, null, 2)}\n`);
    // Encrypted, but better kept out of the repository by default.
    await writeFile(join(this.stateDir, ".gitignore"), "secrets.json\n", { flag: "wx" }).catch(() => {});
  }

  registry(): Promise<AdapterRegistry> {
    this.#registry ??= (async () => {
      const registry = new AdapterRegistry();
      const options = { env: this.io.env };
      for (const pkg of BUILT_IN) registry.use(pkg, options);
      const user = await readJson<{ adapters?: string[] }>(join(this.configDir, "config.json"), {});
      const extra = [...(user.adapters ?? []), ...((await this.config()).adapters ?? []), ...(this.io.env.LOTSE_ADAPTERS?.split(",").filter(Boolean) ?? [])];
      if (extra.length > 0) {
        // Relative paths are resolved from the project, package names from its node_modules.
        await loadAdapters(
          extra.map((name) => (name.startsWith(".") ? resolve(this.projectDir, name) : name)),
          { ...options, registry },
        );
      }
      return registry;
    })();
    return this.#registry;
  }

  oauthSources(): OAuthClientSource[] {
    const cache = new FileBackend(join(this.configDir, "oauth-clients.json"));
    return [
      envClientSource(this.io.env),
      dynamicRegistrationSource(
        {
          get: async (key) => {
            const raw = await cache.get(key);
            return raw ? JSON.parse(raw) : undefined;
          },
          set: (key, client) => cache.set(key, JSON.stringify(client)),
        },
        { clientName: "Lotse CLI" },
      ),
    ];
  }

  manifest(): Promise<Manifest> {
    return loadManifest(this.projectDir);
  }

  async engine(): Promise<DeploymentEngine> {
    return new DeploymentEngine({
      registry: await this.registry(),
      builder: new LocalBuilder(),
      state: new FileStateStore(join(this.stateDir, "state.json")),
      vault: this.vault(),
    });
  }

  /** The hosting adapter to use: `--target`, the project's default, or the only connected one. */
  async target(flag?: string): Promise<string> {
    if (flag) return flag;
    const config = await this.config();
    if (config.target) return config.target;
    const registry = await this.registry();
    const connected = (await this.connections().list()).filter((id) => registry.hasHosting(id));
    if (connected.length === 1) return connected[0] as string;
    throw new LotseError(
      "INVALID_INPUT",
      connected.length === 0 ? "Not signed in to any hosting provider yet." : `Several providers are connected (${connected.join(", ")}).`,
      {
        hints: [connected.length === 0 ? "Run `lotse connect <provider>`; `lotse adapters` lists the choices." : "Choose one with `--target <provider>`."],
      },
    );
  }

  /** The stored connection of an adapter, refreshed if necessary. CI passes it through the environment. */
  async connection(adapterId: string): Promise<Connection> {
    const fromEnv = this.io.env[connectionSecretName(adapterId)];
    if (fromEnv) {
      try {
        return JSON.parse(Buffer.from(fromEnv, "base64").toString("utf8")) as Connection;
      } catch {
        throw new LotseError("INVALID_INPUT", `${connectionSecretName(adapterId)} is not valid. Create it with \`lotse connections export ${adapterId}\`.`);
      }
    }
    const registry = await this.registry();
    const oauth = registry.hasHosting(adapterId)
      ? registry.hosting(adapterId).oauth
      : (registry.listGit().find((g) => g.id === adapterId)?.oauth ?? registry.listResources().find((r) => r.id === adapterId)?.oauth);
    return this.connections().fresh(adapterId, oauth);
  }

  /** Connections to every resource provider the user is signed in to. */
  async resourceConnections(): Promise<Record<string, Connection>> {
    const registry = await this.registry();
    const out: Record<string, Connection> = {};
    const stored = await this.connections().list();
    for (const adapter of registry.listResources()) {
      if (stored.includes(adapter.id) || this.io.env[connectionSecretName(adapter.id)]) out[adapter.id] = await this.connection(adapter.id);
    }
    return out;
  }

  /** Values of the secrets named in the manifest: `LOTSE_SECRET_<NAME>` or the project's store. */
  async secrets(manifest: Manifest): Promise<Record<string, string>> {
    const vault = this.vault();
    const out: Record<string, string> = {};
    for (const name of manifest.env.secrets) {
      const value = this.io.env[`LOTSE_SECRET_${name}`] ?? (await vault.get(`env/${manifest.name}/${name}`));
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
}
