import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiError, get, type Job, type Message, type Project as ProjectData, post, useJob, useLoad } from "../api";
import { Dialog, ErrorNote, Spinner, StatusBadge } from "../components/common";
import { JobActivity } from "../components/JobActivity";
import { PlanCard } from "../components/PlanCard";
import { Publish } from "../components/Publish";
import { type MessageKey, useI18n } from "../i18n";
import { PROJECT_STATUS } from "./Projects";

type Tab = "preview" | "files" | "versions" | "publish" | "usage";
const TABS: { id: Tab; label: MessageKey }[] = [
  { id: "preview", label: "tab.preview" },
  { id: "files", label: "tab.files" },
  { id: "versions", label: "tab.versions" },
  { id: "publish", label: "tab.publish" },
  { id: "usage", label: "tab.usage" },
];

export function ProjectPage({ id }: { id: string }) {
  const { t } = useI18n();
  const project = useLoad(() => get<{ project: ProjectData; jobs: Job[] }>(`/projects/${id}`), [id]);
  const messages = useLoad(() => get<{ messages: Message[] }>(`/projects/${id}/messages`), [id]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("preview");
  const [text, setText] = useState("");
  const [error, setError] = useState<ApiError>();
  const [previewKey, setPreviewKey] = useState(0);

  // Pick up a job that is already running, e.g. after reloading the page.
  const running = project.data?.jobs.find((j) => (j.status === "running" || j.status === "queued") && (j.type === "plan" || j.type === "generate"));
  useEffect(() => {
    if (running && !jobId) setJobId(running.id);
  }, [running, jobId]);

  const stream = useJob(jobId, () => {
    project.reload();
    messages.reload();
    setPreviewKey((n) => n + 1);
  });
  const p = project.data?.project;
  const list = messages.data?.messages ?? [];
  const lastPlan = [...list].reverse().find((m) => m.meta?.kind === "plan");
  const end = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages change
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [list.length]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const started = await post<{ jobId: string }>(`/projects/${id}/messages`, { text });
      setText("");
      setJobId(started.jobId);
      messages.reload();
      project.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  };

  if (project.error)
    return (
      <div className="page">
        <ErrorNote error={project.error} />
      </div>
    );
  if (!p)
    return (
      <div className="page">
        <Spinner label={t("common.loading")} />
      </div>
    );
  const canChat = Boolean(p.stack) && p.status !== "planned" && p.status !== "planning";

  return (
    <div className="workspace">
      <section className="chat" aria-label={t("chat.title")}>
        <header className="chat-head">
          <h1>{p.title}</h1>
          <StatusBadge status={p.status} label={t(PROJECT_STATUS[p.status])} />
        </header>
        <ol className="messages">
          {list.map((m) =>
            m.meta?.kind === "plan" ? (
              m.id === lastPlan?.id && p.status === "planned" && m.meta.plan ? (
                <li key={m.id}>
                  <PlanCard
                    projectId={id}
                    plan={m.meta.plan}
                    onStarted={(job) => {
                      setJobId(job);
                      project.reload();
                    }}
                  />
                </li>
              ) : (
                <li key={m.id} className="msg msg-assistant">
                  <p className="msg-author">{t("chat.plan")}</p>
                  <p className="pre">{m.content}</p>
                </li>
              )
            ) : (
              <li key={m.id} className={`msg msg-${m.role}${m.meta?.kind === "error" ? " msg-error" : ""}`}>
                <p className="msg-author">{m.role === "user" ? t("chat.you") : m.role === "assistant" ? "Lotse" : t("chat.system")}</p>
                <p className="pre">{m.content}</p>
                {m.meta?.verified === false && <p className="note note-warn">{t("chat.unverified")}</p>}
                {m.meta?.changedFiles && m.meta.changedFiles.length > 0 && (
                  <p className="hint">{t("chat.changed", { files: m.meta.changedFiles.join(", ") })}</p>
                )}
                {m.meta?.proposals?.map((proposal) => (
                  <div key={proposal.summary} className="note">
                    <p>{proposal.summary}</p>
                    {/* The model can only propose critical actions; carrying them out is the user's decision. */}
                    {proposal.action === "deploy" && (
                      <button type="button" onClick={() => setTab("publish")}>
                        {t("chat.openPublish")}
                      </button>
                    )}
                  </div>
                ))}
                {m.meta?.url && (
                  <p>
                    <a href={m.meta.url} target="_blank" rel="noreferrer">
                      {m.meta.url}
                    </a>
                  </p>
                )}
              </li>
            ),
          )}
        </ol>
        {jobId && (stream.running || stream.job?.status === "failed") && <JobActivity jobId={jobId} stream={stream} />}
        <div ref={end} />
        <ErrorNote error={error ?? messages.error} />
        <form className="composer" onSubmit={send}>
          <label htmlFor="message" className="sr-only">
            {t("chat.inputLabel")}
          </label>
          <textarea
            id="message"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={canChat ? t("chat.placeholder") : t("chat.placeholderPlan")}
            disabled={!canChat || stream.running}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
            }}
          />
          <button type="submit" className="button-primary" disabled={!canChat || stream.running || !text.trim()}>
            {t("chat.send")}
          </button>
        </form>
      </section>

      <section className="side" aria-label={t("side.title")}>
        <div className="tabs" role="tablist" aria-label={t("side.title")}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className="tab"
              onClick={() => setTab(item.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab);
                const next =
                  e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : undefined;
                if (next) {
                  setTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }
              }}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="panel">
          {tab === "preview" && <Preview project={p} built={list.some((m) => m.meta?.kind === "result")} reloadKey={previewKey} />}
          {tab === "files" && <Files projectId={id} reloadKey={previewKey} />}
          {tab === "versions" && (
            <Versions
              projectId={id}
              onRestored={() => {
                messages.reload();
                setPreviewKey((n) => n + 1);
              }}
            />
          )}
          {tab === "publish" &&
            (p.stack && p.status !== "planned" ? (
              <Publish
                project={p}
                onChanged={() => {
                  project.reload();
                  messages.reload();
                }}
              />
            ) : (
              <p className="pane hint">{t("publish.notYet")}</p>
            ))}
          {tab === "usage" && <Usage projectId={id} reloadKey={previewKey} />}
        </div>
      </section>
    </div>
  );
}

function Preview({ project, built, reloadKey }: { project: ProjectData; built: boolean; reloadKey: number }) {
  const { t } = useI18n();
  const [frame, setFrame] = useState(0);
  // While the first version is being built there is nothing to show yet; later changes appear live.
  const ready = Boolean(project.stack) && (built || project.status === "ready");
  const preview = useLoad(
    () => (ready ? post<{ url: string; ready: boolean }>(`/projects/${project.id}/preview`) : Promise.resolve(undefined)),
    [project.id, ready, reloadKey],
  );
  if (!ready) return <p className="pane hint">{t("preview.notYet")}</p>;
  if (preview.error)
    return (
      <div className="pane">
        <ErrorNote error={preview.error} />
      </div>
    );
  if (!preview.data)
    return (
      <div className="pane">
        <Spinner label={t("preview.starting")} />
      </div>
    );
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-url">{preview.data.url}</span>
        <button type="button" onClick={() => setFrame((n) => n + 1)}>
          {t("preview.reload")}
        </button>
        <a className="button" href={preview.data.url} target="_blank" rel="noreferrer">
          {t("preview.open")}
        </a>
      </div>
      {/* The app runs at its own address, isolated from the builder's origin. */}
      <iframe
        key={`${reloadKey}-${frame}`}
        src={preview.data.url}
        title={t("preview.frameTitle", { app: project.title })}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
      />
    </div>
  );
}

function Files({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
  const { t } = useI18n();
  const files = useLoad(() => get<{ files: string[] }>(`/projects/${projectId}/files`), [projectId, reloadKey]);
  const [path, setPath] = useState<string>();
  const file = useLoad(
    () => (path ? get<{ content: string; truncated: boolean }>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`) : Promise.resolve(undefined)),
    [projectId, path, reloadKey],
  );
  return (
    <div className="files">
      <nav aria-label={t("files.list")}>
        <ul>
          {files.data?.files.map((f) => (
            <li key={f}>
              <button type="button" className="file" aria-current={f === path ? "true" : undefined} onClick={() => setPath(f)}>
                {f}
              </button>
            </li>
          ))}
        </ul>
        {files.data?.files.length === 0 && <p className="hint">{t("files.empty")}</p>}
      </nav>
      <div className="file-view">
        {path ? (
          <>
            <h3>{path}</h3>
            <ErrorNote error={file.error} />
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable with the keyboard (WCAG 2.1.1) */}
            <pre tabIndex={0}>{file.data?.content}</pre>
            {file.data?.truncated && <p className="hint">{t("files.truncated")}</p>}
          </>
        ) : (
          <p className="hint">{t("files.choose")}</p>
        )}
      </div>
    </div>
  );
}

function Versions({ projectId, onRestored }: { projectId: string; onRestored: () => void }) {
  const { t, locale } = useI18n();
  const commits = useLoad(() => get<{ commits: { sha: string; message: string; date: string }[] }>(`/projects/${projectId}/commits`), [projectId]);
  const [target, setTarget] = useState<{ sha: string; message: string }>();
  const [error, setError] = useState<ApiError>();
  const restore = async () => {
    if (!target) return;
    try {
      await post(`/projects/${projectId}/restore`, { sha: target.sha });
      setTarget(undefined);
      commits.reload();
      onRestored();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <div className="pane">
      <h3>{t("versions.title")}</h3>
      <p className="hint">{t("versions.hint")}</p>
      <ErrorNote error={commits.error} />
      <ol className="versions">
        {commits.data?.commits.map((c, i) => (
          <li key={c.sha}>
            <div>
              <strong>{c.message}</strong>
              <span className="hint">
                {" "}
                · {new Date(c.date).toLocaleString(locale)} · <code>{c.sha.slice(0, 8)}</code>
              </span>
            </div>
            {i > 0 && (
              <button type="button" onClick={() => setTarget(c)}>
                {t("versions.restore")}
              </button>
            )}
          </li>
        ))}
      </ol>
      <Dialog
        open={Boolean(target)}
        onClose={() => setTarget(undefined)}
        title={t("versions.confirmTitle")}
        actions={
          <>
            <button type="button" onClick={() => setTarget(undefined)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="button-primary" onClick={() => void restore()}>
              {t("versions.restore")}
            </button>
          </>
        }
      >
        <p>{t("versions.confirmText", { version: target?.message ?? "" })}</p>
        <ErrorNote error={error} />
      </Dialog>
    </div>
  );
}

function Usage({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
  const { t, locale } = useI18n();
  const usage = useLoad(
    () =>
      get<{ models: { model: string; calls: number; inputTokens: number; outputTokens: number; cost: number | null }[]; totalCost: number | null }>(
        `/projects/${projectId}/usage`,
      ),
    [projectId, reloadKey],
  );
  const n = (value: number) => value.toLocaleString(locale);
  const money = (value: number | null) =>
    value === null
      ? t("usage.unknown")
      : value.toLocaleString(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return (
    <div className="pane">
      <h3>{t("usage.title")}</h3>
      <ErrorNote error={usage.error} />
      <table>
        <caption>{t("usage.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("usage.model")}</th>
            <th scope="col" className="num">
              {t("usage.calls")}
            </th>
            <th scope="col" className="num">
              {t("usage.input")}
            </th>
            <th scope="col" className="num">
              {t("usage.output")}
            </th>
            <th scope="col" className="num">
              {t("usage.cost")}
            </th>
          </tr>
        </thead>
        <tbody>
          {usage.data?.models.map((m) => (
            <tr key={m.model}>
              <th scope="row">{m.model}</th>
              <td className="num">{n(m.calls)}</td>
              <td className="num">{n(m.inputTokens)}</td>
              <td className="num">{n(m.outputTokens)}</td>
              <td className="num">{money(m.cost)}</td>
            </tr>
          ))}
        </tbody>
        {usage.data && usage.data.models.length > 0 && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={4}>
                {t("usage.total")}
              </th>
              <td className="num">{money(usage.data.totalCost)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {usage.data?.models.length === 0 && <p className="hint">{t("usage.empty")}</p>}
      <p className="hint">{t("usage.hint")}</p>
    </div>
  );
}
