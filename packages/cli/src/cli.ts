import { errorMessage, isLotseError, type LotseError, redact } from "@lotseai/core";
import { Command, CommanderError } from "commander";
import { registerAccountCommands } from "./commands/account.js";
import { registerProjectCommands } from "./commands/project.js";
import { Context } from "./context.js";
import { type Io, paint } from "./io.js";
import { scaffoldAdapter } from "./scaffold.js";

export const CLI_VERSION = "0.2.0";

export function buildProgram(io: Io): Command {
  const program = new Command();
  let context: Context | undefined;
  const getContext = () => {
    context ??= new Context(io, { dir: program.opts().dir });
    return context;
  };

  program
    .name("lotse")
    .description("Deploy an app to any supported provider or to your own server.")
    .version(CLI_VERSION)
    .option("-C, --dir <path>", "project directory", ".")
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s.replace(/\n$/, "")), writeErr: (s) => io.err(s.replace(/\n$/, "")) });

  registerProjectCommands(program, getContext);
  registerAccountCommands(program, getContext);

  program
    .command("create")
    .description("Generate code")
    .command("adapter <name>")
    .description("Create a new adapter package with tests")
    .option("--display-name <name>", "name of the provider as shown to users")
    .action(async (name: string, flags) => {
      const ctx = getContext();
      const result = await scaffoldAdapter(ctx.projectDir, name, flags.displayName);
      io.out(`Created ${result.dir}`);
      for (const file of result.files) io.out(`  ${file}`);
      io.out("\nNext: `npm install && npm test` inside the new folder. The contract tests pass as generated.");
    });

  return program;
}

/** Runs the CLI and returns the process exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    await buildProgram(io).parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    // Error messages may quote provider responses; never print credentials.
    io.err(`${paint(io, "red", "Error:")} ${redact(errorMessage(err))}`);
    if (isLotseError(err)) for (const hint of (err as LotseError).hints) io.err(`  ${hint}`);
    else if (io.env.LOTSE_DEBUG && err instanceof Error) io.err(err.stack ?? "");
    return 1;
  }
}
