import { join, resolve } from "node:path";
import { LotseError } from "@lotseai/core";
import { envKeyProvider, fileKeyProvider, firstAvailableKeyProvider, type MasterKeyProvider, vaultKeyProviderFromEnv } from "@lotseai/secrets";
import type { SqliteDriver } from "./db/index.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Address users reach the builder at, e.g. https://lotse.example.com */
  publicUrl: string;
  /** Previews are served at `p-<project>-<token>.<previewDomain>`. */
  previewDomain: string;
  dataDir: string;
  /** `sqlite:<path>` for single-user installations, `postgres://…` for teams. */
  databaseUrl: string;
  /** Which SQLite driver to use; by default better-sqlite3, and node:sqlite inside Electron. */
  sqliteDriver?: SqliteDriver;
  /** none: single user without sign-in (desktop app). oidc: multi-user with SSO. */
  auth: "none" | "oidc";
  /**
   * Single-user mode only: a secret every API request must carry in the
   * `lotse_local` cookie. The desktop app sets it, so that other users and
   * programs on the same computer cannot use the builder's stored accounts.
   */
  localToken?: string;
  /** The builder runs inside the desktop app: provider sign-ins finish in the system browser. */
  desktop?: boolean;
  /** Host names the builder answers to, besides the one in `publicUrl` and the loopback names. */
  allowedHosts: string[];
  oidc?: OidcConfig;
  masterKey: MasterKeyProvider;
  /** Default models, `<provider>:<model>`. */
  planModel?: string;
  implementModel?: string;
  /** How often build and runtime errors are fed back to the model. */
  maxCorrections: number;
  /** Extra adapter and stack packages. */
  adapters: string[];
  stacks: string[];
  sandbox: { cpus: number; memoryMb: number; runtime?: string; idleMinutes: number; namePrefix: string; allowedHosts?: string[] };
  /** Directory with the built web UI, if it is served by this process. */
  uiDir?: string;
  /** How many jobs run at the same time. */
  concurrency: number;
  env: Record<string, string | undefined>;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function configFromEnv(env: Record<string, string | undefined> = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = resolve(overrides.dataDir ?? env.LOTSE_DATA_DIR ?? "data");
  const port = overrides.port ?? Number(env.LOTSE_PORT ?? 4780);
  const host = overrides.host ?? env.LOTSE_HOST ?? "127.0.0.1";
  const publicUrl = (overrides.publicUrl ?? env.LOTSE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const auth = (overrides.auth ?? env.LOTSE_AUTH ?? "none") as ServerConfig["auth"];
  if (auth !== "none" && auth !== "oidc") throw new LotseError("INVALID_INPUT", `LOTSE_AUTH must be "none" or "oidc", not "${auth}".`);

  let oidc = overrides.oidc;
  if (auth === "oidc" && !oidc) {
    if (!env.LOTSE_OIDC_ISSUER || !env.LOTSE_OIDC_CLIENT_ID) {
      throw new LotseError(
        "INVALID_INPUT",
        "Sign-in with OpenID Connect needs LOTSE_OIDC_ISSUER and LOTSE_OIDC_CLIENT_ID (and usually LOTSE_OIDC_CLIENT_SECRET).",
      );
    }
    oidc = {
      issuer: env.LOTSE_OIDC_ISSUER.replace(/\/+$/, ""),
      clientId: env.LOTSE_OIDC_CLIENT_ID,
      clientSecret: env.LOTSE_OIDC_CLIENT_SECRET,
      scopes: list(env.LOTSE_OIDC_SCOPES ?? "openid,email,profile"),
    };
  }

  // Web app: the master key comes from the environment or an external secret store.
  // Single-user installations fall back to a key file with owner-only permissions.
  const fromVault = vaultKeyProviderFromEnv(env);
  const masterKey =
    overrides.masterKey ??
    (auth === "oidc"
      ? (fromVault ?? envKeyProvider(env))
      : firstAvailableKeyProvider([
          ...(env.LOTSE_MASTER_KEY ? [envKeyProvider(env)] : []),
          ...(fromVault ? [fromVault] : []),
          fileKeyProvider(join(dataDir, "master.key")),
        ]));

  return {
    host,
    port,
    publicUrl,
    previewDomain: overrides.previewDomain ?? env.LOTSE_PREVIEW_DOMAIN ?? "localhost",
    dataDir,
    databaseUrl: overrides.databaseUrl ?? env.LOTSE_DATABASE_URL ?? `sqlite:${join(dataDir, "lotse.db")}`,
    sqliteDriver: overrides.sqliteDriver ?? (env.LOTSE_SQLITE_DRIVER as SqliteDriver | undefined),
    auth,
    localToken: overrides.localToken ?? (env.LOTSE_LOCAL_TOKEN || undefined),
    desktop: overrides.desktop ?? false,
    allowedHosts: overrides.allowedHosts ?? list(env.LOTSE_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    oidc,
    masterKey,
    planModel: overrides.planModel ?? env.LOTSE_PLAN_MODEL ?? env.LOTSE_MODEL,
    implementModel: overrides.implementModel ?? env.LOTSE_MODEL,
    maxCorrections: overrides.maxCorrections ?? Number(env.LOTSE_MAX_CORRECTIONS ?? 3),
    adapters: overrides.adapters ?? list(env.LOTSE_ADAPTERS),
    stacks: overrides.stacks ?? list(env.LOTSE_STACKS),
    sandbox: overrides.sandbox ?? {
      cpus: Number(env.LOTSE_SANDBOX_CPUS ?? 2),
      memoryMb: Number(env.LOTSE_SANDBOX_MEMORY_MB ?? 2048),
      runtime: env.LOTSE_SANDBOX_RUNTIME || undefined,
      idleMinutes: Number(env.LOTSE_SANDBOX_IDLE_MINUTES ?? 30),
      namePrefix: env.LOTSE_SANDBOX_PREFIX ?? "lotse",
      allowedHosts: env.LOTSE_SANDBOX_ALLOWED_HOSTS ? list(env.LOTSE_SANDBOX_ALLOWED_HOSTS) : undefined,
    },
    uiDir: overrides.uiDir ?? env.LOTSE_UI_DIR,
    concurrency: overrides.concurrency ?? Number(env.LOTSE_JOB_CONCURRENCY ?? 2),
    env,
  };
}
