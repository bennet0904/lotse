/**
 * The builder server process: HTTP API, WebSocket stream of job events, the
 * preview proxy at a separate address per project, and the web UI.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, connect as netConnect } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { contentType } from "@lotseai/core";
import { type WebSocket, WebSocketServer } from "ws";
import type { ServerConfig } from "./config.js";
import { HostingService } from "./hosting.js";
import { createApi } from "./http.js";
import { ProjectService } from "./projects.js";
import { type ServiceOverrides, Services } from "./services.js";

export interface LotseServer {
  services: Services;
  projects: ProjectService;
  hosting: HostingService;
  http: Server;
  /** Starts listening and returns the address, e.g. http://127.0.0.1:4780 */
  listen(): Promise<string>;
  close(): Promise<void>;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const PREVIEW_PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta http-equiv="refresh" content="3"><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#334"><main style="text-align:center;max-width:32rem;padding:1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></main></body></html>`;

export async function createLotseServer(config: ServerConfig, overrides: ServiceOverrides = {}): Promise<LotseServer> {
  const services = await Services.create(config, overrides);
  const projects = new ProjectService(services);
  const hosting = new HostingService(services, projects);
  const api = getRequestListener(createApi(services, projects, hosting).fetch);
  const uiDir = config.uiDir ? resolve(config.uiDir) : undefined;

  /** `p-<project>-<token>.<previewDomain>` → project id, when the token is right. */
  async function previewProject(req: IncomingMessage): Promise<string | undefined> {
    const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
    const match = host.match(/^p-([a-z0-9]+)-([0-9a-f]{16})\.(.+)$/);
    if (!match || match[3] !== config.previewDomain.toLowerCase()) return undefined;
    return (await services.previewHost(match[1] as string)) === host ? (match[1] as string) : "";
  }

  async function servePreview(projectId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = projectId ? await projects.previewTarget(projectId).catch(() => undefined) : undefined;
    if (!target) {
      res.writeHead(projectId ? 503 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        projectId
          ? PREVIEW_PAGE("The preview is not running", "Open the project in Lotse to start it. This page reloads by itself.")
          : PREVIEW_PAGE("Unknown preview", "This preview address is not valid."),
      );
      return;
    }
    const url = new URL(target.url);
    const upstream = httpRequest(
      { host: url.hostname, port: url.port, method: req.method, path: req.url, headers: { ...req.headers, ...target.headers } },
      (up) => {
        if (up.statusCode === 502 && up.headers["x-lotse-preview"] === "unreachable") {
          up.resume();
          res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(PREVIEW_PAGE("The app is starting", "The preview appears as soon as the app answers. This page reloads by itself."));
          return;
        }
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("The preview is not reachable.\n");
    });
    req.pipe(upstream);
  }

  async function serveUi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!uiDir) {
      res.writeHead(404, { "content-type": "text/plain" }).end("The web UI is not installed on this server. The API is available under /api/v1.\n");
      return;
    }
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    let file = join(uiDir, path);
    if (!file.startsWith(uiDir + sep) && file !== uiDir) file = join(uiDir, "index.html");
    const info = await stat(file).catch(() => undefined);
    // Client-side routes fall back to the app shell.
    if (!info?.isFile()) file = join(uiDir, "index.html");
    const immutable = /[\\/]assets[\\/]/.test(file);
    res.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      ...(extname(file) === ".html"
        ? {
            "content-security-policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-src http: https:; frame-ancestors 'self'",
          }
        : {}),
    });
    createReadStream(file).pipe(res);
  }

  // Without sign-in nothing but the address protects the API. A foreign web page can point its own
  // domain at this computer (DNS rebinding), so requests under any other host name are refused.
  const ownHosts = new Set(["localhost", "127.0.0.1", "[::1]", new URL(config.publicUrl).hostname.toLowerCase(), ...config.allowedHosts]);
  const foreignHost = (req: IncomingMessage): boolean => {
    if (config.auth !== "none") return false;
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    return !ownHosts.has(host);
  };

  const http = createServer((req, res) => {
    void (async () => {
      const preview = await previewProject(req);
      if (preview !== undefined) return servePreview(preview, req, res);
      if (foreignHost(req)) {
        res.writeHead(421, { "content-type": "text/plain" }).end(`This builder is reached at ${config.publicUrl}.\n`);
        return;
      }
      if (req.url?.startsWith("/api/")) return api(req, res);
      return serveUi(req, res);
    })().catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error\n");
    });
  });

  // --- WebSocket: progress and logs of jobs ----------------------------------
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const unsubscribe = new Map<string, () => void>();
    const send = (message: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
    socket.on("message", (raw) => {
      void (async () => {
        const message = JSON.parse(String(raw)) as { type?: string; jobId?: string; after?: number };
        if (message.type !== "subscribe" || !message.jobId || unsubscribe.has(message.jobId)) return;
        const user = await services.auth.authenticate((name) => cookie(req, name));
        const job = await services.jobs.get(message.jobId);
        if (!user || !job) return send({ type: "error", jobId: message.jobId, message: "There is no such job." });
        if (job.projectId) await services.project(user, job.projectId);
        // Live events first, so that nothing is lost between the replay and the subscription.
        let last = message.after ?? 0;
        const buffered: { seq: number }[] = [];
        let replaying = true;
        unsubscribe.set(
          job.id,
          services.jobs.subscribe(job.id, (event) => {
            if ("done" in event) return send({ type: "done", job: event.done });
            if (replaying) return void buffered.push(event);
            if (event.seq > last) send({ type: "event", ...event });
          }),
        );
        for (const event of await services.jobs.events(job.id, last)) {
          send({ type: "event", ...event });
          last = event.seq;
        }
        replaying = false;
        for (const event of buffered) if (event.seq > last) send({ type: "event", ...event });
        const current = await services.jobs.get(job.id);
        if (current && current.status !== "queued" && current.status !== "running") send({ type: "done", job: current });
      })().catch((err) => send({ type: "error", message: String((err as Error).message) }));
    });
    socket.on("close", () => {
      for (const stop of unsubscribe.values()) stop();
    });
  });

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const preview = await previewProject(req);
      if (preview !== undefined) {
        // WebSocket connections of the previewed app (hot reloading) are passed through.
        const target = preview ? await projects.previewTarget(preview).catch(() => undefined) : undefined;
        if (!target) return socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        const url = new URL(target.url);
        const upstream = netConnect(Number(url.port), url.hostname, () => {
          const headers = { ...req.headers, ...target.headers };
          upstream.write(
            `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
              .join("\r\n")}\r\n\r\n`,
          );
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        return;
      }
      if (new URL(req.url ?? "/", "http://x").pathname !== "/api/v1/ws") return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      if (foreignHost(req)) return socket.end("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      const user = await services.auth.authenticate((name) => cookie(req, name));
      if (!user) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      // Browsers send the Origin header; a page on another site must not open this socket.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    })().catch(() => socket.destroy());
  });

  return {
    services,
    projects,
    hosting,
    http,
    listen: () =>
      new Promise((resolveListen, reject) => {
        http.once("error", reject);
        http.listen(config.port, config.host, () => {
          services.sandboxes.startIdleTimer();
          const address = http.address() as AddressInfo;
          resolveListen(`http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${address.port}`);
        });
      }),
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((done) => {
        http.close(() => done());
        http.closeAllConnections();
      });
      await services.close();
    },
  };
}
