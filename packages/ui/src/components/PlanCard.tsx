import { type FormEvent, useState } from "react";
import { type ApiError, get, type Plan, post, useLoad } from "../api";
import { useT } from "../i18n";
import { ErrorNote } from "./common";

interface Stack {
  id: string;
  name: string;
  language: string;
  description: string;
  beta: boolean;
}

/** Step 1 of a generation: the user reviews and adjusts the plan before anything is built. */
export function PlanCard({ projectId, plan, onStarted }: { projectId: string; plan: Plan; onStarted: (jobId: string) => void }) {
  const t = useT();
  const stacks = useLoad(() => get<{ stacks: Stack[] }>("/stacks"), []);
  const [draft, setDraft] = useState(plan);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const chosen = stacks.data?.stacks.find((s) => s.id === draft.stack);

  const run = async (path: string, body: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      onStarted((await post<{ jobId: string }>(path, body)).jobId);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const approve = (e: FormEvent) => {
    e.preventDefault();
    void run(`/projects/${projectId}/plan/approve`, { plan: draft });
  };

  return (
    <form className="card plan" onSubmit={approve} aria-labelledby="plan-title">
      <h3 id="plan-title">{t("plan.title")}</h3>
      <p>{draft.summary}</p>
      <div className="field-row">
        <label>
          {t("plan.appTitle")}
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={80} />
        </label>
        <label>
          {t("plan.stack")}
          <select value={draft.stack} onChange={(e) => setDraft({ ...draft, stack: e.target.value })}>
            {(stacks.data?.stacks ?? [{ id: draft.stack, name: draft.stack, beta: false, language: "", description: "" }]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.beta ? ` (${t("plan.beta")})` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {chosen && (
        <p className="hint">
          {chosen.description}
          {chosen.beta ? ` ${t("plan.betaHint")}` : ""}
        </p>
      )}
      {draft.pages.length > 0 && (
        <>
          <h4>{t("plan.pages")}</h4>
          <ul>
            {draft.pages.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>: {p.purpose}
              </li>
            ))}
          </ul>
        </>
      )}
      {draft.dataModel.length > 0 && (
        <>
          <h4>{t("plan.data")}</h4>
          <ul>
            {draft.dataModel.map((e) => (
              <li key={e.entity}>
                <strong>{e.entity}</strong>: {e.fields.join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {draft.resources.length > 0 && (
        <p>
          {t("plan.resources")}: {draft.resources.join(", ")}
        </p>
      )}
      {draft.notes.length > 0 && (
        <ul className="hint">
          {draft.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
      <div className="actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t("plan.approve")}
        </button>
      </div>
      <details>
        <summary>{t("plan.change")}</summary>
        <label>
          {t("plan.feedback")}
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} />
        </label>
        <button type="button" disabled={busy || !feedback.trim()} onClick={() => void run(`/projects/${projectId}/plan`, { feedback })}>
          {t("plan.revise")}
        </button>
      </details>
    </form>
  );
}
