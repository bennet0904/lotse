import { type FormEvent, useState } from "react";
import { type Account, type Adapters, type ApiError, api, type DeployPlan, get, type Job, type Project, post, useJob, useLoad } from "../api";
import { type MessageKey, useI18n } from "../i18n";
import { Link } from "../router";
import { Backups } from "./Backups";
import { Dialog, ErrorNote, Spinner, StatusBadge, timeAgo } from "./common";
import { JobActivity } from "./JobActivity";
import { Secrets } from "./Secrets";

interface Deployment {
  id: string;
  state: string;
  url?: string;
  createdAt: number;
}

interface AppStatus {
  state: string;
  url?: string;
  domains: string[];
  message?: string;
}

interface DomainResult {
  domain: string;
  state: string;
  dnsRecords: { type: string; name: string; value: string }[];
  message?: string;
}

/** How many deployments the history shows before "Show all". */
const RECENT = 5;

const APP_STATE: Record<string, { label: MessageKey; badge: string }> = {
  running: { label: "appState.running", badge: "running" },
  deploying: { label: "appState.deploying", badge: "deploying" },
  stopped: { label: "appState.stopped", badge: "stopped" },
  failed: { label: "appState.failed", badge: "failed" },
  "not-found": { label: "appState.notFound", badge: "failed" },
  unknown: { label: "appState.unknown", badge: "unknown" },
};

const DEPLOY_STATE: Record<string, { label: MessageKey; badge: string }> = {
  live: { label: "deployState.live", badge: "live" },
  superseded: { label: "deployState.superseded", badge: "superseded" },
  failed: { label: "deployState.failed", badge: "failed" },
  "rolled-back": { label: "deployState.rolledBack", badge: "rolled-back" },
  preview: { label: "deployState.preview", badge: "preview" },
};

const DOMAIN_STATE: Record<string, { label: MessageKey; badge: string }> = {
  active: { label: "domainState.active", badge: "live" },
  pending: { label: "domainState.pending", badge: "deploying" },
  error: { label: "domainState.error", badge: "failed" },
};

/** Choose a provider, check what will happen, publish; then manage the published app. Critical actions need approval. */
export function Publish({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const accounts = useLoad(() => get<{ accounts: Account[] }>("/accounts"), []);
  const adapters = useLoad(() => get<Adapters>("/adapters"), []);
  const hosting = (accounts.data?.accounts ?? []).filter((a) => a.kind === "hosting");
  const [accountId, setAccountId] = useState(project.target?.accountId ?? "");
  const selected = accountId || hosting[0]?.id || "";
  const [plan, setPlan] = useState<DeployPlan>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"first" | "delete" | "domain" | "rollback" | null>(null);
  const [rollbackTo, setRollbackTo] = useState<Deployment>();
  const [allDeployments, setAllDeployments] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [domain, setDomain] = useState("");
  const [domainResult, setDomainResult] = useState<DomainResult>();
  const [logs, setLogs] = useState<{ at: number; line: string; stream: string }[]>();

  const status = useLoad(
    () => (project.target ? get<AppStatus>(`/projects/${project.id}/status`) : Promise.resolve(undefined)),
    [project.id, project.target?.accountId, jobId],
  );
  const history = useLoad(() => get<{ deployments: Deployment[] }>(`/projects/${project.id}/deployments`), [project.id, jobId]);
  const stream = useJob(jobId, (job: Job) => {
    if (job.status === "succeeded") onChanged();
    history.reload();
    status.reload();
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const check = () =>
    run(async () => {
      setPlan(await get<DeployPlan>(`/projects/${project.id}/deploy/plan?account=${encodeURIComponent(selected)}`));
    });

  const deploy = (approved: boolean) =>
    run(async () => {
      for (const [name, value] of Object.entries(secrets)) if (value) await api("PUT", `/projects/${project.id}/secrets/${name}`, { value });
      setSecrets({});
      const started = await post<{ jobId: string }>(`/projects/${project.id}/deploy`, { accountId: selected, approved });
      setConfirm(null);
      setPlan(undefined);
      setJobId(started.jobId);
    });

  const publish = (e: FormEvent) => {
    e.preventDefault();
    // The first deployment to a new target is a critical action: the user approves it explicitly.
    if (plan?.firstDeployment) setConfirm("first");
    else void deploy(false);
  };

  const loadLogs = () => run(async () => setLogs((await get<{ lines: { at: number; line: string; stream: string }[] }>(`/projects/${project.id}/logs`)).lines));

  const closeDialog = () => {
    setConfirm(null);
    setRollbackTo(undefined);
  };

  const adapterName = (id: string) => adapters.data?.hosting.find((a) => a.id === id)?.name ?? id;
  // Rollback and domains depend on where the app runs now, not on the account chosen for the next publish.
  const targetAdapter = adapters.data?.hosting.find((a) => a.id === project.target?.adapter);
  const targetAccount = hosting.find((a) => a.id === project.target?.accountId);
  const deployments = history.data?.deployments ?? [];
  const shown = allDeployments ? deployments : deployments.slice(0, RECENT);
  const live = deployments.find((d) => d.state === "live");
  const canRollback = (d: Deployment) => (d.state === "superseded" || d.state === "rolled-back") && targetAdapter?.capabilities?.rollback !== "none";
  const when = (at: number) => new Date(at).toLocaleString(locale);
  const domains = status.data?.domains ?? [];

  if (!accounts.data && !accounts.error) {
    return (
      <div className="pane">
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (accounts.data && hosting.length === 0) {
    return (
      <div className="pane">
        <div className="empty">
          <h3>{t("publish.title")}</h3>
          <p className="hint">{t("publish.noAccounts")}</p>
          <Link to="/accounts" className="button button-primary">
            {t("publish.connect")}
          </Link>
        </div>
      </div>
    );
  }

  const appState = status.data ? (APP_STATE[status.data.state] ?? { label: "appState.unknown" as MessageKey, badge: "unknown" }) : undefined;

  return (
    <div className="pane publish">
      {project.target && (
        <section className="card stack publish-status" aria-labelledby="publish-status-heading">
          <header className="publish-head">
            <h3 id="publish-status-heading">{t("publish.status")}</h3>
            {appState && <StatusBadge status={appState.badge} label={t(appState.label)} />}
          </header>
          {!status.data && !status.error && <Spinner label={t("common.loading")} />}
          <ErrorNote error={status.error} />
          {status.data && (
            <>
              <dl className="facts">
                {status.data.url && (
                  <>
                    <dt>{t("publish.address")}</dt>
                    <dd>
                      <a href={status.data.url} target="_blank" rel="noreferrer">
                        {status.data.url}
                      </a>
                    </dd>
                  </>
                )}
                {domains.length > 0 && (
                  <>
                    <dt>{t("publish.domains")}</dt>
                    <dd>
                      <ul className="publish-domains">
                        {domains.map((d) => (
                          <li key={d}>
                            <a href={`https://${d}`} target="_blank" rel="noreferrer">
                              {d}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                <dt>{t("publish.provider")}</dt>
                <dd>
                  {adapterName(project.target.adapter)}
                  {targetAccount ? ` · ${targetAccount.label}` : ""}
                </dd>
                {live && (
                  <>
                    <dt>{t("publish.lastPublished")}</dt>
                    <dd>
                      <time dateTime={new Date(live.createdAt).toISOString()} title={when(live.createdAt)}>
                        {timeAgo(live.createdAt, locale)}
                      </time>
                    </dd>
                  </>
                )}
              </dl>
              {status.data.message && <p className="hint">{status.data.message}</p>}
              {status.data.url && (
                <div className="actions">
                  <a className="button button-sm" href={status.data.url} target="_blank" rel="noreferrer">
                    <span aria-hidden="true">↗</span>
                    {t("publish.open")}
                  </a>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <section className="card stack" aria-labelledby="publish-heading">
        <div>
          <h3 id="publish-heading">{project.target ? t("publish.again") : t("publish.title")}</h3>
          <p className="hint">{t("publish.intro")}</p>
        </div>
        <form onSubmit={publish} className="stack">
          <div className="field-row">
            <label>
              {t("publish.target")}
              <select
                value={selected}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setPlan(undefined);
                }}
              >
                {hosting.map((a) => (
                  <option key={a.id} value={a.id}>
                    {adapterName(a.adapter)} · {a.label}
                    {a.scope === "team" ? ` (${t("accounts.team")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {!plan && (
              <button type="button" className="button-primary" onClick={() => void check()} disabled={busy || stream.running || !selected}>
                {t("publish.check")}
              </button>
            )}
          </div>
          {plan && (
            <div className="publish-plan stack">
              <h4>
                {plan.firstDeployment
                  ? t("publish.planFirst", { provider: adapterName(plan.adapter) })
                  : t("publish.planUpdate", { provider: adapterName(plan.adapter) })}
              </h4>
              <ol className="plan-steps" aria-label={t("publish.steps")}>
                {plan.steps.map((s) => (
                  <li key={s.id}>
                    <span className="plan-step-title">{s.title}</span>
                    {s.detail ? <span className="hint">{s.detail}</span> : null}
                  </li>
                ))}
              </ol>
              {plan.warnings.map((w) => (
                <p key={w} className="note note-warn">
                  {w}
                </p>
              ))}
              {plan.missingSecrets.length > 0 && (
                <fieldset className="stack">
                  <legend>{t("publish.secretsNeeded")}</legend>
                  <p className="hint">{t("publish.secretHint")}</p>
                  {plan.missingSecrets.map((name) => (
                    <label key={name}>
                      {t("publish.secret", { name })}
                      <input
                        type="password"
                        autoComplete="off"
                        required
                        value={secrets[name] ?? ""}
                        onChange={(e) => setSecrets({ ...secrets, [name]: e.target.value })}
                      />
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="actions">
                <button type="submit" className="button-primary" disabled={busy}>
                  {t("publish.go")}
                </button>
                <button type="button" onClick={() => setPlan(undefined)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}
        </form>
        <ErrorNote error={error ?? accounts.error} />
      </section>

      {jobId && <JobActivity jobId={jobId} stream={stream} />}
      {stream.job?.status === "succeeded" && typeof stream.job.result?.url === "string" && (
        <p className="note note-ok" role="status">
          {t("publish.live")}{" "}
          <a href={stream.job.result.url} target="_blank" rel="noreferrer">
            {stream.job.result.url}
          </a>
        </p>
      )}

      {project.target && (
        <>
          {deployments.length > 0 && (
            <section className="stack" aria-labelledby="deployments-heading">
              <div>
                <h3 id="deployments-heading">{t("publish.history")}</h3>
                <p className="hint">{t("publish.historyHint")}</p>
              </div>
              <ol className="versions">
                {shown.map((d) => {
                  const state = DEPLOY_STATE[d.state] ?? { label: "deployState.superseded" as MessageKey, badge: d.state };
                  return (
                    <li key={d.id} className="version">
                      <div className="version-text">
                        <p className="version-message">
                          <time dateTime={new Date(d.createdAt).toISOString()} title={when(d.createdAt)}>
                            {timeAgo(d.createdAt, locale)}
                          </time>
                        </p>
                        <p className="version-meta">
                          {when(d.createdAt)} · <code>{d.id.slice(0, 16)}</code>
                        </p>
                      </div>
                      <div className="actions">
                        <StatusBadge status={state.badge} label={t(state.label)} />
                        {canRollback(d) && (
                          <button
                            type="button"
                            className="button-sm"
                            disabled={busy || stream.running}
                            onClick={() => {
                              setRollbackTo(d);
                              setConfirm("rollback");
                            }}
                          >
                            {t("publish.rollback")}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {deployments.length > RECENT && (
                <div className="actions">
                  <button type="button" className="button-quiet button-sm" onClick={() => setAllDeployments(!allDeployments)} aria-expanded={allDeployments}>
                    {allDeployments ? t("publish.showRecent") : t("publish.showAll", { count: String(deployments.length) })}
                  </button>
                </div>
              )}
            </section>
          )}

          {(targetAdapter?.capabilities?.customDomains || domainResult) && (
            <section className="card stack" aria-labelledby="domain-heading">
              <div>
                <h3 id="domain-heading">{t("publish.domain")}</h3>
                <p className="hint">{t("publish.domainHint")}</p>
              </div>
              {targetAdapter?.capabilities?.customDomains && (
                <form
                  className="field-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setConfirm("domain");
                  }}
                >
                  <label>
                    {t("publish.domainName")}
                    <input
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="app.example.com"
                      required
                      autoComplete="off"
                      pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    {t("publish.addDomain")}
                  </button>
                </form>
              )}
              {domainResult && (
                <div className="stack" role="status">
                  <p className="publish-head">
                    <strong>{domainResult.domain}</strong>
                    <StatusBadge
                      status={DOMAIN_STATE[domainResult.state]?.badge ?? domainResult.state}
                      label={DOMAIN_STATE[domainResult.state] ? t(DOMAIN_STATE[domainResult.state].label) : domainResult.state}
                    />
                  </p>
                  {domainResult.message && <p className="hint">{domainResult.message}</p>}
                  {domainResult.dnsRecords.length > 0 && (
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls sideways on narrow screens and must be reachable with the keyboard
                    <div className="table-wrap" tabIndex={0}>
                      <table>
                        <caption className="publish-caption">{t("publish.dns")}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{t("publish.dnsType")}</th>
                            <th scope="col">{t("publish.dnsName")}</th>
                            <th scope="col">{t("publish.dnsValue")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {domainResult.dnsRecords.map((r) => (
                            <tr key={`${r.type}${r.name}${r.value}`}>
                              <td>{r.type}</td>
                              <td>
                                <code>{r.name}</code>
                              </td>
                              <td>
                                <code>{r.value}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="card stack" aria-labelledby="logs-heading">
            <header className="publish-head">
              <div>
                <h3 id="logs-heading">{t("publish.logs")}</h3>
                <p className="hint">{t("publish.logsHint")}</p>
              </div>
              <button type="button" className="button-sm" disabled={busy} onClick={() => void loadLogs()}>
                {logs ? t("publish.refreshLogs") : t("publish.showLogs")}
              </button>
            </header>
            {logs && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable with the keyboard (WCAG 2.1.1)
              <pre className="logs" tabIndex={0}>
                {logs.map((l) => `${new Date(l.at).toLocaleTimeString(locale)}  ${l.line}`).join("\n") || t("publish.noLogs")}
              </pre>
            )}
          </section>

          <Secrets projectId={project.id} />

          <Backups projectId={project.id} />

          <section className="card stack danger-zone" aria-labelledby="danger-heading">
            <div>
              <h3 id="danger-heading">{t("publish.danger")}</h3>
              <p className="hint">{t("publish.deleteHint")}</p>
            </div>
            <div className="actions">
              <button type="button" className="button-danger" onClick={() => setConfirm("delete")}>
                {t("publish.delete")}
              </button>
            </div>
          </section>
        </>
      )}

      <Dialog
        open={confirm !== null}
        onClose={closeDialog}
        title={
          confirm === "first"
            ? t("publish.confirmFirstTitle")
            : confirm === "domain"
              ? t("publish.confirmDomainTitle")
              : confirm === "rollback"
                ? t("publish.confirmRollbackTitle")
                : t("publish.confirmDeleteTitle")
        }
        actions={
          <>
            <button type="button" onClick={closeDialog}>
              {t("common.cancel")}
            </button>
            {confirm === "first" && (
              <button type="button" className="button-primary" disabled={busy} onClick={() => void deploy(true)}>
                {t("publish.confirmFirst")}
              </button>
            )}
            {confirm === "domain" && (
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setDomainResult(await post(`/projects/${project.id}/domains`, { domain, approved: true }));
                    setConfirm(null);
                    setDomain("");
                    status.reload();
                  })
                }
              >
                {t("publish.confirmDomain")}
              </button>
            )}
            {confirm === "rollback" && rollbackTo && (
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const started = await post<{ jobId: string }>(`/projects/${project.id}/rollback`, { to: rollbackTo.id });
                    closeDialog();
                    setJobId(started.jobId);
                  })
                }
              >
                {t("publish.confirmRollback")}
              </button>
            )}
            {confirm === "delete" && (
              <button
                type="button"
                className="button-danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("DELETE", `/projects/${project.id}/app`, { approved: true });
                    setConfirm(null);
                    onChanged();
                  })
                }
              >
                {t("publish.confirmDelete")}
              </button>
            )}
          </>
        }
      >
        {confirm === "first" && plan && <p>{t("publish.confirmFirstText", { app: plan.app, provider: adapterName(plan.adapter) })}</p>}
        {confirm === "domain" && <p>{t("publish.confirmDomainText", { domain })}</p>}
        {confirm === "rollback" && rollbackTo && <p>{t("publish.confirmRollbackText", { when: when(rollbackTo.createdAt) })}</p>}
        {confirm === "delete" && <p>{t("publish.confirmDeleteText", { app: project.title })}</p>}
        <ErrorNote error={error} />
      </Dialog>
    </div>
  );
}
