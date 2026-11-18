import { type FormEvent, useState } from "react";
import { type ApiError, api, get, useLoad } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote } from "./common";

/** The app's secrets declared in lotse.yaml: which are set, and new values. Values are never shown. */
export function Secrets({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const list = useLoad(() => get<{ secrets: { name: string; set: boolean }[] }>(`/projects/${projectId}/secrets`), [projectId]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!list.data || list.data.secrets.length === 0) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      for (const [name, value] of Object.entries(values)) if (value) await api("PUT", `/projects/${projectId}/secrets/${name}`, { value });
      setValues({});
      setSaved(true);
      list.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details>
      <summary>{t("secrets.title")}</summary>
      <p className="hint">{t("secrets.hint")}</p>
      <ErrorNote error={error ?? list.error} />
      {saved && (
        <p className="note note-ok" role="status">
          {t("secrets.saved")}
        </p>
      )}
      <form className="stack" onSubmit={save}>
        {list.data.secrets.map((s) => (
          <label key={s.name}>
            <code>{s.name}</code> <span className="hint">({s.set ? t("secrets.set") : t("secrets.notSet")})</span>
            <input
              type="password"
              autoComplete="off"
              value={values[s.name] ?? ""}
              placeholder={s.set ? "••••••••" : ""}
              onChange={(e) => setValues({ ...values, [s.name]: e.target.value })}
            />
          </label>
        ))}
        <div className="actions">
          <button type="submit" disabled={busy || !Object.values(values).some(Boolean)}>
            {t("secrets.save")}
          </button>
        </div>
      </form>
    </details>
  );
}
