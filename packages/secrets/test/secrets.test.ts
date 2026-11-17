import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "@lotse/core";
import {
  ConnectionStore,
  decrypt,
  encrypt,
  envKeyProvider,
  FileBackend,
  fileKeyProvider,
  firstAvailableKeyProvider,
  generateMasterKey,
  keychainKeyProvider,
  MemoryBackend,
  parseMasterKey,
  SecretStore,
  staticKeyProvider,
  vaultKeyProvider,
} from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lotse-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AES-256-GCM", () => {
  const key = parseMasterKey(generateMasterKey());

  it("round-trips and uses a fresh nonce every time", () => {
    const a = encrypt(key, "token-value", "connection/vercel");
    const b = encrypt(key, "token-value", "connection/vercel");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("token-value");
    expect(decrypt(key, a, "connection/vercel")).toBe("token-value");
  });

  it("detects tampering, a wrong key and swapped entries", () => {
    const payload = encrypt(key, "token-value", "a");
    const parts = payload.split(".");
    const tampered = [...parts.slice(0, 3), Buffer.from("other").toString("base64url")].join(".");
    expect(() => decrypt(key, tampered, "a")).toThrow(/could not be decrypted/);
    expect(() => decrypt(parseMasterKey(generateMasterKey()), payload, "a")).toThrow(/could not be decrypted/);
    expect(() => decrypt(key, payload, "b")).toThrow(/could not be decrypted/);
    expect(() => decrypt(key, "garbage", "a")).toThrow(/unknown format/);
  });

  it("accepts base64 and hex keys and rejects weak ones", () => {
    const raw = Buffer.alloc(32, 7);
    expect(parseMasterKey(raw.toString("base64"))).toEqual(raw);
    expect(parseMasterKey(raw.toString("hex"))).toEqual(raw);
    expect(parseMasterKey(raw.toString("base64url"))).toEqual(raw);
    expect(() => parseMasterKey("password123")).toThrow(/32 random bytes/);
  });
});

describe("master key providers", () => {
  it("reads the key from the environment", async () => {
    const key = generateMasterKey();
    expect(await envKeyProvider({ LOTSE_MASTER_KEY: key }).getKey()).toEqual(parseMasterKey(key));
    await expect(envKeyProvider({}).getKey()).rejects.toThrow(/LOTSE_MASTER_KEY is not set/);
  });

  it("creates a key file with owner-only permissions", async () => {
    const path = join(dir, "config/master.key");
    const key = await fileKeyProvider(path).getKey();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await fileKeyProvider(path).getKey()).toEqual(key);
  });

  it("reads the key from Vault or OpenBao (KV v2)", async () => {
    const key = generateMasterKey();
    let seen: { url: string; token: string | null } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), token: new Headers(init?.headers).get("x-vault-token") };
      return Response.json({ data: { data: { master_key: key } } });
    }) as typeof fetch;
    const provider = vaultKeyProvider({ address: "https://vault.test:8200/", token: "s.abc", path: "apps/lotse", fetch: fetchImpl });
    expect(await provider.getKey()).toEqual(parseMasterKey(key));
    expect(seen).toEqual({ url: "https://vault.test:8200/v1/secret/data/apps/lotse", token: "s.abc" });
  });

  it("uses the OS keychain and creates the key on first use", async () => {
    const calls: string[][] = [];
    let stored = "";
    const exec = async (file: string, args: string[], stdin?: string) => {
      calls.push([file, args[0] as string]);
      if (args[0] === "lookup") return stored;
      if (args[0] === "store") stored = stdin ?? "";
      return "";
    };
    const first = await keychainKeyProvider({ platform: "linux", exec }).getKey();
    const second = await keychainKeyProvider({ platform: "linux", exec }).getKey();
    expect(second).toEqual(first);
    expect(calls.map((c) => c.join(" "))).toEqual(["secret-tool lookup", "secret-tool store", "secret-tool lookup"]);
  });

  it("falls back to the next provider", async () => {
    const provider = firstAvailableKeyProvider([envKeyProvider({}), fileKeyProvider(join(dir, "k"))]);
    expect((await provider.getKey()).length).toBe(32);
  });
});

describe("secret store", () => {
  it("never writes plaintext to the backend", async () => {
    const path = join(dir, "secrets.json");
    const store = new SecretStore(new FileBackend(path), staticKeyProvider(generateMasterKey()));
    await store.set("env/app/STRIPE_API_KEY", "sk_live_plaintext");
    await store.set("env/app/OTHER", "another-value");
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain("sk_live_plaintext");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.get("env/app/STRIPE_API_KEY")).toBe("sk_live_plaintext");
    expect(await store.list("env/app/")).toEqual(["env/app/OTHER", "env/app/STRIPE_API_KEY"]);
    await store.delete("env/app/OTHER");
    expect(await store.get("env/app/OTHER")).toBeUndefined();
  });

  it("re-encrypts everything when the master key is rotated", async () => {
    const backend = new MemoryBackend();
    const oldKeys = staticKeyProvider(generateMasterKey());
    const store = new SecretStore(backend, oldKeys);
    await store.set("a", "one");
    const rotated = await store.rotate(staticKeyProvider(generateMasterKey()));
    expect(await rotated.get("a")).toBe("one");
    await expect(new SecretStore(backend, oldKeys).get("a")).rejects.toThrow(/could not be decrypted/);
  });
});

describe("connection store", () => {
  const conn: Connection = {
    adapter: "vercel",
    method: "oauth",
    account: { id: "u1", name: "Ada" },
    credentials: { accessToken: "old-access", refreshToken: "refresh-1", clientId: "client" },
    settings: {},
    expiresAt: Date.now() + 30_000,
  };
  const oauth = { authorizationEndpoint: "https://p.test/a", tokenEndpoint: "https://p.test/t", scopes: [], envPrefix: "X" };

  it("stores accounts encrypted and refreshes OAuth tokens before they expire", async () => {
    const backend = new MemoryBackend();
    const connections = new ConnectionStore(new SecretStore(backend, staticKeyProvider(generateMasterKey())));
    await connections.save("vercel", conn);
    expect(await backend.get("connection/vercel")).not.toContain("old-access");
    expect(await connections.list()).toEqual(["vercel"]);

    const fetchImpl = (async () => Response.json({ access_token: "new-access", expires_in: 3600 })) as typeof fetch;
    const fresh = await connections.fresh("vercel", oauth, fetchImpl);
    expect(fresh.credentials.accessToken).toBe("new-access");
    expect(fresh.credentials.refreshToken).toBe("refresh-1");
    expect((await connections.get("vercel"))?.credentials.accessToken).toBe("new-access");
  });

  it("asks the user to sign in again when the refresh fails", async () => {
    const connections = new ConnectionStore(new SecretStore(new MemoryBackend(), staticKeyProvider(generateMasterKey())));
    await connections.save("vercel", conn);
    const failing = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
    await expect(connections.fresh("vercel", oauth, failing)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    await expect(connections.require("missing")).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});
