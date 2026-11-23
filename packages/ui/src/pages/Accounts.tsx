import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type Account, type AdapterInfo, type Adapters, type ApiError, api, get, post, type SetupPlan, type TokenSetup, useJob, useLoad } from "../api";
import { Dialog, ErrorNote, Spinner, StatusBadge } from "../components/common";
import { JobActivity } from "../components/JobActivity";
import { type MessageKey, useT } from "../i18n";

interface VerifyResult {
  ok: boolean;
  missingPermissions: string[];
  warnings: string[];
}

const KIND: Record<Account["kind"], MessageKey> = {
  hosting: "accounts.hosting",
  git: "accounts.git",
  resource: "accounts.resources",
};

const METHOD: Record<AdapterInfo["auth"][number], MessageKey> = {
  oauth: "accounts.method.oauth",
  token: "accounts.method.token",
  ssh: "accounts.method.ssh",
};

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
  const connected = accounts.data?.accounts;
  const connectedCount = (id: string) => connected?.filter((a) => a.adapter === id).length ?? 0;

  const groups: { id: string; title: string; items: AdapterInfo[] }[] = [
    { id: "hosting", title: t("accounts.hosting"), items: adapters.data?.hosting ?? [] },
    { id: "git", title: t("accounts.git"), items: adapters.data?.git ?? [] },
    { id: "resources", title: t("accounts.resources"), items: adapters.data?.resources ?? [] },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="page providers">
      <h1>{t("accounts.heading")}</h1>
      <p className="hint providers-intro">{t("accounts.intro")}</p>
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

      <section aria-labelledby="connected-heading">
        <h2 id="connected-heading">{t("accounts.yours")}</h2>
        {!connected && !accounts.error && <Spinner label={t("common.loading")} />}
        {connected?.length === 0 && (
          <div className="empty">
            <h3>{t("accounts.empty.title")}</h3>
            <p className="hint">{t("accounts.empty.text")}</p>
          </div>
        )}
        {connected && connected.length > 0 && (
          <ul className="row-list">
            {connected.map((a) => (
              <li key={a.id} className="list-row account-row">
                <div className="list-row-main">
                  <span className="list-row-title">
                    <strong>{name(a.adapter)}</strong>
                    {a.label && <span className="account-label">{a.label}</span>}
                  </span>
                  <span className="list-row-meta">
                    <StatusBadge status={`scope-${a.scope}`} label={a.scope === "team" ? t("accounts.team") : t("accounts.personal")} />
                    <span>{t(KIND[a.kind])}</span>
                    {a.account && <span className="account-id">{a.account}</span>}
                  </span>
                </div>
                <div className="actions account-actions">
                  {adapters.data?.hosting.find((h) => h.id === a.adapter)?.serverSetup && (
                    <button type="button" onClick={() => setSetupFor(a)}>
                      {t("accounts.setup")}
                    </button>
                  )}
                  <button type="button" className="button-quiet" onClick={() => setRemoving(a)}>
                    {t("accounts.remove")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="add-heading">
        <h2 id="add-heading">{t("accounts.add")}</h2>
        {!adapters.data && !adapters.error && <Spinner label={t("common.loading")} />}
        {groups.length > 1 && (
          <nav className="provider-jump" aria-label={t("accounts.add")}>
            {groups.map((g) => (
              <a key={g.id} href={`#providers-${g.id}`} className="provider-jump-link">
                {g.title} <span className="provider-count">{g.items.length}</span>
              </a>
            ))}
          </nav>
        )}
        {groups.map((group) => (
          <section key={group.id} id={`providers-${group.id}`} className="provider-group" aria-labelledby={`providers-${group.id}-heading`}>
            <h3 id={`providers-${group.id}-heading`}>{group.title}</h3>
            <ul className="row-list">
              {group.items.map((a) => {
                const count = connectedCount(a.id);
                const offers = [a.capabilities?.runtimes.join(", "), (a.capabilities?.resources ?? a.resources ?? []).join(", ")].filter(Boolean);
                return (
                  <li key={a.id} className="list-row provider-row">
                    <div className="list-row-main">
                      <span className="list-row-title">
                        <strong>{a.name}</strong>
                        {count > 0 && <StatusBadge status="ready" label={t("accounts.connectedBadge", { count })} />}
                      </span>
                      <span className="list-row-meta">
                        {offers.length > 0 && <span>{offers.join(" · ")}</span>}
                        <span className="provider-method">{a.auth.map((m) => t(METHOD[m])).join(" / ")}</span>
                      </span>
                    </div>
                    <button type="button" onClick={() => setConnecting(a)} aria-label={t("accounts.connect", { provider: a.name })}>
                      {t("accounts.save")}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </section>

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

/**
 * One numbered part of a form; optional parts say so in their heading. A heading rather than a
 * <legend>, so the step title does not become part of the fields' accessible names.
 */
function Step({ n, title, optional, children }: { n: number; title: string; optional?: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <div className="form-step">
      <h3 className="form-step-title">
        <span className="form-step-n" aria-hidden="true">
          {n}
        </span>
        <span>
          {title}
          {optional && <span className="hint"> ({t("common.optional")})</span>}
        </span>
      </h3>
      <div className="stack form-step-body">{children}</div>
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
  const [baseDomain, setBaseDomain] = useState("");
  const [s3, setS3] = useState({ bucket: "", endpoint: "", region: "", accessKey: "", secretKey: "" });
  const [key, setKey] = useState<{ keyId: string; publicKey: string }>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | "done">();
  const [inBrowser, setInBrowser] = useState(false);
  const guide = adapter.tokenSetup;
  const tokenUrl = guide?.url.replace("{baseUrl}", (options.baseUrl ?? "").replace(/\/+$/, ""));
  const withToken = adapter.auth.includes("token") && guide;
  // The instance's address comes first, because the token page lives there; other fields go with the token.
  const instanceFields = (guide?.fields ?? []).filter((f) => f.name === "baseUrl");
  const otherFields = (guide?.fields ?? []).filter((f) => f.name !== "baseUrl");
  let step = 0;

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
      // Backups can additionally go to S3-compatible storage; its keys are stored with the account's credentials.
      const sshOptions = {
        ...options,
        ...(baseDomain.trim() ? { baseDomain: baseDomain.trim().toLowerCase() } : {}),
        ...(s3.bucket.trim()
          ? {
              s3Bucket: s3.bucket.trim(),
              ...(s3.endpoint.trim() ? { s3Endpoint: s3.endpoint.trim() } : {}),
              ...(s3.region.trim() ? { s3Region: s3.region.trim() } : {}),
            }
          : {}),
      };
      const sshSecrets = s3.bucket.trim() ? { s3AccessKey: s3.accessKey.trim(), s3SecretKey: s3.secretKey } : undefined;
      const body = isSsh
        ? {
            adapter: adapter.id,
            host,
            user: sshUser,
            port: Number(port),
            password: password || undefined,
            keyId: key?.keyId,
            options: sshOptions,
            secrets: sshSecrets,
            scope,
            label,
          }
        : { adapter: adapter.id, token, options, scope, label };
      const connected = await post<{ verify: VerifyResult | null }>("/accounts", body);
      setPassword("");
      setS3((current) => ({ ...current, secretKey: "" }));
      setToken("");
      setResult(connected.verify ?? "done");
      onConnected();
    });
  };

  const field = (f: NonNullable<TokenSetup["fields"]>[number]) => (
    <label key={f.name}>
      <span>
        {f.label}
        {!f.required && <span className="hint"> ({t("common.optional")})</span>}
      </span>
      <input
        value={options[f.name] ?? ""}
        onChange={(e) => setOptions({ ...options, [f.name]: e.target.value })}
        placeholder={f.placeholder}
        required={f.required}
        autoComplete="off"
      />
      {f.help && <span className="hint">{f.help}</span>}
    </label>
  );

  const copyKey = () => {
    if (!key) return;
    void navigator.clipboard?.writeText(key.publicKey).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t("accounts.connect", { provider: adapter.name })}
        actions={
          <button type="button" className="button-primary" onClick={onClose}>
            {t("common.done")}
          </button>
        }
      >
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
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("accounts.connect", { provider: adapter.name })}
      actions={
        <>
          <button type="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="connect-form" className="button-primary" disabled={busy || (isSsh && !key)}>
            {t("accounts.save")}
          </button>
        </>
      }
    >
      <form id="connect-form" className="stack connect-form" onSubmit={submit}>
        {adapter.auth.includes("oauth") && (
          <div className="stack">
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
            {withToken && <p className="divider">{t("accounts.orToken")}</p>}
          </div>
        )}

        {withToken && (
          <>
            {instanceFields.length > 0 && (
              <Step n={++step} title={t("accounts.step.instance")}>
                {instanceFields.map(field)}
              </Step>
            )}
            <Step n={++step} title={t("accounts.step.create")}>
              {tokenUrl && /^https?:\/\//.test(tokenUrl) ? (
                <p>
                  <a href={tokenUrl} target="_blank" rel="noreferrer" className="button">
                    {t("accounts.openTokenPage")} ↗
                  </a>
                </p>
              ) : (
                <p className="hint">{t("accounts.tokenPageAfterUrl")}</p>
              )}
              {guide.steps.length > 0 && (
                <ol className="token-steps">
                  {guide.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              )}
              {guide.permissions.length > 0 && (
                <div className="permissions">
                  <p className="permissions-title">{t("accounts.permissions")}</p>
                  <ul>
                    {guide.permissions.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Step>
            <Step n={++step} title={t("accounts.step.paste")}>
              <label>
                {t("accounts.token")}
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" spellCheck={false} />
                <span className="hint">{t("accounts.tokenHint")}</span>
              </label>
              {otherFields.map(field)}
            </Step>
          </>
        )}

        {isSsh && (
          <>
            <Step n={++step} title={t("ssh.step.server")}>
              <div className="field-row">
                <label className="field-wide">
                  {t("ssh.host")}
                  <input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="203.0.113.10" autoComplete="off" spellCheck={false} />
                </label>
                <label>
                  {t("ssh.user")}
                  <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} required autoComplete="off" spellCheck={false} />
                </label>
                <label className="field-narrow">
                  {t("ssh.port")}
                  <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" pattern="[0-9]+" required />
                </label>
              </div>
            </Step>
            <Step n={++step} title={t("ssh.step.key")}>
              {!key ? (
                <>
                  <p className="hint">{t("ssh.generateHint")}</p>
                  <div className="actions">
                    <button type="button" disabled={busy || !host} onClick={() => void run(async () => setKey(await post("/accounts/ssh-key", { host })))}>
                      {t("ssh.generate")}
                    </button>
                    {!host && <span className="hint">{t("ssh.hostFirst")}</span>}
                  </div>
                </>
              ) : (
                <>
                  <label>
                    {t("ssh.publicKey")}
                    <textarea className="public-key" readOnly rows={3} value={key.publicKey} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
                    <span className="hint">{t("ssh.publicKeyHint", { user: sshUser })}</span>
                  </label>
                  <div className="actions">
                    <button type="button" onClick={copyKey}>
                      {t("ssh.copy")}
                    </button>
                    {copied && (
                      <span className="hint" role="status">
                        {t("ssh.copied")}
                      </span>
                    )}
                  </div>
                  <label>
                    {t("ssh.password")}
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                    <span className="hint">{t("ssh.passwordHint")}</span>
                  </label>
                </>
              )}
            </Step>
            {key && (
              <Step n={++step} title={t("ssh.step.extras")} optional>
                <label>
                  {t("ssh.baseDomain")}
                  <input
                    value={baseDomain}
                    onChange={(e) => setBaseDomain(e.target.value)}
                    placeholder="apps.example.com"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="hint">{t("ssh.baseDomainHint")}</span>
                </label>
                <details className="s3">
                  <summary>{t("ssh.s3")}</summary>
                  <div className="stack">
                    <p className="hint">{t("ssh.s3Hint")}</p>
                    <label>
                      {t("ssh.s3Bucket")}
                      <input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} autoComplete="off" spellCheck={false} />
                    </label>
                    <div className="field-row">
                      <label className="field-wide">
                        <span>
                          {t("ssh.s3Endpoint")} <span className="hint">({t("common.optional")})</span>
                        </span>
                        <input
                          value={s3.endpoint}
                          onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
                          placeholder="https://s3.amazonaws.com"
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        <span>
                          {t("ssh.s3Region")} <span className="hint">({t("common.optional")})</span>
                        </span>
                        <input value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} placeholder="us-east-1" autoComplete="off" />
                      </label>
                    </div>
                    <div className="field-row">
                      <label>
                        {t("ssh.s3AccessKey")}
                        <input
                          value={s3.accessKey}
                          onChange={(e) => setS3({ ...s3, accessKey: e.target.value })}
                          required={Boolean(s3.bucket.trim())}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </label>
                      <label>
                        {t("ssh.s3SecretKey")}
                        <input
                          type="password"
                          value={s3.secretKey}
                          onChange={(e) => setS3({ ...s3, secretKey: e.target.value })}
                          required={Boolean(s3.bucket.trim())}
                          autoComplete="off"
                        />
                      </label>
                    </div>
                  </div>
                </details>
              </Step>
            )}
          </>
        )}

        <Step n={++step} title={t("accounts.step.details")}>
          <label>
            {t("accounts.label")}
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("accounts.labelPlaceholder")} />
          </label>
          <fieldset className="choice">
            <legend>{t("accounts.scope")}</legend>
            <label className="check">
              <input type="radio" name="scope" value="user" checked={scope === "user"} onChange={() => setScope("user")} />
              {t("accounts.personal")}
            </label>
            <label className="check">
              <input type="radio" name="scope" value="team" checked={scope === "team"} onChange={() => setScope("team")} />
              <span>
                {t("accounts.team")}
                <span className="hint choice-hint">{t("accounts.scopeHint")}</span>
              </span>
            </label>
          </fieldset>
        </Step>
        <ErrorNote error={error} />
      </form>
    </Dialog>
  );
}

const STEP_STATE = {
  todo: { status: "todo", label: "setup.todo" },
  done: { status: "ready", label: "setup.done" },
  skipped: { status: "skipped", label: "setup.skipped" },
} as const satisfies Record<string, { status: string; label: MessageKey }>;

/** Server setup: every step is listed with what it changes, and nothing runs before the user approves. */
function SetupDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const t = useT();
  const plan = useLoad(() => get<SetupPlan>(`/accounts/${account.id}/setup`), [account.id]);
  const [approved, setApproved] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError>();
  const stream = useJob(jobId, () => plan.reload());
  const steps = (plan.data?.steps ?? []).map((s) => ({ ...s, state: s.skipped ? "skipped" : s.needed ? "todo" : "done" }) as const);
  const count = (state: keyof typeof STEP_STATE) => steps.filter((s) => s.state === state).length;
  const todo = count("todo");
  const canRun = Boolean(plan.data) && !jobId && todo > 0;

  const start = () =>
    void post<{ jobId: string }>(`/accounts/${account.id}/setup`, { approved: true }).then(
      (r) => setJobId(r.jobId),
      (err) => setError(err as ApiError),
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("setup.title", { host: plan.data?.host ?? account.label })}
      actions={
        <>
          <button type="button" onClick={onClose}>
            {canRun ? t("common.cancel") : t("common.close")}
          </button>
          {canRun && (
            <button type="button" className="button-primary" disabled={!approved} onClick={start}>
              {t("setup.run")}
            </button>
          )}
        </>
      }
    >
      <ErrorNote error={plan.error ?? error} />
      {!plan.data && !plan.error && <Spinner label={t("common.loading")} />}
      {plan.data && (
        <div className="stack">
          <p className="setup-summary">
            <span className="hint">
              {plan.data.os.name} · {plan.data.os.arch}
            </span>
            <span className="hint">{t("setup.summary", { todo, done: count("done"), skipped: count("skipped") })}</span>
          </p>
          {plan.data.warnings.map((w) => (
            <p key={w} className="note note-warn">
              {w}
            </p>
          ))}
          <ol className="setup-steps">
            {steps.map((s) => (
              <li key={s.id} className={`setup-step setup-step-${s.state}`}>
                <div className="setup-step-head">
                  <strong>{s.title}</strong>
                  <StatusBadge status={STEP_STATE[s.state].status} label={t(STEP_STATE[s.state].label)} />
                </div>
                {s.state === "skipped" && <p className="hint">{s.skipped}</p>}
                {s.state === "todo" && s.changes.length > 0 && (
                  <ul className="setup-changes">
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
          ) : todo === 0 ? (
            <p className="note note-ok" role="status">
              {t("setup.nothing")}
            </p>
          ) : (
            <div className="approval">
              <p className="hint">{t("setup.beforeApproval")}</p>
              <label className="check">
                <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                {t("setup.approve")}
              </label>
            </div>
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
