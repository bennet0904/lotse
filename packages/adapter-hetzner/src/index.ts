/**
 * Hetzner Cloud as an infrastructure adapter: it creates a server through the
 * API, installs the SSH key and then hands over to the SSH adapter
 * (specification section 9). More VPS providers can follow the same pattern.
 */
import { buildSetupPlan, createSshAdapter, generateSshKeyPair, publicKeyOf, type SshAdapterOptions } from "@lotse/adapter-ssh";
import {
  ADAPTER_API_VERSION,
  type AdapterPackage,
  type AppRef,
  apiConnection,
  type ConnectInput,
  type Connection,
  type DeployContext,
  type DeploymentPlan,
  type DeploymentRef,
  event,
  type HostingAdapter,
  HttpClient,
  isLotseError,
  LotseError,
  type SetupPlan,
  sleep,
  type VerifyResult,
} from "@lotse/core";

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: { ipv4?: { ip: string } | null };
}

const FRESH_UBUNTU = {
  id: "ubuntu",
  version: "24.04",
  name: "Ubuntu 24.04 LTS",
  codename: "noble",
  arch: "x86_64",
  uid: 0,
  sudo: true,
  systemd: true,
  docker: "missing",
  dockerAccess: false,
  deployUser: false,
  deployKey: false,
  proxy: false,
  firewall: false,
  updates: false,
  backupTimer: false,
};

export function createHetznerAdapter(options: SshAdapterOptions = {}): HostingAdapter {
  const ssh = createSshAdapter(options);
  const pollMs = Number(options.settings?.pollIntervalMs ?? 3000);
  const client = (conn: Connection) =>
    new HttpClient({
      provider: "Hetzner Cloud",
      baseUrl: "https://api.hetzner.cloud/v1",
      headers: { authorization: `Bearer ${conn.credentials.token}` },
      fetch: options.fetch,
      retryDelayMs: Math.min(pollMs, 500),
    });

  /** The connection the SSH adapter works with: same key, the server's address. */
  function sshConnection(conn: Connection): Connection {
    if (!conn.settings.host) {
      throw new LotseError("PERMISSION_MISSING", "No server has been created for this Hetzner Cloud account yet.", {
        hints: ["Run the server setup (`lotse server setup --target hetzner`) to create and prepare one."],
      });
    }
    const { token: _token, ...credentials } = conn.credentials;
    return {
      adapter: "ssh",
      method: "ssh",
      account: { id: conn.settings.host, name: `${conn.settings.user ?? "root"}@${conn.settings.host}` },
      credentials,
      settings: { ...conn.settings, port: conn.settings.port ?? "22", user: conn.settings.user ?? "root", ip: conn.settings.host },
    };
  }
  const sshApp = (app: AppRef): AppRef => ({ ...app, adapter: "ssh", connection: sshConnection(app.connection) });
  const sshCtx = (ctx: DeployContext): DeployContext => ({ ...ctx, connection: sshConnection(ctx.connection) });

  async function findServer(conn: Connection): Promise<HetznerServer | undefined> {
    const http = client(conn);
    if (conn.settings.serverId) {
      try {
        return (await http.get<{ server: HetznerServer }>(`/servers/${conn.settings.serverId}`)).server;
      } catch (err) {
        if (isLotseError(err) && err.code === "NOT_FOUND") return undefined;
        throw err;
      }
    }
    return (await http.get<{ servers: HetznerServer[] }>("/servers", { query: { name: conn.settings.serverName } })).servers[0];
  }

  function withServer(conn: Connection, server: HetznerServer): Connection {
    const host = server.public_net.ipv4?.ip;
    if (!host) throw new LotseError("PROVIDER_ERROR", `Server ${server.name} has no public IPv4 address.`);
    return { ...conn, settings: { ...conn.settings, serverId: String(server.id), host, ip: host } };
  }

  return {
    id: "hetzner",
    displayName: "Hetzner Cloud",
    auth: ["token"],
    capabilities: ssh.capabilities,
    tokenSetup: {
      url: "https://console.hetzner.cloud/projects",
      permissions: ["Read & Write (needed to create the server and the SSH key)"],
      steps: [
        "Open the project that should contain the server, then Security → API tokens.",
        "Generate a token with read and write permission.",
        "Copy the token and paste it here. It is shown only once.",
      ],
      fields: [
        { name: "serverType", label: "Server type", required: false, placeholder: "cx22" },
        { name: "location", label: "Location", required: false, placeholder: "nbg1" },
        { name: "serverName", label: "Server name", required: false, placeholder: "lotse" },
      ],
    },

    async connect(input: ConnectInput): Promise<Connection> {
      const { privateKey: given, ...secrets } = input.secrets ?? {};
      const pair = given ? { privateKey: given, publicKey: publicKeyOf(given, "lotse@hetzner") } : generateSshKeyPair("lotse@hetzner");
      const base = apiConnection("hetzner", { ...input, secrets } as ConnectInput, {
        serverType: input.options?.serverType || "cx22",
        location: input.options?.location || "nbg1",
        serverName: input.options?.serverName || "lotse",
        image: "ubuntu-24.04",
        publicKey: pair.publicKey,
        ...(input.options?.tls ? { tls: input.options.tls } : {}),
        ...(input.options?.baseDomain ? { baseDomain: input.options.baseDomain } : {}),
      });
      let conn: Connection = { ...base, credentials: { ...base.credentials, privateKey: pair.privateKey } };
      const server = await findServer(conn);
      conn.account = { id: conn.settings.serverName as string, name: `Hetzner Cloud (${conn.settings.serverName})` };
      // A server from an earlier setup is only adopted with the key that was installed on it.
      if (server && given && server.status === "running") {
        conn = withServer(conn, server);
        const sshConn = await ssh.connect({
          method: "ssh",
          host: conn.settings.host as string,
          user: input.options?.user ?? "lotse",
          privateKey: pair.privateKey,
        });
        conn.settings.hostKey = sshConn.settings.hostKey as string;
        conn.settings.user = sshConn.settings.user as string;
      }
      return conn;
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      const server = await findServer(conn);
      if (!server || !conn.settings.host) {
        return { ok: false, account: conn.account.name, missingPermissions: ["No server yet. Run the server setup to create and prepare one."], warnings: [] };
      }
      if (server.status !== "running") return { ok: false, account: conn.account.name, missingPermissions: [`The server is ${server.status}.`], warnings: [] };
      return ssh.verify(sshConnection(conn));
    },

    async plan(manifest, conn): Promise<DeploymentPlan> {
      const plan = await ssh.plan(manifest, sshConnection(conn));
      return { ...plan, adapter: "hetzner", app: { ...plan.app, adapter: "hetzner", connection: conn } };
    },

    async *deploy(plan, artifact, ctx) {
      const sshPlan: DeploymentPlan = { ...plan, adapter: "ssh", app: sshApp(plan.app) };
      for await (const e of ssh.deploy(sshPlan, artifact, sshCtx(ctx))) {
        if (e.type === "status" && e.deployment)
          yield { ...e, deployment: { ...e.deployment, app: { ...e.deployment.app, adapter: "hetzner", connection: ctx.connection } } };
        else yield e;
      }
    },

    rollback: (target: DeploymentRef, ctx: DeployContext) => ssh.rollback({ ...target, app: sshApp(target.app) }, sshCtx(ctx)),
    // Removes the app. The server keeps running; delete it in the Hetzner console when it is no longer needed.
    destroy: (app, ctx) => ssh.destroy(sshApp(app), sshCtx(ctx)),
    setEnv: (app, vars) => ssh.setEnv(sshApp(app), vars),
    addDomain: (app, domain) => (ssh.addDomain as NonNullable<HostingAdapter["addDomain"]>)(sshApp(app), domain),
    provision: async (app, res) => ({ ...(await (ssh.provision as NonNullable<HostingAdapter["provision"]>)(sshApp(app), res)), provider: "hetzner" }),
    logs: (app, opts) => ssh.logs(sshApp(app), opts),
    status: (app) => ssh.status(sshApp(app)),

    backups: {
      listBackups: (app, resource) => (ssh.backups as NonNullable<HostingAdapter["backups"]>).listBackups(sshApp(app), resource),
      createBackup: (app, resource) => (ssh.backups as NonNullable<HostingAdapter["backups"]>).createBackup(sshApp(app), resource),
      restoreBackup: (app, resource, id) => (ssh.backups as NonNullable<HostingAdapter["backups"]>).restoreBackup(sshApp(app), resource, id),
    },

    server: {
      async planSetup(conn: Connection): Promise<SetupPlan> {
        const server = await findServer(conn);
        if (server && conn.settings.host) return (ssh.server as NonNullable<HostingAdapter["server"]>).planSetup(sshConnection(conn));
        const rest = buildSetupPlan(conn.settings.serverName as string, FRESH_UBUNTU, { sshPort: 22, httpPort: 80, httpsPort: 443 });
        return {
          ...rest,
          steps: [
            {
              id: "server",
              title: `Create the server "${conn.settings.serverName}" at Hetzner Cloud`,
              changes: [
                `Creates a ${conn.settings.serverType} server with ${conn.settings.image} in ${conn.settings.location}`,
                "Adds the SSH key generated by Lotse to the Hetzner project",
                "Hetzner bills the server until you delete it",
              ],
              needed: !server,
            },
            ...rest.steps,
          ],
        };
      },

      async *runSetup(conn, plan, approval) {
        if (approval.approved !== true) throw new LotseError("APPROVAL_REQUIRED", "Creating and setting up a server must be approved explicitly.");
        const http = client(conn);
        let server = await findServer(conn);
        if (!server) {
          yield event.progress("provision", 1, plan.steps.length, `Creating server ${conn.settings.serverName}`);
          const keys = await http.get<{ ssh_keys: { id: number; name: string; public_key: string }[] }>("/ssh_keys");
          const material = (conn.settings.publicKey as string).split(" ").slice(0, 2).join(" ");
          let keyId = keys.ssh_keys.find((k) => k.public_key.startsWith(material))?.id;
          keyId ??= (
            await http.post<{ ssh_key: { id: number } }>("/ssh_keys", {
              name: `lotse-${conn.settings.serverName}-${Date.now().toString(36)}`,
              public_key: conn.settings.publicKey,
            })
          ).ssh_key.id;
          server = (
            await http.post<{ server: HetznerServer }>("/servers", {
              name: conn.settings.serverName,
              server_type: conn.settings.serverType,
              image: conn.settings.image,
              location: conn.settings.location,
              ssh_keys: [keyId],
              labels: { "managed-by": "lotse" },
            })
          ).server;
        }
        const id = server.id;
        while (server.status !== "running") {
          yield event.log("provision", `Server is ${server.status}`);
          await sleep(pollMs, approval.signal);
          server = (await http.get<{ server: HetznerServer }>(`/servers/${id}`)).server;
        }
        const withHost = withServer(conn, server);
        yield event.log("provision", `Server ${server.name} is running at ${withHost.settings.host}`);

        // A new server needs a moment until SSH answers.
        const sshSetup = ssh.server as NonNullable<HostingAdapter["server"]>;
        const root = { ...sshConnection({ ...withHost, settings: { ...withHost.settings, user: "root" } }) };
        let sshPlan: SetupPlan | undefined;
        for (let attempt = 0; !sshPlan; attempt++) {
          try {
            sshPlan = await sshSetup.planSetup(root);
          } catch (err) {
            if (attempt >= 20 || (isLotseError(err) && err.code === "AUTH_FAILED")) throw err;
            await sleep(pollMs, approval.signal);
          }
        }
        const prepared = yield* sshSetup.runSetup(root, sshPlan, approval);
        // Record the server's host key now, so that every later connection is pinned to it.
        const pinned = await ssh.connect({
          method: "ssh",
          host: withHost.settings.host as string,
          user: prepared.settings.user,
          privateKey: conn.credentials.privateKey,
        });
        return { ...withHost, settings: { ...withHost.settings, user: pinned.settings.user as string, hostKey: pinned.settings.hostKey as string } };
      },
    },
  };
}

/**
 * Deletes the server of a connection and its SSH key at Hetzner Cloud.
 * Everything on the server is lost. The live tests clean up with this; the
 * adapter itself never deletes a server.
 */
export async function deleteHetznerServer(conn: Connection, options: { fetch?: typeof fetch } = {}): Promise<void> {
  const http = new HttpClient({
    provider: "Hetzner Cloud",
    baseUrl: "https://api.hetzner.cloud/v1",
    headers: { authorization: `Bearer ${conn.credentials.token}` },
    fetch: options.fetch,
  });
  const ignoreMissing = (err: unknown) => {
    if (!(isLotseError(err) && err.code === "NOT_FOUND")) throw err;
  };
  if (conn.settings.serverId) await http.delete(`/servers/${conn.settings.serverId}`).catch(ignoreMissing);
  const material = conn.settings.publicKey?.split(" ").slice(0, 2).join(" ");
  if (!material) return;
  const { ssh_keys: keys } = await http.get<{ ssh_keys: { id: number; public_key: string }[] }>("/ssh_keys");
  for (const key of keys.filter((k) => k.public_key.startsWith(material))) await http.delete(`/ssh_keys/${key.id}`).catch(ignoreMissing);
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createHetznerAdapter };
export default pkg;
