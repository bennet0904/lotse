import { type FormEvent, useEffect, useState } from "react";
import { type Account, type AdapterInfo, type Adapters, type ApiError, api, get, post, type SetupPlan, useJob, useLoad } from "../api";
import { Dialog, ErrorNote, StatusBadge } from "../components/common";
import { JobActivity } from "../components/JobActivity";
import { useT } from "../i18n";

interface VerifyResult {
  ok: boolean;
  missingPermissions: string[];
  warnings: string[];
}

/** Provider accounts: OAuth where available, otherwise the guided token setup; SSH for own servers. */
export function Accounts({ desktop = false }: { desktop?: boolean }) {
  const t = useT();
  const adapters = useLoad(() => get<Adapters>("/adapters"), []);
  const accounts = useLoad(() => get<{ accounts: Account[] }>("/accounts"), []);
  const { reload } = accounts;
  // A sign-in that finished in another tab or in the system browser shows up when the user returns.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  const [connecting, setConnecting] = useState<AdapterInfo>();
  const [setupFor, setSetupFor] = useState<Account>();
  const [removing, setRemoving] = useState<Account>();
  const [error, setError] = useState<ApiError>();
  const query = new URLSearchParams(location.search);
  const all = [...(adapters.data?.hosting ?? []), ...(adapters.data?.git ?? []), ...(adapters.data?.resources ?? [])];
  const name = (id: string) => all.find((a) => a.id === id)?.name ?? id;

  const groups: { title: string; items: AdapterInfo[] }[] = [
    { title: t("accounts.hosting"), items: adapters.data?.hosting ?? [] },
    { title: t("accounts.git"), items: adapters.data?.git ?? [] },
    { title: t("accounts.resources"), items: adapters.data?.resources ?? [] },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="page">
      <h1>{t("accounts.heading")}</h1>
      <p className="hint">{t("accounts.intro")}</p>
      {query.get("error") && (
        <p className="note note-error" role="alert">
          {query.get("error")}
        </p>
      )}
      {query.get("connected") && (
        <p className="note note-ok" role="status">
          {t("accounts.connected")}
        </p>
      )}
      <ErrorNote error={accounts.error ?? adapters.error ?? error} />

      <h2>{t("accounts.yours")}</h2>
      {accounts.data?.accounts.length === 0 && <p className="hint">{t("accounts.empty")}</p>}
      <ul className="list">
        {accounts.data?.accounts.map((a) => (
          <li key={a.id} className="card row">
            <div>
              <strong>{name(a.adapter)}</strong> · {a.label}
              <p className="hint">
                {a.account} · <StatusBadge status={a.scope} label={a.scope === "team" ? t("accounts.team") : t("accounts.personal")} />
              </p>
            </div>
            <div className="actions">
              {adapters.data?.hosting.find((h) => h.id === a.adapter)?.serverSetup && (
                <button type="button" onClick={() => setSetupFor(a)}>
                  {t("accounts.setup")}
                </button>
              )}
              <button type="button" onClick={() => setRemoving(a)}>
                {t("accounts.remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>{t("accounts.add")}</h2>
      {groups.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <ul className="grid">
            {group.items.map((a) => (
              <li key={a.id} className="card">
                <h4>{a.name}</h4>
                {a.capabilities && (
                  <p className="hint">
                    {a.capabilities.runtimes.join(", ")}
                    {a.capabilities.resources.length > 0 ? ` · ${a.capabilities.resources.join(", ")}` : ""}
                  </p>
                )}
                {a.resources && <p className="hint">{a.resources.join(", ")}</p>}
                <button type="button" onClick={() => setConnecting(a)}>
                  {t("accounts.connect", { provider: a.name })}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {connecting && (
        <ConnectDialog
          desktop={desktop}
          adapter={connecting}
          onClose={() => setConnecting(undefined)}
          onConnected={() => {
            accounts.reload();
          }}
        />
      )}
      {setupFor && <SetupDialog account={setupFor} onClose={() => setSetupFor(undefined)} />}
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        title={t("accounts.removeTitle")}
        actions={
          <>
            <button type="button" onClick={() => setRemoving(undefined)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="button-danger"
              onClick={() =>
                void api("DELETE", `/accounts/${removing?.id}`).then(
                  () => {
                    setRemoving(undefined);
                    accounts.reload();
                  },
                  (err) => setError(err as ApiError),
                )
              }
            >
              {t("accounts.remove")}
            </button>
          </>
        }
      >
        <p>{t("accounts.removeText", { account: removing?.label ?? "" })}</p>
      </Dialog>
    </div>
  );
}

function ConnectDialog({ adapter, desktop, onClose, onConnected }: { adapter: AdapterInfo; desktop: boolean; onClose: () => void; onConnected: () => void }) {
  const t = useT();
  const isSsh = adapter.auth.includes("ssh");
  const [token, setToken] = useState("");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<"user" | "team">("user");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [port, setPort] = useState("22");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState<{ keyId: string; publicKey: string }>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | "done">();
  const [inBrowser, setInBrowser] = useState(false);
  const guide = adapter.tokenSetup;
  const tokenUrl = guide?.url.replace("{baseUrl}", (options.baseUrl ?? "").replace(/\/+$/, ""));

  const run = async (fn: () => Promise<void>) => {
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = isSsh
        ? { adapter: adapter.id, host, user: sshUser, port: Number(port), password: password || undefined, keyId: key?.keyId, options, scope, label }
        : { adapter: adapter.id, token, options, scope, label };
      const connected = await post<{ verify: VerifyResult | null }>("/accounts", body);
      setPassword("");
      setToken("");
      setResult(connected.verify ?? "done");
      onConnected();
    });
  };

  return (
    <Dialog open onClose={onClose} title={t("accounts.connect", { provider: adapter.name })}>
      {result ? (
        <div className="stack">
          <p className="note note-ok" role="status">
            {t("accounts.connected")}
          </p>
          {result !== "done" && result.missingPermissions.length > 0 && (
            <div className="note note-warn">
              <p>{t("accounts.missing")}</p>
              <ul>
                {result.missingPermissions.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {result !== "done" &&
            result.warnings.map((w) => (
              <p key={w} className="hint">
                {w}
              </p>
            ))}
          <div className="actions">
            <button type="button" className="button-primary" onClick={onClose}>
              {t("common.done")}
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {adapter.auth.includes("oauth") && (
            <>
              {/* The most convenient method available on this instance comes first. */}
              <button
                type="button"
                className="button-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { url } = await post<{ url: string }>("/accounts/oauth", { adapter: adapter.id, scope, label });
                    // The desktop app hands the provider's page to the system browser; the builder stays open.
                    if (desktop) {
                      window.open(url, "_blank", "noopener");
                      setInBrowser(true);
                    } else location.href = url;
                  })
                }
              >
                {t("accounts.oauth", { provider: adapter.name })}
              </button>
              {inBrowser && (
                <p className="note" role="status">
                  {t("accounts.oauthBrowser")}
                </p>
              )}
              {adapter.auth.includes("token") && <p className="divider">{t("accounts.orToken")}</p>}
            </>
          )}

          {adapter.auth.includes("token") && guide && (
            <>
              {guide.fields?.map((f) => (
                <label key={f.name}>
                  {f.label}
                  {!f.required && <span className="hint"> ({t("common.optional")})</span>}
                  <input
                    value={options[f.name] ?? ""}
                    onChange={(e) => setOptions({ ...options, [f.name]: e.target.value })}
                    placeholder={f.placeholder}
                    required={f.required}
                    autoComplete="off"
                  />
                  {f.help && <span className="hint">{f.help}</span>}
                </label>
              ))}
              <ol className="steps">
                <li>
                  {tokenUrl && /^https?:\/\//.test(tokenUrl) ? (
                    <a href={tokenUrl} target="_blank" rel="noreferrer">
                      {t("accounts.openTokenPage")}
                    </a>
                  ) : (
                    t("accounts.tokenPageAfterUrl")
                  )}
                </li>
                {guide.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <p>{t("accounts.permissions")}</p>
              <ul>
                {guide.permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <label>
                {t("accounts.token")}
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
                <span className="hint">{t("accounts.tokenHint")}</span>
              </label>
            </>
          )}

          {isSsh && (
            <>
              <div className="field-row">
                <label>
                  {t("ssh.host")}
                  <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="203.0.113.10" autoComplete="off" />
                </label>
                <label>
                  {t("ssh.user")}
                  <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} required autoComplete="off" />
                </label>
                <label>
                  {t("ssh.port")}
                  <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" pattern="[0-9]+" required />
                </label>
              </div>
              {!key ? (
                <button type="button" disabled={busy || !host} onClick={() => void run(async () => setKey(await post("/accounts/ssh-key", { host })))}>
                  {t("ssh.generate")}
                </button>
              ) : (
                <>
                  <label>
                    {t("ssh.publicKey")}
                    <textarea readOnly rows={3} value={key.publicKey} onFocus={(e) => e.currentTarget.select()} />
                    <span className="hint">{t("ssh.publicKeyHint", { user: sshUser })}</span>
                  </label>
                  <label>
                    {t("ssh.password")}
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                    <span className="hint">{t("ssh.passwordHint")}</span>
                  </label>
                </>
              )}
            </>
          )}

          <div className="field-row">
            <label>
              {t("accounts.label")}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("accounts.labelPlaceholder")} />
            </label>
            <label>
              {t("accounts.scope")}
              <select value={scope} onChange={(e) => setScope(e.target.value as "user" | "team")}>
                <option value="user">{t("accounts.personal")}</option>
                <option value="team">{t("accounts.team")}</option>
              </select>
            </label>
          </div>
          <p className="hint">{t("accounts.scopeHint")}</p>
          <ErrorNote error={error} />
          <div className="actions">
            <button type="submit" className="button-primary" disabled={busy || (isSsh && !key)}>
              {t("accounts.save")}
            </button>
            <button type="button" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Server setup: every step is listed with what it changes, and nothing runs before the user approves. */
function SetupDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const t = useT();
  const plan = useLoad(() => get<SetupPlan>(`/accounts/${account.id}/setup`), [account.id]);
  const [approved, setApproved] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const stream = useJob(jobId, () => plan.reload());
  const todo = plan.data?.steps.filter((s) => s.needed && !s.skipped) ?? [];

  return (
    <Dialog open onClose={onClose} title={t("setup.title", { host: plan.data?.host ?? account.label })}>
      <ErrorNote error={plan.error ?? error} />
      {plan.data && (
        <div className="stack">
          <p className="hint">
            {plan.data.os.name} · {plan.data.os.arch}
          </p>
          {plan.data.warnings.map((w) => (
            <p key={w} className="note note-warn">
              {w}
            </p>
          ))}
          <ol className="steps">
            {plan.data.steps.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong>{" "}
                <StatusBadge
                  status={s.skipped ? "skipped" : s.needed ? "todo" : "ready"}
                  label={s.skipped ? t("setup.skipped") : s.needed ? t("setup.todo") : t("setup.done")}
                />
                {s.skipped && <p className="hint">{s.skipped}</p>}
                {s.needed && !s.skipped && (
                  <ul>
                    {s.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          {jobId ? (
            <JobActivity jobId={jobId} stream={stream} />
          ) : todo.length === 0 ? (
            <p className="note note-ok" role="status">
              {t("setup.nothing")}
            </p>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                {t("setup.approve")}
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="button-primary"
                  disabled={!approved}
                  onClick={() =>
                    void post<{ jobId: string }>(`/accounts/${account.id}/setup`, { approved: true }).then(
                      (r) => setJobId(r.jobId),
                      (err) => setError(err as ApiError),
                    )
                  }
                >
                  {t("setup.run")}
                </button>
              </div>
            </>
          )}
          {stream.job?.status === "succeeded" && (
            <p className="note note-ok" role="status">
              {t("setup.ready")}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
