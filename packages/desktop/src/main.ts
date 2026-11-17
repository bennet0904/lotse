/**
 * The desktop app (specification sections 5 and 12.5): starts the builder
 * locally with SQLite and without sign-in, keeps the master key in the
 * operating system's keychain, and shows the user interface in a window.
 * Projects, accounts and the database stay on this computer.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isLotseError } from "@lotseai/core";
import { createLotseServer, LOCAL_COOKIE, type LotseServer } from "@lotseai/server";
import { app, BrowserWindow, dialog, safeStorage, session, shell, type WebContents } from "electron";
import { chooseMasterKey, choosePort, desktopServerConfig, navigation } from "./shell.js";

const env = process.env;
let server: LotseServer | undefined;
let window: BrowserWindow | undefined;
let appUrl = "";

const secureWebPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } as const;

/** The built user interface: inside the app when bundled, in the workspace during development. */
function uiDirectory(): string | undefined {
  const candidates = [env.LOTSE_UI_DIR, join(app.getAppPath(), "ui"), fileURLToPath(new URL("../../ui/dist", import.meta.url))];
  return candidates.find((dir): dir is string => Boolean(dir && existsSync(join(dir, "index.html"))));
}

/** Every page in the app follows the same rules for links, new windows and permissions. */
function guard(contents: WebContents): void {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const leave = (event: { preventDefault(): void }, url: string) => {
    const decision = navigation(url, appUrl);
    if (decision === "allow" || (decision === "window" && contents !== window?.webContents)) return;
    event.preventDefault();
    if (decision === "browser") void shell.openExternal(url);
  };
  contents.on("will-navigate", leave);
  contents.on("will-redirect", leave);
  contents.setWindowOpenHandler(({ url }) => {
    const decision = navigation(url, appUrl);
    if (decision === "allow" || decision === "window") {
      return { action: "allow", overrideBrowserWindowOptions: { width: 1100, height: 800, autoHideMenuBar: true, webPreferences: secureWebPreferences } };
    }
    // Provider sign-ins happen in the system browser, where the user's password manager and existing sessions are.
    if (decision === "browser") void shell.openExternal(url);
    return { action: "deny" };
  });
}

function openWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: "Lotse",
    show: false,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences,
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });
  void window.loadURL(appUrl);
}

/** Tells the user once that the master key is not protected by a keychain. */
async function warnOnce(dataDir: string, warning: string): Promise<void> {
  const marker = join(dataDir, ".keychain-warning-shown");
  if (existsSync(marker)) return;
  await writeFile(marker, `${new Date().toISOString()}\n`);
  await dialog.showMessageBox({ type: "warning", title: "Lotse", message: "Credentials are not protected by a keychain", detail: warning, buttons: ["OK"] });
}

async function start(): Promise<void> {
  const dataDir = env.LOTSE_DESKTOP_DATA_DIR ?? join(app.getPath("userData"), "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const key = chooseMasterKey(safeStorage, dataDir);
  const localToken = randomBytes(32).toString("base64url");
  const port = await choosePort(Number(env.LOTSE_DESKTOP_PORT ?? 4781));
  const config = desktopServerConfig({ dataDir, port, masterKey: key.provider, uiDir: uiDirectory(), localToken, env });
  server = await createLotseServer(config);
  await server.listen();
  appUrl = config.publicUrl;

  // The window carries the local access token; other programs and web pages do not have it.
  await session.defaultSession.cookies.set({ url: appUrl, name: LOCAL_COOKIE, value: localToken, httpOnly: true, sameSite: "strict" });
  // The builder needs no camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  openWindow();
  if (key.warning) void warnOnce(dataDir, key.warning);
}

if (!app.requestSingleInstanceLock()) {
  // A second start brings the running app to the front instead.
  app.quit();
} else {
  app.setAppUserModelId("dev.lotse.desktop");
  app.on("second-instance", () => {
    if (!window) return openWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("web-contents-created", (_event, contents) => guard(contents));
  app.on("activate", () => {
    if (!window && server) openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let stopping = false;
  app.on("before-quit", (event) => {
    if (!server || stopping) return;
    stopping = true;
    event.preventDefault();
    void server.close().finally(() => app.exit(0));
  });

  app
    .whenReady()
    .then(start)
    .catch((err) => {
      const hints = isLotseError(err) ? err.hints : [];
      dialog.showErrorBox("Lotse could not start", [errorMessage(err), ...hints].join("\n\n"));
      app.exit(1);
    });
}
