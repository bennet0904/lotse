/**
 * Step 1 of a generation: the model turns the prompt into a plan covering
 * stack, data model and page structure. The user can adjust the plan before
 * implementation starts (specification section 12.1).
 */
import { LotseError } from "@lotseai/core";
import { generateText } from "ai";
import { z } from "zod";
import type { ResolvedModel, UsageTracker } from "./models.js";

export interface StackChoice {
  id: string;
  name: string;
  description: string;
  beta: boolean;
}

export const planSchema = z.object({
  stack: z.string(),
  name: z
    .string()
    .regex(/^[a-z]([a-z0-9-]{0,48}[a-z0-9])?$/, "lowercase letters, digits and hyphens, starting with a letter")
    .describe("Short technical name of the app"),
  title: z.string().min(1).max(80),
  summary: z.string().min(1).describe("Two or three sentences describing what will be built"),
  dataModel: z.array(z.object({ entity: z.string(), fields: z.array(z.string()) })).default([]),
  pages: z.array(z.object({ name: z.string(), purpose: z.string() })).default([]),
  resources: z.array(z.enum(["postgres", "redis", "object-storage"])).default([]),
  notes: z.array(z.string()).default([]),
});

export type AppPlan = z.infer<typeof planSchema>;

const PLAN_SYSTEM = `You plan small web applications that will then be implemented from a strict stack template.

Reply with exactly one JSON object in a \`\`\`json code block and nothing else. Fields:
- "stack": id of the stack that fits best (see the list in the request)
- "name": short technical name: lowercase letters, digits, hyphens
- "title": human-readable title
- "summary": two or three sentences on what will be built, for a non-developer
- "dataModel": list of { "entity", "fields": [names with types] }; empty if nothing is stored
- "pages": list of { "name", "purpose" }: the pages or endpoints of the app
- "resources": subset of ["postgres", "redis", "object-storage"]; only what the app really needs
- "notes": assumptions you made and open questions, as short sentences

Choose the simplest stack that satisfies the request. Prefer stacks that are not marked beta unless the request names a language or framework. Plan only what was asked for.`;

/** Extracts the first JSON object from a model answer, with or without a code fence. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The answer contains no JSON object.");
  return JSON.parse(candidate.slice(start, end + 1));
}

export interface PlanInput {
  prompt: string;
  stacks: StackChoice[];
  model: ResolvedModel;
  usage?: UsageTracker;
  /** A previous plan and the user's change requests, when the plan is being adjusted. */
  previous?: { plan: AppPlan; feedback: string };
  signal?: AbortSignal;
}

export async function createPlan(input: PlanInput): Promise<AppPlan> {
  const stackList = input.stacks.map((s) => `- ${s.id}: ${s.name}${s.beta ? " (beta)" : ""}. ${s.description}`).join("\n");
  const request = input.previous
    ? `Available stacks:\n${stackList}\n\nOriginal request:\n${input.prompt}\n\nCurrent plan:\n${JSON.stringify(input.previous.plan, null, 2)}\n\nThe user wants these changes to the plan:\n${input.previous.feedback}`
    : `Available stacks:\n${stackList}\n\nRequest:\n${input.prompt}`;

  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await generateText({
      model: input.model.model,
      system: PLAN_SYSTEM,
      prompt: problem ? `${request}\n\nYour previous answer could not be used: ${problem}\nAnswer again with one valid JSON object.` : request,
      maxOutputTokens: 4000,
      abortSignal: input.signal,
    });
    input.usage?.add(input.model.id, input.model.local, result.totalUsage);
    if (result.finishReason === "content-filter") {
      throw new LotseError("INVALID_INPUT", "The model declined to plan this request.");
    }
    try {
      const plan = planSchema.parse(extractJson(result.text));
      if (!input.stacks.some((s) => s.id === plan.stack))
        throw new Error(`"${plan.stack}" is not one of the available stacks (${input.stacks.map((s) => s.id).join(", ")}).`);
      return plan;
    } catch (err) {
      problem = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (err as Error).message;
    }
  }
  throw new LotseError("PROVIDER_ERROR", `The model did not produce a usable plan (${problem}). Try again or choose another model.`);
}

/** Renders a plan as the text shown to the user and given to the implementation step. */
export function describePlan(plan: AppPlan): string {
  const lines = [`${plan.title} (${plan.stack})`, "", plan.summary];
  if (plan.pages.length) lines.push("", "Pages:", ...plan.pages.map((p) => `- ${p.name}: ${p.purpose}`));
  if (plan.dataModel.length) lines.push("", "Data model:", ...plan.dataModel.map((e) => `- ${e.entity}: ${e.fields.join(", ")}`));
  if (plan.resources.length) lines.push("", `Resources: ${plan.resources.join(", ")}`);
  if (plan.notes.length) lines.push("", "Notes:", ...plan.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}
