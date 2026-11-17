import { type FormEvent, useState } from "react";
import { type ApiError, get, type Project, post, useLoad } from "../api";
import { ErrorNote, StatusBadge, timeAgo } from "../components/common";
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

  return (
    <div className="page">
      <h1>{t("projects.heading")}</h1>
      {runtime.data && !runtime.data.ready && (
        <div className="note note-warn" role="status">
          <p>
            <strong>{runtimeGuidance(runtime.data, t).title}</strong>
          </p>
          <ol>
            {runtimeGuidance(runtime.data, t).steps.map((s) => (
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
        </div>
      )}
      <form className="card prompt" onSubmit={create}>
        <label htmlFor="prompt">{t("projects.promptLabel")}</label>
        <textarea id="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("projects.promptPlaceholder")} required />
        <details>
          <summary>{t("projects.options")}</summary>
          <label>
            {t("projects.model")}
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic:claude-opus-5-5" autoComplete="off" spellCheck={false} />
            <span className="hint">{t("projects.modelHint")}</span>
          </label>
        </details>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="submit" className="button-primary" disabled={busy || !prompt.trim()}>
            {t("projects.create")}
          </button>
        </div>
      </form>

      <h2>{t("projects.yours")}</h2>
      <ErrorNote error={projects.error} />
      {projects.data?.projects.length === 0 && <p className="hint">{t("projects.empty")}</p>}
      <ul className="grid">
        {projects.data?.projects.map((p) => (
          <li key={p.id} className="card">
            <h3>
              <Link to={`/projects/${p.id}`}>{p.title}</Link>
            </h3>
            <p className="hint">
              <StatusBadge status={p.status} label={t(STATUS[p.status])} /> {p.stack ?? ""} · {timeAgo(p.updatedAt, locale)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { STATUS as PROJECT_STATUS };
