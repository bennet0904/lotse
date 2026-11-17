/**
 * Users, roles and sign-in. Two modes:
 *   none  one local user, no sign-in (desktop app, single-user installations)
 *   oidc  multi-user with SSO via OpenID Connect; roles Owner, Admin, Member
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createPkcePair, createState, LotseError } from "@lotse/core";
import type { OidcConfig, ServerConfig } from "./config.js";
import { type Database, eq } from "./db/index.js";

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export const SESSION_COOKIE = "lotse_session";
/** Carries the local access token of a single-user installation, see `ServerConfig.localToken`. */
export const LOCAL_COOKIE = "lotse_local";
const SESSION_MS = 14 * 24 * 60 * 60_000;
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function newId(prefix: string): string {
  return `${prefix}${randomBytes(8).toString("hex")}`;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface AuditEntry {
  userId?: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

export class AuthService {
  readonly #pending = new Map<string, { verifier: string; createdAt: number; returnTo: string }>();
  #discovery?: Promise<Discovery>;

  constructor(
    readonly database: Database,
    readonly config: ServerConfig,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Audit log for sign-ins, deployments and changes to credentials. Never contains secrets. */
  async audit(entry: AuditEntry): Promise<void> {
    const { db, schema } = this.database;
    await db.insert(schema.auditLog).values({
      id: newId("log_"),
      at: Date.now(),
      userId: entry.userId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      ip: entry.ip ?? null,
    });
  }

  /** The single user of an installation without sign-in. */
  async localUser(): Promise<User> {
    const { db, schema } = this.database;
    const existing = await db.select().from(schema.users).where(eq(schema.users.id, "local"));
    if (existing[0]) return toUser(existing[0]);
    await db.insert(schema.users).values({ id: "local", email: "local@localhost", name: "You", role: "owner", subject: null, createdAt: Date.now() });
    return { id: "local", email: "local@localhost", name: "You", role: "owner" };
  }

  /** The user a request acts as, from its cookies; undefined when it is not signed in. */
  async authenticate(cookie: (name: string) => string | undefined): Promise<User | undefined> {
    if (this.config.auth === "none" && this.config.localToken) {
      const given = Buffer.from(cookie(LOCAL_COOKIE) ?? "");
      const expected = Buffer.from(this.config.localToken);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    }
    return this.userForSession(cookie(SESSION_COOKIE));
  }

  async userForSession(token: string | undefined): Promise<User | undefined> {
    if (this.config.auth === "none") return this.localUser();
    if (!token) return undefined;
    const { db, schema } = this.database;
    const sessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, hash(token)));
    const session = sessions[0];
    if (!session || session.expiresAt < Date.now()) return undefined;
    const users = await db.select().from(schema.users).where(eq(schema.users.id, session.userId));
    return users[0] ? toUser(users[0]) : undefined;
  }

  async createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_MS;
    const { db, schema } = this.database;
    await db.insert(schema.sessions).values({ id: hash(token), userId, expiresAt, createdAt: Date.now() });
    return { token, expiresAt };
  }

  async destroySession(token: string | undefined): Promise<void> {
    if (!token) return;
    const { db, schema } = this.database;
    await db.delete(schema.sessions).where(eq(schema.sessions.id, hash(token)));
  }

  #oidc(): OidcConfig {
    if (!this.config.oidc) throw new LotseError("UNSUPPORTED", "Sign-in with OpenID Connect is not configured.");
    return this.config.oidc;
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const res = await this.fetchImpl(`${this.#oidc().issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new LotseError("AUTH_FAILED", `The identity provider's configuration could not be loaded (HTTP ${res.status}).`);
      return (await res.json()) as Discovery;
    })().catch((err) => {
      this.#discovery = undefined;
      throw err;
    });
    return this.#discovery;
  }

  get callbackUrl(): string {
    return `${this.config.publicUrl}/api/v1/auth/callback`;
  }

  /** Starts the OpenID Connect sign-in (authorization code with PKCE). Returns the URL to redirect to. */
  async beginLogin(returnTo = "/"): Promise<string> {
    const oidc = this.#oidc();
    const discovery = await this.#discover();
    const pkce = createPkcePair();
    const state = createState();
    // Abandoned attempts expire after ten minutes.
    for (const [key, value] of this.#pending) if (Date.now() - value.createdAt > 600_000) this.#pending.delete(key);
    this.#pending.set(state, {
      verifier: pkce.verifier,
      createdAt: Date.now(),
      returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/",
    });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oidc.clientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("scope", oidc.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Completes the sign-in: exchanges the code, loads the profile, creates the user if needed. */
  async completeLogin(code: string, state: string, ip?: string): Promise<{ user: User; token: string; expiresAt: number; returnTo: string }> {
    const oidc = this.#oidc();
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending) throw new LotseError("AUTH_FAILED", "The sign-in attempt is unknown or has expired. Please try again.");
    const discovery = await this.#discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.callbackUrl,
      client_id: oidc.clientId,
      code_verifier: pending.verifier,
    });
    if (oidc.clientSecret) body.set("client_secret", oidc.clientSecret);
    const tokenRes = await this.fetchImpl(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    const tokens = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
    if (!tokenRes.ok || !tokens.access_token) {
      await this.audit({ action: "signin.failed", detail: { reason: tokens.error ?? `HTTP ${tokenRes.status}` }, ip });
      throw new LotseError(
        "AUTH_FAILED",
        `The identity provider rejected the sign-in: ${tokens.error_description ?? tokens.error ?? `HTTP ${tokenRes.status}`}`,
      );
    }
    // The profile is read from the provider's userinfo endpoint over TLS, so no token needs to be verified locally.
    const infoRes = await this.fetchImpl(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const info = (await infoRes.json().catch(() => ({}))) as { sub?: string; email?: string; name?: string; preferred_username?: string };
    if (!infoRes.ok || !info.sub) throw new LotseError("AUTH_FAILED", "The identity provider returned no user profile.");

    const subject = `${oidc.issuer}|${info.sub}`;
    const { db, schema } = this.database;
    const existing = await db.select().from(schema.users).where(eq(schema.users.subject, subject));
    let user: User;
    if (existing[0]) {
      user = toUser(existing[0]);
    } else {
      // The first person to sign in becomes the owner of the instance.
      const anyone = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
      user = {
        id: newId("usr_"),
        email: info.email ?? `${info.sub}@${new URL(oidc.issuer).host}`,
        name: info.name ?? info.preferred_username ?? info.email ?? "User",
        role: anyone.length === 0 ? "owner" : "member",
      };
      await db.insert(schema.users).values({ ...user, subject, createdAt: Date.now() });
    }
    const session = await this.createSession(user.id);
    await this.audit({ userId: user.id, action: "signin", ip });
    return { user, ...session, returnTo: pending.returnTo };
  }

  async listUsers(): Promise<User[]> {
    const { db, schema } = this.database;
    return (await db.select().from(schema.users)).map(toUser);
  }

  async setRole(actor: User, userId: string, role: Role): Promise<void> {
    requireRole(actor, "admin");
    if (!(role in RANK)) throw new LotseError("INVALID_INPUT", `Unknown role "${role}".`);
    const { db, schema } = this.database;
    const target = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    if (!target) throw new LotseError("NOT_FOUND", "There is no such user.");
    // Only owners appoint or demote owners, and the last owner cannot be demoted.
    if ((target.role === "owner" || role === "owner") && actor.role !== "owner")
      throw new LotseError("PERMISSION_MISSING", "Only an owner can change who is an owner.");
    if (target.role === "owner" && role !== "owner") {
      const owners = (await db.select().from(schema.users)).filter((u) => u.role === "owner");
      if (owners.length <= 1) throw new LotseError("CONFLICT", "The instance needs at least one owner.");
    }
    await db.update(schema.users).set({ role }).where(eq(schema.users.id, userId));
    await this.audit({ userId: actor.id, action: "user.role", target: userId, detail: { role } });
  }

  async auditLog(
    actor: User,
    limit = 200,
  ): Promise<{ id: string; at: number; userId: string | null; action: string; target: string | null; detail: unknown; ip: string | null }[]> {
    requireRole(actor, "admin");
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.auditLog);
    return rows
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}

function toUser(row: { id: string; email: string; name: string; role: string }): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role as Role };
}

export function requireRole(user: User, role: Role): void {
  if (RANK[user.role] < RANK[role]) throw new LotseError("PERMISSION_MISSING", `This needs the role ${role}.`);
}

export function hasRole(user: User, role: Role): boolean {
  return RANK[user.role] >= RANK[role];
}
