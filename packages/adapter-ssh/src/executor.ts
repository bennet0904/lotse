import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { type Connection, LotseError } from "@lotse/core";
import ssh2 from "ssh2";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  stdin?: Readable | Buffer | string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Run as root through passwordless sudo when the SSH user is not root. */
  sudo?: boolean;
}

/**
 * Runs commands on a server. All remote work of the adapter goes through
 * `run`, whose `op` names the operation; tests script answers per operation.
 */
export interface SshExecutor {
  readonly user: string;
  /** SHA256 fingerprint of the host key seen when connecting. */
  readonly hostKey: string;
  run(op: string, script: string, options?: ExecOptions): Promise<ExecResult>;
  close(): void;
}

export interface SshParams {
  host: string;
  port: number;
  user: string;
  privateKey?: string;
  password?: string;
  /** Pinned fingerprint. A different key aborts the connection. */
  hostKey?: string;
  timeoutMs?: number;
}

export type SshConnector = (params: SshParams) => Promise<SshExecutor>;

export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Quotes a value for use as a single shell word. */
export function sh(value: string | number): string {
  const s = String(value);
  return /^[A-Za-z0-9_/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

class Ssh2Executor implements SshExecutor {
  constructor(
    readonly client: ssh2.Client,
    readonly user: string,
    readonly hostKey: string,
  ) {}

  run(_op: string, script: string, options: ExecOptions = {}): Promise<ExecResult> {
    // Scripts travel as an argument to `bash -c`, which keeps stdin free for data. The strict
    // mode is set inside the script: as a bash option it would also apply to the startup files
    // sshd makes bash read, and those are not written for `-u`.
    const command = `${options.sudo && this.user !== "root" ? "sudo -n " : ""}bash -c ${sh(`set -euo pipefail\n${script}`)}`;
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new LotseError("ABORTED", "The operation was aborted."));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(new LotseError("PROVIDER_ERROR", `Could not run a command on the server: ${err.message}`));
        let stdout = "";
        let stderr = "";
        const onAbort = () => {
          stream.close();
          reject(new LotseError("ABORTED", "The operation was aborted."));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        stream.on("data", (d: Buffer) => {
          const text = d.toString("utf8");
          stdout += text;
          options.onStdout?.(text);
        });
        stream.stderr.on("data", (d: Buffer) => {
          const text = d.toString("utf8");
          stderr += text;
          options.onStderr?.(text);
        });
        stream.on("close", (code: number | null) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve({ code: code ?? 255, stdout, stderr });
        });
        const stdin = options.stdin;
        if (stdin === undefined) stream.end();
        else if (typeof stdin === "string" || Buffer.isBuffer(stdin)) stream.end(stdin);
        else {
          stdin.on("error", (e) => {
            stream.close();
            reject(e);
          });
          stdin.pipe(stream);
        }
      });
    });
  }

  close(): void {
    this.client.end();
  }
}

/** Connects with the ssh2 library: no `ssh` binary and no agent on the server are needed. */
export const connectWithSsh2: SshConnector = (params) =>
  new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seen = "";
    let mismatch = false;
    client
      .on("ready", () => resolve(new Ssh2Executor(client, params.user, seen)))
      .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => params.password ?? "")))
      .on("error", (err: Error & { level?: string }) => {
        client.end();
        if (mismatch) {
          return reject(
            new LotseError("AUTH_FAILED", `The host key of ${params.host} changed (now ${seen}, expected ${params.hostKey}). Refusing to connect.`, {
              hints: ["If the server was reinstalled, remove the connection and add the server again."],
            }),
          );
        }
        if (err.level === "client-authentication") {
          return reject(new LotseError("AUTH_FAILED", `${params.user}@${params.host} did not accept the ${params.privateKey ? "SSH key" : "password"}.`));
        }
        reject(new LotseError("PROVIDER_ERROR", `Could not connect to ${params.host}:${params.port} (${err.message}).`));
      })
      .connect({
        host: params.host,
        port: params.port,
        username: params.user,
        privateKey: params.privateKey,
        password: params.password,
        tryKeyboard: Boolean(params.password),
        readyTimeout: params.timeoutMs ?? 20_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          mismatch = Boolean(params.hostKey) && params.hostKey !== seen;
          return !mismatch;
        },
      });
  });

export interface SshKeyPair {
  privateKey: string;
  publicKey: string;
}

function sshString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

/**
 * Generates the framework's Ed25519 key pair in OpenSSH format. The keys come
 * from Node's crypto module and are encoded here (PROTOCOL.key), because
 * ssh2's own generator occasionally emits keys it cannot read back.
 */
export function generateSshKeyPair(comment = "lotse"): SshKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const type = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const padding = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    count,
    sshString(publicBlob),
    sshString(secret),
  ]);
  const body = (blob.toString("base64").match(/.{1,70}/g) ?? []).join("\n");
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${type} ${publicBlob.toString("base64")} ${comment}`,
  };
}

export function publicKeyOf(privateKey: string, comment = "lotse"): string {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw new LotseError("INVALID_INPUT", `The private key cannot be read: ${parsed.message}`);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return `${key.type} ${key.getPublicSSH().toString("base64")} ${comment}`;
}

export function paramsOf(conn: Connection): SshParams {
  const host = conn.settings.host;
  if (!host) throw new LotseError("INVALID_INPUT", "The SSH connection has no host.");
  return {
    host,
    port: Number(conn.settings.port ?? 22),
    user: conn.settings.user ?? "root",
    privateKey: conn.credentials.privateKey,
    hostKey: conn.settings.hostKey,
  };
}

/** Runs a script and throws with the server's error output when it fails. */
export async function must(executor: SshExecutor, op: string, script: string, options?: ExecOptions): Promise<string> {
  const result = await executor.run(op, script, options);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-8).join("\n");
    throw new LotseError("PROVIDER_ERROR", `The server reported an error during "${op}"${detail ? `:\n${detail}` : ` (exit code ${result.code})`}`, {
      details: { op, code: result.code },
    });
  }
  return result.stdout;
}
