import { type FormEvent, type ReactNode, useState } from "react";
import { type ApiError, api, get, post, type User, useLoad } from "../api";
import { ErrorNote } from "../components/common";
import { ModelSettings } from "../components/ModelSettings";
import { type MessageKey, useI18n } from "../i18n";

interface Config {
  version: string;
  auth: "none" | "oidc";
  /** The builder runs inside the desktop app. */
  desktop: boolean;
  telemetry: boolean;
  models: { plan: string | null; implement: string | null };
  sandbox: { cpus: number; memoryMb: number; isolation: string };
}

interface GithubApp {
  registered: boolean;
  slug?: string;
  url?: string;
  installUrl?: string;
}

/** A section of the settings page: a card with a heading, an optional hint and an anchor for the section list. */
function SettingsSection({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} className="card settings-section">
      <header className="section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {hint && <p className="hint">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/**
 * GitHub's manifest flow: the manifest is posted to GitHub by the browser, the
 * administrator picks a name there, and GitHub sends them back with the app's credentials.
 */
function GithubAppSection() {
  const { t } = useI18n();
  const app = useLoad(() => get<GithubApp>("/git/github/app"), []);
  const [organization, setOrganization] = useState("");
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams(location.search);

  const register = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { url, manifest } = await post<{ url: string; manifest: Record<string, unknown> }>("/git/github/app/manifest", {
        organization: organization.trim() || undefined,
      });
      const form = document.createElement("form");
      form.method = "post";
      form.action = url;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = JSON.stringify(manifest);
      form.append(field);
      document.body.append(form);
      form.submit();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="github-app"
      title={t("settings.githubApp")}
      hint={app.data?.registered ? t("settings.githubInstallHint") : t("settings.githubAppHint")}
    >
      {query.get("github") === "registered" && (
        <p className="note note-ok" role="status">
          {t("settings.githubRegistered")}
        </p>
      )}
      {query.get("error") && (
        <p className="note note-error" role="alert">
          {query.get("error")}
        </p>
      )}
      <ErrorNote error={error ?? app.error} />
      {app.data?.registered ? (
        <div className="settings-row">
          <p className="settings-row-text">
            <span className="badge badge-set">{t("settings.githubRegisteredBadge")}</span> <a href={app.data.url}>{app.data.slug}</a>
          </p>
          <a className="button button-primary" href={app.data.installUrl}>
            {t("settings.githubInstall")}
          </a>
        </div>
      ) : (
        app.data && (
          <form className="settings-row" onSubmit={register}>
            <label className="settings-row-field">
              <span>
                {t("settings.githubOrganization")} <span className="hint">({t("common.optional")})</span>
              </span>
              <input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="acme" autoComplete="off" />
            </label>
            <button type="submit" className="button-primary" disabled={busy}>
              {t("settings.githubRegister")}
            </button>
          </form>
        )
      )}
    </SettingsSection>
  );
}

interface AuditEntry {
  id: string;
  at: number;
  userId: string | null;
  action: string;
  target: string | null;
  detail?: unknown;
  ip: string | null;
}

/** Readable names for the actions the server records; unknown actions show their code. */
const AUDIT_ACTIONS: Record<string, MessageKey> = {
  signin: "audit.signin",
  "signin.failed": "audit.signinFailed",
  "deploy.started": "audit.deployStarted",
  "deploy.rollback": "audit.deployRollback",
  "app.deleted": "audit.appDeleted",
  "domain.added": "audit.domainAdded",
  "backup.restored": "audit.backupRestored",
  "server.setup": "audit.serverSetup",
  "ci.configured": "audit.ciConfigured",
  "credentials.added": "audit.credentialsAdded",
  "credentials.removed": "audit.credentialsRemoved",
  "secret.set": "audit.secretSet",
  "github-app.registered": "audit.githubAppRegistered",
  "user.role": "audit.userRole",
  "model-settings.changed": "audit.modelSettingsChanged",
};

type AuditKind = "all" | "signin" | "publishing" | "access" | "people";
const AUDIT_KINDS: { kind: AuditKind; label: MessageKey; actions?: string[] }[] = [
  { kind: "all", label: "audit.kind.all" },
  { kind: "signin", label: "audit.kind.signin", actions: ["signin", "signin.failed"] },
  {
    kind: "publishing",
    label: "audit.kind.publishing",
    actions: ["deploy.started", "deploy.rollback", "app.deleted", "domain.added", "backup.restored", "server.setup", "ci.configured"],
  },
  { kind: "access", label: "audit.kind.access", actions: ["credentials.added", "credentials.removed", "secret.set", "github-app.registered"] },
  { kind: "people", label: "audit.kind.people", actions: ["user.role", "model-settings.changed"] },
];
const AUDIT_PAGE = 30;

/** The audit log, newest first, grouped by day, filterable by kind and shown a page at a time. */
function AuditLog({ entries, names }: { entries: AuditEntry[]; names: Map<string, string> }) {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<AuditKind>("all");
  const [shown, setShown] = useState(AUDIT_PAGE);
  const actions = AUDIT_KINDS.find((k) => k.kind === kind)?.actions;
  const matching = actions ? entries.filter((e) => actions.includes(e.action)) : entries;
  const visible = matching.slice(0, shown);

  const days: { day: string; entries: AuditEntry[] }[] = [];
  for (const entry of visible) {
    const day = new Date(entry.at).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }

  const target = (e: AuditEntry) => {
    if (!e.target) return "";
    const name = names.get(e.target) ?? e.target;
    const role = e.action === "user.role" ? (e.detail as { role?: string } | null)?.role : undefined;
    return role === "owner" || role === "admin" || role === "member" ? `${name} → ${t(`role.${role}`)}` : name;
  };

  return (
    <>
      <div className="audit-toolbar">
        <label>
          {t("audit.show")}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as AuditKind);
              setShown(AUDIT_PAGE);
            }}
          >
            {AUDIT_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {t(k.label)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint" aria-live="polite">
          {t("audit.count", { shown: visible.length, total: matching.length })}
        </p>
      </div>
      {matching.length === 0 && <p className="hint">{t("audit.empty")}</p>}
      {days.map(({ day, entries }) => (
        <div key={day} className="audit-day">
          <h3>{day}</h3>
          <ol className="audit-list">
            {entries.map((e) => {
              const label = AUDIT_ACTIONS[e.action];
              const who = e.userId ? (names.get(e.userId) ?? e.userId) : t("audit.nobody");
              return (
                <li key={e.id} className={`audit-entry${e.action.endsWith(".failed") ? " audit-entry-failed" : ""}`}>
                  <time className="audit-time" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString(locale)}>
                    {new Date(e.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                  </time>
                  <div className="audit-text">
                    <span className="audit-what">{label ? t(label) : e.action}</span>
                    {e.target && <span className="audit-target"> · {target(e)}</span>}
                    <span className="audit-meta">
                      {who}
                      {e.ip && <> · {e.ip}</>} · <code>{e.action}</code>
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {matching.length > shown && (
        <button type="button" onClick={() => setShown(shown + AUDIT_PAGE)}>
          {t("audit.more")}
        </button>
      )}
    </>
  );
}

export function Settings({ me, config }: { me: User; config: Config }) {
  const { t } = useI18n();
  const isAdmin = me.role !== "member";
  const users = useLoad(() => (isAdmin && config.auth === "oidc" ? get<{ users: User[] }>("/users") : Promise.resolve(undefined)), [isAdmin]);
  const audit = useLoad(() => (isAdmin ? get<{ entries: AuditEntry[] }>("/audit?limit=500") : Promise.resolve(undefined)), [isAdmin]);
  const [error, setError] = useState<ApiError>();
  const names = new Map((users.data?.users ?? [me]).map((u) => [u.id, u.name]));

  const sections: { id: string; title: string }[] = [
    { id: "installation", title: t("settings.instance") },
    ...(isAdmin ? [{ id: "models", title: t("models.title") }] : []),
    ...(isAdmin && !config.desktop ? [{ id: "github-app", title: t("settings.githubApp") }] : []),
    ...(users.data ? [{ id: "people", title: t("settings.users") }] : []),
    ...(audit.data ? [{ id: "audit", title: t("settings.audit") }] : []),
  ];

  return (
    <div className="page settings">
      <h1>{t("settings.heading")}</h1>
      <ErrorNote error={error ?? users.error ?? audit.error} />

      <div className="settings-layout">
        {sections.length > 1 && (
          <nav className="settings-nav" aria-label={t("settings.sections")}>
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <a className="settings-link" href={`#${s.id}`}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="settings-sections">
          <SettingsSection id="installation" title={t("settings.instance")}>
            <dl className="facts">
              <dt>{t("settings.version")}</dt>
              <dd>{config.version}</dd>
              <dt>{t("settings.signin")}</dt>
              <dd>{config.auth === "oidc" ? "OpenID Connect" : t("settings.singleUser")}</dd>
              <dt>{t("settings.models")}</dt>
              <dd>
                <code>{config.models.implement ?? "anthropic:claude-opus-5-5"}</code>
                {config.models.plan && config.models.plan !== config.models.implement && (
                  <>
                    {" "}
                    ({t("settings.planning")}: <code>{config.models.plan}</code>)
                  </>
                )}
              </dd>
              <dt>{t("settings.sandbox")}</dt>
              <dd>{t("settings.sandboxValue", { cpus: config.sandbox.cpus, memory: config.sandbox.memoryMb, isolation: config.sandbox.isolation })}</dd>
              <dt>{t("settings.telemetry")}</dt>
              <dd>{t("settings.telemetryOff")}</dd>
            </dl>
          </SettingsSection>

          {isAdmin && (
            <SettingsSection id="models" title={t("models.title")} hint={t("models.hint")}>
              <ModelSettings />
            </SettingsSection>
          )}

          {isAdmin && !config.desktop && <GithubAppSection />}

          {users.data && (
            <SettingsSection id="people" title={t("settings.users")} hint={t("settings.usersHint")}>
              <div className="table-wrap people">
                <table>
                  <caption className="sr-only">{t("settings.users")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("settings.person")}</th>
                      <th scope="col">{t("settings.role")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.data.users.map((u) => (
                      <tr key={u.id}>
                        <th scope="row">
                          <span className="person-name">
                            {u.name}
                            {u.id === me.id && <span className="badge">{t("settings.you")}</span>}
                          </span>
                          <span className="person-email">{u.email}</span>
                        </th>
                        <td>
                          <label className="sr-only" htmlFor={`role-${u.id}`}>
                            {t("settings.roleOf", { name: u.name })}
                          </label>
                          <select
                            id={`role-${u.id}`}
                            value={u.role}
                            disabled={u.id === me.id && me.role !== "owner"}
                            onChange={(e) =>
                              void api("PATCH", `/users/${u.id}`, { role: e.target.value }).then(
                                () => {
                                  setError(undefined);
                                  users.reload();
                                },
                                (err) => setError(err as ApiError),
                              )
                            }
                          >
                            <option value="owner">{t("role.owner")}</option>
                            <option value="admin">{t("role.admin")}</option>
                            <option value="member">{t("role.member")}</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SettingsSection>
          )}

          {audit.data && (
            <SettingsSection id="audit" title={t("settings.audit")} hint={t("settings.auditHint")}>
              <AuditLog entries={audit.data.entries} names={names} />
            </SettingsSection>
          )}
        </div>
      </div>
    </div>
  );
}

export type { Config };
