/**
 * Language models (specification section 12.2). Everything goes through the
 * Vercel AI SDK, so every provider supported there works without extra code;
 * local models are reached through any OpenAI-compatible API.
 *
 * A model is named `<provider>:<model id>`, e.g. `anthropic:claude-opus-5-5`,
 * `openai:gpt-…`, `ollama:qwen3-coder` or `lmstudio:<loaded model>`.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LotseError } from "@lotse/core";
import type { LanguageModel } from "ai";

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

export interface ModelSettings {
  /** Model for the planning step. */
  planModel?: string | LanguageModel;
  /** Model for implementation and self-correction. Defaults to the planning model. */
  implementModel?: string | LanguageModel;
}

export type Env = Record<string, string | undefined>;

export interface ResolvedModel {
  model: LanguageModel;
  /** `<provider>:<model id>`, used for usage and cost accounting. */
  id: string;
  /** True for models that run on the user's machine. */
  local: boolean;
}

const LOCAL_PROVIDERS: Record<string, { baseURL: string; envUrl: string; name: string }> = {
  ollama: { baseURL: "http://127.0.0.1:11434/v1", envUrl: "OLLAMA_BASE_URL", name: "Ollama" },
  lmstudio: { baseURL: "http://127.0.0.1:1234/v1", envUrl: "LMSTUDIO_BASE_URL", name: "LM Studio" },
};

export function parseModelId(spec: string): { provider: string; model: string } {
  const i = spec.indexOf(":");
  if (i < 1 || i === spec.length - 1) {
    throw new LotseError("INVALID_INPUT", `"${spec}" is not a model name. Use <provider>:<model>, for example ${DEFAULT_MODEL} or ollama:qwen3-coder.`);
  }
  return { provider: spec.slice(0, i).toLowerCase(), model: spec.slice(i + 1) };
}

/** Turns a model name into an AI SDK model. Keys come from the environment and never from a prompt. */
export async function resolveModel(spec: string | LanguageModel | undefined, env: Env = process.env): Promise<ResolvedModel> {
  if (spec !== undefined && typeof spec !== "string") {
    const m = spec as { provider?: string; modelId?: string };
    return { model: spec, id: `${m.provider ?? "custom"}:${m.modelId ?? "model"}`, local: false };
  }
  const id = spec ?? env.LOTSE_MODEL ?? DEFAULT_MODEL;
  const { provider, model } = parseModelId(id);

  if (provider === "anthropic") {
    return { model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL })(model), id, local: false };
  }
  if (provider === "openai") {
    return { model: createOpenAI({ apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL })(model), id, local: false };
  }
  const local = LOCAL_PROVIDERS[provider];
  if (local) {
    const baseURL = (env[local.envUrl] ?? local.baseURL).replace(/\/+$/, "");
    return { model: createOpenAICompatible({ name: provider, baseURL: baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1` })(model), id, local: true };
  }
  if (provider === "openai-compatible") {
    const baseURL = env.LOTSE_OPENAI_COMPATIBLE_URL;
    if (!baseURL) throw new LotseError("INVALID_INPUT", "Set LOTSE_OPENAI_COMPATIBLE_URL to the base address of the OpenAI-compatible API.");
    return {
      model: createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey: env.LOTSE_OPENAI_COMPATIBLE_KEY })(model),
      id,
      local: /\/\/(localhost|127\.|\[::1\]|host\.docker\.internal)/.test(baseURL),
    };
  }

  // Any other AI SDK provider: install `@ai-sdk/<provider>` and it works.
  const pkg = `@ai-sdk/${provider}`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pkg)) as Record<string, unknown>;
  } catch {
    throw new LotseError("INVALID_INPUT", `No model provider "${provider}" is available.`, {
      hints: [`Install the AI SDK provider with \`npm install ${pkg}\`, or use one of: anthropic, openai, ollama, lmstudio, openai-compatible.`],
    });
  }
  const factory = (mod[provider] ?? mod.default) as ((model: string) => LanguageModel) | undefined;
  if (typeof factory !== "function") throw new LotseError("INVALID_INPUT", `${pkg} does not export a provider named "${provider}".`);
  return { model: factory(model), id, local: false };
}

// ---------------------------------------------------------------------------
// Usage and estimated cost
// ---------------------------------------------------------------------------

export interface Price {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
  cacheRead?: number;
}

/**
 * List prices used for the cost estimate shown per project. Providers change
 * prices; instances can override this table. Unknown models show no estimate.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "anthropic:claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "anthropic:claude-fable-5": { input: 10, output: 50 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "anthropic:claude-opus-5": { input: 5, output: 25 },
  "anthropic:claude-opus-4-8": { input: 5, output: 25 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "anthropic:claude-sonnet-5": { input: 2, output: 10 },
  "anthropic:claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Estimated cost in US dollars; undefined when the model's price is unknown. */
  cost?: number;
}

export interface UsageByModel extends Usage {
  model: string;
  calls: number;
}

export class UsageTracker {
  readonly #byModel = new Map<string, UsageByModel>();
  readonly #prices: Record<string, Price>;

  constructor(prices: Record<string, Price> = DEFAULT_PRICES) {
    this.#prices = prices;
  }

  add(
    model: string,
    local: boolean,
    usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } | undefined,
  ): Usage {
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cached = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    const price = this.#prices[model];
    // Local models cost nothing; for unknown hosted models no estimate is shown.
    const cost = local
      ? 0
      : price
        ? ((input - cached) * price.input + cached * (price.cacheRead ?? price.input) + output * price.output) / 1_000_000
        : undefined;
    const entry = this.#byModel.get(model) ?? { model, calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: local || price ? 0 : undefined };
    entry.calls++;
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.cachedInputTokens += cached;
    if (cost !== undefined && entry.cost !== undefined) entry.cost += cost;
    this.#byModel.set(model, entry);
    return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, cost };
  }

  byModel(): UsageByModel[] {
    return [...this.#byModel.values()];
  }

  total(): Usage {
    const all = this.byModel();
    return {
      inputTokens: all.reduce((s, u) => s + u.inputTokens, 0),
      outputTokens: all.reduce((s, u) => s + u.outputTokens, 0),
      cachedInputTokens: all.reduce((s, u) => s + u.cachedInputTokens, 0),
      cost: all.every((u) => u.cost !== undefined) ? all.reduce((s, u) => s + (u.cost ?? 0), 0) : undefined,
    };
  }
}
