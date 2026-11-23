import { useEffect, useRef, useState } from "react";
import { type ApiError, type JobStream, post } from "../api";
import { type MessageKey, useT } from "../i18n";
import { ErrorNote, Spinner } from "./common";

interface AgentEvent {
  type: string;
  phase?: string;
  text?: string;
  message?: string;
  activity?: { tool: string; summary: string; ok: boolean };
  ok?: boolean;
  output?: string;
  attempt?: number;
  proposal?: { action: string; summary: string };
}

interface DeployEvent {
  type: "status" | "progress" | "log" | "error";
  phase: string;
  state?: string;
  message?: string;
  line?: string;
  stream?: string;
  current?: number;
  total?: number;
  code?: string;
}

const PHASES: Record<string, MessageKey> = {
  implement: "activity.implement",
  verify: "activity.verify",
  correct: "activity.correct",
  commit: "activity.commit",
  build: "activity.build",
  provision: "activity.provision",
  deploy: "activity.deploy",
  rollback: "activity.rollback",
  finish: "activity.finish",
};

type StepState = "running" | "done" | "failed" | "stopped";
interface Step {
  key: number;
  phase: string;
  label: string;
  state: StepState;
  /** The latest thing that happened in this step, e.g. a file being written. */
  now?: string;
}

/**
 * Turns the event stream into steps: each phase starts a step, and the next phase
 * finishes the one before. Deployments report the end of a step themselves.
 */
function toSteps(events: JobStream["events"], job: JobStream["job"], t: ReturnType<typeof useT>): Step[] {
  const steps: Step[] = [];
  const current = () => steps.findLast((s) => s.state === "running");
  const start = (key: number, phase: string, label: string) => {
    const open = current();
    if (open) open.state = "done";
    steps.push({ key, phase, label, state: "running" });
  };
  for (const e of events) {
    if (e.data.kind === "status") start(e.seq, "status", String(e.data.message));
    else if (e.data.kind === "log") {
      const open = current();
      if (open) open.now = String(e.data.line);
    } else if (e.data.kind === "agent") {
      const a = e.data.event as AgentEvent;
      if (a.type === "phase" && a.phase && a.phase !== "done") start(e.seq, a.phase, t(PHASES[a.phase] ?? "activity.working"));
      else if (a.type === "tool" && a.activity) {
        const open = current();
        if (open) open.now = a.activity.summary;
      } else if (a.type === "check" && !a.ok) {
        const open = current();
        if (open) open.state = "failed";
      }
    } else if (e.data.kind === "deploy") {
      const d = e.data.event as DeployEvent;
      if (d.type === "status") {
        // In a deployment, "verify" is the health check of the new version.
        const label = t(d.phase === "verify" ? "activity.health" : (PHASES[d.phase] ?? "activity.working"));
        if (d.state === "started") start(e.seq, d.phase, label);
        else if (d.state === "succeeded" || d.state === "failed") {
          const step = steps.findLast((s) => s.phase === d.phase && s.state === "running");
          if (step) step.state = d.state === "succeeded" ? "done" : "failed";
          else steps.push({ key: e.seq, phase: d.phase, label, state: d.state === "succeeded" ? "done" : "failed" });
        }
      } else if (d.type === "progress" || d.type === "log") {
        const open = current();
        if (open) open.now = d.type === "log" ? d.line : `${d.total ? `${d.current}/${d.total} ` : ""}${d.message ?? ""}`;
      }
    }
  }
  // When the job has ended, nothing is running any more.
  if (job)
    for (const s of steps)
      if (s.state === "running") {
        s.state = job.status === "succeeded" ? "done" : job.status === "cancelled" ? "stopped" : "failed";
        s.now = undefined;
      }
  for (const s of steps) if (s.state !== "running") s.now = undefined;
  return steps;
}

const STEP_STATE: Record<StepState, MessageKey> = {
  running: "activity.stateRunning",
  done: "activity.stateDone",
  failed: "activity.stateFailed",
  stopped: "activity.stateStopped",
};

/**
 * Progress of a job: the steps with their state, what happens right now, and the
 * full log under "Details" (the same events the CLI prints).
 * `runningHint` explains what stopping means, `failedHint` what to do after a failure.
 * `showError: false` leaves the error message to the caller, e.g. when the
 * conversation already shows it.
 */
export function JobActivity({
  jobId,
  stream,
  runningHint,
  failedHint,
  showError = true,
}: {
  jobId: string;
  stream: JobStream;
  runningHint?: string;
  failedHint?: string;
  showError?: boolean;
}) {
  const t = useT();
  const end = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<ApiError>();
  const count = stream.events.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new events arrive
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new job can be stopped again
  useEffect(() => {
    setStopping(false);
    setStopError(undefined);
  }, [jobId]);

  const steps = toSteps(stream.events, stream.job, t);
  const failed = stream.job?.status === "failed";
  // The hints of the error event say what the user can do about it.
  const hints = stream.events.flatMap((e) => (e.data.kind === "error" && Array.isArray(e.data.hints) ? (e.data.hints as string[]) : []));

  const stop = async () => {
    setStopping(true);
    setStopError(undefined);
    try {
      await post(`/jobs/${jobId}/cancel`);
    } catch (err) {
      setStopping(false);
      setStopError(err as ApiError);
    }
  };

  const rows = stream.events.map((e) => {
    const key = e.seq;
    if (e.data.kind === "status")
      return (
        <li key={key} className="act act-phase">
          {String(e.data.message)}
        </li>
      );
    if (e.data.kind === "log")
      return (
        <li key={key} className="act act-log">
          {String(e.data.line)}
        </li>
      );
    if (e.data.kind === "error")
      return (
        <li key={key} className="act act-error">
          {String(e.data.message)}
        </li>
      );
    if (e.data.kind === "agent") {
      const a = e.data.event as AgentEvent;
      if (a.type === "phase" && a.phase && a.phase !== "done")
        return (
          <li key={key} className="act act-phase">
            {t(PHASES[a.phase] ?? "activity.working")}
            {a.message ? ` · ${a.message}` : ""}
          </li>
        );
      if (a.type === "text")
        return (
          <li key={key} className="act act-text">
            {a.text}
          </li>
        );
      if (a.type === "tool" && a.activity)
        return (
          <li key={key} className={`act act-tool${a.activity.ok ? "" : " act-failed"}`}>
            <span aria-hidden="true">{a.activity.ok ? "✓" : "✗"}</span> {a.activity.summary}
          </li>
        );
      if (a.type === "check") {
        return (
          <li key={key} className={`act ${a.ok ? "act-ok" : "act-failed"}`}>
            {a.ok ? t("activity.checkOk") : t("activity.checkFailed")}
            {!a.ok && a.output && (
              <details>
                <summary>{t("activity.details")}</summary>
                <pre>{a.output}</pre>
              </details>
            )}
          </li>
        );
      }
      if (a.type === "proposal" && a.proposal)
        return (
          <li key={key} className="act act-proposal">
            {t("activity.proposal")}: {a.proposal.summary}
          </li>
        );
      return null;
    }
    if (e.data.kind === "deploy") {
      const d = e.data.event as DeployEvent;
      if (d.type === "status") {
        const label = t(d.phase === "verify" ? "activity.health" : (PHASES[d.phase] ?? "activity.working"));
        if (d.state === "started")
          return (
            <li key={key} className="act act-phase">
              {label}
              {d.message ? ` · ${d.message}` : ""}
            </li>
          );
        if (d.state === "succeeded")
          return (
            <li key={key} className="act act-ok">
              <span aria-hidden="true">✓</span> {label}
              {d.message ? ` · ${d.message}` : ""}
            </li>
          );
        if (d.state === "failed")
          return (
            <li key={key} className="act act-failed">
              <span aria-hidden="true">✗</span> {label}
              {d.message ? ` · ${d.message}` : ""}
            </li>
          );
        return (
          <li key={key} className="act act-log">
            {label}: {d.message}
          </li>
        );
      }
      if (d.type === "progress")
        return (
          <li key={key} className="act act-log">
            {d.total ? `${d.current}/${d.total} ` : ""}
            {d.message}
          </li>
        );
      if (d.type === "log")
        return (
          <li key={key} className="act act-log">
            {d.line}
          </li>
        );
      if (d.type === "error")
        return (
          <li key={key} className="act act-error">
            {d.message}
          </li>
        );
    }
    return null;
  });

  return (
    <section className="activity" aria-labelledby={`activity-${jobId}`}>
      <header className="activity-head">
        <h3 id={`activity-${jobId}`}>{t("activity.title")}</h3>
        {stream.running && (
          <button type="button" className="button-danger" onClick={() => void stop()} disabled={stopping}>
            {stopping ? t("activity.stopping") : t("activity.stop")}
          </button>
        )}
      </header>
      {steps.length > 0 && (
        // Screen readers hear new steps without the focus moving; the detailed log stays quiet.
        <ol className="activity-steps" aria-live="polite" aria-relevant="additions">
          {steps.map((s) => (
            <li key={s.key} className={`activity-step activity-step-${s.state}`}>
              <span className="activity-step-mark" aria-hidden="true">
                {s.state === "running" ? <span className="spinner-dot" /> : s.state === "done" ? "✓" : s.state === "stopped" ? "–" : "✗"}
              </span>
              <span className="activity-step-text">
                <span>
                  {s.label}
                  <span className="sr-only"> · {t(STEP_STATE[s.state])}</span>
                </span>
                {s.now && <span className="activity-now">{s.now}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {stream.running && steps.length === 0 && <Spinner label={t("activity.working")} />}
      {stream.running && runningHint && <p className="hint">{runningHint}</p>}
      <ErrorNote error={stopError} />
      {count > 0 && (
        <details className="activity-log" open={steps.length === 0}>
          <summary className="activity-log-summary">{t("activity.log")}</summary>
          <ol className="activity-list">{rows}</ol>
          <div ref={end} />
        </details>
      )}
      {failed && (showError || failedHint || hints.length > 0) && (
        <div className="note note-error" role="alert">
          {showError && stream.job?.error && <p>{stream.job.error}</p>}
          {hints.length > 0 && (
            <ul>
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
          {failedHint && <p>{failedHint}</p>}
        </div>
      )}
    </section>
  );
}
