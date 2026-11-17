/**
 * Tools for the model. They work on one project inside its sandbox and have
 * no way to reach credentials, other projects or the hosting core. Critical
 * actions can only be proposed (specification section 13.2).
 */
import { errorMessage, type Redactor } from "@lotseai/core";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { Workspace } from "./workspace.js";

export const CRITICAL_ACTIONS = ["deploy", "change_domain", "delete_app", "setup_server"] as const;
export type CriticalAction = (typeof CRITICAL_ACTIONS)[number];

export interface Proposal {
  action: CriticalAction;
  summary: string;
  details: Record<string, string>;
}

export interface ToolActivity {
  tool: string;
  /** One line for the activity log, e.g. `write src/App.tsx`. */
  summary: string;
  ok: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  redactor: Redactor;
  onActivity?: (activity: ToolActivity) => void;
  onProposal?: (proposal: Proposal) => void;
  /** Paths written or deleted during this run. */
  changed: Set<string>;
  commandTimeoutMs?: number;
}

const MAX_FILE_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 12_000;

function clip(text: string, max: number, keep: "head" | "tail"): string {
  if (text.length <= max) return text;
  return keep === "head"
    ? `${text.slice(0, max)}\n[… ${text.length - max} more characters not shown]`
    : `[… ${text.length - max} earlier characters not shown]\n${text.slice(-max)}`;
}

export function createTools(ctx: ToolContext): ToolSet {
  const { workspace, redactor } = ctx;
  const done = (name: string, summary: string, ok = true) => ctx.onActivity?.({ tool: name, summary, ok });
  // Tool failures are reported back to the model as text so that it can react to them.
  const guard = async (name: string, summary: string, fn: () => Promise<string>): Promise<string> => {
    try {
      const out = await fn();
      done(name, summary);
      return out;
    } catch (err) {
      done(name, summary, false);
      return `Error: ${redactor.redact(errorMessage(err))}`;
    }
  };

  return {
    list_files: tool({
      description: "List the files of the project (without dependencies and build output).",
      inputSchema: z.object({}),
      execute: () =>
        guard("list_files", "list files", async () => {
          const files = await workspace.listFiles();
          return files.length ? clip(files.join("\n"), MAX_OUTPUT_CHARS, "head") : "(the project is empty)";
        }),
    }),

    read_file: tool({
      description: "Read a text file of the project. Paths are relative to the project root.",
      inputSchema: z.object({ path: z.string().describe("Path relative to the project root, e.g. src/App.tsx") }),
      execute: ({ path }) => guard("read_file", `read ${path}`, async () => clip(redactor.redact(await workspace.readFile(path)), MAX_FILE_CHARS, "head")),
    }),

    write_file: tool({
      description: "Create a file or replace its whole content. Parent folders are created as needed.",
      inputSchema: z.object({ path: z.string(), content: z.string().describe("The complete new content of the file") }),
      execute: ({ path, content }) =>
        guard("write_file", `write ${path}`, async () => {
          await workspace.writeFile(path, content);
          ctx.changed.add(path);
          return `Wrote ${path} (${content.length} characters).`;
        }),
    }),

    edit_file: tool({
      description: "Replace one exact passage in a file. `old_text` must occur exactly once; include enough surrounding lines to make it unique.",
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: ({ path, old_text, new_text }) =>
        guard("edit_file", `edit ${path}`, async () => {
          const current = await workspace.readFile(path);
          const count = old_text ? current.split(old_text).length - 1 : 0;
          if (count === 0) throw new Error(`old_text was not found in ${path}. Read the file again and copy the passage exactly.`);
          if (count > 1) throw new Error(`old_text occurs ${count} times in ${path}. Include more surrounding lines so that it is unique.`);
          await workspace.writeFile(
            path,
            current.replace(old_text, () => new_text),
          );
          ctx.changed.add(path);
          return `Edited ${path}.`;
        }),
    }),

    delete_file: tool({
      description: "Delete a file of the project.",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) =>
        guard("delete_file", `delete ${path}`, async () => {
          await workspace.deleteFile(path);
          ctx.changed.add(path);
          return `Deleted ${path}.`;
        }),
    }),

    run_command: tool({
      description:
        "Run a shell command in the project directory inside the sandbox, e.g. to install packages, run a build, tests or a type check. Network access is limited to package registries. Do not start long-running servers; the development server is managed for you.",
      inputSchema: z.object({ command: z.string(), timeout_seconds: z.number().int().min(1).max(600).optional() }),
      execute: ({ command, timeout_seconds }) =>
        guard("run_command", `run ${command.length > 80 ? `${command.slice(0, 77)}…` : command}`, async () => {
          const result = await workspace.run(command, { timeoutMs: (timeout_seconds ?? 120) * 1000 });
          return `exit code ${result.code}\n${clip(redactor.redact(result.output), MAX_OUTPUT_CHARS, "tail")}`;
        }),
    }),

    read_logs: tool({
      description: "Read the most recent output of the running app (development server), e.g. to find runtime errors.",
      inputSchema: z.object({ lines: z.number().int().min(1).max(500).optional() }),
      execute: ({ lines }) =>
        guard("read_logs", "read logs", async () => clip(redactor.redact(await workspace.logs(lines ?? 100)), MAX_OUTPUT_CHARS, "tail") || "(no output yet)"),
    }),

    propose_action: tool({
      description:
        "Propose an action only the user can approve: deploying, changing domains, deleting an app or setting up a server. This does not perform the action. Use it when the user asks for one of these.",
      inputSchema: z.object({
        action: z.enum(CRITICAL_ACTIONS),
        summary: z.string().describe("One sentence telling the user what you propose and why"),
        details: z.record(z.string(), z.string()).optional().describe("Parameters such as the domain name or the provider"),
      }),
      execute: async ({ action, summary, details }) => {
        ctx.onProposal?.({ action, summary, details: details ?? {} });
        done("propose_action", `propose ${action}`);
        return "The proposal was shown to the user. It only happens if they approve it; do not assume that it was carried out.";
      },
    }),
  };
}
