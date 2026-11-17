/**
 * Scrubs credentials from text. Used for logs, error messages and everything
 * that is passed to a language model (specification section 13.2).
 */
import type { Connection, EnvVar } from "./types.js";

export const REDACTED = "[redacted]";

const PATTERNS: RegExp[] = [
  // PEM blocks (private keys, certificates with keys)
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Authorization headers
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // Credentials inside URLs: scheme://user:password@host
  /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  // Well-known token formats
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // key=value pairs with secret-looking keys
  /(?<=\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s"']{6,}/gi,
];

export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers literal secret values. Very short values are ignored to avoid mangling output. */
  add(...values: (string | undefined)[]): this {
    for (const v of values) {
      if (typeof v === "string" && v.length >= 6) this.#secrets.add(v);
    }
    return this;
  }

  addConnection(conn: Connection): this {
    return this.add(...Object.values(conn.credentials));
  }

  addEnv(vars: EnvVar[]): this {
    return this.add(...vars.filter((v) => v.secret).map((v) => v.value));
  }

  redact(text: string): string {
    let out = text;
    // Longest first so that a secret containing another one is replaced as a whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTED);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (_match, prefix) =>
        typeof prefix === "string" && /^(Bearer|Basic|token)$/i.test(prefix) ? `${prefix} ${REDACTED}` : REDACTED,
      );
    }
    return out;
  }
}

/** Pattern-only scrubbing for call sites without a `Redactor` instance. */
export function redact(text: string): string {
  return new Redactor().redact(text);
}

/** A copy of the connection that is safe to log or return from an API. */
export function redactConnection(conn: Connection): Connection {
  return {
    ...conn,
    credentials: Object.fromEntries(Object.keys(conn.credentials).map((k) => [k, REDACTED])),
  };
}
