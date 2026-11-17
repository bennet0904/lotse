import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Connection, connectionExpiresSoon, ensureFreshConnection, LotseError, type OAuthProviderConfig, type SecretVault } from "@lotseai/core";
import { decrypt, encrypt } from "./crypto.js";
import type { MasterKeyProvider } from "./keys.js";

/** Stores ciphertexts. Backends never see plaintext or the master key. */
export interface SecretBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, ciphertext: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export class MemoryBackend implements SecretBackend {
  readonly #data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.#data.get(key);
  }
  async set(key: string, ciphertext: string): Promise<void> {
    this.#data.set(key, ciphertext);
  }
  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.#data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** A JSON file of ciphertexts with owner-only permissions. Used by the CLI. */
export class FileBackend implements SecretBackend {
  constructor(readonly path: string) {}

  async #read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async #write(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.#read())[key];
  }
  async set(key: string, ciphertext: string): Promise<void> {
    const data = await this.#read();
    data[key] = ciphertext;
    await this.#write(data);
  }
  async delete(key: string): Promise<void> {
    const data = await this.#read();
    if (key in data) {
      delete data[key];
      await this.#write(data);
    }
  }
  async list(prefix = ""): Promise<string[]> {
    return Object.keys(await this.#read())
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
}

/**
 * Encrypted credential store. Every value is encrypted on its own with
 * AES-256-GCM and bound to its key name.
 */
export class SecretStore implements SecretVault {
  constructor(
    readonly backend: SecretBackend,
    readonly keys: MasterKeyProvider,
  ) {}

  async get(key: string): Promise<string | undefined> {
    const ciphertext = await this.backend.get(key);
    return ciphertext === undefined ? undefined : decrypt(await this.keys.getKey(), ciphertext, key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.backend.set(key, encrypt(await this.keys.getKey(), value, key));
  }

  delete(key: string): Promise<void> {
    return this.backend.delete(key);
  }

  list(prefix?: string): Promise<string[]> {
    return this.backend.list(prefix);
  }

  /** Re-encrypts every value with a new master key. */
  async rotate(next: MasterKeyProvider): Promise<SecretStore> {
    const [oldKey, newKey] = await Promise.all([this.keys.getKey(), next.getKey()]);
    for (const key of await this.backend.list()) {
      const ciphertext = await this.backend.get(key);
      if (ciphertext !== undefined) await this.backend.set(key, encrypt(newKey, decrypt(oldKey, ciphertext, key), key));
    }
    return new SecretStore(this.backend, next);
  }
}

const CONNECTION_PREFIX = "connection/";

/** Provider accounts in the credential store. */
export class ConnectionStore {
  constructor(readonly vault: SecretVault) {}

  async save(id: string, conn: Connection): Promise<void> {
    await this.vault.set(CONNECTION_PREFIX + id, JSON.stringify(conn));
  }

  async get(id: string): Promise<Connection | undefined> {
    const raw = await this.vault.get(CONNECTION_PREFIX + id);
    return raw === undefined ? undefined : (JSON.parse(raw) as Connection);
  }

  async require(id: string): Promise<Connection> {
    const conn = await this.get(id);
    if (!conn) {
      throw new LotseError("AUTH_FAILED", `Not signed in to "${id}".`, { hints: [`Run \`lotse connect ${id.split(":")[0]}\` first.`] });
    }
    return conn;
  }

  /**
   * Returns the connection with a valid access token. OAuth tokens are
   * refreshed shortly before they expire and stored again. Throws
   * `AUTH_EXPIRED` when the user has to sign in again.
   */
  async fresh(id: string, oauth?: OAuthProviderConfig, fetchImpl?: typeof fetch): Promise<Connection> {
    const conn = await this.require(id);
    if (!connectionExpiresSoon(conn)) return conn;
    const refreshed = await ensureFreshConnection(conn, oauth, { fetch: fetchImpl });
    await this.save(id, refreshed);
    return refreshed;
  }

  async delete(id: string): Promise<void> {
    await this.vault.delete(CONNECTION_PREFIX + id);
  }

  async list(): Promise<string[]> {
    return (await this.vault.list(CONNECTION_PREFIX)).map((k) => k.slice(CONNECTION_PREFIX.length));
  }
}
