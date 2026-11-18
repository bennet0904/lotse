/**
 * Language-model settings made in the user interface: the default model, API
 * keys and the addresses of local model servers. They are stored in the
 * encrypted credential store and take precedence over environment variables,
 * so that the desktop app can be configured without a terminal. Keys are
 * never returned by the API.
 */
import { LotseError } from "@lotseai/core";
import { requireRole, type User } from "./auth.js";
import type { Services } from "./services.js";

/** Settings field → environment variable it stands for. */
const FIELDS = {
  defaultModel: { env: "LOTSE_MODEL", secret: false },
  anthropicKey: { env: "ANTHROPIC_API_KEY", secret: true },
  openaiKey: { env: "OPENAI_API_KEY", secret: true },
  ollamaUrl: { env: "OLLAMA_BASE_URL", secret: false },
  lmstudioUrl: { env: "LMSTUDIO_BASE_URL", secret: false },
  compatibleUrl: { env: "LOTSE_OPENAI_COMPATIBLE_URL", secret: false },
  compatibleKey: { env: "LOTSE_OPENAI_COMPATIBLE_KEY", secret: true },
} as const;

export type ModelField = keyof typeof FIELDS;

/** What the settings page sees: values of non-secret fields, only whether secrets are set. */
export type ModelSettingsView = Record<ModelField, { value: string | null; configured: boolean; source: "settings" | "environment" | null }>;

const vaultKey = (env: string) => `model-setting/${env}`;

export class ModelSettings {
  constructor(readonly services: Services) {}

  /** The environment model calls see: stored settings over the process environment. */
  async env(): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = { ...this.services.config.env };
    for (const { env } of Object.values(FIELDS)) {
      const stored = await this.services.vault.get(vaultKey(env));
      if (stored) out[env] = stored;
    }
    return out;
  }

  /** The model for implementation when a project names none. */
  async defaultModel(): Promise<string | undefined> {
    return (await this.services.vault.get(vaultKey("LOTSE_MODEL"))) ?? this.services.config.implementModel;
  }

  /** The model for planning when a project names none: an explicit LOTSE_PLAN_MODEL, else the default. */
  async planModel(): Promise<string | undefined> {
    return this.services.config.env.LOTSE_PLAN_MODEL ?? (await this.services.vault.get(vaultKey("LOTSE_MODEL"))) ?? this.services.config.planModel;
  }

  async view(user: User): Promise<ModelSettingsView> {
    requireRole(user, "admin");
    const view = {} as ModelSettingsView;
    for (const [field, { env, secret }] of Object.entries(FIELDS) as [ModelField, (typeof FIELDS)[ModelField]][]) {
      const stored = await this.services.vault.get(vaultKey(env));
      const fromEnv = this.services.config.env[env];
      const value = stored ?? fromEnv ?? null;
      view[field] = { value: secret ? null : value, configured: Boolean(value), source: stored ? "settings" : fromEnv ? "environment" : null };
    }
    return view;
  }

  /** Sets the given fields; an empty string removes a stored value. Fields that are left out stay as they are. */
  async update(user: User, input: Partial<Record<ModelField, string>>, ip?: string): Promise<ModelSettingsView> {
    requireRole(user, "admin");
    const changed: string[] = [];
    for (const [field, raw] of Object.entries(input)) {
      const spec = FIELDS[field as ModelField];
      if (!spec) throw new LotseError("INVALID_INPUT", `Unknown setting "${field}".`);
      if (typeof raw !== "string") continue;
      const value = raw.trim();
      if (value && field === "defaultModel" && !/^[a-z0-9-]+:.+$/i.test(value)) {
        throw new LotseError("INVALID_INPUT", "Write the model as provider:model, for example anthropic:claude-opus-5-5 or ollama:qwen3-coder.");
      }
      if (value && field.endsWith("Url") && !/^https?:\/\/\S+$/.test(value)) throw new LotseError("INVALID_INPUT", `"${value}" is not an http(s) address.`);
      if (value) await this.services.vault.set(vaultKey(spec.env), value);
      else await this.services.vault.delete(vaultKey(spec.env));
      changed.push(field);
    }
    if (changed.length > 0) await this.services.auth.audit({ userId: user.id, action: "model-settings.changed", detail: { fields: changed }, ip });
    return this.view(user);
  }
}
