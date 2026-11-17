/**
 * A model that follows a script instead of calling a provider. End-to-end
 * tests use it as the "fixed model" so that a run from prompt to deployment
 * is reproducible and needs no API key (specification section 14.2).
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ResolvedModel } from "./models.js";

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

export type ScriptedStep = ScriptedTurn | ((call: { index: number; options: LanguageModelV4CallOptions; promptText: string }) => ScriptedTurn);

export interface ScriptedModel extends ResolvedModel {
  /** Everything the model was sent, flattened to text, one entry per call. */
  prompts: string[];
  calls: LanguageModelV4CallOptions[];
}

function flatten(options: LanguageModelV4CallOptions): string {
  return JSON.stringify(options.prompt);
}

export function scriptedModel(steps: ScriptedStep[], options: { inputTokens?: number; outputTokens?: number } = {}): ScriptedModel {
  const prompts: string[] = [];
  const calls: LanguageModelV4CallOptions[] = [];
  let index = 0;

  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "fixed",
    supportedUrls: {},
    async doGenerate(callOptions): Promise<LanguageModelV4GenerateResult> {
      const promptText = flatten(callOptions);
      prompts.push(promptText);
      calls.push(callOptions);
      const step = steps[index];
      const turn: ScriptedTurn = step === undefined ? { text: "Done." } : typeof step === "function" ? step({ index, options: callOptions, promptText }) : step;
      index++;
      const content: LanguageModelV4Content[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        content.push({ type: "tool-call", toolCallId: `call_${index}_${i}`, toolName: call.name, input: JSON.stringify(call.input) });
      }
      const input = options.inputTokens ?? 1000;
      const output = options.outputTokens ?? 200;
      return {
        content,
        finishReason: { unified: turn.toolCalls?.length ? "tool-calls" : "stop", raw: undefined },
        usage: { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("The scripted model does not stream.");
    },
  };
  return { model, id: "scripted:fixed", local: true, prompts, calls };
}
