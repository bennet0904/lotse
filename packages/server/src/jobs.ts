/**
 * Long-running operations (generation, builds, deployments) run as jobs in a
 * queue. Progress and logs are stored and streamed to the UI over WebSocket
 * (specification section 6, persistence).
 */
import { errorMessage, isLotseError, LotseError, redact } from "@lotse/core";
import { newId } from "./auth.js";
import { asc, type Database, eq } from "./db/index.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  projectId: string | null;
  type: string;
  status: JobStatus;
  input: unknown;
  result: unknown;
  error: string | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  at: number;
  /** Event payload: `{ kind: "agent" | "deploy" | "log" | "status", … }`. */
  data: Record<string, unknown>;
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  /** Stores an event and sends it to everyone watching the job. */
  emit(data: Record<string, unknown>): void;
}

export type JobHandler = (input: never, ctx: JobContext) => Promise<unknown>;
type Listener = (event: JobEvent | { jobId: string; done: Job }) => void;

function toJob(row: {
  id: string;
  projectId: string | null;
  type: string;
  status: string;
  input: string;
  result: string | null;
  error: string | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}): Job {
  return { ...row, status: row.status as JobStatus, input: JSON.parse(row.input), result: row.result ? JSON.parse(row.result) : null };
}

export class JobQueue {
  readonly #handlers = new Map<string, JobHandler>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #running = new Map<string, AbortController>();
  readonly #queue: string[] = [];
  readonly #pendingWrites = new Set<Promise<unknown>>();
  #active = 0;
  #closed = false;

  constructor(
    readonly database: Database,
    readonly concurrency = 2,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.#handlers.set(type, handler);
  }

  /** Jobs that were running when the server stopped cannot be resumed; they are marked as failed. */
  async recover(): Promise<void> {
    const { db, schema } = this.database;
    for (const status of ["running", "queued"] as const) {
      await db
        .update(schema.jobs)
        .set({ status: "failed", error: "The server was restarted while this was running.", finishedAt: Date.now() })
        .where(eq(schema.jobs.status, status));
    }
  }

  async enqueue(type: string, input: unknown, meta: { projectId?: string; userId: string }): Promise<Job> {
    if (!this.#handlers.has(type)) throw new LotseError("INVALID_INPUT", `Unknown job type "${type}".`);
    const { db, schema } = this.database;
    const row = {
      id: newId("job_"),
      projectId: meta.projectId ?? null,
      type,
      status: "queued",
      input: JSON.stringify(input ?? {}),
      result: null,
      error: null,
      createdBy: meta.userId,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    await db.insert(schema.jobs).values(row);
    this.#queue.push(row.id);
    queueMicrotask(() => this.#drain());
    return toJob(row);
  }

  async get(id: string): Promise<Job | undefined> {
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    return rows[0] ? toJob(rows[0]) : undefined;
  }

  async listForProject(projectId: string, limit = 20): Promise<Job[]> {
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.projectId, projectId));
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(toJob);
  }

  async events(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    const { db, schema } = this.database;
    const rows = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.seq));
    return rows.filter((r) => r.seq > afterSeq).map((r) => ({ jobId: r.jobId, seq: r.seq, at: r.at, data: JSON.parse(r.data) }));
  }

  subscribe(jobId: string, listener: Listener): () => void {
    const set = this.#listeners.get(jobId) ?? new Set();
    set.add(listener);
    this.#listeners.set(jobId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(jobId);
    };
  }

  cancel(jobId: string): boolean {
    const controller = this.#running.get(jobId);
    if (controller) {
      controller.abort();
      return true;
    }
    const queued = this.#queue.indexOf(jobId);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      void this.#finish(jobId, "cancelled", null, null);
      return true;
    }
    return false;
  }

  /** Resolves when the job has finished, with its final state. */
  async wait(jobId: string, timeoutMs = 600_000): Promise<Job> {
    const current = await this.get(jobId);
    if (!current) throw new LotseError("NOT_FOUND", "There is no such job.");
    if (current.status !== "queued" && current.status !== "running") return current;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new LotseError("PROVIDER_ERROR", "Timed out waiting for the job."));
      }, timeoutMs);
      const unsubscribe = this.subscribe(jobId, (event) => {
        if ("done" in event) {
          clearTimeout(timer);
          unsubscribe();
          resolve(event.done);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#running.values()) controller.abort();
    const deadline = Date.now() + 10_000;
    while (this.#active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await Promise.allSettled([...this.#pendingWrites]);
  }

  #publish(jobId: string, event: JobEvent | { jobId: string; done: Job }): void {
    for (const listener of this.#listeners.get(jobId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not disturb the job.
      }
    }
  }

  async #finish(jobId: string, status: JobStatus, result: unknown, error: string | null): Promise<void> {
    const { db, schema } = this.database;
    await db
      .update(schema.jobs)
      .set({ status, result: result === undefined || result === null ? null : JSON.stringify(result), error, finishedAt: Date.now() })
      .where(eq(schema.jobs.id, jobId));
    const job = await this.get(jobId);
    if (job) this.#publish(jobId, { jobId, done: job });
  }

  #drain(): void {
    while (!this.#closed && this.#active < this.concurrency && this.#queue.length > 0) {
      const id = this.#queue.shift() as string;
      this.#active++;
      void this.#run(id).finally(() => {
        this.#active--;
        this.#drain();
      });
    }
  }

  async #run(jobId: string): Promise<void> {
    const { db, schema } = this.database;
    const job = await this.get(jobId);
    if (!job) return;
    const handler = this.#handlers.get(job.type) as JobHandler;
    const controller = new AbortController();
    this.#running.set(jobId, controller);
    await db.update(schema.jobs).set({ status: "running", startedAt: Date.now() }).where(eq(schema.jobs.id, jobId));
    let seq = 0;
    const emit = (data: Record<string, unknown>) => {
      const event: JobEvent = { jobId, seq: ++seq, at: Date.now(), data };
      this.#publish(jobId, event);
      const write = Promise.resolve(
        db.insert(schema.jobEvents).values({ id: `${jobId}_${event.seq}`, jobId, seq: event.seq, at: event.at, data: JSON.stringify(data) }),
      ).catch(() => {});
      this.#pendingWrites.add(write);
      void write.finally(() => this.#pendingWrites.delete(write));
    };
    try {
      const result = await handler(job.input as never, { job: { ...job, status: "running" }, signal: controller.signal, emit });
      await Promise.allSettled([...this.#pendingWrites]);
      await this.#finish(jobId, "succeeded", result, null);
    } catch (err) {
      const cancelled = controller.signal.aborted || (isLotseError(err) && err.code === "ABORTED");
      const message = redact(errorMessage(err));
      if (!cancelled) emit({ kind: "error", code: isLotseError(err) ? err.code : "INTERNAL", message, hints: isLotseError(err) ? err.hints : [] });
      await Promise.allSettled([...this.#pendingWrites]);
      await this.#finish(jobId, cancelled ? "cancelled" : "failed", null, cancelled ? "Stopped." : message);
    } finally {
      this.#running.delete(jobId);
    }
  }
}
