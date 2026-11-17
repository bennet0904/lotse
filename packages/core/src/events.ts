import type { DeployEvent, DeploymentRef, DeployPhase, ErrorEvent, LogEvent, ProgressEvent, StatusEvent } from "./types.js";

/** Constructors for `DeployEvent`s. Adapters and the engine share them. */
export const event = {
  status(phase: DeployPhase, state: StatusEvent["state"], message?: string, deployment?: DeploymentRef): StatusEvent {
    return { type: "status", phase, state, message, deployment, at: Date.now() };
  },
  progress(phase: DeployPhase, current: number, total?: number, message?: string): ProgressEvent {
    return { type: "progress", phase, current, total, message, at: Date.now() };
  },
  log(phase: DeployPhase, line: string, stream: LogEvent["stream"] = "system"): LogEvent {
    return { type: "log", phase, stream, line, at: Date.now() };
  },
  error(phase: DeployPhase, code: string, message: string): ErrorEvent {
    return { type: "error", phase, code, message, at: Date.now() };
  },
};

/**
 * Strips the connection from deployment references so that events can be
 * serialized, stored and streamed to clients without leaking credentials.
 */
export function serializeEvent(e: DeployEvent): Record<string, unknown> {
  if (e.type === "status" && e.deployment) {
    const { app, ...rest } = e.deployment;
    return { ...e, deployment: { ...rest, app: { adapter: app.adapter, name: app.name, id: app.id } } };
  }
  return { ...e };
}

/** One-line rendering used by the CLI and by plain-text logs. */
export function formatEvent(e: DeployEvent): string {
  switch (e.type) {
    case "status": {
      const mark = e.state === "succeeded" ? "ok" : e.state === "failed" ? "FAILED" : e.state;
      return `[${e.phase}] ${mark}${e.message ? ` - ${e.message}` : ""}`;
    }
    case "progress": {
      const of = e.total ? `${e.current}/${e.total}` : String(e.current);
      return `[${e.phase}] ${of}${e.message ? ` ${e.message}` : ""}`;
    }
    case "log":
      return `[${e.phase}] ${e.line}`;
    case "error":
      return `[${e.phase}] error ${e.code}: ${e.message}`;
  }
}

/** Collects every event of a run; convenient in tests and for the CLI's JSON output. */
export async function collectEvents<T>(iterable: AsyncGenerator<DeployEvent, T, void>): Promise<{ events: DeployEvent[]; result: T }> {
  const events: DeployEvent[] = [];
  for (;;) {
    const next = await iterable.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}
