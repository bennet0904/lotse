import { LotseError, type LotseErrorCode } from "./errors.js";
import { redact } from "./redact.js";

export interface HttpClientOptions {
  /** Provider name used in error messages. */
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Retries for 429 and 5xx responses. */
  retries?: number;
  retryDelayMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body, or a raw body when `contentType` is set. */
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Return the `Response` instead of the parsed body. */
  raw?: boolean;
}

function providerMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 500) || undefined;
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === "string") return typeof b.error_description === "string" ? `${err}: ${b.error_description}` : err;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (typeof b.message === "string") return b.message;
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    return b.errors.map((e) => (typeof e === "string" ? e : typeof e?.message === "string" ? e.message : JSON.stringify(e))).join("; ");
  }
  return undefined;
}

function codeForStatus(status: number): LotseErrorCode {
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "PERMISSION_MISSING";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return "PROVIDER_ERROR";
}

/** Small JSON-over-HTTP client shared by the adapters. */
export class HttpClient {
  readonly #opts: HttpClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.#opts = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  with(headers: Record<string, string>): HttpClient {
    return new HttpClient({ ...this.#opts, headers: { ...this.#opts.headers, ...headers } });
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(this.#opts.baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...this.#opts.headers, ...options.headers };
    let body: RequestInit["body"];
    if (options.body !== undefined) {
      if (options.contentType) {
        headers["content-type"] = options.contentType;
        body = options.body as RequestInit["body"];
      } else if (options.body instanceof FormData) {
        body = options.body;
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.body);
      }
    }
    const url = this.url(path, options.query);
    const retries = this.#opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.#fetch(url, { method, headers, body, signal: options.signal });
      } catch (err) {
        if (options.signal?.aborted) throw new LotseError("ABORTED", "The operation was aborted.");
        if (attempt < retries && method === "GET") {
          await sleep(this.#delay(attempt));
          continue;
        }
        throw new LotseError("PROVIDER_ERROR", `${this.#opts.provider}: request to ${new URL(url).host} failed (${(err as Error).message}).`, { cause: err });
      }
      if ((res.status === 429 || res.status >= 502) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : this.#delay(attempt));
        continue;
      }
      if (options.raw && res.ok) return res as T;
      const text = res.status === 204 ? "" : await res.text();
      let parsed: unknown = text;
      if (text && (res.headers.get("content-type") ?? "").includes("json")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // keep the raw text
        }
      } else if (text && /^[[{]/.test(text.trimStart())) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // keep the raw text
        }
      }
      if (!res.ok) {
        const detail = providerMessage(parsed);
        throw new LotseError(
          codeForStatus(res.status),
          redact(`${this.#opts.provider} responded with ${res.status}${detail ? `: ${detail}` : ""} (${method} ${new URL(url).pathname})`),
          { details: { status: res.status, body: parsed } },
        );
      }
      return (text === "" ? undefined : parsed) as T;
    }
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }
  delete<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  #delay(attempt: number): number {
    return (this.#opts.retryDelayMs ?? 500) * 2 ** attempt;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LotseError("ABORTED", "The operation was aborted."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LotseError("ABORTED", "The operation was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollOptions<T> {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with every intermediate value. */
  onTick?: (value: T) => void;
  description?: string;
}

/** Polls `fn` until `done` returns true. Throws `PROVIDER_ERROR` on timeout. */
export async function poll<T>(fn: () => Promise<T>, done: (value: T) => boolean, options: PollOptions<T> = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    options.onTick?.(value);
    if (Date.now() > deadline) {
      throw new LotseError("PROVIDER_ERROR", `Timed out waiting for ${options.description ?? "the provider"}.`);
    }
    await sleep(options.intervalMs ?? 2000, options.signal);
  }
}
