/**
 * Projects: from a prompt through plan, scaffold, implementation and
 * self-correction to a versioned project with a live preview
 * (specification section 12.1).
 */
import { createHash } from "node:crypto";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AppPlan, type CheckResult, createPlan, describePlan, HostWorkspace, planSchema, runGeneration, UsageTracker } from "@lotseai/agent";
import { errorMessage, GitWorkspace, isLotseError, LotseError, type RepoRecord } from "@lotseai/core";
import { chownTree, type Sandbox } from "@lotseai/sandbox";
import { type StackTemplate, scaffoldFiles } from "@lotseai/stacks";
import { newId, type User } from "./auth.js";
import { asc, eq } from "./db/index.js";
import type { JobContext } from "./jobs.js";
import type { ProjectRow, Services } from "./services.js";

export interface ProjectView {
  id: string;
  name: string;
  title: string;
  stack: string | null;
  status: string;
  prompt: string;
  plan: AppPlan | null;
  models: { planModel?: string; implementModel?: string };
  target: { adapter: string; accountId: string } | null;
  git: { provider: string; accountId: string; repo: RepoRecord } | null;
  previewUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageView {
  id: string;
  role: string;
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

const parse = <T>(text: string | null, fallback: T): T => (text ? (JSON.parse(text) as T) : fallback);

export class ProjectService {
  readonly #locks = new Map<string, Promise<unknown>>();

  /** Installing, checking and starting the app happen one at a time per project. */
  #exclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(projectId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.#locks.set(projectId, tail);
    void tail.then(() => {
      if (this.#locks.get(projectId) === tail) this.#locks.delete(projectId);
    });
    return next;
  }

  constructor(readonly services: Services) {
    services.jobs.register("plan", (input, ctx) => this.#planJob(input, ctx));
    services.jobs.register("generate", (input, ctx) => this.#generateJob(input, ctx));
  }

  async view(project: ProjectRow): Promise<ProjectView> {
    return {
      id: project.id,
      name: project.name,
      title: project.title,
      stack: project.stack,
      status: project.status,
      prompt: project.prompt,
      plan: parse<AppPlan | null>(project.plan, null),
      models: parse(project.models, {}),
      target: parse(project.target, null),
      git: parse(project.git, null),
      previewUrl: await this.services.previewUrl(project.id),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  async list(user: User): Promise<ProjectView[]> {
    const { db, schema } = this.services.database;
    const rows =
      user.role === "member" ? await db.select().from(schema.projects).where(eq(schema.projects.ownerId, user.id)) : await db.select().from(schema.projects);
    return Promise.all(rows.sort((a, b) => b.updatedAt - a.updatedAt).map((p) => this.view(p)));
  }

  async addMessage(projectId: string, role: "user" | "assistant" | "system", content: string, meta?: Record<string, unknown>): Promise<MessageView> {
    const { db, schema } = this.services.database;
    const row = { id: newId("msg_"), projectId, role, content, meta: meta ? JSON.stringify(meta) : null, createdAt: Date.now() };
    await db.insert(schema.messages).values(row);
    return { ...row, meta: meta ?? null };
  }

  async messages(user: User, projectId: string): Promise<MessageView[]> {
    await this.services.project(user, projectId);
    const { db, schema } = this.services.database;
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.projectId, projectId)).orderBy(asc(schema.messages.createdAt));
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, meta: parse(r.meta, null), createdAt: r.createdAt }));
  }

  /**
   * Someone pushed to a repository that projects are linked to. The builder
   * does not merge on its own: it tells the user, who pulls before the next
   * change. Pushes of the builder itself are recognized by their commit.
   */
  async outsidePush(push: { repository: string; branch: string; sha: string; pusher: string }): Promise<string[]> {
    const { db, schema } = this.services.database;
    const notified: string[] = [];
    for (const project of await db.select().from(schema.projects)) {
      const link = parse<ProjectView["git"]>(project.git, null);
      if (link?.provider !== "github") continue;
      if (`${link.repo.owner}/${link.repo.name}`.toLowerCase() !== push.repository.toLowerCase() || link.repo.defaultBranch !== push.branch) continue;
      if ((await new GitWorkspace(this.services.projectDir(project.id)).head().catch(() => undefined)) === push.sha) continue;
      await this.addMessage(
        project.id,
        "system",
        `${push.pusher} pushed new commits to ${push.repository} (${push.branch}). Sync the project to bring them in before the next change.`,
        {
          kind: "git-push",
          sha: push.sha,
        },
      );
      notified.push(project.id);
    }
    return notified;
  }

  /** Step 1: the prompt becomes a plan. */
  async create(user: User, input: { prompt: string; planModel?: string; implementModel?: string }): Promise<{ project: ProjectView; jobId: string }> {
    const prompt = input.prompt?.trim();
    if (!prompt) throw new LotseError("INVALID_INPUT", "Describe the app you want to build.");
    const { db, schema } = this.services.database;
    const id = `p${newId("")}`.slice(0, 13);
    const now = Date.now();
    const row: ProjectRow = {
      id,
      ownerId: user.id,
      name: "new-app",
      title: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
      stack: null,
      status: "planning",
      prompt,
      plan: null,
      models: JSON.stringify({ planModel: input.planModel, implementModel: input.implementModel }),
      target: null,
      git: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(schema.projects).values(row);
    await this.addMessage(id, "user", prompt);
    const job = await this.services.jobs.enqueue("plan", {}, { projectId: id, userId: user.id });
    return { project: await this.view(row), jobId: job.id };
  }

  /** The user adjusts the plan before implementation starts. */
  async revisePlan(user: User, projectId: string, feedback: string): Promise<{ jobId: string }> {
    const project = await this.services.project(user, projectId);
    if (!project.plan) throw new LotseError("CONFLICT", "There is no plan to revise yet.");
    if (project.stack && project.status !== "planned")
      throw new LotseError("CONFLICT", "The plan was already implemented. Describe further changes in the chat instead.");
    if (!feedback?.trim()) throw new LotseError("INVALID_INPUT", "Say what should change in the plan.");
    await this.addMessage(projectId, "user", feedback.trim(), { kind: "plan-feedback" });
    await this.services.updateProject(projectId, { status: "planning" });
    const job = await this.services.jobs.enqueue("plan", { feedback: feedback.trim() }, { projectId, userId: user.id });
    return { jobId: job.id };
  }

  /** Step 2 and following: the approved plan is scaffolded and implemented. */
  async approvePlan(user: User, projectId: string, edited?: unknown): Promise<{ jobId: string }> {
    const project = await this.services.project(user, projectId);
    if (project.status !== "planned") throw new LotseError("CONFLICT", project.plan ? "The plan was already approved." : "The plan is not ready yet.");
    const plan = planSchema.parse(edited ?? parse(project.plan, null));
    const stack = this.services.stacks.get(plan.stack);
    await this.services.updateProject(projectId, { plan: JSON.stringify(plan), name: plan.name, title: plan.title, stack: stack.id, status: "generating" });
    const job = await this.services.jobs.enqueue("generate", { first: true }, { projectId, userId: user.id });
    return { jobId: job.id };
  }

  /** Keep iterating: a further prompt changes the existing app. */
  async sendMessage(user: User, projectId: string, text: string): Promise<{ jobId: string }> {
    const project = await this.services.project(user, projectId);
    if (!project.stack || project.status === "planned" || project.status === "planning") throw new LotseError("CONFLICT", "Approve the plan first.");
    if (project.status === "generating") throw new LotseError("CONFLICT", "The app is being changed right now. Wait for it to finish or stop it.");
    if (!text?.trim()) throw new LotseError("INVALID_INPUT", "Say what should change.");
    await this.addMessage(projectId, "user", text.trim());
    await this.services.updateProject(projectId, { status: "generating" });
    const job = await this.services.jobs.enqueue("generate", { prompt: text.trim() }, { projectId, userId: user.id });
    return { jobId: job.id };
  }

  async #recordUsage(projectId: string, usage: UsageTracker): Promise<void> {
    const { db, schema } = this.services.database;
    for (const u of usage.byModel()) {
      const id = `${projectId}|${u.model}`;
      const existing = (await db.select().from(schema.usage).where(eq(schema.usage.id, id)))[0];
      const micros = u.cost === undefined ? null : Math.round(u.cost * 1_000_000);
      if (existing) {
        await db
          .update(schema.usage)
          .set({
            calls: existing.calls + u.calls,
            inputTokens: existing.inputTokens + u.inputTokens,
            outputTokens: existing.outputTokens + u.outputTokens,
            costMicros: existing.costMicros === null || micros === null ? null : existing.costMicros + micros,
          })
          .where(eq(schema.usage.id, id));
      } else {
        await db
          .insert(schema.usage)
          .values({ id, projectId, model: u.model, calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costMicros: micros });
      }
    }
  }

  /** Token usage and estimated cost per project (specification section 12.2). */
  async usage(
    user: User,
    projectId: string,
  ): Promise<{ models: { model: string; calls: number; inputTokens: number; outputTokens: number; cost: number | null }[]; totalCost: number | null }> {
    await this.services.project(user, projectId);
    const { db, schema } = this.services.database;
    const rows = await db.select().from(schema.usage).where(eq(schema.usage.projectId, projectId));
    const models = rows.map((r) => ({
      model: r.model,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cost: r.costMicros === null ? null : r.costMicros / 1_000_000,
    }));
    return { models, totalCost: models.every((m) => m.cost !== null) ? models.reduce((s, m) => s + (m.cost ?? 0), 0) : null };
  }

  async #planJob(input: { feedback?: string }, ctx: JobContext): Promise<unknown> {
    const { services } = this;
    const projectId = ctx.job.projectId as string;
    const { db, schema } = services.database;
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0] as ProjectRow;
    const usage = new UsageTracker();
    try {
      const models = parse<{ planModel?: string }>(project.models, {});
      const model = await services.resolveModel(models.planModel ?? (await services.models.planModel()));
      ctx.emit({ kind: "status", message: input.feedback ? "Revising the plan" : "Planning the app" });
      const plan = await createPlan({
        prompt: project.prompt,
        stacks: services.stacks.list().map((s) => ({ id: s.id, name: s.name, description: s.description, beta: s.beta })),
        model,
        usage,
        previous: input.feedback && project.plan ? { plan: JSON.parse(project.plan) as AppPlan, feedback: input.feedback } : undefined,
        signal: ctx.signal,
      });
      await services.updateProject(projectId, { plan: JSON.stringify(plan), name: plan.name, title: plan.title, status: "planned" });
      await this.addMessage(projectId, "assistant", describePlan(plan), { kind: "plan", plan });
      return { plan };
    } catch (err) {
      await services.updateProject(projectId, { status: project.plan ? "planned" : "failed" });
      await this.addMessage(projectId, "assistant", `Planning did not work: ${errorMessage(err)}`, { kind: "error" });
      throw err;
    } finally {
      await this.#recordUsage(projectId, usage);
    }
  }

  // --- sandbox -------------------------------------------------------------

  #stackOf(project: ProjectRow): StackTemplate {
    if (!project.stack) throw new LotseError("CONFLICT", "The project has no stack yet. Approve the plan first.");
    return this.services.stacks.get(project.stack);
  }

  /** Hands a file written by the server to the sandbox user, when the server runs as root. */
  async #own(path: string): Promise<void> {
    if (process.getuid?.() !== 0) return;
    const { uid, gid } = this.services.sandboxes.user;
    await chown(path, uid, gid).catch(() => {});
  }

  async #installHash(project: ProjectRow, stack: StackTemplate): Promise<string> {
    const hash = createHash("sha256");
    for (const file of stack.sandbox.installTriggers ?? [])
      hash.update(await readFile(join(this.services.projectDir(project.id), file)).catch(() => Buffer.alloc(0)));
    return hash.digest("hex");
  }

  /** Starts the project's sandbox if it is not running, with dependencies installed. */
  async ensureSandbox(project: ProjectRow, onLog?: (line: string) => void): Promise<Sandbox> {
    const { services } = this;
    const stack = this.#stackOf(project);
    let sandbox = await services.sandboxes.get(project.id);
    if (!sandbox) {
      onLog?.("Starting the sandbox");
      const cacheDir = services.cacheDir(project.id);
      for (const [path, content] of Object.entries(stack.sandbox.helperFiles ?? {})) {
        await mkdir(dirname(join(cacheDir, path)), { recursive: true });
        await writeFile(join(cacheDir, path), content);
      }
      sandbox = await services.sandboxes.start({
        projectId: project.id,
        workdir: services.projectDir(project.id),
        cacheDir,
        image: stack.sandbox.image,
        env: { PORT: String(stack.sandbox.port), LOTSE_PREVIEW_HOST: `*.${services.config.previewDomain}` },
      });
    }
    return sandbox;
  }

  /** Installs dependencies when the dependency files changed since the last install. */
  async #install(project: ProjectRow, sandbox: Sandbox, onLog?: (line: string) => void, signal?: AbortSignal): Promise<CheckResult> {
    const stack = this.#stackOf(project);
    if (!stack.sandbox.install) return { ok: true, output: "" };
    const marker = join(this.services.cacheDir(project.id), "lotse", "install.hash");
    const wanted = await this.#installHash(project, stack);
    if ((await readFile(marker, "utf8").catch(() => "")) === wanted) return { ok: true, output: "" };
    onLog?.(`$ ${stack.sandbox.install}`);
    const result = await sandbox.exec(stack.sandbox.install, { timeoutMs: 600_000, signal, onOutput: (line) => onLog?.(line) });
    if (result.code !== 0) return { ok: false, output: `Installing dependencies failed (exit code ${result.code}):\n${result.output}` };
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, wanted);
    return { ok: true, output: "" };
  }

  async #startDev(project: ProjectRow, sandbox: Sandbox, restart: boolean): Promise<boolean> {
    const stack = this.#stackOf(project);
    if (restart || !(await sandbox.processRunning("dev"))) await sandbox.startProcess("dev", stack.sandbox.dev, { PORT: String(stack.sandbox.port) });
    return sandbox.waitForPort(stack.sandbox.port, 90_000);
  }

  /**
   * Builds and runs the project: install, the stack's check, start the app and
   * request its start page. Errors go back to the model (self-correction).
   */
  verify(project: ProjectRow, onLog?: (line: string) => void, signal?: AbortSignal): Promise<CheckResult> {
    return this.#exclusive(project.id, () => this.#verify(project, onLog, signal));
  }

  async #verify(project: ProjectRow, onLog?: (line: string) => void, signal?: AbortSignal): Promise<CheckResult> {
    const stack = this.#stackOf(project);
    const sandbox = await this.ensureSandbox(project, onLog);
    const installed = await this.#install(project, sandbox, onLog, signal);
    if (!installed.ok) return installed;
    if (stack.sandbox.check) {
      onLog?.(`$ ${stack.sandbox.check}`);
      const check = await sandbox.exec(stack.sandbox.check, { timeoutMs: 300_000, signal, onOutput: (line) => onLog?.(line) });
      if (check.code !== 0) return { ok: false, output: `\`${stack.sandbox.check}\` failed (exit code ${check.code}):\n${check.output}` };
    }
    const listening = await this.#startDev(project, sandbox, !stack.sandbox.hotReload);
    if (!listening) return { ok: false, output: `The app did not start listening on port ${stack.sandbox.port}.\n${await sandbox.processLogs("dev", 60)}` };
    const target = sandbox.previewTarget(stack.sandbox.port);
    const res = await fetch(`${target.url}/`, { headers: target.headers, redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch((err) => ({
      status: 599,
      text: async () => String(err),
    }));
    if (res.status >= 500) {
      return {
        ok: false,
        output: `Requesting the start page failed with HTTP ${res.status}.\n${(await res.text()).slice(0, 2000)}\n\nServer output:\n${await sandbox.processLogs("dev", 60)}`,
      };
    }
    return { ok: true, output: "" };
  }

  /** Starts the live preview and returns its address. Idle sandboxes resume on access. */
  async startPreview(user: User, projectId: string): Promise<{ url: string; ready: boolean }> {
    const project = await this.services.project(user, projectId);
    const ready = await this.#exclusive(projectId, async () => {
      const sandbox = await this.ensureSandbox(project);
      const installed = await this.#install(project, sandbox);
      return installed.ok && (await this.#startDev(project, sandbox, false));
    });
    return { url: await this.services.previewUrl(projectId), ready };
  }

  /** Where the preview proxy sends a request for this project, or undefined when no sandbox is running. */
  async previewTarget(projectId: string): Promise<{ url: string; headers: Record<string, string> } | undefined> {
    const { db, schema } = this.services.database;
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0];
    if (!project?.stack) return undefined;
    const sandbox = await this.services.sandboxes.get(projectId);
    if (!sandbox) return undefined;
    await sandbox.resume();
    this.services.sandboxes.touch(projectId);
    return sandbox.previewTarget(this.services.stacks.get(project.stack).sandbox.port);
  }

  // --- generation ----------------------------------------------------------

  async #generateJob(input: { first?: boolean; prompt?: string }, ctx: JobContext): Promise<unknown> {
    const { services } = this;
    const projectId = ctx.job.projectId as string;
    const { db, schema } = services.database;
    const project = (await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)))[0] as ProjectRow;
    const stack = this.#stackOf(project);
    const dir = services.projectDir(projectId);
    const git = new GitWorkspace(dir);
    const log = (line: string) => ctx.emit({ kind: "log", line });
    const usage = new UsageTracker();
    const plan = parse<AppPlan | null>(project.plan, null);

    try {
      await mkdir(dir, { recursive: true });
      const sandbox = await this.ensureSandbox(project, log);

      if (input.first) {
        // Step 2: the stack template produces a runnable base project including the manifest.
        ctx.emit({ kind: "status", message: `Creating the base project (${stack.name})` });
        if (stack.bootstrap) {
          log(`$ ${stack.bootstrap}`);
          const boot = await sandbox.exec(stack.bootstrap, { timeoutMs: 900_000, signal: ctx.signal, onOutput: log });
          if (boot.code !== 0) throw new LotseError("BUILD_FAILED", `Creating the base project failed:\n${boot.output.slice(-2000)}`);
        }
        await scaffoldFiles(stack, dir, { name: project.name, title: project.title });
        if (process.getuid?.() === 0) await chownTree(dir, services.sandboxes.user.uid, services.sandboxes.user.gid);
        await git.init();
        await git.commitAll(`Scaffold ${stack.name} project`);
      } else {
        // Changes made outside are pulled before the next generation; conflicts stop it.
        await this.#pullIfLinked(project, log);
      }

      const history = input.first ? [] : (await this.#history(projectId)).slice(0, -1);
      const model = await services.resolveModel(
        parse<{ implementModel?: string }>(project.models, {}).implementModel ?? (await services.models.defaultModel()),
      );
      const result = await runGeneration({
        prompt: input.first ? project.prompt : (input.prompt as string),
        plan: input.first ? (plan ?? undefined) : undefined,
        stack: { name: stack.name, guidance: stack.guidance },
        workspace: new HostWorkspace({
          root: dir,
          run: (command, options) => sandbox.exec(command, { timeoutMs: options?.timeoutMs ?? 120_000, signal: options?.signal }),
          logs: (tail) => sandbox.processLogs("dev", tail),
          afterWrite: (path) => this.#own(path),
        }),
        model,
        usage,
        history,
        maxCorrections: services.config.maxCorrections,
        verify: () => this.verify(project, log, ctx.signal),
        // Step 5: every completed change is saved as a commit.
        commit: (message) => git.commitAll(message),
        secrets: await this.#secretValues(projectId),
        signal: ctx.signal,
        onEvent: (event) => ctx.emit({ kind: "agent", event }),
      });

      await this.addMessage(projectId, "assistant", result.summary || "Done.", {
        kind: "result",
        changedFiles: result.changedFiles,
        proposals: result.proposals,
        verified: result.verified,
        corrections: result.corrections,
        commit: result.commit,
        stopped: result.stopped,
      });
      await services.updateProject(projectId, { status: "ready" });
      const pushed = result.commit ? await this.#pushIfLinked(project, log) : false;
      return { ...result, pushed };
    } catch (err) {
      const cancelled = ctx.signal.aborted || (isLotseError(err) && err.code === "ABORTED");
      await services.updateProject(projectId, { status: input.first && !(await git.head()) ? "failed" : "ready" });
      const detail =
        isLotseError(err) && err.code === "GIT_CONFLICT"
          ? `${err.message}\n${((err.details.files as string[] | undefined) ?? []).map((f) => `- ${f}`).join("\n")}`
          : errorMessage(err);
      await this.addMessage(projectId, "assistant", cancelled ? "Stopped." : `That did not work: ${detail}`, { kind: cancelled ? "stopped" : "error" });
      throw err;
    } finally {
      await this.#recordUsage(projectId, usage);
    }
  }

  async #history(projectId: string): Promise<{ role: "user" | "assistant"; text: string }[]> {
    const { db, schema } = this.services.database;
    const rows = await db.select().from(schema.messages).where(eq(schema.messages.projectId, projectId)).orderBy(asc(schema.messages.createdAt));
    return rows
      .filter(
        (r) =>
          (r.role === "user" || r.role === "assistant") &&
          !["plan", "plan-feedback", "error", "stopped"].includes(parse<{ kind?: string }>(r.meta, {}).kind ?? ""),
      )
      .slice(-12)
      .map((r) => ({ role: r.role as "user" | "assistant", text: r.content }));
  }

  /** Secret values of the project, so that they can be scrubbed from anything the model sees. */
  async #secretValues(projectId: string): Promise<string[]> {
    const vault = this.services.projectVault(projectId);
    const values: string[] = [];
    for (const key of await vault.list()) {
      const raw = await vault.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { value?: string };
        values.push(typeof parsed?.value === "string" ? parsed.value : raw);
      } catch {
        values.push(raw);
      }
    }
    return values;
  }

  // --- git -----------------------------------------------------------------

  async #remote(project: ProjectRow) {
    const link = parse<ProjectView["git"]>(project.git, null);
    if (!link) return undefined;
    const provider = this.services.registry.git(link.provider);
    const conn = await this.services.connections.fresh(link.accountId, provider.oauth);
    return { link, auth: await provider.remoteUrl({ ...link.repo, connection: conn }, conn) };
  }

  async #pullIfLinked(project: ProjectRow, log: (line: string) => void): Promise<void> {
    const remote = await this.#remote(project);
    if (!remote) return;
    const result = await new GitWorkspace(this.services.projectDir(project.id)).pull(remote.auth, remote.link.repo.defaultBranch);
    if (result.updated)
      log(`Merged changes from ${remote.link.repo.owner}/${remote.link.repo.name}${result.files.length ? `: ${result.files.join(", ")}` : ""}`);
  }

  async #pushIfLinked(project: ProjectRow, log: (line: string) => void): Promise<boolean> {
    const remote = await this.#remote(project);
    if (!remote) return false;
    await new GitWorkspace(this.services.projectDir(project.id)).push(remote.auth, remote.link.repo.defaultBranch);
    log(`Pushed to ${remote.link.repo.owner}/${remote.link.repo.name}`);
    return true;
  }

  /** Syncs with the linked repository: pull outside changes, then push. Conflicts are reported with their files. */
  async sync(user: User, projectId: string): Promise<{ pulled: string[]; pushed: boolean }> {
    const project = await this.services.project(user, projectId);
    const remote = await this.#remote(project);
    if (!remote) throw new LotseError("CONFLICT", "The project is not linked to a repository.");
    const git = new GitWorkspace(this.services.projectDir(projectId));
    const pulled = await git.pull(remote.auth, remote.link.repo.defaultBranch);
    await git.push(remote.auth, remote.link.repo.defaultBranch);
    return { pulled: pulled.files, pushed: true };
  }

  // --- files and versions --------------------------------------------------

  async files(user: User, projectId: string): Promise<string[]> {
    await this.services.project(user, projectId);
    const dir = this.services.projectDir(projectId);
    if (!(await stat(dir).catch(() => undefined))) return [];
    return new HostWorkspace({ root: dir, run: async () => ({ code: 1, output: "" }) }).listFiles();
  }

  async file(user: User, projectId: string, path: string): Promise<{ path: string; content: string; truncated: boolean }> {
    await this.services.project(user, projectId);
    const content = await new HostWorkspace({ root: this.services.projectDir(projectId), run: async () => ({ code: 1, output: "" }) }).readFile(path);
    return { path, content: content.slice(0, 400_000), truncated: content.length > 400_000 };
  }

  async commits(user: User, projectId: string) {
    await this.services.project(user, projectId);
    return new GitWorkspace(this.services.projectDir(projectId)).log(100);
  }

  /** Returns the project to an earlier state. History is kept: restoring adds a commit. */
  async restore(user: User, projectId: string, sha: string): Promise<{ commit?: string }> {
    const project = await this.services.project(user, projectId);
    if (project.status === "generating") throw new LotseError("CONFLICT", "The app is being changed right now.");
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new LotseError("INVALID_INPUT", "Not a version id.");
    const commit = await new GitWorkspace(this.services.projectDir(projectId)).restore(sha);
    if (process.getuid?.() === 0)
      await chownTree(this.services.projectDir(projectId), this.services.sandboxes.user.uid, this.services.sandboxes.user.gid).catch(() => {});
    await this.addMessage(projectId, "system", `Restored version ${sha.slice(0, 8)}.`, { kind: "restore", commit });
    const sandbox = await this.services.sandboxes.get(projectId);
    if (sandbox && !this.#stackOf(project).sandbox.hotReload) await this.#startDev(project, sandbox, true);
    return { commit };
  }

  /** Removes the project and its sandbox. A deployed app is not touched; that is a separate, explicit action. */
  async remove(user: User, projectId: string): Promise<void> {
    await this.services.project(user, projectId);
    const { db, schema } = this.services.database;
    await this.services.sandboxes.remove(projectId).catch(() => {});
    await rm(join(this.services.config.dataDir, "projects", projectId), { recursive: true, force: true });
    await db.delete(schema.messages).where(eq(schema.messages.projectId, projectId));
    await db.delete(schema.usage).where(eq(schema.usage.projectId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    const vault = this.services.projectVault(projectId);
    for (const key of await vault.list()) await vault.delete(key);
  }
}
