/**
 * The desktop app as a user starts it: Electron with the builder inside, its
 * data in a local SQLite database and the master key outside the database.
 * Needs a display (on Linux e.g. `xvfb-run -a`) and a built workspace
 * (`pnpm build`). LOTSE_DESKTOP_APP selects the bundled app folder instead,
 * LOTSE_DESKTOP_EXECUTABLE a packaged app (e.g. release/linux-unpacked/lotse).
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { decrypt, parseMasterKey } from "@lotse/secrets";

type Playwright = typeof import("playwright");
const root = fileURLToPath(new URL("../..", import.meta.url));
const appDir = process.env.LOTSE_DESKTOP_APP ?? join(root, "packages/desktop");
const require = createRequire(join(root, "packages/desktop/package.json"));
const playwright = (() => {
  try {
    return require("playwright") as Playwright;
  } catch {
    return undefined;
  }
})();
const electronBinary = (() => {
  try {
    return require("electron") as unknown as string;
  } catch {
    return undefined;
  }
})();
const packaged = process.env.LOTSE_DESKTOP_EXECUTABLE;
const built = packaged
  ? existsSync(packaged)
  : existsSync(join(appDir, "package.json")) && (existsSync(join(appDir, "dist/main.js")) || existsSync(join(appDir, "main.mjs")));
const display = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!playwright || !electronBinary || !built || !display)("desktop app", () => {
  let home = "";
  let dataDir = "";
  let port = 0;
  let app: import("playwright").ElectronApplication;
  let page: import("playwright").Page;

  const launch = async () => {
    // No language model keys: creating a project must not reach a paid API.
    const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, ...inherited } = process.env;
    app = await (playwright as Playwright)._electron.launch({
      executablePath: packaged ?? electronBinary,
      // Chromium's sandbox cannot start as root, nor on CI runners whose kernel forbids unprivileged user namespaces.
      args: [...(packaged ? [] : [appDir]), ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : [])],
      env: {
        ...(inherited as Record<string, string>),
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        LOTSE_DESKTOP_DATA_DIR: dataDir,
        LOTSE_DESKTOP_PORT: String(port),
        LOTSE_SANDBOX_PREFIX: "lotse-it-desktop",
      },
    });
    page = await app.firstWindow();
    await page.getByRole("heading", { name: "What do you want to build?" }).waitFor({ timeout: 60_000 });
  };
  const api = <T>(path: string, init?: { method?: string; body?: unknown }) =>
    page.evaluate(
      async ({ path, init }) => {
        const res = await fetch(`/api/v1${path}`, {
          method: init?.method ?? "GET",
          headers: init?.body === undefined ? { "x-requested-with": "lotse" } : { "x-requested-with": "lotse", "content-type": "application/json" },
          body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        });
        return { status: res.status, body: await res.json() };
      },
      { path, init },
    ) as Promise<{ status: number; body: T }>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "lotse-desktop-home-"));
    dataDir = join(home, "data");
    port = await freePort();
    await launch();
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  it("starts the builder and shows it in a window", async () => {
    expect(page.url()).toBe(`http://localhost:${port}/`);
    expect(await page.title()).toBe("Lotse");
    const me = await api<{ user: { id: string; role: string } }>("/me");
    expect(me.body.user).toMatchObject({ id: "local", role: "owner" });
    const config = await api<{ desktop: boolean; auth: string; telemetry: boolean }>("/config");
    expect(config.body).toMatchObject({ desktop: true, auth: "none", telemetry: false });
  });

  it("answers only to its own window", async () => {
    // Another program on this computer, or a web page in a browser, has no local access token.
    const outside = await fetch(`http://localhost:${port}/api/v1/me`);
    expect(outside.status).toBe(401);
    const forged = await fetch(`http://localhost:${port}/api/v1/me`, { headers: { cookie: "lotse_local=guess" } });
    expect(forged.status).toBe(401);
  });

  it("opens provider pages in the system browser and keeps the builder in its window", async () => {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await page.evaluate(() => {
      window.open("https://provider.example.test/oauth/authorize?state=x", "_blank", "noopener");
    });
    await page.evaluate(() => {
      location.href = "https://docs.example.test/guide";
    });
    await page.evaluate(() => {
      window.open("file:///etc/passwd");
    });
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(["https://provider.example.test/oauth/authorize?state=x", "https://docs.example.test/guide"]);
    expect(app.windows().length).toBe(1);
    expect(page.url()).toBe(`http://localhost:${port}/`);
  });

  it("keeps projects and encrypted secrets across restarts", async () => {
    const created = await api<{ project: { id: string } }>("/projects", { method: "POST", body: { prompt: "A guest book for a small café" } });
    expect(created.status).toBe(201);
    const id = created.body.project.id;
    expect((await api(`/projects/${id}/secrets/MAIL_PASSWORD`, { method: "PUT", body: { value: "very-secret-mail-password" } })).status).toBe(200);
    // With a keychain the key is stored sealed by it; without one (as on this test machine) in a protected file.
    const sealed = existsSync(join(dataDir, "master.key.enc"));
    const keyFile = join(dataDir, sealed ? "master.key.enc" : "master.key");
    const key = await readFile(keyFile);

    await app.close();
    await launch();
    const projects = await api<{ projects: { id: string; title: string }[] }>("/projects");
    expect(projects.body.projects.map((p) => p.title)).toEqual(["A guest book for a small café"]);
    expect((await api(`/projects/${id}/secrets/API_TOKEN`, { method: "PUT", body: { value: "second-secret-after-restart" } })).status).toBe(200);
    await app.close();

    // The database holds only ciphertext, and the same master key is used before and after the restart.
    const db = new DatabaseSync(join(dataDir, "lotse.db"), { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM secrets WHERE key LIKE 'project/%'").all() as { key: string; value: string }[];
    db.close();
    expect(rows.map((r) => r.key).sort()).toEqual([`project/${id}/env/API_TOKEN`, `project/${id}/env/MAIL_PASSWORD`]);
    expect(JSON.stringify(rows)).not.toMatch(/very-secret-mail-password|second-secret-after-restart/);
    expect((await readFile(keyFile)).equals(key)).toBe(true);
    if (!sealed) {
      const master = parseMasterKey(key.toString("utf8"));
      expect(rows.map((r) => decrypt(master, r.value, r.key)).sort()).toEqual(["second-secret-after-restart", "very-secret-mail-password"]);
    }
    await launch();
  });
});
