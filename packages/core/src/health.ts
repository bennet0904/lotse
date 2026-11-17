import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { LotseError } from "./errors.js";
import { sleep } from "./http.js";

export interface HealthCheckOptions {
  url: string;
  headers?: Record<string, string>;
  /** Total time budget. */
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** Called after every failed attempt. */
  onAttempt?: (attempt: number, detail: string) => void;
}

export interface HealthResult {
  ok: boolean;
  status?: number;
  attempts: number;
  durationMs: number;
  detail?: string;
}

export type HealthChecker = (options: HealthCheckOptions) => Promise<HealthResult>;

/**
 * Single HTTP GET with full control over the `Host` header, which `fetch`
 * does not allow. Follows up to five redirects.
 */
export function probeOnce(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000, redirects = 5): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: "GET", headers: { "user-agent": "lotse-healthcheck", accept: "*/*", ...headers }, timeout: timeoutMs },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          const next = new URL(location, target);
          // A redirect to another host must not carry the overridden Host header.
          const nextHeaders = next.host === target.host ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "host"));
          probeOnce(next.toString(), nextHeaders, timeoutMs, redirects - 1).then(resolve, reject);
          return;
        }
        resolve(status);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** Calls the health check until it returns a 2xx status or the time budget is used up. */
export const waitForHealthy: HealthChecker = async (options) => {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 120_000);
  let attempts = 0;
  let detail = "";
  let status: number | undefined;
  for (;;) {
    if (options.signal?.aborted) throw new LotseError("ABORTED", "The operation was aborted.");
    attempts++;
    try {
      status = await probeOnce(options.url, options.headers, options.requestTimeoutMs ?? 10_000);
      if (status >= 200 && status < 300) {
        return { ok: true, status, attempts, durationMs: Date.now() - started };
      }
      detail = `HTTP ${status}`;
    } catch (err) {
      detail = (err as Error).message;
      status = undefined;
    }
    options.onAttempt?.(attempts, detail);
    if (Date.now() + (options.intervalMs ?? 2000) > deadline) {
      return { ok: false, status, attempts, durationMs: Date.now() - started, detail };
    }
    await sleep(options.intervalMs ?? 2000, options.signal);
  }
};
