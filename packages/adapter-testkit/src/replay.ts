/**
 * Replays recorded provider API responses so that contract tests run without
 * network access or accounts. Real responses are captured by the live tests:
 * with `LOTSE_RECORD=<folder>` they write every interaction with the provider,
 * credentials scrubbed, to `<folder>/<adapter>.live.json` (see `liveTransport`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Redactor } from "@lotseai/core";

export interface RecordedRequest {
  method: string;
  /** Full URL. `*` matches one path segment, a trailing `**` any rest. Query parameters listed here must be present. */
  url: string;
  /** JSON subset the request body must contain. For GraphQL, `{ "query": "..." }` matches by substring. */
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Interaction {
  request: RecordedRequest;
  response: RecordedResponse;
  /** Not every run has to hit this interaction (e.g. polling). */
  optional?: boolean;
}

export interface Cassette {
  adapter: string;
  /** `live` when recorded against the real API, `documentation` when written from the provider's API reference. */
  source: "live" | "documentation";
  recordedAt?: string;
  notes?: string;
  scenarios: Record<string, Interaction[]>;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Raw body, e.g. for uploads. */
  rawBody?: Uint8Array;
}

function segmentsMatch(pattern: string[], actual: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "**") return true;
    if (i >= actual.length) return false;
    if (pattern[i] !== "*" && pattern[i] !== actual[i]) return false;
  }
  return pattern.length === actual.length;
}

function urlMatches(pattern: string, actual: string): boolean {
  const p = new URL(pattern.replace(/\*/g, "%2A"));
  const a = new URL(actual);
  if (p.origin !== a.origin) return false;
  const decode = (s: string) => s.split("/").map((x) => decodeURIComponent(x));
  if (!segmentsMatch(decode(p.pathname), decode(a.pathname))) return false;
  for (const [k, v] of p.searchParams) {
    if (v !== "*" && a.searchParams.get(k) !== v) return false;
    if (v === "*" && !a.searchParams.has(k)) return false;
  }
  return true;
}

/** True when `actual` contains everything in `expected`. Strings under a `query` key match by substring. */
export function subsetMatches(expected: unknown, actual: unknown, key?: string): boolean {
  if (expected === null || typeof expected !== "object") {
    if (key === "query" && typeof expected === "string" && typeof actual === "string")
      return actual.replace(/\s+/g, " ").includes(expected.replace(/\s+/g, " "));
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((e) => actual.some((a) => subsetMatches(e, a)));
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => subsetMatches(v, (actual as Record<string, unknown>)[k], k));
}

async function readBody(init: RequestInit | undefined): Promise<{ body: unknown; raw?: Uint8Array }> {
  const b = init?.body;
  if (b === undefined || b === null) return { body: undefined };
  if (typeof b === "string") {
    try {
      return { body: JSON.parse(b) };
    } catch {
      return { body: b };
    }
  }
  if (b instanceof URLSearchParams) return { body: Object.fromEntries(b) };
  if (b instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of b.entries()) {
      if (typeof v !== "string") {
        out[k] = `[file ${v.size} bytes]`;
        continue;
      }
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    }
    return { body: out };
  }
  if (b instanceof Uint8Array) return { body: `[binary ${b.byteLength} bytes]`, raw: b };
  if (b instanceof ArrayBuffer) return { body: `[binary ${b.byteLength} bytes]`, raw: new Uint8Array(b) };
  const raw = new Uint8Array(await new Response(b as BodyInitLike).arrayBuffer());
  return { body: `[binary ${raw.byteLength} bytes]`, raw };
}
type BodyInitLike = ConstructorParameters<typeof Response>[0];

export class ReplayTransport {
  readonly requests: SeenRequest[] = [];
  readonly #interactions: { interaction: Interaction; used: number }[];
  readonly #scenario: string;

  constructor(interactions: Interaction[], scenario = "scenario") {
    this.#interactions = interactions.map((interaction) => ({ interaction, used: 0 }));
    this.#scenario = scenario;
  }

  /**
   * Interactions are matched by method, URL and body subset. Several
   * interactions for the same request are consumed in order; the last one
   * keeps answering, which models polling.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const { body, raw } = await readBody(init);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    this.requests.push({ method, url, headers, body, rawBody: raw });

    const candidates = this.#interactions.filter(
      ({ interaction: i }) =>
        i.request.method.toUpperCase() === method && urlMatches(i.request.url, url) && (i.request.body === undefined || subsetMatches(i.request.body, body)),
    );
    const next = candidates.find((c) => c.used === 0) ?? candidates.at(-1);
    if (!next) {
      const bodyText = body === undefined ? "" : `\n  body: ${JSON.stringify(body).slice(0, 400)}`;
      throw new Error(
        `[${this.#scenario}] No recorded response for ${method} ${url}${bodyText}\n  Recorded: ${this.#interactions.map((c) => `${c.interaction.request.method} ${c.interaction.request.url}`).join("\n            ")}`,
      );
    }
    next.used++;
    const { status, headers: resHeaders, body: resBody } = next.interaction.response;
    if (resBody === undefined || status === 204) return new Response(null, { status, headers: resHeaders });
    if (typeof resBody === "string") return new Response(resBody, { status, headers: { "content-type": "text/plain", ...resHeaders } });
    return new Response(JSON.stringify(resBody), { status, headers: { "content-type": "application/json", ...resHeaders } });
  };

  /** Recorded interactions that no request asked for. */
  unused(): string[] {
    return this.#interactions.filter((c) => c.used === 0 && !c.interaction.optional).map((c) => `${c.interaction.request.method} ${c.interaction.request.url}`);
  }

  /** Requests that change state at the provider. GraphQL queries count as reads. */
  mutations(): SeenRequest[] {
    return this.requests.filter((r) => {
      if (r.method === "GET" || r.method === "HEAD") return false;
      const query = (r.body as { query?: unknown } | undefined)?.query;
      if (typeof query === "string") return /^\s*mutation\b/.test(query);
      return true;
    });
  }
}

export async function loadCassette(path: string | URL): Promise<Cassette> {
  return JSON.parse(await readFile(path, "utf8")) as Cassette;
}

/**
 * Wraps the real `fetch` and collects interactions for a cassette. Secrets are
 * scrubbed when the interactions are read, so values learned later in a run
 * (e.g. a refreshed token) are removed from earlier interactions as well.
 */
export class RecordingTransport {
  readonly #raw: Interaction[] = [];
  readonly #redactor: Redactor;

  constructor(secrets: string[] = []) {
    this.#redactor = new Redactor().add(...secrets);
  }

  /** Values that must never appear in the recording. */
  protect(...secrets: (string | undefined)[]): this {
    this.#redactor.add(...secrets);
    return this;
  }

  get interactions(): Interaction[] {
    const scrub = <T>(value: T): T => (value === undefined ? value : (JSON.parse(this.#redactor.redact(JSON.stringify(value))) as T));
    return this.#raw.map((i) => ({
      request: { ...i.request, url: this.#redactor.redact(i.request.url), body: scrub(i.request.body) },
      response: { ...i.response, body: scrub(i.response.body) },
    }));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { body } = await readBody(init);
    const res = await fetch(input, init);
    const text = await res.clone().text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    this.#raw.push({
      request: { method: (init?.method ?? "GET").toUpperCase(), url, body },
      response: { status: res.status, body: text === "" ? undefined : parsed },
    });
    return res;
  };
}

export async function saveCassette(path: string, cassette: Cassette): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
}
