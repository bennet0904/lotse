import { type FormEvent, useState } from "react";
import { type Account, type Adapters, type ApiError, get, type Project, post, useLoad } from "../api";
import { useI18n } from "../i18n";
import { Link } from "../router";
import { ErrorNote } from "./common";

/**
 * The project's repository on GitHub, GitLab or Forgejo. Once linked, every
 * change is pushed there; changes made outside are pulled before the next one,
 * and conflicts stop instead of overwriting anything.
 */
export function Repository({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { t } = useI18n();
  const accounts = useLoad(() => get<{ accounts: Account[] }>("/accounts"), []);
  const adapters = useLoad(() => get<Adapters>("/adapters"), []);
  const git = (accounts.data?.accounts ?? []).filter((a) => a.kind === "git");
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(project.name);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [previews, setPreviews] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const selected = accountId || git[0]?.id || "";
  const providerName = (id: string) => adapters.data?.git.find((g) => g.id === id)?.name ?? id;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const link = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await post(`/projects/${project.id}/git`, { accountId: selected, repo: name.trim(), create: mode === "create", private: visibility === "private" });
      onChanged();
    });
  };

  if (project.git) {
    const repo = `${project.git.repo.owner}/${project.git.repo.name}`;
    return (
      <section className="stack" aria-labelledby="repo-heading">
        <h3 id="repo-heading">{t("repo.title")}</h3>
        <p>
          {t("repo.linked", { provider: providerName(project.git.provider) })}{" "}
          <a href={project.git.repo.url} target="_blank" rel="noreferrer">
            {repo}
          </a>
        </p>
        <p className="hint">{t("repo.linkedHint")}</p>
        <ErrorNote error={error} />
        {note && (
          <p className="note note-ok" role="status">
            {note}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await post<{ pulled: string[] }>(`/projects/${project.id}/git/sync`);
                setNote(result.pulled.length > 0 ? t("repo.syncedWith", { files: result.pulled.join(", ") }) : t("repo.synced"));
                onChanged();
              })
            }
          >
            {t("repo.sync")}
          </button>
        </div>
        <h4>{t("repo.ciTitle")}</h4>
        {project.target ? (
          <>
            <p className="hint">{t("repo.ciHint")}</p>
            <label className="check">
              <input type="checkbox" checked={previews} onChange={(e) => setPreviews(e.target.checked)} />
              {t("repo.ciPreviews")}
            </label>
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await post<{ secrets: string[] }>(`/projects/${project.id}/git/ci`, { previews });
                    setNote(t("repo.ciDone", { secrets: result.secrets.join(", ") }));
                  })
                }
              >
                {t("repo.ciSetup")}
              </button>
            </div>
          </>
        ) : (
          <p className="hint">{t("repo.ciPublishFirst")}</p>
        )}
      </section>
    );
  }

  return (
    <section className="stack" aria-labelledby="repo-heading">
      <h3 id="repo-heading">{t("repo.title")}</h3>
      <p className="hint">{t("repo.intro")}</p>
      <ErrorNote error={error ?? accounts.error} />
      {accounts.data && git.length === 0 ? (
        <p>
          {t("repo.noAccount")} <Link to="/accounts">{t("publish.connect")}</Link>
        </p>
      ) : (
        accounts.data && (
          <form className="stack" onSubmit={link}>
            <label>
              {t("repo.account")}
              <select value={selected} onChange={(e) => setAccountId(e.target.value)}>
                {git.map((a) => (
                  <option key={a.id} value={a.id}>
                    {providerName(a.adapter)} · {a.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>{t("repo.which")}</legend>
              <label className="check">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={mode === "create"}
                  onChange={() => {
                    setMode("create");
                    setName(project.name);
                  }}
                />
                {t("repo.create")}
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="repo-mode"
                  checked={mode === "existing"}
                  onChange={() => {
                    setMode("existing");
                    setName("");
                  }}
                />
                {t("repo.existing")}
              </label>
            </fieldset>
            <label>
              {mode === "create" ? t("repo.name") : t("repo.fullName")}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === "create" ? project.name : "owner/name"}
                required
                autoComplete="off"
              />
            </label>
            {mode === "create" && (
              <label>
                {t("repo.visibility")}
                <select value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "public")}>
                  <option value="private">{t("repo.private")}</option>
                  <option value="public">{t("repo.public")}</option>
                </select>
              </label>
            )}
            <div className="actions">
              <button type="submit" className="button-primary" disabled={busy || !selected}>
                {t("repo.link")}
              </button>
            </div>
          </form>
        )
      )}
    </section>
  );
}
