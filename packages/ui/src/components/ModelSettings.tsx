import { type FormEvent, useState } from "react";
import { type ApiError, api, get, useLoad } from "../api";
import { type MessageKey, useI18n } from "../i18n";
import { ErrorNote } from "./common";

type Field = "defaultModel" | "anthropicKey" | "openaiKey" | "ollamaUrl" | "lmstudioUrl" | "compatibleUrl" | "compatibleKey";
type View = Record<Field, { value: string | null; configured: boolean; source: "settings" | "environment" | null }>;

interface FieldInfo {
  field: Field;
  label: MessageKey;
  secret: boolean;
  placeholder?: string;
}

const GROUPS: { legend?: MessageKey; fields: FieldInfo[] }[] = [
  { fields: [{ field: "defaultModel", label: "models.default", secret: false, placeholder: "anthropic:claude-opus-5-5" }] },
  {
    legend: "models.group.hosted",
    fields: [
      { field: "anthropicKey", label: "models.anthropicKey", secret: true },
      { field: "openaiKey", label: "models.openaiKey", secret: true },
    ],
  },
  {
    legend: "models.group.local",
    fields: [
      { field: "ollamaUrl", label: "models.ollamaUrl", secret: false, placeholder: "http://127.0.0.1:11434" },
      { field: "lmstudioUrl", label: "models.lmstudioUrl", secret: false, placeholder: "http://127.0.0.1:1234" },
    ],
  },
  {
    legend: "models.group.compatible",
    fields: [
      { field: "compatibleUrl", label: "models.compatibleUrl", secret: false, placeholder: "https://llm.example.com/v1" },
      { field: "compatibleKey", label: "models.compatibleKey", secret: true },
    ],
  },
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

  /** Whether a value is set and where, as a badge inside the label, so it is part of the field's name. */
  const state = (field: Field) => {
    const s = settings.data?.[field];
    if (!s?.configured) return <span className="badge badge-unset">{t("models.notSet")}</span>;
    return s.source === "environment" ? (
      <span className="badge">{t("models.fromEnvironment")}</span>
    ) : (
      <span className="badge badge-set">{t("models.stored")}</span>
    );
  };

  const input = ({ field, label, secret, placeholder }: FieldInfo) => {
    const current = settings.data?.[field];
    return (
      <div key={field} className="field">
        <label htmlFor={`model-${field}`} className="field-label">
          <span>{t(label)}</span> {state(field)}
        </label>
        <input
          id={`model-${field}`}
          type={secret ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={draft[field] ?? (secret ? "" : current?.source === "settings" ? (current.value ?? "") : "")}
          placeholder={secret ? (current?.configured ? t("models.replaceKey") : t("models.enterKey")) : (current?.value ?? placeholder)}
          onChange={(e) => {
            setSaved(false);
            setDraft({ ...draft, [field]: e.target.value });
          }}
        />
      </div>
    );
  };

  return (
    <>
      <ErrorNote error={error ?? settings.error} />
      {settings.data && (
        <form className="stack" onSubmit={save}>
          {GROUPS.map((group) =>
            group.legend ? (
              <fieldset key={group.legend} className="field-group">
                <legend>{t(group.legend)}</legend>
                <div className="field-grid">{group.fields.map(input)}</div>
              </fieldset>
            ) : (
              group.fields.map(input)
            ),
          )}
          <div className="form-foot">
            <p className="hint">{t("models.clearHint")}</p>
            <div className="actions">
              {saved && (
                <span className="saved" role="status">
                  {t("models.saved")}
                </span>
              )}
              <button type="submit" className="button-primary" disabled={busy || Object.keys(draft).length === 0}>
                {t("models.save")}
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
