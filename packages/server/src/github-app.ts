/**
 * The instance's GitHub App (specification section 11.3). An administrator
 * registers it through GitHub's manifest flow: GitHub hands back the app's ID,
 * private key, OAuth client and webhook secret, which go straight into the
 * encrypted store. Sign-ins to GitHub then use the app, so users can limit
 * access to single repositories and tokens are short-lived.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  completeGithubAppRegistration,
  type GithubAppRegistration,
  githubAppManifest,
  githubAppRegistrationUrl,
  githubOAuthClient,
} from "@lotseai/adapter-github";
import { LotseError, type OAuthClientSource } from "@lotseai/core";
import { requireRole, type User } from "./auth.js";
import type { Services } from "./services.js";

const VAULT_KEY = "github-app/registration";
const PENDING_MS = 30 * 60_000;

export interface GithubAppStatus {
  registered: boolean;
  slug?: string;
  url?: string;
  /** Where users install the app on their account or organization. */
  installUrl?: string;
}

/** A push to a repository, as far as the builder cares. */
export interface GithubPush {
  repository: string;
  branch: string;
  sha: string;
  pusher: string;
}

export class GithubAppService {
  #registration?: GithubAppRegistration;
  readonly #pending = new Map<string, { userId: string; createdAt: number }>();

  constructor(
    readonly services: Services,
    readonly fetchImpl?: typeof globalThis.fetch,
  ) {}

  get baseUrl(): string | undefined {
    return this.services.config.env.LOTSE_GITHUB_URL;
  }

  async load(): Promise<void> {
    const raw = await this.services.vault.get(VAULT_KEY);
    this.#registration = raw ? (JSON.parse(raw) as GithubAppRegistration) : undefined;
  }

  status(): GithubAppStatus {
    const app = this.#registration;
    if (!app) return { registered: false };
    return { registered: true, slug: app.slug, url: app.htmlUrl, installUrl: `${app.htmlUrl.replace(/\/+$/, "")}/installations/new` };
  }

  /** Step 1: the manifest and the address the administrator's browser posts it to. */
  begin(user: User, input: { organization?: string; name?: string }): { url: string; manifest: Record<string, unknown> } {
    requireRole(user, "admin");
    if (input.organization && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.organization))
      throw new LotseError("INVALID_INPUT", "That is not a GitHub organization name.");
    for (const [key, value] of this.#pending) if (Date.now() - value.createdAt > PENDING_MS) this.#pending.delete(key);
    const state = randomBytes(24).toString("base64url");
    this.#pending.set(state, { userId: user.id, createdAt: Date.now() });
    return {
      url: githubAppRegistrationUrl(state, { baseUrl: this.baseUrl, organization: input.organization }),
      manifest: githubAppManifest(this.services.config.publicUrl, input.name?.trim() || "Lotse"),
    };
  }

  /** Step 2: GitHub sends the administrator back with a code that turns into the app's credentials. */
  async complete(user: User, code: string, state: string, ip?: string): Promise<GithubAppStatus> {
    requireRole(user, "admin");
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.userId !== user.id || Date.now() - pending.createdAt > PENDING_MS) {
      throw new LotseError("AUTH_FAILED", "The registration is unknown or has expired. Please start it again.");
    }
    const registration = await completeGithubAppRegistration(code, { baseUrl: this.baseUrl, fetch: this.fetchImpl });
    await this.services.vault.set(VAULT_KEY, JSON.stringify(registration));
    this.#registration = registration;
    await this.services.auth.audit({ userId: user.id, action: "github-app.registered", target: registration.slug, detail: { appId: registration.id }, ip });
    return this.status();
  }

  /** Sign-ins to GitHub (and GitHub Pages) use the app's OAuth client once it is registered. */
  oauthSource(): OAuthClientSource {
    const isGithub = (adapter: string) => adapter === "github" || adapter === "github-pages";
    return {
      id: "github-app",
      available: ({ adapter }) => isGithub(adapter) && Boolean(this.#registration),
      resolve: async ({ adapter }) => (isGithub(adapter) && this.#registration ? githubOAuthClient(this.#registration) : undefined),
    };
  }

  /**
   * Checks a webhook delivery's signature and returns the push it reports, if
   * any. Deliveries that are not signed with the app's secret are refused.
   */
  verifyWebhook(body: string, signature: string | undefined, event: string | undefined): GithubPush | undefined {
    const secret = this.#registration?.webhookSecret;
    if (!secret) throw new LotseError("NOT_FOUND", "No GitHub App is registered on this instance.");
    const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
    const given = Buffer.from(signature ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new LotseError("AUTH_FAILED", "The webhook signature does not match.");
    if (event !== "push") return undefined;
    const payload = JSON.parse(body) as { ref?: string; after?: string; deleted?: boolean; repository?: { full_name?: string }; pusher?: { name?: string } };
    if (payload.deleted || !payload.ref?.startsWith("refs/heads/") || !payload.repository?.full_name || !payload.after) return undefined;
    return {
      repository: payload.repository.full_name,
      branch: payload.ref.slice("refs/heads/".length),
      sha: payload.after,
      pusher: payload.pusher?.name ?? "someone",
    };
  }
}
