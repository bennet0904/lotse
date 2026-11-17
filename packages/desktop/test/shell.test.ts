import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt, encrypt } from "@lotse/secrets";
import { chooseMasterKey, choosePort, desktopServerConfig, keychainUsable, navigation, type SafeStorageLike, safeStorageKeyProvider } from "../src/shell.js";

/** Stands in for Electron's safeStorage: a reversible transformation that is visibly not the plain text. */
function fakeSafeStorage(backend = "gnome_libsecret"): SafeStorageLike & { calls: number } {
  const storage = {
    calls: 0,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString(text: string) {
      storage.calls++;
      return Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`);
    },
    decryptString(data: Buffer) {
      const raw = data.toString();
      if (!raw.startsWith("sealed:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(raw.slice("sealed:".length), "base64").toString();
    },
  };
  return storage;
}

describe("master key in the operating system's keychain", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lotse-desktop-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the key once, stores it only in sealed form and finds it again", async () => {
    const storage = fakeSafeStorage();
    const file = join(dir, "data/master.key.enc");
    const key = await safeStorageKeyProvider(storage, file).getKey();
    expect(key.length).toBe(32);
    const onDisk = await readFile(file, "utf8");
    expect(onDisk).toMatch(/^sealed:/);
    expect(onDisk).not.toContain(key.toString("base64"));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    // After a restart the same key decrypts what was stored before.
    const again = await safeStorageKeyProvider(storage, file).getKey();
    expect(again.equals(key)).toBe(true);
    const ciphertext = encrypt(key, "secret value", "connection/vercel");
    expect(decrypt(again, ciphertext, "connection/vercel")).toBe("secret value");
    expect(storage.calls).toBe(1);
  });

  it("does not replace a key it cannot unlock", async () => {
    const file = join(dir, "master.key.enc");
    await writeFile(file, "sealed-by-another-user");
    await expect(safeStorageKeyProvider(fakeSafeStorage(), file).getKey()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(await readFile(file, "utf8")).toBe("sealed-by-another-user");
  });

  it("falls back to a protected key file, with a warning, when there is no keyring", async () => {
    const plain = fakeSafeStorage("basic_text");
    expect(keychainUsable(plain)).toBe(false);
    expect(keychainUsable({ ...fakeSafeStorage(), isEncryptionAvailable: () => false })).toBe(false);
    // macOS and Windows do not report a backend.
    expect(keychainUsable({ ...fakeSafeStorage(), getSelectedStorageBackend: undefined })).toBe(true);

    const choice = chooseMasterKey(plain, dir);
    expect(choice.warning).toContain("keyring");
    expect(chooseMasterKey(fakeSafeStorage(), dir).warning).toBeUndefined();
  });
});

describe("local builder", () => {
  it("prefers the fixed port and moves on when it is taken", async () => {
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const taken = (busy.address() as { port: number }).port;
    try {
      const port = await choosePort(taken);
      expect(port).not.toBe(taken);
      expect(port).toBeGreaterThan(0);
    } finally {
      busy.close();
    }
  });

  it("runs for one user, on this computer only, with SQLite and a local access token", () => {
    const config = desktopServerConfig({
      dataDir: "/data",
      port: 4781,
      masterKey: { id: "test", getKey: async () => Buffer.alloc(32) },
      localToken: "t".repeat(43),
      env: {},
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      publicUrl: "http://localhost:4781",
      previewDomain: "localhost",
      auth: "none",
      desktop: true,
      localToken: "t".repeat(43),
      databaseUrl: "sqlite:/data/lotse.db",
      sqliteDriver: "node",
    });
  });
});

describe("where links open", () => {
  const app = "http://localhost:4781";
  it("keeps the builder in the window and previews in app windows", () => {
    expect(navigation("http://localhost:4781/projects/abc", app)).toBe("allow");
    expect(navigation("http://p-abc123-0123456789abcdef.localhost:4781/", app)).toBe("window");
    // A preview address on another port is not this builder's.
    expect(navigation("http://p-abc123-0123456789abcdef.localhost:9999/", app)).toBe("browser");
  });

  it("sends provider sign-ins and documentation to the system browser", () => {
    expect(navigation("https://vercel.com/oauth/authorize?client_id=x", app)).toBe("browser");
    expect(navigation("http://localhost:5173/", app)).toBe("browser");
  });

  it("refuses everything else", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://server/share",
      "ms-settings:privacy",
      "not a url",
      "https://user:pass@example.com/",
    ]) {
      expect(navigation(url, app), url).toBe("deny");
    }
  });
});
