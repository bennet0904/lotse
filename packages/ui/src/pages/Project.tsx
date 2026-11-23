import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type ApiError, get, type Job, type Message, type Project as ProjectData, post, useJob, useLoad } from "../api";
import { Dialog, ErrorNote, Spinner, StatusBadge, timeAgo } from "../components/common";
import { JobActivity } from "../components/JobActivity";
import { PlanCard } from "../components/PlanCard";
import { Publish } from "../components/Publish";
import { Repository } from "../components/Repository";
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
  const [sending, setSending] = useState(false);
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
    setSending(true);
    try {
      const started = await post<{ jobId: string }>(`/projects/${id}/messages`, { text });
      setText("");
      setJobId(started.jobId);
      messages.reload();
      project.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSending(false);
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
  // Why the message box cannot be used right now, in words the user can act on.
  const blocked =
    p.status === "planning"
      ? t("chat.blockedPlanning")
      : p.status === "planned"
        ? t("chat.blockedPlan")
        : !p.stack
          ? t("chat.blockedNoPlan")
          : stream.running || p.status === "generating"
            ? t("chat.blockedWorking")
            : undefined;

  return (
    <div className="workspace">
      <section className="chat" aria-label={t("chat.title")}>
        <header className="chat-head">
          <h1>{p.title}</h1>
          <StatusBadge status={p.status} label={t(PROJECT_STATUS[p.status])} />
        </header>
        <ol className="messages">
          {list.map((m) => {
            if (m.meta?.kind === "plan" && m.id === lastPlan?.id && p.status === "planned" && m.meta.plan)
              return (
                <li key={m.id}>
                  <PlanCard
                    projectId={id}
                    plan={m.meta.plan}
                    onStarted={(job) => {
                      setJobId(job);
                      project.reload();
                      messages.reload();
                    }}
                  />
                </li>
              );
            return (
              <ChatMessage
                key={m.id}
                message={m}
                planLabel={m.id === lastPlan?.id && p.status !== "planning" ? t("chat.planApproved") : t("chat.planEarlier")}
                next={
                  m.id === list[list.length - 1]?.id && m.meta?.kind === "error"
                    ? p.stack
                      ? t("chat.errorNext")
                      : p.status === "planned"
                        ? t("chat.errorNextPlan")
                        : undefined
                    : undefined
                }
                onPublish={() => setTab("publish")}
              />
            );
          })}
        </ol>
        {jobId && (stream.running || stream.job?.status === "failed") && (
          <div className="chat-activity">
            {/* The conversation shows the error itself; the progress shows where it happened. */}
            <JobActivity jobId={jobId} stream={stream} runningHint={t("chat.stopHint")} showError={false} />
          </div>
        )}
        <div ref={end} />
        <form className="composer" onSubmit={send}>
          <ErrorNote error={error ?? messages.error} />
          <label htmlFor="message" className="composer-label">
            {t("chat.inputLabel")}
          </label>
          <div className="composer-row">
            <textarea
              id="message"
              className="composer-input"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={blocked ? undefined : t("chat.placeholder")}
              aria-describedby="message-hint"
              disabled={Boolean(blocked) || sending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
              }}
            />
            <button type="submit" className="button-primary" disabled={Boolean(blocked) || sending || !text.trim()}>
              {t("chat.send")}
            </button>
          </div>
          <p id="message-hint" className={`hint composer-hint${blocked ? " composer-blocked" : ""}`}>
            {blocked ?? t("chat.shortcut")}
          </p>
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
              // The bold label of the selected tab is reserved in every tab, so switching does not shift the row.
              data-label={t(item.label)}
              onClick={() => setTab(item.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab);
                const next =
                  e.key === "ArrowRight"
                    ? TABS[(i + 1) % TABS.length]
                    : e.key === "ArrowLeft"
                      ? TABS[(i + TABS.length - 1) % TABS.length]
                      : e.key === "Home"
                        ? TABS[0]
                        : e.key === "End"
                          ? TABS[TABS.length - 1]
                          : undefined;
                if (next) {
                  e.preventDefault();
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
              project={p}
              projectId={id}
              onChanged={() => project.reload()}
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
              <PanelState>
                <p className="hint">{t("publish.notYet")}</p>
              </PanelState>
            ))}
          {tab === "usage" && <Usage projectId={id} reloadKey={previewKey} />}
        </div>
      </section>
    </div>
  );
}

/** One entry of the conversation: the user, Lotse or a system note, each with its own look. */
function ChatMessage({ message: m, planLabel, next, onPublish }: { message: Message; planLabel: string; next?: string; onPublish: () => void }) {
  const { t } = useI18n();
  if (m.role === "system")
    return (
      <li className="msg msg-system">
        <span className="sr-only">{t("chat.system")}: </span>
        <span className="pre">{m.content}</span>
      </li>
    );
  if (m.meta?.kind === "plan")
    return (
      <li className="msg msg-assistant msg-plan">
        <details>
          <summary>{planLabel}</summary>
          <p className="pre">{m.content}</p>
        </details>
      </li>
    );
  const user = m.role === "user";
  const kind = m.meta?.kind;
  return (
    <li className={`msg ${user ? "msg-user" : "msg-assistant"}${kind === "error" ? " msg-error" : ""}${kind === "stopped" ? " msg-stopped" : ""}`}>
      {kind !== "stopped" && <p className="msg-author">{user ? (kind === "plan-feedback" ? t("chat.youPlan") : t("chat.you")) : "Lotse"}</p>}
      <p className="pre">{m.content}</p>
      {m.meta?.verified === false && <p className="note note-warn">{t("chat.unverified")}</p>}
      {next && <p className="msg-next">{next}</p>}
      {m.meta?.changedFiles && m.meta.changedFiles.length > 0 && (
        <details className="msg-files">
          <summary className="msg-files-summary">{t("chat.changed", { count: m.meta.changedFiles.length })}</summary>
          <ul>
            {m.meta.changedFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {m.meta?.proposals?.map((proposal) => (
        <div key={proposal.summary} className="note msg-proposal">
          <p>
            <strong>{t("activity.proposal")}:</strong> {proposal.summary}
          </p>
          {/* The model can only propose critical actions; carrying them out is the user's decision. */}
          {proposal.action === "deploy" && (
            <button type="button" onClick={onPublish}>
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
  );
}

/** A calm, centred message that fills a tab while there is nothing else to show. */
function PanelState({ children }: { children: ReactNode }) {
  return <div className="panel-state">{children}</div>;
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
  if (!ready)
    return (
      <PanelState>
        {project.status === "generating" ? (
          <>
            <Spinner label={t("preview.building")} />
            <p className="hint">{t("preview.buildingHint")}</p>
          </>
        ) : (
          <>
            <h3>{t("preview.notYetTitle")}</h3>
            <p className="hint">{t("preview.notYet")}</p>
          </>
        )}
      </PanelState>
    );
  if (preview.error)
    return (
      <PanelState>
        <ErrorNote error={preview.error} />
        <button type="button" onClick={preview.reload} disabled={preview.loading}>
          {t("preview.retry")}
        </button>
      </PanelState>
    );
  if (!preview.data)
    return (
      <PanelState>
        <Spinner label={t("preview.starting")} />
        <p className="hint">{t("preview.startingHint")}</p>
      </PanelState>
    );
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-url" title={preview.data.url}>
          {preview.data.url}
        </span>
        <div className="preview-actions">
          <button type="button" className="button-sm" onClick={() => setFrame((n) => n + 1)}>
            <span aria-hidden="true">↻</span>
            {t("preview.reload")}
          </button>
          <a className="button button-sm" href={preview.data.url} target="_blank" rel="noreferrer">
            <span aria-hidden="true">↗</span>
            {t("preview.open")}
          </a>
        </div>
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
  const { t, locale } = useI18n();
  const files = useLoad(() => get<{ files: string[] }>(`/projects/${projectId}/files`), [projectId, reloadKey]);
  const [path, setPath] = useState<string>();
  const file = useLoad(
    () => (path ? get<{ content: string; truncated: boolean }>(`/projects/${projectId}/file?path=${encodeURIComponent(path)}`) : Promise.resolve(undefined)),
    [projectId, path, reloadKey],
  );
  const list = files.data?.files ?? [];
  const lines = file.data ? file.data.content.replace(/\n$/, "").split("\n") : [];
  return (
    <div className="files">
      <nav aria-label={t("files.list")} className="file-list">
        <ErrorNote error={files.error} />
        {!files.data && !files.error && <Spinner label={t("common.loading")} />}
        {files.data && <p className="file-list-head">{t("files.count", { count: list.length })}</p>}
        <ul>
          {list.map((f) => {
            const cut = f.lastIndexOf("/") + 1;
            return (
              <li key={f}>
                <button type="button" className="file" aria-current={f === path ? "true" : undefined} onClick={() => setPath(f)} title={f}>
                  {cut > 0 && <span className="file-dir">{f.slice(0, cut)}</span>}
                  <span className="file-name">{f.slice(cut)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {files.data && list.length === 0 && <p className="hint">{t("files.empty")}</p>}
      </nav>
      <div className="file-view">
        {path ? (
          <>
            <header className="file-head">
              <h3 className="file-path">{path}</h3>
              {file.data && !file.loading && <span className="hint">{t("files.lines", { count: lines.length.toLocaleString(locale) })}</span>}
            </header>
            <ErrorNote error={file.error} />
            {file.loading ? (
              <Spinner label={t("common.loading")} />
            ) : (
              file.data && (
                <>
                  {file.data.truncated && <p className="note note-warn">{t("files.truncated")}</p>}
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable with the keyboard (WCAG 2.1.1) */}
                  <pre className="code" tabIndex={0}>
                    <code>
                      {lines.map((line, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity besides their position
                        <span key={i} className="code-line">
                          {line}
                        </span>
                      ))}
                    </code>
                  </pre>
                </>
              )
            )}
          </>
        ) : (
          <PanelState>
            <p className="hint">{list.length > 0 ? t("files.choose") : t("files.empty")}</p>
          </PanelState>
        )}
      </div>
    </div>
  );
}

function Versions({ project, projectId, onRestored, onChanged }: { project: ProjectData; projectId: string; onRestored: () => void; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const commits = useLoad(() => get<{ commits: { sha: string; message: string; date: string }[] }>(`/projects/${projectId}/commits`), [projectId]);
  const [target, setTarget] = useState<{ sha: string; message: string }>();
  const [error, setError] = useState<ApiError>();
  const [restoring, setRestoring] = useState(false);
  const restore = async () => {
    if (!target) return;
    setRestoring(true);
    setError(undefined);
    try {
      await post(`/projects/${projectId}/restore`, { sha: target.sha });
      setTarget(undefined);
      commits.reload();
      onRestored();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setRestoring(false);
    }
  };
  return (
    <div className="pane">
      <section className="stack" aria-labelledby="versions-heading">
        <div>
          <h3 id="versions-heading">{t("versions.title")}</h3>
          <p className="hint">{t("versions.hint")}</p>
        </div>
        <ErrorNote error={commits.error} />
        {!commits.data && !commits.error && <Spinner label={t("common.loading")} />}
        <ol className="versions">
          {commits.data?.commits.map((c, i) => (
            <li key={c.sha} className="version">
              <div className="version-text">
                <p className="version-message">{c.message}</p>
                <p className="version-meta">
                  <time dateTime={c.date} title={new Date(c.date).toLocaleString(locale)}>
                    {timeAgo(Date.parse(c.date), locale)}
                  </time>{" "}
                  · <code>{c.sha.slice(0, 8)}</code>
                </p>
              </div>
              {i === 0 ? (
                <span className="badge">{t("versions.current")}</span>
              ) : (
                <button type="button" className="button-sm" onClick={() => setTarget(c)}>
                  {t("versions.restore")}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>
      <Repository
        project={project}
        onChanged={() => {
          commits.reload();
          onChanged();
        }}
      />
      <Dialog
        open={Boolean(target)}
        onClose={() => {
          setTarget(undefined);
          setError(undefined);
        }}
        title={t("versions.confirmTitle")}
        actions={
          <>
            <button type="button" onClick={() => setTarget(undefined)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="button-primary" disabled={restoring} onClick={() => void restore()}>
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

type ModelUsage = { model: string; calls: number; inputTokens: number; outputTokens: number; cost: number | null };

function Usage({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
  const { t, locale } = useI18n();
  const usage = useLoad(() => get<{ models: ModelUsage[]; totalCost: number | null }>(`/projects/${projectId}/usage`), [projectId, reloadKey]);
  const n = (value: number) => value.toLocaleString(locale);
  const money = (value: number | null) =>
    value === null
      ? t("usage.unknown")
      : value.toLocaleString(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const models = usage.data?.models ?? [];
  const sum = (key: "calls" | "inputTokens" | "outputTokens") => models.reduce((total, m) => total + m[key], 0);
  return (
    <div className="pane">
      <div>
        <h3>{t("usage.title")}</h3>
        <p className="hint">{t("usage.hint")}</p>
      </div>
      <ErrorNote error={usage.error} />
      {!usage.data && !usage.error && <Spinner label={t("common.loading")} />}
      {usage.data && models.length === 0 && (
        <div className="empty">
          <p className="hint">{t("usage.empty")}</p>
        </div>
      )}
      {models.length > 0 && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls sideways on narrow screens and must be reachable with the keyboard
        <section className="table-wrap" tabIndex={0} aria-labelledby="usage-caption">
          <table>
            <caption id="usage-caption" className="sr-only">
              {t("usage.caption")}
            </caption>
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
              {models.map((m) => (
                <tr key={m.model}>
                  <th scope="row" className="usage-model">
                    {m.model}
                  </th>
                  <td className="num">{n(m.calls)}</td>
                  <td className="num">{n(m.inputTokens)}</td>
                  <td className="num">{n(m.outputTokens)}</td>
                  <td className="num">{money(m.cost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t("usage.total")}</th>
                <td className="num">{n(sum("calls"))}</td>
                <td className="num">{n(sum("inputTokens"))}</td>
                <td className="num">{n(sum("outputTokens"))}</td>
                <td className="num">{money(usage.data?.totalCost ?? null)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </div>
  );
}
