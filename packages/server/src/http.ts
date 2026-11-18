/** The builder's HTTP API. The web UI and the desktop app are two front ends for it. */
import { ADAPTER_API_VERSION, errorMessage, isLotseError, LotseError, type LotseErrorCode, redact } from "@lotseai/core";
import { detectRuntimes } from "@lotseai/sandbox";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ZodError } from "zod";
import { type Role, requireRole, SESSION_COOKIE, type User } from "./auth.js";
import type { HostingService } from "./hosting.js";
import type { ProjectService } from "./projects.js";
import type { Services } from "./services.js";

export const SERVER_VERSION = "0.1.1";

const STATUS: Partial<Record<LotseErrorCode, number>> = {
  NOT_FOUND: 404,
  ADAPTER_NOT_FOUND: 404,
  MANIFEST_NOT_FOUND: 404,
  AUTH_FAILED: 401,
  AUTH_EXPIRED: 401,
  PERMISSION_MISSING: 403,
  APPROVAL_REQUIRED: 409,
  CONFLICT: 409,
  GIT_CONFLICT: 409,
  INVALID_INPUT: 400,
  MANIFEST_INVALID: 400,
  UNSUPPORTED: 400,
  RUNTIME_UNSUPPORTED: 400,
  LANGUAGE_UNSUPPORTED: 400,
  RESOURCE_UNSUPPORTED: 400,
  DOMAINS_UNSUPPORTED: 400,
  ROLLBACK_UNSUPPORTED: 400,
};

type Env = { Variables: { user: User } };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const RETURN_PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#223"><main style="text-align:center;max-width:32rem;padding:1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;

export function createApi(services: Services, projects: ProjectService, hosting: HostingService): Hono<Env> {
  const app = new Hono<Env>().basePath("/api/v1");
  const { auth, config, jobs } = services;
  const secure = config.publicUrl.startsWith("https://");
  const ip = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const body = async <T>(c: Context): Promise<T> => (await c.req.json().catch(() => ({}))) as T;

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: { code: "INVALID_INPUT", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), hints: [] } }, 400);
    }
    if (isLotseError(err)) {
      const status = STATUS[err.code] ?? 502;
      return c.json(
        {
          error: {
            code: err.code,
            message: redact(err.message),
            hints: err.hints,
            details: err.code === "APPROVAL_REQUIRED" || err.code === "GIT_CONFLICT" ? err.details : undefined,
          },
        },
        status as 400,
      );
    }
    console.error(err);
    return c.json({ error: { code: "INTERNAL", message: redact(errorMessage(err)), hints: [] } }, 500);
  });

  // --- public ----------------------------------------------------------------
  app.get("/health", (c) => c.json({ status: "ok", version: SERVER_VERSION }));
  app.get("/config", async (c) =>
    c.json({
      version: SERVER_VERSION,
      adapterApi: ADAPTER_API_VERSION,
      auth: config.auth,
      desktop: config.desktop === true,
      // No telemetry is collected. This flag exists so that the UI can say so.
      telemetry: false,
      models: { plan: config.planModel ?? null, implement: (await services.models.defaultModel()) ?? null },
      sandbox: { cpus: config.sandbox.cpus, memoryMb: config.sandbox.memoryMb, isolation: config.sandbox.runtime ?? "default" },
    }),
  );

  app.get("/auth/login", async (c) => {
    if (config.auth !== "oidc") return c.redirect("/");
    return c.redirect(await auth.beginLogin(c.req.query("returnTo") ?? "/"));
  });
  app.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) throw new LotseError("AUTH_FAILED", c.req.query("error_description") ?? "The identity provider did not complete the sign-in.");
    const result = await auth.completeLogin(code, state, ip(c));
    setCookie(c, SESSION_COOKIE, result.token, { httpOnly: true, secure, sameSite: "Lax", path: "/", expires: new Date(result.expiresAt) });
    return c.redirect(result.returnTo);
  });
  app.post("/auth/logout", async (c) => {
    await auth.destroySession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // GitHub reports pushes to repositories the instance's GitHub App can see. Signed with the app's webhook secret.
  app.post("/git/github/webhook", async (c) => {
    const push = services.githubApp.verifyWebhook(await c.req.text(), c.req.header("x-hub-signature-256"), c.req.header("x-github-event"));
    const notified = push ? await projects.outsidePush(push) : [];
    return c.json({ ok: true, notified: notified.length }, push ? 200 : 202);
  });

  // The provider sends the user back here. In the desktop app that happens in the system browser,
  // which has no local cookie; the unguessable `state` ties the request to the sign-in attempt.
  app.get("/oauth/callback", async (c) => {
    const done = (params: Record<string, string>, text: string) =>
      config.desktop
        ? c.html(RETURN_PAGE(params.error ? "The sign-in did not work" : "You are signed in", text), params.error ? 400 : 200)
        : c.redirect(`/accounts?${new URLSearchParams(params)}`);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      const reason = c.req.query("error_description") ?? c.req.query("error") ?? "The provider did not complete the sign-in.";
      return done({ error: reason }, reason);
    }
    try {
      const user = config.auth === "none" ? await auth.localUser() : await auth.userForSession(getCookie(c, SESSION_COOKIE));
      if (!user) throw new LotseError("AUTH_FAILED", "Please sign in.");
      const account = await hosting.completeOAuth(user, code, state, ip(c));
      return done({ connected: account.id }, `${account.label} is connected. You can close this tab and return to Lotse.`);
    } catch (err) {
      const reason = redact(errorMessage(err));
      return done({ error: reason }, reason);
    }
  });

  // --- everything below needs a signed-in user -------------------------------
  app.use("*", async (c, next) => {
    const user = await auth.authenticate((name) => getCookie(c, name));
    if (!user) throw new LotseError("AUTH_FAILED", config.auth === "none" ? "This builder only answers to its own app." : "Please sign in.");
    // Requests that change something must come from the app itself, not from another site.
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-requested-with") !== "lotse") {
      throw new LotseError("PERMISSION_MISSING", "Missing request header x-requested-with: lotse.");
    }
    c.set("user", user);
    await next();
  });
  const me = (c: Context<Env>) => c.get("user");
  const admin = (role: Role) => async (c: Context<Env>, next: () => Promise<void>) => {
    requireRole(me(c), role);
    await next();
  };

  app.get("/me", (c) => c.json({ user: me(c) }));
  app.get("/users", admin("admin"), async (c) => c.json({ users: await auth.listUsers() }));
  app.patch("/users/:id", async (c) => {
    await auth.setRole(me(c), c.req.param("id"), (await body<{ role: Role }>(c)).role);
    return c.json({ ok: true });
  });
  app.get("/settings/models", async (c) => c.json(await services.models.view(me(c))));
  app.put("/settings/models", async (c) => c.json(await services.models.update(me(c), await body(c), ip(c))));
  app.get("/audit", async (c) => c.json({ entries: await auth.auditLog(me(c), Number(c.req.query("limit") ?? 200)) }));
  app.get("/runtime", async (c) => c.json(await detectRuntimes(config.env)));

  // --- providers and accounts --------------------------------------------------
  app.get("/adapters", (c) => c.json(hosting.adapters()));
  // The instance's GitHub App, registered through GitHub's manifest flow by an administrator.
  app.get("/git/github/app", (c) => c.json(services.githubApp.status()));
  app.post("/git/github/app/manifest", async (c) => c.json(services.githubApp.begin(me(c), await body<{ organization?: string; name?: string }>(c))));
  app.get("/git/github/app/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.redirect("/settings?error=GitHub%20did%20not%20complete%20the%20registration.");
    try {
      await services.githubApp.complete(me(c), code, state, ip(c));
      return c.redirect("/settings?github=registered");
    } catch (err) {
      return c.redirect(`/settings?error=${encodeURIComponent(redact(errorMessage(err)))}`);
    }
  });
  app.get("/stacks", (c) =>
    c.json({
      stacks: services.stacks
        .list()
        .map((s) => ({ id: s.id, name: s.name, language: s.language, runtime: s.runtime, description: s.description, beta: s.beta })),
    }),
  );
  app.get("/accounts", async (c) => c.json({ accounts: await hosting.listAccounts(me(c)) }));
  app.post("/accounts", async (c) => c.json(await hosting.connect(me(c), await body(c), ip(c)), 201));
  app.post("/accounts/ssh-key", async (c) => c.json(await hosting.createSshKey(me(c), (await body<{ host?: string }>(c)).host ?? "")));
  app.post("/accounts/oauth", async (c) => c.json(await hosting.beginOAuth(me(c), await body(c))));
  app.post("/accounts/:id/verify", async (c) => c.json(await hosting.verifyAccount(me(c), c.req.param("id"))));
  app.delete("/accounts/:id", async (c) => {
    await hosting.removeAccount(me(c), c.req.param("id"), ip(c));
    return c.json({ ok: true });
  });
  app.get("/accounts/:id/setup", async (c) => c.json(await hosting.setupPlan(me(c), c.req.param("id"))));
  app.post("/accounts/:id/setup", async (c) =>
    c.json(await hosting.startSetup(me(c), c.req.param("id"), (await body<{ approved?: boolean }>(c)).approved === true), 202),
  );
  app.get("/accounts/:id/repos", async (c) => c.json({ repos: await hosting.repos(me(c), c.req.param("id"), c.req.query("q")) }));

  // --- projects ----------------------------------------------------------------
  app.get("/projects", async (c) => c.json({ projects: await projects.list(me(c)) }));
  app.post("/projects", async (c) => c.json(await projects.create(me(c), await body(c)), 201));
  app.get("/projects/:id", async (c) => {
    const project = await services.project(me(c), c.req.param("id"));
    return c.json({ project: await projects.view(project), jobs: await jobs.listForProject(project.id, 5) });
  });
  app.delete("/projects/:id", async (c) => {
    await projects.remove(me(c), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/projects/:id/messages", async (c) => c.json({ messages: await projects.messages(me(c), c.req.param("id")) }));
  app.post("/projects/:id/messages", async (c) => c.json(await projects.sendMessage(me(c), c.req.param("id"), (await body<{ text: string }>(c)).text), 202));
  app.post("/projects/:id/plan", async (c) => c.json(await projects.revisePlan(me(c), c.req.param("id"), (await body<{ feedback: string }>(c)).feedback), 202));
  app.post("/projects/:id/plan/approve", async (c) =>
    c.json(await projects.approvePlan(me(c), c.req.param("id"), (await body<{ plan?: unknown }>(c)).plan), 202),
  );
  app.get("/projects/:id/files", async (c) => c.json({ files: await projects.files(me(c), c.req.param("id")) }));
  app.get("/projects/:id/file", async (c) => c.json(await projects.file(me(c), c.req.param("id"), c.req.query("path") ?? "")));
  app.get("/projects/:id/commits", async (c) => c.json({ commits: await projects.commits(me(c), c.req.param("id")) }));
  app.post("/projects/:id/restore", async (c) => c.json(await projects.restore(me(c), c.req.param("id"), (await body<{ sha: string }>(c)).sha)));
  app.get("/projects/:id/usage", async (c) => c.json(await projects.usage(me(c), c.req.param("id"))));
  app.post("/projects/:id/preview", async (c) => c.json(await projects.startPreview(me(c), c.req.param("id"))));

  // --- publishing ----------------------------------------------------------------
  app.get("/projects/:id/deploy/plan", async (c) => c.json(await hosting.deployPlan(me(c), c.req.param("id"), c.req.query("account"))));
  app.post("/projects/:id/deploy", async (c) => c.json(await hosting.deploy(me(c), c.req.param("id"), await body(c), ip(c)), 202));
  app.get("/projects/:id/deployments", async (c) => c.json({ deployments: await hosting.deployments(me(c), c.req.param("id")) }));
  app.post("/projects/:id/rollback", async (c) => c.json(await hosting.rollback(me(c), c.req.param("id"), (await body<{ to?: string }>(c)).to, ip(c)), 202));
  app.get("/projects/:id/status", async (c) => c.json(await hosting.status(me(c), c.req.param("id"))));
  app.get("/projects/:id/logs", async (c) => c.json({ lines: await hosting.logs(me(c), c.req.param("id"), Number(c.req.query("tail") ?? 200)) }));
  app.post("/projects/:id/domains", async (c) => {
    const input = await body<{ domain: string; approved?: boolean }>(c);
    return c.json(await hosting.addDomain(me(c), c.req.param("id"), input.domain ?? "", input.approved === true, ip(c)));
  });
  app.delete("/projects/:id/app", async (c) => {
    await hosting.destroyApp(me(c), c.req.param("id"), await body(c), ip(c));
    return c.json({ ok: true });
  });
  app.get("/projects/:id/secrets", async (c) => c.json({ secrets: await hosting.listSecrets(me(c), c.req.param("id")) }));
  app.put("/projects/:id/secrets/:name", async (c) => {
    await hosting.setSecret(me(c), c.req.param("id"), c.req.param("name"), (await body<{ value: string }>(c)).value, ip(c));
    return c.json({ ok: true });
  });
  app.get("/projects/:id/backups", async (c) => c.json(await hosting.backupResources(me(c), c.req.param("id"))));
  app.get("/projects/:id/backups/:resource", async (c) => c.json({ backups: await hosting.listBackups(me(c), c.req.param("id"), c.req.param("resource")) }));
  app.post("/projects/:id/backups/:resource", async (c) => c.json(await hosting.createBackup(me(c), c.req.param("id"), c.req.param("resource")), 201));
  app.post("/projects/:id/backups/:resource/restore", async (c) => {
    const input = await body<{ backup: string; approved?: boolean }>(c);
    await hosting.restoreBackup(me(c), c.req.param("id"), c.req.param("resource"), input.backup, input.approved === true, ip(c));
    return c.json({ ok: true });
  });

  // --- git ------------------------------------------------------------------------
  app.post("/projects/:id/git", async (c) => c.json(await hosting.linkRepo(me(c), c.req.param("id"), await body(c))));
  app.post("/projects/:id/git/sync", async (c) => c.json(await projects.sync(me(c), c.req.param("id"))));
  app.post("/projects/:id/git/ci", async (c) =>
    c.json(await hosting.setupCi(me(c), c.req.param("id"), (await body<{ previews?: boolean }>(c)).previews === true)),
  );

  // --- jobs -----------------------------------------------------------------------
  const job = async (c: Context<Env>) => {
    const found = await jobs.get(c.req.param("id") as string);
    if (!found) throw new LotseError("NOT_FOUND", "There is no such job.");
    // Jobs are visible to whoever may see their project (or started them).
    if (found.projectId) await services.project(me(c), found.projectId);
    else if (found.createdBy !== me(c).id && me(c).role === "member") throw new LotseError("NOT_FOUND", "There is no such job.");
    return found;
  };
  app.get("/jobs/:id", async (c) => {
    const found = await job(c);
    return c.json({ job: found, events: await jobs.events(found.id, Number(c.req.query("after") ?? 0)) });
  });
  app.post("/jobs/:id/cancel", async (c) => c.json({ cancelled: jobs.cancel((await job(c)).id) }));

  app.all("*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Unknown API endpoint.", hints: [] } }, 404));
  return app;
}
