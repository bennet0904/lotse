import { useEffect, useRef } from "react";
import { type JobStream, post } from "../api";
import { type MessageKey, useT } from "../i18n";
import { Spinner } from "./common";

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

/** Progress and logs of a running job. The same events the CLI prints. */
export function JobActivity({ jobId, stream }: { jobId: string; stream: JobStream }) {
  const t = useT();
  const end = useRef<HTMLDivElement>(null);
  const count = stream.events.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new events arrive
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

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
        // In a deployment, "verify" is the health check of the new version.
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
    <section className="activity" aria-label={t("activity.title")}>
      {/* Screen readers hear new progress without the focus moving. */}
      <ol className="activity-list" aria-live="polite" aria-relevant="additions">
        {rows}
      </ol>
      <div ref={end} />
      {stream.running && (
        <div className="activity-foot">
          <Spinner label={t("activity.working")} />
          <button type="button" className="button-quiet" onClick={() => void post(`/jobs/${jobId}/cancel`)}>
            {t("activity.stop")}
          </button>
        </div>
      )}
      {stream.job?.status === "failed" && (
        <p className="note note-error" role="alert">
          {stream.job.error}
        </p>
      )}
    </section>
  );
}
