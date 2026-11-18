import { readFile } from "node:fs/promises";
import { generateSshKeyPair } from "@lotseai/adapter-ssh";
import {
  type AuthMethod,
  availableAuthMethods,
  buildAuthorizationUrl,
  type ConnectInput,
  type Connection,
  collectEvents,
  connectionSecretName,
  exchangeCode,
  formatEvent,
  LotseError,
  listenOnLoopback,
  type OAuthProviderConfig,
  redactConnection,
  resolveOAuthClient,
  type TokenSetupGuide,
} from "@lotseai/core";
import { generateMasterKey } from "@lotseai/secrets";
import type { Command } from "commander";
import type { Context } from "../context.js";
import { confirm, paint, table } from "../io.js";

interface Connectable {
  id: string;
  displayName: string;
  auth: AuthMethod[];
  oauth?: OAuthProviderConfig;
  tokenSetup?: TokenSetupGuide;
  connect(input: ConnectInput): Promise<Connection>;
}

async function findAdapter(ctx: Context, id: string): Promise<Connectable> {
  const registry = await ctx.registry();
  const found = [...registry.listHosting(), ...registry.listGit(), ...registry.listResources()].find((a) => a.id === id);
  if (!found) return registry.hosting(id); // throws with the list of available adapters
  return found;
}

function parseOptions(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 1) throw new LotseError("INVALID_INPUT", `Options are given as name=value, got "${pair}".`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

async function tokenInput(ctx: Context, adapter: Connectable, flags: { token?: string; option?: string[] }): Promise<ConnectInput> {
  const { io } = ctx;
  const options = parseOptions(flags.option);
  const guide = adapter.tokenSetup;
  let token = flags.token ?? io.env.LOTSE_TOKEN;
  if (!token && guide) {
    io.out(paint(io, "bold", `Connect ${adapter.displayName} with an API token`));
    io.out(`  1. Open ${guide.url.replace("{baseUrl}", options.baseUrl ?? "<your instance>")}`);
    for (const [i, step] of guide.steps.entries()) io.out(`  ${i + 2}. ${step}`);
    io.out("  Required permissions:");
    for (const p of guide.permissions) io.out(`    - ${p}`);
  }
  for (const field of guide?.fields ?? []) {
    if (options[field.name] !== undefined) continue;
    if (io.interactive) {
      const answer = await io.prompt(`${field.label}${field.required ? "" : " (optional)"}${field.placeholder ? ` [${field.placeholder}]` : ""}: `);
      if (answer) options[field.name] = answer;
    }
    if (field.required && !options[field.name]) throw new LotseError("INVALID_INPUT", `${field.label} is required: pass \`--option ${field.name}=…\`.`);
  }
  if (!token) {
    if (!io.interactive) throw new LotseError("INVALID_INPUT", "No token given. Pass --token or set LOTSE_TOKEN.");
    token = await io.prompt("Token: ", { hidden: true });
  }
  if (!token) throw new LotseError("INVALID_INPUT", "No token entered.");
  return { method: "token", token, options };
}

async function oauthInput(ctx: Context, adapter: Connectable, flags: { option?: string[] }): Promise<ConnectInput> {
  const { io } = ctx;
  const config = adapter.oauth as OAuthProviderConfig;
  // Native apps use a loopback redirect (RFC 8252).
  const listener = await listenOnLoopback(Number(io.env.LOTSE_OAUTH_PORT ?? 0));
  try {
    const client = await resolveOAuthClient(ctx.oauthSources(), { adapter: adapter.id, config, redirectUri: listener.redirectUri, native: true });
    if (!client) throw new LotseError("AUTH_FAILED", `No OAuth app is configured for ${adapter.displayName}.`);
    const request = buildAuthorizationUrl(config, client, listener.redirectUri);
    io.out(`Open this address to sign in to ${adapter.displayName}:\n\n  ${request.url}\n`);
    io.openBrowser(request.url);
    const code = await listener.waitForCode(request.state);
    const tokens = await exchangeCode(config, client, { code, verifier: request.verifier, redirectUri: listener.redirectUri });
    return { method: "oauth", tokens, client, options: parseOptions(flags.option) };
  } finally {
    listener.close();
  }
}

async function sshInput(
  ctx: Context,
  flags: { host?: string; user?: string; port?: string; key?: string; password?: string; option?: string[] },
): Promise<ConnectInput> {
  const { io } = ctx;
  const host = flags.host ?? (io.interactive ? await io.prompt("Server address (IP or host name): ") : "");
  if (!host) throw new LotseError("INVALID_INPUT", "No server given. Pass --host.");
  const base = {
    method: "ssh" as const,
    host,
    user: flags.user ?? "root",
    port: flags.port ? Number(flags.port) : undefined,
    options: parseOptions(flags.option),
  };
  if (flags.key) return { ...base, privateKey: await readFile(flags.key, "utf8") };

  // The framework generates the key pair; the user installs the public key or enters the password once.
  const pair = generateSshKeyPair(`lotse@${host}`);
  let password = flags.password ?? io.env.LOTSE_SSH_PASSWORD;
  if (!password) {
    io.out(paint(io, "bold", "A new SSH key was generated for this server."));
    io.out(`Either add this public key to ~/.ssh/authorized_keys of ${base.user} on ${host}:\n\n  ${pair.publicKey}\n`);
    if (io.interactive)
      password = await io.prompt(`…or enter the password of ${base.user}@${host} once (leave empty if the key is installed): `, { hidden: true });
  }
  return { ...base, privateKey: pair.privateKey, password: password || undefined };
}

export function registerAccountCommands(program: Command, getContext: () => Context): void {
  program
    .command("adapters")
    .description("List the installed hosting, Git and resource adapters")
    .action(async () => {
      const ctx = getContext();
      const registry = await ctx.registry();
      const connected = new Set(await ctx.connections().list());
      const sources = ctx.oauthSources();
      const mark = (id: string) => (connected.has(id) ? "connected" : "");
      ctx.io.out(paint(ctx.io, "bold", "Hosting"));
      ctx.io.out(
        table([
          ["ID", "NAME", "SIGN-IN", "RUNTIMES", "RESOURCES", "ROLLBACK", ""],
          ...registry
            .listHosting()
            .map((a) => [
              a.id,
              a.displayName,
              availableAuthMethods(a, sources).join(", "),
              a.capabilities.runtimes.join(", "),
              a.capabilities.resources.join(", ") || "-",
              a.capabilities.rollback,
              mark(a.id),
            ]),
        ]),
      );
      ctx.io.out(`\n${paint(ctx.io, "bold", "Git platforms")}`);
      ctx.io.out(
        table([
          ["ID", "NAME", "SIGN-IN", ""],
          ...registry.listGit().map((g) => [g.id, g.displayName, availableAuthMethods(g, sources).join(", "), mark(g.id)]),
        ]),
      );
      if (registry.listResources().length > 0) {
        ctx.io.out(`\n${paint(ctx.io, "bold", "Resources")}`);
        ctx.io.out(table([["ID", "NAME", "PROVIDES", ""], ...registry.listResources().map((r) => [r.id, r.displayName, r.resources.join(", "), mark(r.id)])]));
      }
    });

  program
    .command("connect <adapter>")
    .description("Sign in to a provider or register a server")
    .option("--token <token>", "API token (or set LOTSE_TOKEN)")
    .option("--oauth", "use OAuth even if a token would work")
    .option("--host <host>", "server address (SSH)")
    .option("--user <user>", "SSH user", "root")
    .option("--port <port>", "SSH port")
    .option("--key <file>", "existing private key instead of a generated one (SSH)")
    .option("--password <password>", "password, used once to install the key (SSH; or set LOTSE_SSH_PASSWORD)")
    .option("-o, --option <name=value...>", "adapter setting such as baseUrl=https://… or teamId=…")
    .option("-s, --secret <name=value...>", "secret adapter setting such as s3SecretKey=…, stored encrypted with the account")
    .action(async (id: string, flags) => {
      const ctx = getContext();
      const adapter = await findAdapter(ctx, id);
      // The most convenient method available on this installation wins; without an OAuth app the guided token setup is used.
      const methods = availableAuthMethods(adapter, ctx.oauthSources());
      const method: AuthMethod | undefined = flags.token || ctx.io.env.LOTSE_TOKEN ? "token" : flags.oauth ? "oauth" : methods[0];
      if (!method || !adapter.auth.includes(method)) throw new LotseError("INVALID_INPUT", `${adapter.displayName} does not support that sign-in method.`);
      if (method === "oauth" && !methods.includes("oauth")) {
        throw new LotseError("AUTH_FAILED", `No OAuth app is configured for ${adapter.displayName}.`, {
          hints: [`Set ${adapter.oauth?.envPrefix}_CLIENT_ID (and _CLIENT_SECRET), or connect with a token.`],
        });
      }
      const input =
        method === "ssh" ? await sshInput(ctx, flags) : method === "oauth" ? await oauthInput(ctx, adapter, flags) : await tokenInput(ctx, adapter, flags);
      if (flags.secret) input.secrets = { ...input.secrets, ...parseOptions(flags.secret) };
      const conn = await adapter.connect(input);
      await ctx.connections().save(id, conn);
      ctx.io.out(`${paint(ctx.io, "green", "Connected")} ${adapter.displayName} as ${conn.account.name}.`);

      const registry = await ctx.registry();
      if (registry.hasHosting(id)) {
        const check = await registry.hosting(id).verify(conn);
        for (const m of check.missingPermissions) ctx.io.out(`${paint(ctx.io, "yellow", "Missing:")} ${m}`);
        for (const w of check.warnings) ctx.io.out(`${paint(ctx.io, "dim", "Note:")} ${w}`);
        if (registry.hosting(id).server && !check.ok) ctx.io.out("Run `lotse server setup` to prepare the server.");
      }
    });

  const connections = program.command("connections").description("Manage stored provider accounts");
  connections
    .command("list", { isDefault: true })
    .description("List the accounts you are signed in to")
    .action(async () => {
      const ctx = getContext();
      const store = ctx.connections();
      const rows = [["ID", "ACCOUNT", "SIGN-IN"]];
      for (const id of await store.list()) {
        const conn = await store.get(id);
        if (conn) rows.push([id, conn.account.name, conn.method]);
      }
      ctx.io.out(rows.length > 1 ? table(rows) : "Not signed in anywhere yet. Run `lotse connect <provider>`.");
    });
  connections
    .command("show <id>")
    .description("Show an account without its credentials")
    .action(async (id: string) => {
      const ctx = getContext();
      ctx.io.out(JSON.stringify(redactConnection(await ctx.connections().require(id)), null, 2));
    });
  connections
    .command("remove <id>")
    .description("Forget an account")
    .action(async (id: string) => {
      const ctx = getContext();
      await ctx.connections().delete(id);
      ctx.io.out(`Removed ${id}.`);
    });
  connections
    .command("export <id>")
    .description("Print an account as a CI secret value (contains credentials)")
    .action(async (id: string) => {
      const ctx = getContext();
      const conn = await ctx.connection(id);
      ctx.io.err(`Store the following value as the CI secret ${connectionSecretName(id)}. Treat it like a password.`);
      ctx.io.out(Buffer.from(JSON.stringify(conn), "utf8").toString("base64"));
    });

  program
    .command("verify [adapter]")
    .description("Check that an account works and has the permissions deployments need")
    .action(async (id?: string) => {
      const ctx = getContext();
      const adapterId = await ctx.target(id);
      const adapter = (await ctx.registry()).hosting(adapterId);
      const result = await adapter.verify(await ctx.connection(adapterId));
      ctx.io.out(
        `${result.ok ? paint(ctx.io, "green", "OK") : paint(ctx.io, "red", "Not ready")}  ${adapter.displayName}${result.account ? ` (${result.account})` : ""}`,
      );
      for (const m of result.missingPermissions) ctx.io.out(`  missing: ${m}`);
      for (const w of result.warnings) ctx.io.out(`  note: ${w}`);
      if (!result.ok) throw new LotseError("PERMISSION_MISSING", "The account is not ready for deployments.");
    });

  const server = program.command("server").description("Prepare and maintain your own servers");
  server
    .command("setup")
    .description("Set up a fresh server: deployment user, Docker, Caddy, firewall, security updates")
    .option("-t, --target <adapter>", "adapter of the server", "ssh")
    .option("-y, --yes", "approve the listed changes without asking")
    .action(async (flags) => {
      const ctx = getContext();
      const adapter = (await ctx.registry()).hosting(flags.target);
      if (!adapter.server) throw new LotseError("UNSUPPORTED", `${adapter.displayName} has no server setup.`);
      const conn = await ctx.connection(flags.target);
      const plan = await adapter.server.planSetup(conn);
      ctx.io.out(paint(ctx.io, "bold", `Setup of ${plan.host} (${plan.os.name}, ${plan.os.arch})`));
      for (const w of plan.warnings) ctx.io.out(`${paint(ctx.io, "yellow", "Note:")} ${w}`);
      for (const step of plan.steps) {
        const state = step.skipped ? paint(ctx.io, "dim", "skipped") : step.needed ? paint(ctx.io, "cyan", "to do") : paint(ctx.io, "green", "done");
        ctx.io.out(`\n  [${state}] ${step.title}`);
        if (step.skipped) ctx.io.out(`      ${step.skipped}`);
        else if (step.needed) for (const change of step.changes) ctx.io.out(`      - ${change}`);
      }
      if (!plan.steps.some((s) => s.needed && !s.skipped)) {
        ctx.io.out("\nNothing to do: the server is already set up.");
        return;
      }
      // Setting up a server is a critical action: it always needs explicit approval.
      if (!(await confirm(ctx.io, "\nApply these changes to the server?", Boolean(flags.yes)))) {
        throw new LotseError("APPROVAL_REQUIRED", "Setup was not approved. Nothing was changed.", {
          hints: ["Re-run with --yes to approve the listed changes."],
        });
      }
      const run = adapter.server.runSetup(conn, plan, { approved: true });
      for (;;) {
        const next = await run.next();
        if (next.done) {
          await ctx.connections().save(flags.target, next.value);
          break;
        }
        ctx.io.out(formatEvent(next.value));
      }
      ctx.io.out(paint(ctx.io, "green", "\nThe server is ready for deployments."));
    });

  const backup = program.command("backup").description("Back up and restore databases on your own server");
  const backupTarget = async (ctx: Context, flags: { target?: string }) => {
    const adapterId = await ctx.target(flags.target);
    const adapter = (await ctx.registry()).hosting(adapterId);
    if (!adapter.backups) throw new LotseError("UNSUPPORTED", `${adapter.displayName} manages backups itself; use its own tools.`);
    const manifest = await ctx.manifest();
    const app = await (await ctx.engine()).app(adapterId, manifest.name, await ctx.connection(adapterId));
    return { backups: adapter.backups, app };
  };
  backup
    .command("list <resource>")
    .description("List the backups of a database")
    .option("-t, --target <adapter>")
    .action(async (resource: string, flags) => {
      const ctx = getContext();
      const { backups, app } = await backupTarget(ctx, flags);
      const list = await backups.listBackups(app, resource);
      ctx.io.out(
        list.length
          ? table([["ID", "CREATED", "SIZE"], ...list.map((b) => [b.id, new Date(b.createdAt).toISOString(), `${(b.bytes / 1024).toFixed(1)} kB`])])
          : "No backups yet.",
      );
    });
  backup
    .command("create <resource>")
    .description("Create a backup now")
    .option("-t, --target <adapter>")
    .action(async (resource: string, flags) => {
      const ctx = getContext();
      const { backups, app } = await backupTarget(ctx, flags);
      const info = await backups.createBackup(app, resource);
      ctx.io.out(`Created ${info.id} (${(info.bytes / 1024).toFixed(1)} kB).`);
    });
  backup
    .command("restore <resource> <backup>")
    .description("Replace the database content with a backup")
    .option("-t, --target <adapter>")
    .option("-y, --yes", "do not ask for confirmation")
    .action(async (resource: string, id: string, flags) => {
      const ctx = getContext();
      const { backups, app } = await backupTarget(ctx, flags);
      if (!(await confirm(ctx.io, `Replace the current content of "${resource}" with backup ${id}?`, Boolean(flags.yes)))) {
        throw new LotseError("APPROVAL_REQUIRED", "Restore was not confirmed. Nothing was changed.");
      }
      await backups.restoreBackup(app, resource, id);
      ctx.io.out(`Restored ${id}.`);
    });

  program
    .command("secrets")
    .description("Tools for the credential store")
    .command("generate-key")
    .description("Print a new master key for LOTSE_MASTER_KEY")
    .action(() => getContext().io.out(generateMasterKey()));
}

export { collectEvents };
