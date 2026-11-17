/**
 * OAuth 2.0 with PKCE (specification section 8).
 *
 * Adapters only publish static metadata (`OAuthProviderConfig`) and receive
 * finished tokens through `connect({ method: "oauth", tokens })`. Where the
 * OAuth client comes from is decided here, by a chain of `OAuthClientSource`s:
 * operator-supplied environment variables, RFC 7591 dynamic registration, and,
 * in a later version, a central broker. Adding a source needs no adapter change.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LotseError } from "./errors.js";
import type { AuthMethod, ConnectInput, Connection, OAuthClient, OAuthProviderConfig, OAuthTokens } from "./types.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function createState(): string {
  return base64url(randomBytes(24));
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

export function buildAuthorizationUrl(
  config: OAuthProviderConfig,
  client: OAuthClient,
  redirectUri: string,
  scopes: string[] = config.scopes,
): AuthorizationRequest {
  const pkce = createPkcePair();
  const state = createState();
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  if (scopes.length > 0) url.searchParams.set("scope", scopes.join(config.scopeSeparator ?? " "));
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) url.searchParams.set(k, v);
  return { url: url.toString(), state, verifier: pkce.verifier, redirectUri };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  config: OAuthProviderConfig,
  client: OAuthClient,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
  previousRefreshToken?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  let res: Response;
  try {
    res = await fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
  } catch (err) {
    throw new LotseError("AUTH_FAILED", `Could not reach the token endpoint (${(err as Error).message}).`, { cause: err });
  }
  const text = await res.text();
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    // Some providers answer form-encoded.
    json = Object.fromEntries(new URLSearchParams(text)) as TokenResponse;
    if (json.expires_in !== undefined) json.expires_in = Number(json.expires_in);
  }
  if (!res.ok || json.error || !json.access_token) {
    throw new LotseError("AUTH_FAILED", `The provider rejected the sign-in: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefreshToken,
    expiresAt: typeof json.expires_in === "number" && json.expires_in > 0 ? Date.now() + json.expires_in * 1000 : undefined,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export function exchangeCode(
  config: OAuthProviderConfig,
  client: OAuthClient,
  input: { code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  return tokenRequest(
    config,
    client,
    { grant_type: "authorization_code", code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri },
    fetchImpl,
  );
}

export function refreshTokens(config: OAuthProviderConfig, client: OAuthClient, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
  return tokenRequest(config, client, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, refreshToken);
}

/** RFC 7591 dynamic client registration. */
export async function registerClient(
  config: OAuthProviderConfig,
  input: { redirectUris: string[]; clientName: string; native?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthClient> {
  if (!config.registrationEndpoint) {
    throw new LotseError("UNSUPPORTED", "The provider does not support dynamic client registration.");
  }
  const res = await fetchImpl(config.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: input.native ? "none" : "client_secret_post",
      application_type: input.native ? "native" : "web",
      scope: config.scopes.join(" "),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error_description?: string; error?: string };
  if (!res.ok || !json.client_id) {
    throw new LotseError("AUTH_FAILED", `Dynamic client registration failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  return { clientId: json.client_id, clientSecret: json.client_secret };
}

// ---------------------------------------------------------------------------
// Where OAuth clients come from
// ---------------------------------------------------------------------------

export interface OAuthClientRequest {
  /** Adapter id. */
  adapter: string;
  config: OAuthProviderConfig;
  redirectUri: string;
  native?: boolean;
}

export interface OAuthClientSource {
  readonly id: string;
  /** Cheap check used to decide which sign-in methods to offer. */
  available(request: Pick<OAuthClientRequest, "adapter" | "config">): boolean;
  resolve(request: OAuthClientRequest): Promise<OAuthClient | undefined>;
}

/** Clients registered by the operator: `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET`. */
export function envClientSource(env: Record<string, string | undefined> = process.env): OAuthClientSource {
  return {
    id: "env",
    available: ({ config }) => Boolean(env[`${config.envPrefix}_CLIENT_ID`]),
    async resolve({ config }) {
      const clientId = env[`${config.envPrefix}_CLIENT_ID`];
      return clientId ? { clientId, clientSecret: env[`${config.envPrefix}_CLIENT_SECRET`] } : undefined;
    },
  };
}

export interface OAuthClientCache {
  get(key: string): Promise<OAuthClient | undefined>;
  set(key: string, client: OAuthClient): Promise<void>;
}

/** Registers the instance at the provider on the first connection attempt (RFC 7591). */
export function dynamicRegistrationSource(cache: OAuthClientCache, options: { clientName?: string; fetch?: typeof fetch } = {}): OAuthClientSource {
  return {
    id: "dynamic-registration",
    available: ({ config }) => Boolean(config.registrationEndpoint),
    async resolve({ adapter, config, redirectUri, native }) {
      if (!config.registrationEndpoint) return undefined;
      const key = `${adapter}|${redirectUri}`;
      const cached = await cache.get(key);
      if (cached) return cached;
      const client = await registerClient(config, { redirectUris: [redirectUri], clientName: options.clientName ?? "Lotse", native }, options.fetch);
      await cache.set(key, client);
      return client;
    },
  };
}

export async function resolveOAuthClient(sources: OAuthClientSource[], request: OAuthClientRequest): Promise<OAuthClient | undefined> {
  for (const source of sources) {
    if (!source.available(request)) continue;
    const client = await source.resolve(request);
    if (client) return client;
  }
  return undefined;
}

/**
 * Orders an adapter's sign-in methods by convenience for this instance:
 * OAuth first when a client is available, otherwise the guided token setup.
 * An adapter with OAuth support but no client simply does not offer OAuth;
 * that is not an error (specification section 8.1).
 */
export function availableAuthMethods(adapter: { id: string; auth: AuthMethod[]; oauth?: OAuthProviderConfig }, sources: OAuthClientSource[]): AuthMethod[] {
  const methods: AuthMethod[] = [];
  const config = adapter.oauth;
  if (adapter.auth.includes("oauth") && config && sources.some((s) => s.available({ adapter: adapter.id, config }))) {
    methods.push("oauth");
  }
  if (adapter.auth.includes("token")) methods.push("token");
  if (adapter.auth.includes("ssh")) methods.push("ssh");
  return methods;
}

// ---------------------------------------------------------------------------
// Loopback redirect for native apps (RFC 8252)
// ---------------------------------------------------------------------------

export interface LoopbackListener {
  redirectUri: string;
  /** Resolves with the authorization code once the browser was redirected back. */
  waitForCode(expectedState: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

export async function listenOnLoopback(port = 0, path = "/oauth/callback"): Promise<LoopbackListener> {
  let settle: ((result: { code?: string; state?: string; error?: string }) => void) | undefined;
  const pending = new Promise<{ code?: string; state?: string; error?: string }>((resolve) => {
    settle = resolve;
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Lotse</title><body style="font-family:system-ui;margin:3rem"><h1>${
        error ? "Sign-in failed" : "Signed in"
      }</h1><p>${error ? "The provider reported an error. You can close this window and try again." : "You can close this window and return to Lotse."}</p></body></html>`,
    );
    settle?.({
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: error ? (url.searchParams.get("error_description") ?? error) : undefined,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${actualPort}${path}`,
    async waitForCode(expectedState, timeoutMs = 5 * 60_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LotseError("AUTH_FAILED", "Timed out waiting for the sign-in to complete.")), timeoutMs);
      });
      try {
        const result = await Promise.race([pending, timeout]);
        if (result.error) throw new LotseError("AUTH_FAILED", `The provider rejected the sign-in: ${result.error}`);
        if (!result.code || result.state !== expectedState) {
          throw new LotseError("AUTH_FAILED", "The sign-in response was invalid (state mismatch).");
        }
        return result.code;
      } finally {
        clearTimeout(timer);
        server.close();
      }
    },
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

const REFRESH_SKEW_MS = 5 * 60_000;

export function connectionExpiresSoon(conn: Connection, now = Date.now(), skewMs = REFRESH_SKEW_MS): boolean {
  return conn.method === "oauth" && conn.expiresAt !== undefined && conn.expiresAt - skewMs <= now;
}

/**
 * Refreshes an OAuth connection shortly before it expires. Returns the same
 * object when nothing had to be done. Throws `AUTH_EXPIRED` when the refresh
 * fails, in which case the user has to sign in again.
 */
export async function ensureFreshConnection(
  conn: Connection,
  config: OAuthProviderConfig | undefined,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<Connection> {
  if (!connectionExpiresSoon(conn, options.now)) return conn;
  const refreshToken = conn.credentials.refreshToken;
  const clientId = conn.credentials.clientId;
  if (!config || !refreshToken || !clientId) {
    throw new LotseError("AUTH_EXPIRED", `The sign-in for ${conn.account.name} has expired. Please sign in again.`);
  }
  try {
    const tokens = await refreshTokens(config, { clientId, clientSecret: conn.credentials.clientSecret }, refreshToken, options.fetch);
    return oauthConnectionUpdate(conn, tokens);
  } catch (err) {
    throw new LotseError("AUTH_EXPIRED", `The sign-in for ${conn.account.name} could not be renewed. Please sign in again.`, { cause: err });
  }
}

export function oauthConnectionUpdate(conn: Connection, tokens: OAuthTokens): Connection {
  const credentials: Record<string, string> = { ...conn.credentials, accessToken: tokens.accessToken };
  if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
  return { ...conn, credentials, expiresAt: tokens.expiresAt };
}

/** Builds the credential map every adapter stores for an OAuth connection. */
export function oauthCredentials(tokens: OAuthTokens, client?: OAuthClient): Record<string, string> {
  const credentials: Record<string, string> = { accessToken: tokens.accessToken };
  if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
  if (client?.clientId) credentials.clientId = client.clientId;
  if (client?.clientSecret) credentials.clientSecret = client.clientSecret;
  return credentials;
}

/** The bearer token of a connection, independent of how the user signed in. */
export function accessToken(conn: Connection): string {
  const token = conn.credentials.accessToken ?? conn.credentials.token;
  if (!token) throw new LotseError("AUTH_FAILED", `The connection for ${conn.adapter} has no access token.`);
  return token;
}

/**
 * The connection skeleton for token and OAuth sign-ins. Adapters fill in the
 * account after their first API call.
 */
export function apiConnection(adapter: string, input: ConnectInput, settings: Record<string, string> = {}): Connection {
  if (input.method === "ssh") throw new LotseError("INVALID_INPUT", `${adapter} is connected with ${"an API token or OAuth"}, not SSH.`);
  return {
    adapter,
    method: input.method,
    account: { id: "", name: "" },
    credentials: { ...(input.method === "token" ? { token: input.token } : oauthCredentials(input.tokens, input.client)), ...input.secrets },
    settings: { ...settings },
    expiresAt: input.method === "oauth" ? input.tokens.expiresAt : undefined,
  };
}
