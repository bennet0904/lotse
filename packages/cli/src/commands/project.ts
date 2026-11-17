import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { detectProject, suggestManifest } from "@lotseai/build";
import {
  connectionSecretName,
  type DeployEvent,
  type DeploymentPlan,
  formatEvent,
  GitWorkspace,
  LotseError,
  MANIFEST_FILE,
  type RepoRef,
  serializeEvent,
  toRepoRecord,
  validateManifest,
  writeManifest,
} from "@lotseai/core";
import type { Command } from "commander";
import type { Context } from "../context.js";
import { confirm, type Io, paint, table } from "../io.js";

const exec = promisify(execFile);

function printEvent(io: Io, e: DeployEvent, json: boolean): void {
  if (json) {
    io.out(JSON.stringify(serializeEvent(e)));
    return;
  }
  const line = formatEvent(e);
  if (e.type === "error" || (e.type === "status" && e.state === "failed")) io.err(paint(io, "red", line));
  else if (e.type === "status" && e.state === "succeeded") io.out(paint(io, "green", line));
  else if (e.type === "log") io.out(paint(io, "dim", line));
  else io.out(line);
}

function printPlan(io: Io, plan: DeploymentPlan, displayName: string): void {
  io.out(paint(io, "bold", `${plan.firstDeployment ? "First deployment" : "Deployment"} of ${plan.manifest.name} to ${displayName}`));
  for (const step of plan.steps)
    io.out(
      `  ${step.action === "noop" ? " " : step.action === "create" ? "+" : step.action === "delete" ? "-" : "~"} ${step.title}${step.detail ? paint(io, "dim", `  ${step.detail}`) : ""}`,
    );
  for (const warning of plan.warnings) io.out(`${paint(io, "yellow", "Note:")} ${warning}`);
}

/** The repository the project is linked to, or the `origin` remote of the working copy. */
async function repositoryOf(ctx: Context): Promise<{ url: string; branch: string } | undefined> {
  const config = await ctx.config();
  if (config.git) return { url: config.git.repo.cloneUrl, branch: config.git.repo.defaultBranch };
  try {
    const url = (await exec("git", ["remote", "get-url", "origin"], { cwd: ctx.projectDir })).stdout.trim();
    const branch = (await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: ctx.projectDir })).stdout.trim();
    return /^https?:\/\//.test(url) ? { url, branch } : undefined;
  } catch {
    return undefined;
  }
}

export function registerProjectCommands(program: Command, getContext: () => Context): void {
  program
    .command("init")
    .description(`Create ${MANIFEST_FILE} for the project in the current folder`)
    .option("--name <name>", "app name")
    .option("--force", "overwrite an existing manifest")
    .action(async (flags) => {
      const ctx = getContext();
      const exists = await access(join(ctx.projectDir, MANIFEST_FILE)).then(
        () => true,
        () => false,
      );
      if (exists && !flags.force) throw new LotseError("CONFLICT", `${MANIFEST_FILE} already exists.`, { hints: ["Use --force to replace it."] });
      const info = await detectProject(ctx.projectDir);
      const manifest = suggestManifest(flags.name ?? basename(ctx.projectDir), info);
      validateManifest(manifest);
      await writeManifest(ctx.projectDir, manifest);
      const what =
        info.language === "unknown"
          ? "No known project type found; wrote a starting point."
          : `Detected ${[info.framework, info.language].filter(Boolean).join(" / ")} (${info.kind}).`;
      ctx.io.out(`${what}\nWrote ${MANIFEST_FILE}. Next: \`lotse connect <provider>\`, then \`lotse deploy\`.`);
    });

  program
    .command("validate")
    .description(`Check ${MANIFEST_FILE}`)
    .action(async () => {
      const ctx = getContext();
      const manifest = await ctx.manifest();
      ctx.io.out(
        `${paint(ctx.io, "green", "Valid.")} ${manifest.name}: ${manifest.runtime.kind}${manifest.runtime.language ? ` (${manifest.runtime.language})` : ""}, build strategy ${manifest.build.strategy}.`,
      );
    });

  program
    .command("plan")
    .description("Show what a deployment would change, without changing anything")
    .option("-t, --target <adapter>", "hosting adapter")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const engine = await ctx.engine();
      const plan = await engine.plan(await ctx.manifest(), {
        adapter: adapterId,
        connection: await ctx.connection(adapterId),
        resourceConnections: await ctx.resourceConnections(),
      });
      printPlan(ctx.io, plan, engine.registry.hosting(adapterId).displayName);
    });

  program
    .command("deploy")
    .description("Build and deploy the app")
    .option("-t, --target <adapter>", "hosting adapter")
    .option("-y, --yes", "do not ask before the first deployment to a new target")
    .option("--preview <id>", "deploy a preview, e.g. for a pull request")
    .option("--comment <request>", "post the preview address on this pull or merge request")
    .option("--json", "print events as JSON lines")
    .action(async (flags) => {
      const ctx = getContext();
      const { io } = ctx;
      const manifest = await ctx.manifest();
      const adapterId = await ctx.target(flags.target);
      const engine = await ctx.engine();
      const adapter = engine.registry.hosting(adapterId);
      if (flags.preview && !adapter.capabilities.previewDeployments) {
        throw new LotseError("UNSUPPORTED", `${adapter.displayName} does not support preview deployments.`);
      }
      const target = { adapter: adapterId, connection: await ctx.connection(adapterId), resourceConnections: await ctx.resourceConnections() };
      const plan = await engine.plan(manifest, target);
      if (!flags.json) printPlan(io, plan, adapter.displayName);
      // The first deployment to a new target is a critical action and needs approval.
      if (
        plan.firstDeployment &&
        !flags.preview &&
        !(await confirm(io, `Deploy ${manifest.name} to ${adapter.displayName} for the first time?`, Boolean(flags.yes)))
      ) {
        throw new LotseError("APPROVAL_REQUIRED", "The first deployment to a new target needs approval.", { hints: ["Re-run with --yes to approve."] });
      }

      const abort = new AbortController();
      const onSignal = () => abort.abort();
      process.once("SIGINT", onSignal);
      try {
        const run = engine.deploy(plan, {
          ...target,
          workdir: ctx.projectDir,
          secrets: await ctx.secrets(manifest),
          preview: flags.preview ? { id: String(flags.preview) } : undefined,
          repository: await repositoryOf(ctx),
          signal: abort.signal,
        });
        for (;;) {
          const next = await run.next();
          if (next.done) {
            const outcome = next.value;
            if (!outcome.ok) {
              throw new LotseError(
                "DEPLOY_FAILED",
                `${outcome.error?.message ?? "The deployment failed."}${outcome.rolledBack ? "\nThe previous version was restored." : ""}`,
              );
            }
            if (!flags.target) await ctx.saveConfig({ target: adapterId });
            io.out(`\n${paint(io, "green", flags.preview ? "Preview ready:" : "Live at")} ${outcome.deployment?.url ?? "(no address reported)"}`);
            for (const d of outcome.domains.filter((x) => x.state === "pending")) {
              io.out(`${paint(io, "yellow", "DNS needed")} for ${d.domain}: ${d.dnsRecords.map((r) => `${r.type} ${r.name} → ${r.value}`).join(", ")}`);
            }
            if (flags.preview && flags.comment && outcome.deployment?.url) await commentPreview(ctx, Number(flags.comment), outcome.deployment.url);
            break;
          }
          printEvent(io, next.value, Boolean(flags.json));
        }
      } finally {
        process.off("SIGINT", onSignal);
      }
    });

  program
    .command("rollback")
    .description("Return to an earlier deployment")
    .option("-t, --target <adapter>", "hosting adapter")
    .option("--to <deployment>", "deployment to restore (default: the previous one)")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const engine = await ctx.engine();
      const run = engine.rollback(await ctx.manifest(), {
        adapter: adapterId,
        connection: await ctx.connection(adapterId),
        workdir: ctx.projectDir,
        to: flags.to,
      });
      for (;;) {
        const next = await run.next();
        if (next.done) {
          if (!next.value.ok) throw new LotseError("ROLLBACK_FAILED", next.value.error?.message ?? "The rollback failed.");
          ctx.io.out(
            `${paint(ctx.io, "green", "Restored")} ${next.value.deployment?.id}${next.value.deployment?.url ? ` at ${next.value.deployment.url}` : ""}`,
          );
          break;
        }
        printEvent(ctx.io, next.value, false);
      }
    });

  program
    .command("status")
    .description("Show whether the app is running")
    .option("-t, --target <adapter>", "hosting adapter")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const status = await (await ctx.engine()).status(adapterId, (await ctx.manifest()).name, await ctx.connection(adapterId));
      ctx.io.out(
        table([
          ["STATE", status.state],
          ...(status.url ? [["URL", status.url]] : []),
          ...(status.domains.length ? [["DOMAINS", status.domains.join(", ")]] : []),
          ...(status.deployment ? [["DEPLOYMENT", status.deployment.id]] : []),
          ...(status.message ? [["NOTE", status.message]] : []),
        ]),
      );
    });

  program
    .command("logs")
    .description("Show the app's logs")
    .option("-t, --target <adapter>", "hosting adapter")
    .option("-f, --follow", "keep streaming")
    .option("-n, --tail <lines>", "number of lines", "100")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort());
      for await (const line of (await ctx.engine()).logs(adapterId, (await ctx.manifest()).name, await ctx.connection(adapterId), {
        follow: Boolean(flags.follow),
        tail: Number(flags.tail),
        signal: abort.signal,
      })) {
        ctx.io.out(`${paint(ctx.io, "dim", new Date(line.at).toISOString())} ${line.stream === "stderr" ? paint(ctx.io, "red", line.line) : line.line}`);
      }
    });

  program
    .command("history")
    .description("List earlier deployments")
    .option("-t, --target <adapter>", "hosting adapter")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const list = await (await ctx.engine()).history(adapterId, (await ctx.manifest()).name);
      ctx.io.out(
        list.length
          ? table([["ID", "STATE", "CREATED", "URL"], ...list.map((d) => [d.id, d.state, new Date(d.createdAt).toISOString(), d.url ?? ""])])
          : "No deployments recorded yet.",
      );
    });

  const env = program.command("env").description("Manage secrets and environment variables");
  env
    .command("set <name> [value]")
    .description("Store a secret for this app (asks for the value when omitted)")
    .option("--apply", "also update the running app")
    .option("-t, --target <adapter>", "hosting adapter")
    .action(async (name: string, value: string | undefined, flags) => {
      const ctx = getContext();
      const manifest = await ctx.manifest();
      if (!manifest.env.secrets.includes(name)) {
        throw new LotseError("INVALID_INPUT", `"${name}" is not declared in ${MANIFEST_FILE}.`, {
          hints: [`Add it under env.secrets, or put non-secret values under env.public.`],
        });
      }
      const secret = value ?? (ctx.io.interactive ? await ctx.io.prompt(`Value of ${name}: `, { hidden: true }) : "");
      if (!secret) throw new LotseError("INVALID_INPUT", "No value given.");
      await ctx.vault().set(`env/${manifest.name}/${name}`, secret);
      ctx.io.out(`Stored ${name} (encrypted).`);
      if (flags.apply) {
        const adapterId = await ctx.target(flags.target);
        await (await ctx.engine()).setEnv(adapterId, manifest.name, await ctx.connection(adapterId), [{ name, value: secret, secret: true }]);
        ctx.io.out(`Updated ${name} at ${adapterId}.`);
      }
    });
  env
    .command("list")
    .description("List the variables of this app without showing secret values")
    .action(async () => {
      const ctx = getContext();
      const manifest = await ctx.manifest();
      const stored = await ctx.secrets(manifest);
      ctx.io.out(
        table([
          ["NAME", "KIND", "VALUE"],
          ...Object.entries(manifest.env.public).map(([k, v]) => [k, "public", v]),
          ...manifest.env.secrets.map((s) => [s, "secret", s in stored ? "(set)" : "(missing)"]),
        ]),
      );
    });
  env
    .command("unset <name>")
    .description("Remove a stored secret value")
    .action(async (name: string) => {
      const ctx = getContext();
      await ctx.vault().delete(`env/${(await ctx.manifest()).name}/${name}`);
      ctx.io.out(`Removed ${name}.`);
    });

  program
    .command("domains")
    .description("Manage custom domains")
    .command("add <domain>")
    .description("Attach a domain to the app")
    .option("-t, --target <adapter>", "hosting adapter")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (domain: string, flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const manifest = await ctx.manifest();
      // Changing domains is a critical action.
      if (!(await confirm(ctx.io, `Serve ${manifest.name} at ${domain}?`, Boolean(flags.yes))))
        throw new LotseError("APPROVAL_REQUIRED", "Changing domains needs approval.", { hints: ["Re-run with --yes to approve."] });
      const status = await (await ctx.engine()).addDomain(adapterId, manifest.name, await ctx.connection(adapterId), domain.toLowerCase());
      ctx.io.out(`${domain}: ${status.state}${status.message ? ` (${status.message})` : ""}`);
      for (const r of status.dnsRecords) ctx.io.out(`  create DNS record: ${r.type} ${r.name} → ${r.value}`);
      ctx.io.out(`Add "${domain}" under domains in ${MANIFEST_FILE} to keep it on future deployments.`);
    });

  program
    .command("destroy")
    .description("Remove the app from the provider")
    .option("-t, --target <adapter>", "hosting adapter")
    .option("--with-resources", "also delete databases and storage at external providers")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (flags) => {
      const ctx = getContext();
      const adapterId = await ctx.target(flags.target);
      const manifest = await ctx.manifest();
      const engine = await ctx.engine();
      if (
        !(await confirm(ctx.io, `Delete ${manifest.name} at ${engine.registry.hosting(adapterId).displayName}? This cannot be undone.`, Boolean(flags.yes)))
      ) {
        throw new LotseError("APPROVAL_REQUIRED", "Deleting an app needs approval. Nothing was deleted.", { hints: ["Re-run with --yes to approve."] });
      }
      await engine.destroy(manifest, {
        adapter: adapterId,
        connection: await ctx.connection(adapterId),
        resourceConnections: await ctx.resourceConnections(),
        workdir: ctx.projectDir,
        withResources: Boolean(flags.withResources),
      });
      ctx.io.out(`Removed ${manifest.name} from ${adapterId}.`);
    });

  registerGitCommands(program, getContext);
}

async function linkedRepo(ctx: Context): Promise<RepoRef> {
  const config = await ctx.config();
  if (!config.git)
    throw new LotseError("INVALID_INPUT", "This project is not linked to a repository.", {
      hints: ["Run `lotse git link <owner/name>` or `lotse git link --create`."],
    });
  return { ...config.git.repo, connection: await ctx.connection(config.git.connection) };
}

async function commentPreview(ctx: Context, request: number, url: string): Promise<void> {
  const config = await ctx.config();
  if (!config.git) return;
  const provider = (await ctx.registry()).git(config.git.provider);
  if (!provider.comment) return;
  await provider.comment(await linkedRepo(ctx), request, `Preview deployment: ${url}`);
  ctx.io.out(`Posted the preview address on request #${request}.`);
}

function registerGitCommands(program: Command, getContext: () => Context): void {
  const git = program.command("git").description("Sync the project with GitHub, GitLab or Forgejo");

  git
    .command("link [repository]")
    .description("Link the project to a repository (owner/name), or create one")
    .requiredOption("-p, --provider <id>", "Git platform", "github")
    .option("--create", "create the repository")
    .option("--public", "create it as a public repository")
    .action(async (repository: string | undefined, flags) => {
      const ctx = getContext();
      const provider = (await ctx.registry()).git(flags.provider);
      const conn = await ctx.connection(flags.provider);
      const name = repository ?? (await ctx.manifest()).name;
      let repo: RepoRef | undefined;
      if (flags.create) {
        const [owner, short] = name.includes("/") ? (name.split("/") as [string, string]) : [undefined, name];
        repo = await provider.createRepo(conn, { name: short, owner, private: !flags.public });
      } else {
        const full = name.includes("/") ? name : `${conn.account.name}/${name}`;
        repo = (await provider.listRepos(conn, name.split("/").pop())).find((r) => `${r.owner}/${r.name}`.toLowerCase() === full.toLowerCase());
        if (!repo) throw new LotseError("NOT_FOUND", `Repository ${full} was not found at ${provider.displayName}.`, { hints: ["Use --create to create it."] });
      }
      await ctx.saveConfig({ git: { provider: provider.id, connection: flags.provider, repo: toRepoRecord(repo) } });
      const ws = new GitWorkspace(ctx.projectDir);
      await ws.init(repo.defaultBranch);
      await ws.setRemote(repo.cloneUrl);
      ctx.io.out(`Linked to ${repo.url}`);
    });

  git
    .command("push")
    .description("Commit all changes and push them")
    .option("-m, --message <message>", "commit message", "Update from Lotse")
    .action(async (flags) => {
      const ctx = getContext();
      const repo = await linkedRepo(ctx);
      const provider = (await ctx.registry()).git(repo.provider);
      const ws = new GitWorkspace(ctx.projectDir);
      const sha = await ws.commitAll(flags.message);
      await ws.push(await provider.remoteUrl(repo, repo.connection as NonNullable<RepoRef["connection"]>), repo.defaultBranch);
      ctx.io.out(sha ? `Pushed ${sha.slice(0, 8)} to ${repo.owner}/${repo.name}.` : `Nothing new to commit; ${repo.owner}/${repo.name} is up to date.`);
    });

  git
    .command("pull")
    .description("Fetch changes made outside and merge them; stops on conflicts")
    .action(async () => {
      const ctx = getContext();
      const repo = await linkedRepo(ctx);
      const provider = (await ctx.registry()).git(repo.provider);
      const result = await new GitWorkspace(ctx.projectDir).pull(
        await provider.remoteUrl(repo, repo.connection as NonNullable<RepoRef["connection"]>),
        repo.defaultBranch,
      );
      ctx.io.out(result.updated ? `Merged changes from the repository${result.files.length ? `: ${result.files.join(", ")}` : "."}` : "Already up to date.");
    });

  git
    .command("ci")
    .description("Set up push-to-deploy: write the workflow and store the credentials as CI secrets")
    .option("-t, --target <adapter>", "hosting adapter to deploy to")
    .option("--previews", "also deploy previews for pull or merge requests")
    .option("--cli-version <version>", "version of @lotseai/cli the workflow installs")
    .action(async (flags) => {
      const ctx = getContext();
      const repo = await linkedRepo(ctx);
      const provider = (await ctx.registry()).git(repo.provider);
      if (!provider.writeWorkflow || !provider.setCiSecret)
        throw new LotseError("UNSUPPORTED", `${provider.displayName} does not support generated pipelines.`);
      const adapterId = await ctx.target(flags.target);
      const manifest = await ctx.manifest();
      const conn = await ctx.connection(adapterId);

      // The connection and the project's secrets travel as CI secrets; nothing is written to the repository.
      const secrets: Record<string, string> = { [connectionSecretName(adapterId)]: Buffer.from(JSON.stringify(conn), "utf8").toString("base64") };
      const vault = ctx.vault();
      const entries: Record<string, string> = {};
      for (const key of await vault.list()) {
        const value = await vault.get(key);
        if (value !== undefined) entries[key] = value;
      }
      if (Object.keys(entries).length > 0) secrets.LOTSE_VAULT = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
      for (const [id, c] of Object.entries(await ctx.resourceConnections()))
        secrets[connectionSecretName(id)] = Buffer.from(JSON.stringify(c), "utf8").toString("base64");

      for (const [name, value] of Object.entries(secrets)) {
        await provider.setCiSecret(repo, name, value);
        ctx.io.out(`Stored CI secret ${name}.`);
      }
      await provider.writeWorkflow(repo, {
        adapter: adapterId,
        branch: repo.defaultBranch,
        secrets: Object.keys(secrets),
        cliVersion: flags.cliVersion,
        previews: Boolean(flags.previews),
      });
      ctx.io.out(`Wrote the deploy workflow to ${repo.owner}/${repo.name}. Every push to ${repo.defaultBranch} now deploys ${manifest.name} to ${adapterId}.`);
      ctx.io.out("Commit .lotse/state.json and .lotse/config.json so the pipeline knows the project's target.");
    });
}
