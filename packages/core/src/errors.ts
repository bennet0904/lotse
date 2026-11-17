export type LotseErrorCode =
  | "MANIFEST_INVALID"
  | "MANIFEST_NOT_FOUND"
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_INVALID"
  | "AUTH_FAILED"
  | "AUTH_EXPIRED"
  | "PERMISSION_MISSING"
  | "RUNTIME_UNSUPPORTED"
  | "LANGUAGE_UNSUPPORTED"
  | "RESOURCE_UNSUPPORTED"
  | "DOMAINS_UNSUPPORTED"
  | "BUILD_FAILED"
  | "DEPLOY_FAILED"
  | "HEALTHCHECK_FAILED"
  | "ROLLBACK_FAILED"
  | "ROLLBACK_UNSUPPORTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ABORTED"
  | "APPROVAL_REQUIRED"
  | "PROVIDER_ERROR"
  | "GIT_CONFLICT"
  | "GIT_FAILED"
  | "UNSUPPORTED"
  | "INVALID_INPUT";

export interface LotseErrorOptions {
  cause?: unknown;
  /** Suggestions shown to the user, e.g. alternative providers. */
  hints?: string[];
  details?: Record<string, unknown>;
}

/** Error type used across the framework. Messages are safe to show to users. */
export class LotseError extends Error {
  readonly code: LotseErrorCode;
  readonly hints: string[];
  readonly details: Record<string, unknown>;

  constructor(code: LotseErrorCode, message: string, options: LotseErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LotseError";
    this.code = code;
    this.hints = options.hints ?? [];
    this.details = options.details ?? {};
  }
}

export function isLotseError(err: unknown): err is LotseError {
  return err instanceof Error && err.name === "LotseError" && "code" in err;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LotseError("ABORTED", "The operation was aborted.");
}
