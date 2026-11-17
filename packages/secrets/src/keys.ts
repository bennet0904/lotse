/**
 * Where the master key comes from (specification section 8.2):
 * an environment variable or external secret store in the web app, the
 * operating system's keychain in the desktop app, a protected file for the CLI.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LotseError } from "@lotse/core";
import { generateMasterKey, parseMasterKey } from "./crypto.js";

export interface MasterKeyProvider {
  readonly id: string;
  getKey(): Promise<Buffer>;
}

function memo(id: string, load: () => Promise<Buffer>): MasterKeyProvider {
  let cached: Promise<Buffer> | undefined;
  return {
    id,
    getKey() {
      cached ??= load().catch((err) => {
        cached = undefined;
        throw err;
      });
      return cached;
    },
  };
}

export function staticKeyProvider(key: string | Buffer): MasterKeyProvider {
  return memo("static", async () => (typeof key === "string" ? parseMasterKey(key) : key));
}

export function envKeyProvider(env: Record<string, string | undefined> = process.env, name = "LOTSE_MASTER_KEY"): MasterKeyProvider {
  return memo("env", async () => {
    const value = env[name];
    if (!value) {
      throw new LotseError("INVALID_INPUT", `The environment variable ${name} is not set. It must contain the master key for the credential store.`, {
        hints: ["Create a key with `lotse secrets generate-key` and keep it safe: without it stored credentials cannot be read."],
      });
    }
    return parseMasterKey(value);
  });
}

/** Key file with owner-only permissions. Created on first use. */
export function fileKeyProvider(path: string): MasterKeyProvider {
  return memo("file", async () => {
    try {
      return parseMasterKey(await readFile(path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const key = generateMasterKey();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${key}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return parseMasterKey(key);
  });
}

export interface VaultOptions {
  /** Base address of HashiCorp Vault or OpenBao, e.g. https://vault.example.com:8200 */
  address: string;
  token: string;
  /** KV v2 mount, defaults to `secret`. */
  mount?: string;
  /** Secret path inside the mount, defaults to `lotse`. */
  path?: string;
  /** Field holding the key, defaults to `master_key`. */
  field?: string;
  namespace?: string;
  fetch?: typeof fetch;
}

/** Reads the master key from a KV v2 secret in HashiCorp Vault or OpenBao. */
export function vaultKeyProvider(options: VaultOptions): MasterKeyProvider {
  return memo("vault", async () => {
    const url = `${options.address.replace(/\/+$/, "")}/v1/${options.mount ?? "secret"}/data/${options.path ?? "lotse"}`;
    const headers: Record<string, string> = { "x-vault-token": options.token };
    if (options.namespace) headers["x-vault-namespace"] = options.namespace;
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(url, { headers });
    } catch (err) {
      throw new LotseError("AUTH_FAILED", `The secret store at ${options.address} is not reachable (${(err as Error).message}).`);
    }
    if (!res.ok) throw new LotseError("AUTH_FAILED", `The secret store answered with HTTP ${res.status} when reading the master key.`);
    const body = (await res.json()) as { data?: { data?: Record<string, string> } };
    const value = body.data?.data?.[options.field ?? "master_key"];
    if (!value) throw new LotseError("INVALID_INPUT", `The secret store has no field "${options.field ?? "master_key"}" at ${options.path ?? "lotse"}.`);
    return parseMasterKey(value);
  });
}

export function vaultKeyProviderFromEnv(env: Record<string, string | undefined> = process.env): MasterKeyProvider | undefined {
  const address = env.LOTSE_VAULT_ADDR ?? env.VAULT_ADDR;
  const token = env.LOTSE_VAULT_TOKEN ?? env.VAULT_TOKEN;
  if (!address || !token || !env.LOTSE_VAULT_PATH) return undefined;
  return vaultKeyProvider({
    address,
    token,
    path: env.LOTSE_VAULT_PATH,
    mount: env.LOTSE_VAULT_MOUNT,
    field: env.LOTSE_VAULT_FIELD,
    namespace: env.VAULT_NAMESPACE,
  });
}

type Exec = (file: string, args: string[], stdin?: string) => Promise<string>;

const defaultExec: Exec = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

/**
 * Keeps the master key in the operating system's keychain: Keychain on macOS
 * (`security`), the Secret Service on Linux (`secret-tool`). The desktop app
 * passes its own implementation based on Electron's `safeStorage` instead,
 * which also covers Windows.
 */
export function keychainKeyProvider(options: { service?: string; account?: string; platform?: NodeJS.Platform; exec?: Exec } = {}): MasterKeyProvider {
  const service = options.service ?? "lotse";
  const account = options.account ?? "master-key";
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  return memo("keychain", async () => {
    if (platform === "darwin") {
      try {
        return parseMasterKey(await exec("security", ["find-generic-password", "-s", service, "-a", account, "-w"]));
      } catch {
        const key = generateMasterKey();
        await exec("security", ["add-generic-password", "-s", service, "-a", account, "-w", key, "-U"]);
        return parseMasterKey(key);
      }
    }
    if (platform === "linux") {
      const found = await exec("secret-tool", ["lookup", "service", service, "account", account]).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") throw new LotseError("UNSUPPORTED", "No keychain is available (secret-tool is not installed).");
        return "";
      });
      if (found.trim()) return parseMasterKey(found);
      const key = generateMasterKey();
      await exec("secret-tool", ["store", "--label", "Lotse master key", "service", service, "account", account], key);
      return parseMasterKey(key);
    }
    throw new LotseError("UNSUPPORTED", `No keychain integration for ${platform} outside the desktop app.`);
  });
}

/**
 * Default for the CLI and single-user installations: the keychain if it is
 * usable, otherwise a key file with owner-only permissions.
 */
export function firstAvailableKeyProvider(providers: MasterKeyProvider[]): MasterKeyProvider {
  return memo("auto", async () => {
    let last: unknown;
    for (const provider of providers) {
      try {
        return await provider.getKey();
      } catch (err) {
        last = err;
      }
    }
    throw last ?? new LotseError("INVALID_INPUT", "No master key source is configured.");
  });
}
