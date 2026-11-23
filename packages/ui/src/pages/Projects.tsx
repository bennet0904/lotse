import { type FormEvent, useState } from "react";
import { type ApiError, get, type Project, post, useLoad } from "../api";
import { ErrorNote, Spinner, StatusBadge, timeAgo } from "../components/common";
import { type MessageKey, useI18n } from "../i18n";
import { Link, navigate } from "../router";

interface Runtime {
  ready: boolean;
  installed: string[];
  guidance: { state: "missing" | "stopped"; title: string; steps: string[]; links: { id: string; label: string; url: string }[] };
}

const RUNTIME_NAMES: Record<string, string> = {
  "docker-desktop": "Docker Desktop",
  "docker-engine": "Docker Engine",
  podman: "Podman",
  orbstack: "OrbStack",
  colima: "Colima",
};
const RUNTIME_LINKS: Record<string, MessageKey> = {
  podman: "runtime.link.podman",
  orbstack: "runtime.link.orbstack",
  "docker-engine": "runtime.link.dockerEngine",
  "docker-desktop": "runtime.link.dockerDesktop",
};

/** What to do when no container runtime is running, in the user's language. */
function runtimeGuidance(runtime: Runtime, t: (key: MessageKey, params?: Record<string, string>) => string): { title: string; steps: string[] } {
  if (runtime.guidance.state === "missing")
    return { title: t("runtime.missing.title"), steps: [t("runtime.missing.step1"), t("runtime.missing.step2"), t("runtime.missing.step3")] };
  const names = runtime.installed.map((r) => RUNTIME_NAMES[r] ?? r).join(", ");
  return {
    title: t("runtime.stopped.title", { runtimes: names }),
    steps: runtime.installed.includes("podman") ? [t("runtime.stopped.podman1"), t("runtime.stopped.podman2")] : [t("runtime.stopped.other")],
  };
}

const STATUS: Record<Project["status"], MessageKey> = {
  planning: "status.planning",
  planned: "status.planned",
  generating: "status.generating",
  ready: "status.ready",
  failed: "status.failed",
};

/** Rows that need a look stand out: failed apps, and apps the model is working on. */
const ATTENTION: Partial<Record<Project["status"], string>> = {
  failed: "app-row-failed",
  planning: "app-row-busy",
  generating: "app-row-busy",
};

export function Projects() {
  const { t, locale } = useI18n();
  const projects = useLoad(() => get<{ projects: Project[] }>("/projects"), []);
  const runtime = useLoad(() => get<Runtime>("/runtime"), []);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await post<{ project: Project }>("/projects", { prompt, planModel: model || undefined, implementModel: model || undefined });
      navigate(`/projects/${created.project.id}`);
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  };

  const guidance = runtime.data && !runtime.data.ready ? runtimeGuidance(runtime.data, t) : undefined;
  const list = projects.data?.projects;

  return (
    <div className="page start">
      {guidance && runtime.data && (
        <div className="note note-warn runtime-note" role="status">
          <p>
            <strong>{guidance.title}</strong>
          </p>
          <details>
            <summary>{t("runtime.howTo")}</summary>
            <ol>
              {guidance.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p>
              {runtime.data.guidance.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="inline-link">
                  {RUNTIME_LINKS[l.id] ? t(RUNTIME_LINKS[l.id] as MessageKey) : l.label}
                </a>
              ))}
            </p>
          </details>
        </div>
      )}

      <section className="start-hero" aria-labelledby="start-heading">
        <h1 id="start-heading">{t("projects.heading")}</h1>
        <form className="card prompt" onSubmit={create}>
          <label htmlFor="prompt">{t("projects.promptLabel")}</label>
          <textarea id="prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("projects.promptPlaceholder")} required />
          <ErrorNote error={error} />
          <div className="prompt-foot">
            <details className="prompt-options">
              <summary>{t("projects.options")}</summary>
              <label>
                {t("projects.model")}
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic:claude-opus-5-5" autoComplete="off" spellCheck={false} />
                <span className="hint">{t("projects.modelHint")}</span>
              </label>
            </details>
            <button type="submit" className="button-primary" disabled={busy || !prompt.trim()}>
              {t("projects.create")}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="apps-heading">
        <h2 id="apps-heading">{t("projects.yours")}</h2>
        <ErrorNote error={projects.error} />
        {!list && !projects.error && <Spinner label={t("common.loading")} />}
        {list?.length === 0 && (
          <div className="empty">
            <h3>{t("projects.empty.title")}</h3>
            <p className="hint">{t("projects.empty.text")}</p>
          </div>
        )}
        {list && list.length > 0 && (
          <ul className="app-list">
            {list.map((p) => (
              <li key={p.id} className={`app-row ${ATTENTION[p.status] ?? ""}`}>
                <Link to={`/projects/${p.id}`} className="app-title">
                  {p.title}
                </Link>
                <span className="app-meta">
                  <StatusBadge status={p.status} label={t(STATUS[p.status])} />
                  {p.stack && <span className="app-stack">{p.stack}</span>}
                  <time dateTime={new Date(p.updatedAt).toISOString()} title={new Date(p.updatedAt).toLocaleString(locale)}>
                    {t("projects.changed", { when: timeAgo(p.updatedAt, locale) })}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export { STATUS as PROJECT_STATUS };
