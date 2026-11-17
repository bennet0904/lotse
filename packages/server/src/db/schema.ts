/**
 * Database schema. SQLite (desktop app, single-user installations) and
 * PostgreSQL (web app for teams) use the same schema: it is defined once,
 * below, and instantiated for both dialects (specification section 6).
 *
 * Only portable column types are used: text, integer and 64-bit integer.
 * JSON is stored as text, timestamps as epoch milliseconds.
 */
import * as pg from "drizzle-orm/pg-core";
import * as sqlite from "drizzle-orm/sqlite-core";

interface Builders {
  table: typeof sqlite.sqliteTable;
  text: typeof sqlite.text;
  integer: typeof sqlite.integer;
  /** 64-bit integer: plain INTEGER in SQLite, BIGINT in PostgreSQL. */
  bigint: (name: string) => ReturnType<typeof sqlite.integer>;
}

const sqliteBuilders: Builders = { table: sqlite.sqliteTable, text: sqlite.text, integer: sqlite.integer, bigint: (name) => sqlite.integer(name) };

// The PostgreSQL builders create real PostgreSQL tables at run time. They are
// typed like their SQLite counterparts so that every query is written once.
const pgBuilders = {
  table: pg.pgTable,
  text: pg.text,
  integer: pg.integer,
  bigint: (name: string) => pg.bigint(name, { mode: "number" }),
} as unknown as Builders;

function define(b: Builders) {
  return {
    users: b.table("users", {
      id: b.text("id").primaryKey(),
      email: b.text("email").notNull().unique(),
      name: b.text("name").notNull(),
      /** owner | admin | member */
      role: b.text("role").notNull(),
      /** Subject at the identity provider, `<issuer>|<sub>`. */
      subject: b.text("subject").unique(),
      createdAt: b.bigint("created_at").notNull(),
    }),
    sessions: b.table("sessions", {
      /** SHA-256 of the session token; the token itself is only in the cookie. */
      id: b.text("id").primaryKey(),
      userId: b.text("user_id").notNull(),
      expiresAt: b.bigint("expires_at").notNull(),
      createdAt: b.bigint("created_at").notNull(),
    }),
    /** Provider accounts. Credentials live encrypted in `secrets`, never here. */
    accounts: b.table("accounts", {
      id: b.text("id").primaryKey(),
      adapter: b.text("adapter").notNull(),
      /** hosting | git | resource */
      kind: b.text("kind").notNull(),
      label: b.text("label").notNull(),
      /** user: only the owner may use it. team: every member may deploy with it. */
      scope: b.text("scope").notNull(),
      ownerId: b.text("owner_id").notNull(),
      method: b.text("method").notNull(),
      createdAt: b.bigint("created_at").notNull(),
    }),
    /** Encrypted values (AES-256-GCM). */
    secrets: b.table("secrets", {
      key: b.text("key").primaryKey(),
      value: b.text("value").notNull(),
      updatedAt: b.bigint("updated_at").notNull(),
    }),
    projects: b.table("projects", {
      id: b.text("id").primaryKey(),
      ownerId: b.text("owner_id").notNull(),
      name: b.text("name").notNull(),
      title: b.text("title").notNull(),
      stack: b.text("stack"),
      /** planning | planned | generating | ready | failed */
      status: b.text("status").notNull(),
      prompt: b.text("prompt").notNull(),
      plan: b.text("plan"),
      /** JSON: { planModel?, implementModel? } */
      models: b.text("models"),
      /** JSON: { adapter, accountId } of the default hosting target. */
      target: b.text("target"),
      /** JSON: { provider, accountId, repo } of the linked repository. */
      git: b.text("git"),
      createdAt: b.bigint("created_at").notNull(),
      updatedAt: b.bigint("updated_at").notNull(),
    }),
    messages: b.table("messages", {
      id: b.text("id").primaryKey(),
      projectId: b.text("project_id").notNull(),
      /** user | assistant | system */
      role: b.text("role").notNull(),
      content: b.text("content").notNull(),
      /** JSON: kind, plan, proposals, changed files, job id ... */
      meta: b.text("meta"),
      createdAt: b.bigint("created_at").notNull(),
    }),
    jobs: b.table("jobs", {
      id: b.text("id").primaryKey(),
      projectId: b.text("project_id"),
      type: b.text("type").notNull(),
      /** queued | running | succeeded | failed | cancelled */
      status: b.text("status").notNull(),
      input: b.text("input").notNull(),
      result: b.text("result"),
      error: b.text("error"),
      createdBy: b.text("created_by").notNull(),
      createdAt: b.bigint("created_at").notNull(),
      startedAt: b.bigint("started_at"),
      finishedAt: b.bigint("finished_at"),
    }),
    jobEvents: b.table("job_events", {
      id: b.text("id").primaryKey(),
      jobId: b.text("job_id").notNull(),
      seq: b.integer("seq").notNull(),
      at: b.bigint("at").notNull(),
      data: b.text("data").notNull(),
    }),
    /** What is deployed where: the engine's state store. */
    apps: b.table("apps", {
      key: b.text("key").primaryKey(),
      data: b.text("data").notNull(),
      updatedAt: b.bigint("updated_at").notNull(),
    }),
    deployments: b.table("deployments", {
      id: b.text("id").primaryKey(),
      appKey: b.text("app_key").notNull(),
      state: b.text("state").notNull(),
      createdAt: b.bigint("created_at").notNull(),
      data: b.text("data").notNull(),
    }),
    usage: b.table("usage", {
      /** `<project>|<model>` */
      id: b.text("id").primaryKey(),
      projectId: b.text("project_id").notNull(),
      model: b.text("model").notNull(),
      calls: b.integer("calls").notNull(),
      inputTokens: b.bigint("input_tokens").notNull(),
      outputTokens: b.bigint("output_tokens").notNull(),
      /** Estimated cost in millionths of a US dollar; null when the price is unknown. */
      costMicros: b.bigint("cost_micros"),
    }),
    /** Sign-ins, deployments and changes to credentials (specification section 13.1). */
    auditLog: b.table("audit_log", {
      id: b.text("id").primaryKey(),
      at: b.bigint("at").notNull(),
      userId: b.text("user_id"),
      action: b.text("action").notNull(),
      target: b.text("target"),
      detail: b.text("detail"),
      ip: b.text("ip"),
    }),
    settings: b.table("settings", {
      key: b.text("key").primaryKey(),
      value: b.text("value").notNull(),
    }),
  };
}

export type Schema = ReturnType<typeof define>;
export const sqliteSchema: Schema = define(sqliteBuilders);
export const pgSchema: Schema = define(pgBuilders);

/**
 * Migrations in SQL that both databases accept. Each entry runs once; the
 * list only ever grows.
 */
export const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: "0001_initial",
    statements: [
      "CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, subject TEXT UNIQUE, created_at BIGINT NOT NULL)",
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)",
      "CREATE TABLE accounts (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, scope TEXT NOT NULL, owner_id TEXT NOT NULL, method TEXT NOT NULL, created_at BIGINT NOT NULL)",
      "CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL)",
      "CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, stack TEXT, status TEXT NOT NULL, prompt TEXT NOT NULL, plan TEXT, models TEXT, target TEXT, git TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
      "CREATE TABLE messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at BIGINT NOT NULL)",
      "CREATE INDEX messages_project ON messages (project_id, created_at)",
      "CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, result TEXT, error TEXT, created_by TEXT NOT NULL, created_at BIGINT NOT NULL, started_at BIGINT, finished_at BIGINT)",
      "CREATE INDEX jobs_project ON jobs (project_id, created_at)",
      "CREATE TABLE job_events (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, at BIGINT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX job_events_job ON job_events (job_id, seq)",
      "CREATE TABLE apps (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)",
      "CREATE TABLE deployments (id TEXT PRIMARY KEY, app_key TEXT NOT NULL, state TEXT NOT NULL, created_at BIGINT NOT NULL, data TEXT NOT NULL)",
      "CREATE INDEX deployments_app ON deployments (app_key, created_at)",
      "CREATE TABLE usage (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, cost_micros BIGINT)",
      "CREATE TABLE audit_log (id TEXT PRIMARY KEY, at BIGINT NOT NULL, user_id TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT)",
      "CREATE INDEX audit_log_at ON audit_log (at)",
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ],
  },
];
