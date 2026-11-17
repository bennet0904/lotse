import { type FormEvent, useState } from "react";
import { type ApiError, api, get, post, type User, useLoad } from "../api";
import { ErrorNote } from "../components/common";
import { useI18n } from "../i18n";

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
    <section>
      <h2>{t("settings.githubApp")}</h2>
      {query.get("github") === "registered" && (
        <p className="note note-ok" role="status">
          {t("settings.githubRegistered")}
        </p>
      )}
      <ErrorNote error={error ?? app.error} />
      {app.data?.registered ? (
        <>
          <p>
            {t("settings.githubAppIs")} <a href={app.data.url}>{app.data.slug}</a>
          </p>
          <p className="hint">{t("settings.githubInstallHint")}</p>
          <p>
            <a className="button" href={app.data.installUrl}>
              {t("settings.githubInstall")}
            </a>
          </p>
        </>
      ) : (
        app.data && (
          <form className="stack" onSubmit={register}>
            <p className="hint">{t("settings.githubAppHint")}</p>
            <label>
              {t("settings.githubOrganization")} <span className="hint">({t("common.optional")})</span>
              <input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="acme" autoComplete="off" />
            </label>
            <div className="actions">
              <button type="submit" className="button-primary" disabled={busy}>
                {t("settings.githubRegister")}
              </button>
            </div>
          </form>
        )
      )}
    </section>
  );
}

interface AuditEntry {
  id: string;
  at: number;
  userId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
}

export function Settings({ me, config }: { me: User; config: Config }) {
  const { t, locale } = useI18n();
  const isAdmin = me.role !== "member";
  const users = useLoad(() => (isAdmin && config.auth === "oidc" ? get<{ users: User[] }>("/users") : Promise.resolve(undefined)), [isAdmin]);
  const audit = useLoad(() => (isAdmin ? get<{ entries: AuditEntry[] }>("/audit?limit=100") : Promise.resolve(undefined)), [isAdmin]);
  const [error, setError] = useState<ApiError>();
  const names = new Map((users.data?.users ?? [me]).map((u) => [u.id, u.name]));

  return (
    <div className="page">
      <h1>{t("settings.heading")}</h1>
      <ErrorNote error={error ?? users.error ?? audit.error} />

      <section>
        <h2>{t("settings.instance")}</h2>
        <dl className="facts">
          <dt>{t("settings.version")}</dt>
          <dd>{config.version}</dd>
          <dt>{t("settings.signin")}</dt>
          <dd>{config.auth === "oidc" ? "OpenID Connect" : t("settings.singleUser")}</dd>
          <dt>{t("settings.models")}</dt>
          <dd>
            {config.models.implement ?? "anthropic:claude-opus-5-5"}
            {config.models.plan && config.models.plan !== config.models.implement ? ` (${t("settings.planning")}: ${config.models.plan})` : ""}
          </dd>
          <dt>{t("settings.sandbox")}</dt>
          <dd>{t("settings.sandboxValue", { cpus: config.sandbox.cpus, memory: config.sandbox.memoryMb, isolation: config.sandbox.isolation })}</dd>
          <dt>{t("settings.telemetry")}</dt>
          <dd>{t("settings.telemetryOff")}</dd>
        </dl>
      </section>

      {isAdmin && !config.desktop && <GithubAppSection />}

      {users.data && (
        <section>
          <h2>{t("settings.users")}</h2>
          <table>
            <caption className="sr-only">{t("settings.users")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("settings.name")}</th>
                <th scope="col">{t("settings.email")}</th>
                <th scope="col">{t("settings.role")}</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <th scope="row">{u.name}</th>
                  <td>{u.email}</td>
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
        </section>
      )}

      {audit.data && (
        <section>
          <h2>{t("settings.audit")}</h2>
          <p className="hint">{t("settings.auditHint")}</p>
          <table>
            <caption className="sr-only">{t("settings.audit")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("settings.when")}</th>
                <th scope="col">{t("settings.who")}</th>
                <th scope="col">{t("settings.action")}</th>
                <th scope="col">{t("settings.target")}</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.at).toLocaleString(locale)}</td>
                  <td>{e.userId ? (names.get(e.userId) ?? e.userId) : "–"}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td>{e.target ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export type { Config };
