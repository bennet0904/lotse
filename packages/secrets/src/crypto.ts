import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { LotseError } from "@lotse/core";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** A new random master key, base64 encoded. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Accepts a 256-bit key in base64, base64url or hex encoding. */
export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const candidates = [
    /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, "hex") : undefined,
    /^[A-Za-z0-9+/]{43}=?$/.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined,
    /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? Buffer.from(trimmed, "base64url") : undefined,
  ];
  const key = candidates.find((c) => c?.length === KEY_BYTES);
  if (!key) {
    throw new LotseError("INVALID_INPUT", "The master key must be 32 random bytes in base64 or hex encoding. Create one with `lotse secrets generate-key`.");
  }
  return key;
}

/**
 * Encrypts with AES-256-GCM. `context` is authenticated but not encrypted;
 * binding a value to its name prevents ciphertexts from being swapped.
 */
export function encrypt(key: Buffer, plaintext: string, context = ""): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(key: Buffer, payload: string, context = ""): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new LotseError("INVALID_INPUT", "The stored credential has an unknown format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new LotseError("AUTH_FAILED", "A stored credential could not be decrypted. The master key is wrong or the data was modified.");
  }
}
