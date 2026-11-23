import { type ApiError, get, post, type User, useLoad } from "./api";
import { ErrorNote, Spinner } from "./components/common";
import { LOCALES, type Locale, useI18n } from "./i18n";
import logo from "./logo.svg";
import { Accounts } from "./pages/Accounts";
import { ProjectPage } from "./pages/Project";
import { Projects } from "./pages/Projects";
import { type Config, Settings } from "./pages/Settings";
import { Link, usePath } from "./router";

export function App() {
  const { t } = useI18n();
  const path = usePath().split("?")[0] ?? "/";
  const config = useLoad(() => get<Config>("/config"), []);
  const me = useLoad(() => get<{ user: User }>("/me"), []);

  if (config.error)
    return (
      <main className="page">
        <ErrorNote error={config.error} />
      </main>
    );
  if (!config.data || (me.loading && !me.data))
    return (
      <main className="page">
        <Spinner label={t("common.loading")} />
      </main>
    );

  // Not signed in: with single sign-on the only thing to do is to sign in.
  if ((me.error as ApiError | undefined)?.status === 401) {
    return (
      <main className="login">
        <div className="login-card">
          <img className="login-logo" src={logo} alt="" width={48} height={48} />
          <h1>{t("login.heading")}</h1>
          <p className="hint">{t("login.text")}</p>
          <a className="button button-primary" href={`/api/v1/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}>
            {t("login.button")}
          </a>
          <p className="login-note hint">{t("login.note")}</p>
        </div>
        <LocaleSelect />
      </main>
    );
  }
  if (!me.data)
    return (
      <main className="page">
        <ErrorNote error={me.error} />
      </main>
    );
  const user = me.data.user;
  const project = path.match(/^\/projects\/([a-z0-9]+)$/)?.[1];

  return (
    <>
      <a href="#main" className="skip-link">
        {t("nav.skip")}
      </a>
      <header className="top">
        <Link to="/" className="brand">
          <img src={logo} alt="" width={24} height={24} />
          Lotse
        </Link>
        <nav aria-label={t("nav.main")}>
          <Link to="/" current={path === "/" || Boolean(project)}>
            {t("nav.projects")}
          </Link>
          <Link to="/accounts" current={path === "/accounts"}>
            {t("nav.accounts")}
          </Link>
          <Link to="/settings" current={path === "/settings"}>
            {t("nav.settings")}
          </Link>
        </nav>
        <div className="top-end">
          <LocaleSelect />
          {config.data.auth === "oidc" && (
            <>
              <span className="who">{user.name}</span>
              <button type="button" className="button-quiet" onClick={() => void post("/auth/logout").then(() => location.assign("/"))}>
                {t("nav.signout")}
              </button>
            </>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {project ? (
          <ProjectPage key={project} id={project} />
        ) : path === "/accounts" ? (
          <Accounts desktop={config.data.desktop} />
        ) : path === "/settings" ? (
          <Settings me={user} config={config.data} />
        ) : (
          <Projects />
        )}
      </main>
    </>
  );
}

function LocaleSelect() {
  const { t, locale, setLocale } = useI18n();
  return (
    <span className="locale">
      <label className="sr-only" htmlFor="locale">
        {t("nav.language")}
      </label>
      <select id="locale" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </span>
  );
}
