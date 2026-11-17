/**
 * The parts of the desktop app that do not need Electron: where the master
 * key is kept, how the local builder is configured, and which addresses the
 * window may open. `main.ts` wires them to Electron.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { LotseError } from "@lotseai/core";
import { fileKeyProvider, firstAvailableKeyProvider, generateMasterKey, keychainKeyProvider, type MasterKeyProvider, parseMasterKey } from "@lotseai/secrets";
import { configFromEnv, type ServerConfig } from "@lotseai/server";

/** The part of Electron's `safeStorage` the desktop app uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which keyring protects the data; `basic_text` means none. */
  getSelectedStorageBackend?(): string;
}

/**
 * Keeps the master key encrypted by the operating system's keychain through
 * Electron's `safeStorage`: Keychain on macOS, DPAPI on Windows, the Secret
 * Service or KWallet on Linux. Only the encrypted key is written to disk.
 */
export function safeStorageKeyProvider(storage: SafeStorageLike, file: string): MasterKeyProvider {
  let cached: Promise<Buffer> | undefined;
  const load = async (): Promise<Buffer> => {
    if (!keychainUsable(storage)) throw new LotseError("UNSUPPORTED", "The operating system's keychain is not available.");
    try {
      return parseMasterKey(storage.decryptString(await readFile(file)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LotseError("AUTH_FAILED", "The master key could not be unlocked with the operating system's keychain.", {
          cause: err,
          hints: [
            "Stored provider accounts cannot be read without it. Sign in to the same user account you used before, or remove the accounts and connect them again.",
          ],
        });
      }
    }
    const key = generateMasterKey();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // Written next to the target and renamed, so that an interrupted start leaves no half-written key.
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, storage.encryptString(key), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
    return parseMasterKey(key);
  };
  return {
    id: "safe-storage",
    getKey() {
      cached ??= load().catch((err) => {
        cached = undefined;
        throw err;
      });
      return cached;
    },
  };
}

/** Whether `safeStorage` is protected by a real keychain, not just obfuscated. */
export function keychainUsable(storage: SafeStorageLike): boolean {
  return storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text";
}

export interface MasterKeyChoice {
  provider: MasterKeyProvider;
  /** Shown to the user when the key is not protected by the keychain. */
  warning?: string;
}

/**
 * The keychain through `safeStorage` where possible. Linux desktops without a
 * keyring fall back to `secret-tool` and finally to a key file that only the
 * user can read.
 */
export function chooseMasterKey(storage: SafeStorageLike, dataDir: string): MasterKeyChoice {
  if (keychainUsable(storage)) return { provider: safeStorageKeyProvider(storage, join(dataDir, "master.key.enc")) };
  return {
    provider: firstAvailableKeyProvider([keychainKeyProvider(), fileKeyProvider(join(dataDir, "master.key"))]),
    warning:
      "No keychain is available, so the master key is kept in a file that only your user account can read. Install and unlock a keyring (GNOME Keyring or KWallet) to protect it better.",
  };
}

/** The port the local builder listens on: the preferred one if it is free, any free one otherwise. */
export async function choosePort(preferred: number, host = "127.0.0.1"): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(undefined));
      probe.listen(port, host, () => {
        const { port: bound } = probe.address() as { port: number };
        probe.close(() => resolve(bound));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0)) ?? preferred;
}

export interface DesktopServerOptions {
  dataDir: string;
  port: number;
  masterKey: MasterKeyProvider;
  /** Directory with the built user interface. */
  uiDir?: string;
  /** Secret the window carries in a cookie; see `ServerConfig.localToken`. */
  localToken: string;
  env?: Record<string, string | undefined>;
}

/** The builder as the desktop app runs it: one user, SQLite, reachable only from this computer. */
export function desktopServerConfig(options: DesktopServerOptions): ServerConfig {
  const env = options.env ?? process.env;
  return configFromEnv(env, {
    host: "127.0.0.1",
    port: options.port,
    // `localhost` rather than 127.0.0.1: provider OAuth apps accept it as a loopback redirect,
    // and previews at p-<project>-<token>.localhost resolve to this computer without DNS.
    publicUrl: `http://localhost:${options.port}`,
    previewDomain: "localhost",
    auth: "none",
    localToken: options.localToken,
    desktop: true,
    dataDir: options.dataDir,
    databaseUrl: `sqlite:${join(options.dataDir, "lotse.db")}`,
    sqliteDriver: "node",
    masterKey: options.masterKey,
    uiDir: options.uiDir,
  });
}

export type Navigation = "allow" | "window" | "browser" | "deny";

/**
 * What happens when the app's window navigates or opens a link: the builder
 * itself stays in the window, previews open in an app window, other web
 * addresses (provider sign-ins, documentation) in the system browser, and
 * everything else is refused.
 */
export function navigation(target: string, appUrl: string): Navigation {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  const app = new URL(appUrl);
  if (url.origin === app.origin) return "allow";
  if (url.protocol === "http:" && url.port === app.port && /^p-[a-z0-9]+-[0-9a-f]{16}\.localhost$/.test(url.hostname)) return "window";
  if (url.protocol === "https:" || url.protocol === "http:") return url.username || url.password ? "deny" : "browser";
  return "deny";
}
