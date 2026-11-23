import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, get, type Plan, post, useLoad } from "../api";
import { useT } from "../i18n";
import { ErrorNote, Spinner } from "./common";

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
  const [changing, setChanging] = useState(false);
  const feedbackBox = useRef<HTMLTextAreaElement>(null);
  // Opening "Change the plan" moves the focus to where the change is written.
  useEffect(() => {
    if (changing) feedbackBox.current?.focus();
  }, [changing]);
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
      <header className="plan-head">
        <h3 id="plan-title">{t("plan.title")}</h3>
        <p className="hint">{t("plan.intro")}</p>
      </header>
      <p className="plan-summary">{draft.summary}</p>
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
        <section className="plan-section" aria-labelledby="plan-pages">
          <h4 id="plan-pages">{t("plan.pages")}</h4>
          <ul className="plan-list">
            {draft.pages.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong>
                <span>{p.purpose}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft.dataModel.length > 0 && (
        <section className="plan-section" aria-labelledby="plan-data">
          <h4 id="plan-data">{t("plan.data")}</h4>
          <ul className="plan-list">
            {draft.dataModel.map((e) => (
              <li key={e.entity}>
                <strong>{e.entity}</strong>
                <span className="plan-fields">
                  {e.fields.map((f) => (
                    <code key={f}>{f}</code>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft.resources.length > 0 && (
        <section className="plan-section" aria-labelledby="plan-needs">
          <h4 id="plan-needs">{t("plan.resources")}</h4>
          <ul className="plan-tags">
            {draft.resources.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}
      {draft.notes.length > 0 && (
        <ul className="plan-notes hint">
          {draft.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
      <div className="actions plan-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t("plan.approve")}
        </button>
        <button type="button" aria-expanded={changing} aria-controls="plan-change" onClick={() => setChanging(!changing)} disabled={busy}>
          {t("plan.change")}
        </button>
        {busy && <Spinner label={t("activity.working")} />}
      </div>
      {changing && (
        <div id="plan-change" className="plan-change">
          <label>
            {t("plan.feedback")}
            <textarea ref={feedbackBox} value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} placeholder={t("plan.feedbackPlaceholder")} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="button-primary"
              disabled={busy || !feedback.trim()}
              onClick={() => void run(`/projects/${projectId}/plan`, { feedback })}
            >
              {t("plan.revise")}
            </button>
            <button type="button" className="button-quiet" onClick={() => setChanging(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
