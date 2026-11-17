import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type AppRecord, type DeploymentRecord, LotseError, type StateStore } from "@lotse/core";
import type { SecretBackend } from "@lotse/secrets";
import { and, asc, desc, eq, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import pg from "pg";
import { MIGRATIONS, pgSchema, type Schema, sqliteSchema } from "./schema.js";

export type Db = BetterSQLite3Database<Schema>;

export interface Database {
  kind: "sqlite" | "postgres";
  db: Db;
  schema: Schema;
  close(): Promise<void>;
}

/**
 * SQLite drivers: `better-sqlite3` is the default under Node.js. The desktop
 * app uses the SQLite built into Node.js (`node:sqlite`), because a native
 * module compiled for Node.js does not load in Electron.
 */
export type SqliteDriver = "better-sqlite3" | "node";

export interface OpenOptions {
  sqliteDriver?: SqliteDriver;
}

/**
 * Opens the database named by a URL: `sqlite:<path>` (or `sqlite::memory:`)
 * or `postgres://…`. Pending migrations are applied.
 */
export async function openDatabase(url: string, options: OpenOptions = {}): Promise<Database> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    // BIGINT columns hold epoch milliseconds and token counts, which fit JavaScript numbers.
    pg.types.setTypeParser(20, (value) => Number(value));
    const run = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[];
    try {
      await migrate(run, "$1");
    } catch (err) {
      await pool.end();
      throw new LotseError("PROVIDER_ERROR", `Could not open the PostgreSQL database: ${(err as Error).message}`);
    }
    return { kind: "postgres", db: drizzlePg(pool, { schema: pgSchema }) as unknown as Db, schema: pgSchema, close: () => pool.end() };
  }
  if (!url.startsWith("sqlite:")) throw new LotseError("INVALID_INPUT", `Unsupported database URL "${url.split(":")[0]}:". Use sqlite:<path> or postgres://….`);
  const path = url.slice("sqlite:".length);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const driver = options.sqliteDriver ?? (process.versions.electron ? "node" : "better-sqlite3");
  return driver === "node" ? openNodeSqlite(path) : openBetterSqlite(path);
}

async function openBetterSqlite(path: string): Promise<Database> {
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  const raw = new BetterSqlite3(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  await migrate(async (sql, params = []) => {
    const statement = raw.prepare(sql);
    if (statement.reader) return statement.all(...params) as Record<string, unknown>[];
    statement.run(...params);
    return [];
  }, "?");
  return { kind: "sqlite", db: drizzle(raw, { schema: sqliteSchema }), schema: sqliteSchema, close: async () => void raw.close() };
}

type SqlValue = null | number | bigint | string | Uint8Array;

async function openNodeSqlite(path: string): Promise<Database> {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  // Drizzle passes booleans and dates already converted; only undefined needs mapping.
  const bind = (params: unknown[]) => params.map((p) => (p === undefined ? null : (p as SqlValue)));
  await migrate(async (sql, params = []) => {
    const statement = raw.prepare(sql);
    if (statement.columns().length > 0) return statement.all(...bind(params)) as Record<string, unknown>[];
    statement.run(...bind(params));
    return [];
  }, "?");
  // Drizzle's proxy driver expects rows as arrays of values in column order.
  const db = drizzleSqliteProxy(
    async (sql, params, method) => {
      const statement = raw.prepare(sql);
      if (method === "run") {
        statement.run(...bind(params));
        return { rows: [] };
      }
      statement.setReturnArrays(true);
      if (method === "get") return { rows: (statement.get(...bind(params)) as unknown[] | undefined) ?? (undefined as unknown as unknown[]) };
      return { rows: statement.all(...bind(params)) as unknown as unknown[][] };
    },
    { schema: sqliteSchema },
  );
  return { kind: "sqlite", db: db as unknown as Db, schema: sqliteSchema, close: async () => raw.close() };
}

async function migrate(run: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>, placeholder: string): Promise<void> {
  await run("CREATE TABLE IF NOT EXISTS lotse_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
  const applied = new Set((await run("SELECT id FROM lotse_migrations")).map((r) => r.id as string));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) await run(statement);
    await run(`INSERT INTO lotse_migrations (id, applied_at) VALUES (${placeholder}, ${placeholder === "?" ? "?" : "$2"})`, [migration.id, Date.now()]);
  }
}

/** Ciphertexts of the credential store, kept in the database. */
export class DbSecretBackend implements SecretBackend {
  constructor(readonly database: Database) {}

  async get(key: string): Promise<string | undefined> {
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.secrets).where(eq(schema.secrets.key, key));
    return rows[0]?.value;
  }

  async set(key: string, ciphertext: string): Promise<void> {
    const { db, schema } = this.database;
    await db
      .insert(schema.secrets)
      .values({ key, value: ciphertext, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: schema.secrets.key, set: { value: ciphertext, updatedAt: Date.now() } });
  }

  async delete(key: string): Promise<void> {
    const { db, schema } = this.database;
    await db.delete(schema.secrets).where(eq(schema.secrets.key, key));
  }

  async list(prefix = ""): Promise<string[]> {
    const { db, schema } = this.database;
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await db
      .select({ key: schema.secrets.key })
      .from(schema.secrets)
      .where(like(schema.secrets.key, `${escaped}%`))
      .orderBy(asc(schema.secrets.key));
    return rows.map((r) => r.key).filter((k) => k.startsWith(prefix));
  }
}

/** The deployment engine's state, kept in the database. Keys are namespaced per project. */
export class DbStateStore implements StateStore {
  constructor(
    readonly database: Database,
    readonly namespace: string,
  ) {}

  #key(adapter: string, name: string): string {
    return `${this.namespace}|${adapter}|${name}`;
  }

  async getApp(adapter: string, name: string): Promise<AppRecord | undefined> {
    const { db, schema } = this.database;
    const rows = await db
      .select()
      .from(schema.apps)
      .where(eq(schema.apps.key, this.#key(adapter, name)));
    return rows[0] ? (JSON.parse(rows[0].data) as AppRecord) : undefined;
  }

  async saveApp(app: AppRecord): Promise<void> {
    const { db, schema } = this.database;
    const row = { key: this.#key(app.adapter, app.name), data: JSON.stringify(app), updatedAt: Date.now() };
    await db
      .insert(schema.apps)
      .values(row)
      .onConflictDoUpdate({ target: schema.apps.key, set: { data: row.data, updatedAt: row.updatedAt } });
  }

  async deleteApp(adapter: string, name: string): Promise<void> {
    const { db, schema } = this.database;
    await db.delete(schema.apps).where(eq(schema.apps.key, this.#key(adapter, name)));
    await db.delete(schema.deployments).where(eq(schema.deployments.appKey, this.#key(adapter, name)));
  }

  async listDeployments(adapter: string, name: string): Promise<DeploymentRecord[]> {
    const { db, schema } = this.database;
    const rows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.appKey, this.#key(adapter, name)))
      .orderBy(desc(schema.deployments.createdAt));
    return rows.map((r) => JSON.parse(r.data) as DeploymentRecord);
  }

  async saveDeployment(deployment: DeploymentRecord): Promise<void> {
    const { db, schema } = this.database;
    const appKey = this.#key(deployment.adapter, deployment.app);
    const row = { id: `${appKey}|${deployment.id}`, appKey, state: deployment.state, createdAt: deployment.createdAt, data: JSON.stringify(deployment) };
    await db
      .insert(schema.deployments)
      .values(row)
      .onConflictDoUpdate({ target: schema.deployments.id, set: { state: row.state, data: row.data } });
  }
}

export { and, asc, desc, eq };
