import { type FormEvent, useState } from "react";
import { type Account, type Adapters, type ApiError, api, type DeployPlan, get, type Job, type Project, post, useJob, useLoad } from "../api";
import { useI18n } from "../i18n";
import { Link } from "../router";
import { Backups } from "./Backups";
import { Dialog, ErrorNote, StatusBadge } from "./common";
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

/** One-click deploy, with the approvals critical actions need. */
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
  const [confirm, setConfirm] = useState<"first" | "delete" | "domain" | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [domain, setDomain] = useState("");
  const [domainResult, setDomainResult] = useState<{
    domain: string;
    state: string;
    dnsRecords: { type: string; name: string; value: string }[];
    message?: string;
  }>();
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

  const adapterName = (id: string) => adapters.data?.hosting.find((a) => a.id === id)?.name ?? id;
  const selectedAdapter = adapters.data?.hosting.find((a) => a.id === hosting.find((h) => h.id === selected)?.adapter);

  if (accounts.data && hosting.length === 0) {
    return (
      <div className="pane">
        <h3>{t("publish.title")}</h3>
        <p>{t("publish.noAccounts")}</p>
        <Link to="/accounts" className="button button-primary">
          {t("publish.connect")}
        </Link>
      </div>
    );
  }

  return (
    <div className="pane">
      <h3>{t("publish.title")}</h3>
      <form onSubmit={publish} className="stack">
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
          <div className="actions">
            <button type="button" className="button-primary" onClick={() => void check()} disabled={busy || stream.running || !selected}>
              {t("publish.check")}
            </button>
          </div>
        )}
        {plan && (
          <div className="card">
            <h4>
              {plan.firstDeployment
                ? t("publish.planFirst", { provider: adapterName(plan.adapter) })
                : t("publish.planUpdate", { provider: adapterName(plan.adapter) })}
            </h4>
            <ul>
              {plan.steps.map((s) => (
                <li key={s.id}>
                  {s.title}
                  {s.detail ? <span className="hint"> · {s.detail}</span> : null}
                </li>
              ))}
            </ul>
            {plan.warnings.map((w) => (
              <p key={w} className="note note-warn">
                {w}
              </p>
            ))}
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
                <span className="hint">{t("publish.secretHint")}</span>
              </label>
            ))}
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
      {jobId && <JobActivity jobId={jobId} stream={stream} />}
      {stream.job?.status === "succeeded" && typeof stream.job.result?.url === "string" && (
        <p className="note note-ok" role="status">
          {t("publish.live")}{" "}
          <a href={stream.job.result.url} target="_blank" rel="noreferrer">
            {stream.job.result.url}
          </a>
        </p>
      )}

      {project.target && status.data && (
        <section className="stack">
          <h4>{t("publish.status")}</h4>
          <p>
            <StatusBadge status={status.data.state} label={status.data.state} />{" "}
            {status.data.url && (
              <a href={status.data.url} target="_blank" rel="noreferrer">
                {status.data.url}
              </a>
            )}
            {status.data.message ? <span className="hint"> {status.data.message}</span> : null}
          </p>

          {(history.data?.deployments.length ?? 0) > 0 && (
            <table>
              <caption>{t("publish.history")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("publish.deployment")}</th>
                  <th scope="col">{t("publish.state")}</th>
                  <th scope="col">{t("publish.when")}</th>
                  <th scope="col">
                    <span className="sr-only">{t("publish.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.data?.deployments.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code>{d.id.slice(0, 16)}</code>
                    </td>
                    <td>{d.state}</td>
                    <td>{new Date(d.createdAt).toLocaleString(locale)}</td>
                    <td>
                      {(d.state === "superseded" || d.state === "rolled-back") && selectedAdapter?.capabilities?.rollback !== "none" && (
                        <button
                          type="button"
                          disabled={busy || stream.running}
                          onClick={() =>
                            void run(async () => setJobId((await post<{ jobId: string }>(`/projects/${project.id}/rollback`, { to: d.id })).jobId))
                          }
                        >
                          {t("publish.rollback")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {selectedAdapter?.capabilities?.customDomains && (
            <form
              className="field-row"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirm("domain");
              }}
            >
              <label>
                {t("publish.domain")}
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="app.example.com"
                  required
                  pattern="[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
                />
              </label>
              <button type="submit" disabled={busy}>
                {t("publish.addDomain")}
              </button>
            </form>
          )}
          {domainResult && (
            <div className="note" role="status">
              <p>
                {domainResult.domain}: {domainResult.state}
                {domainResult.message ? ` · ${domainResult.message}` : ""}
              </p>
              {domainResult.dnsRecords.length > 0 && (
                <>
                  <p>{t("publish.dns")}</p>
                  <ul>
                    {domainResult.dnsRecords.map((r) => (
                      <li key={`${r.type}${r.value}`}>
                        <code>
                          {r.type} {r.name} → {r.value}
                        </code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <details
            onToggle={(e) =>
              e.currentTarget.open && !logs
                ? void run(async () => setLogs((await get<{ lines: { at: number; line: string; stream: string }[] }>(`/projects/${project.id}/logs`)).lines))
                : undefined
            }
          >
            <summary>{t("publish.logs")}</summary>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable regions must be reachable with the keyboard (WCAG 2.1.1) */}
            <pre className="logs" tabIndex={0}>
              {(logs ?? []).map((l) => `${new Date(l.at).toISOString()} ${l.line}`).join("\n") || t("publish.noLogs")}
            </pre>
          </details>

          <Secrets projectId={project.id} />

          <Backups projectId={project.id} />

          <details>
            <summary>{t("publish.danger")}</summary>
            <p className="hint">{t("publish.deleteHint")}</p>
            <button type="button" className="button-danger" onClick={() => setConfirm("delete")}>
              {t("publish.delete")}
            </button>
          </details>
        </section>
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "first" ? t("publish.confirmFirstTitle") : confirm === "domain" ? t("publish.confirmDomainTitle") : t("publish.confirmDeleteTitle")}
        actions={
          <>
            <button type="button" onClick={() => setConfirm(null)}>
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
                  })
                }
              >
                {t("publish.confirmDomain")}
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
        {confirm === "delete" && <p>{t("publish.confirmDeleteText", { app: project.title })}</p>}
        <ErrorNote error={error} />
      </Dialog>
    </div>
  );
}
