import { type FormEvent, useState } from "react";
import { type ApiError, api, get, useLoad } from "../api";
import { type MessageKey, useI18n } from "../i18n";
import { ErrorNote } from "./common";

type Field = "defaultModel" | "anthropicKey" | "openaiKey" | "ollamaUrl" | "lmstudioUrl" | "compatibleUrl" | "compatibleKey";
type View = Record<Field, { value: string | null; configured: boolean; source: "settings" | "environment" | null }>;

const FIELDS: { field: Field; label: MessageKey; secret: boolean; placeholder?: string }[] = [
  { field: "defaultModel", label: "models.default", secret: false, placeholder: "anthropic:claude-opus-5-5" },
  { field: "anthropicKey", label: "models.anthropicKey", secret: true },
  { field: "openaiKey", label: "models.openaiKey", secret: true },
  { field: "ollamaUrl", label: "models.ollamaUrl", secret: false, placeholder: "http://127.0.0.1:11434" },
  { field: "lmstudioUrl", label: "models.lmstudioUrl", secret: false, placeholder: "http://127.0.0.1:1234" },
  { field: "compatibleUrl", label: "models.compatibleUrl", secret: false, placeholder: "https://llm.example.com/v1" },
  { field: "compatibleKey", label: "models.compatibleKey", secret: true },
];

/** Default model, API keys and local model servers. Keys are stored encrypted and never shown again. */
export function ModelSettings() {
  const { t } = useI18n();
  const settings = useLoad(() => get<View>("/settings/models"), []);
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      // An emptied field means "leave as it is"; a single space removes the stored value.
      await api("PUT", "/settings/models", Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== "")));
      setDraft({});
      setSaved(true);
      settings.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const state = (field: Field) => {
    const s = settings.data?.[field];
    if (!s?.configured) return t("models.notSet");
    return s.source === "environment" ? t("models.fromEnvironment") : t("models.stored");
  };

  return (
    <section>
      <h2>{t("models.title")}</h2>
      <p className="hint">{t("models.hint")}</p>
      <ErrorNote error={error ?? settings.error} />
      {saved && (
        <p className="note note-ok" role="status">
          {t("models.saved")}
        </p>
      )}
      {settings.data && (
        <form className="stack" onSubmit={save}>
          {FIELDS.map(({ field, label, secret, placeholder }) => {
            const current = settings.data?.[field];
            return (
              <label key={field}>
                {t(label)} <span className="hint">({state(field)})</span>
                <input
                  type={secret ? "password" : "text"}
                  autoComplete="off"
                  value={draft[field] ?? (secret ? "" : current?.source === "settings" ? (current.value ?? "") : "")}
                  placeholder={secret ? (current?.configured ? "••••••••" : "") : (current?.value ?? placeholder)}
                  onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                />
              </label>
            );
          })}
          <p className="hint">{t("models.clearHint")}</p>
          <div className="actions">
            <button type="submit" className="button-primary" disabled={busy || Object.keys(draft).length === 0}>
              {t("models.save")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
