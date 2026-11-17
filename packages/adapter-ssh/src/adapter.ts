/**
 * Self-hosting via SSH (specification section 10). Turns any Linux server
 * with SSH access into a hosting target. No agent runs on the server: every
 * command is sent over SSH and is idempotent.
 */
import { randomBytes } from "node:crypto";
import { lookup, resolve4 } from "node:dns/promises";
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type AppRef,
  type AppStatus,
  type BackupInfo,
  type BuildArtifact,
  type Capabilities,
  type ConnectInput,
  type Connection,
  cliImageTools,
  createChannel,
  type DeployContext,
  type DeployEvent,
  type DeploymentPlan,
  type DeploymentRef,
  type DomainStatus,
  type EnvVar,
  event,
  type HostingAdapter,
  type LogLine,
  type LogOptions,
  LotseError,
  lineSplitter,
  type Manifest,
  type ResourceRef,
  type ResourceSpec,
  resourceEnvName,
  type SetupPlan,
  STATIC_SITE_IGNORE,
  tarStream,
  throwIfAborted,
  type VerifyResult,
  walkFiles,
} from "@lotseai/core";
import { connectWithSsh2, generateSshKeyPair, must, paramsOf, publicKeyOf, type SshConnector, type SshExecutor, sh } from "./executor.js";
import {
  appDir,
  backupDir,
  defaultHostFor,
  imageRepo,
  KEEP_BACKUPS,
  KEEP_RELEASES,
  NETWORK,
  POSTGRES_IMAGE,
  PROXY,
  REDIS_IMAGE,
  type Release,
  type RemoteState,
  ROOT,
  releaseId,
  resourceContainer,
  siteConfig,
  siteFile,
} from "./layout.js";
import { BACKUP_SCRIPT, buildSetupPlan, detectServer, platformOf, runSetupSteps, type SetupSettings } from "./setup.js";

const capabilities: Capabilities = {
  runtimes: ["static", "server", "container"],
  languages: ["node", "python", "go", "php"],
  resources: ["postgres", "redis"],
  customDomains: true,
  previewDeployments: false,
  rollback: "native",
};

export interface SshAdapterOptions extends AdapterOptions {
  /** Opens SSH connections. Tests substitute a scripted implementation. */
  connector?: SshConnector;
  /** Seconds to wait for a new container to become healthy before giving up. */
  healthTimeoutSeconds?: number;
  /** Seconds the previous container keeps finishing requests after traffic moved on. */
  drainSeconds?: number;
  /** Resolves a domain to IPv4 addresses. Defaults to DNS. */
  resolve?: (domain: string) => Promise<string[]>;
}

function setupSettings(conn: Connection): SetupSettings {
  return {
    sshPort: Number(conn.settings.port ?? 22),
    httpPort: Number(conn.settings.httpPort ?? 80),
    httpsPort: Number(conn.settings.httpsPort ?? 443),
    acmeEmail: conn.settings.acmeEmail,
  };
}

function tlsMode(conn: Connection): "auto" | "internal" | "off" {
  const mode = conn.settings.tls;
  return mode === "internal" || mode === "off" ? mode : "auto";
}

function envFiles(vars: EnvVar[]): { script: string; names: string; json: string } {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return {
    script: vars.map((v) => `export ${v.name}=${quote(v.value)}`).join("\n") + (vars.length ? "\n" : ""),
    names: vars.map((v) => v.name).join("\n") + (vars.length ? "\n" : ""),
    json: JSON.stringify(vars),
  };
}

export function createSshAdapter(options: SshAdapterOptions = {}): HostingAdapter {
  const connector = options.connector ?? connectWithSsh2;
  const healthSeconds = options.healthTimeoutSeconds ?? Number(options.settings?.healthTimeoutSeconds ?? 90);
  const drainSeconds = options.drainSeconds ?? Number(options.settings?.drainSeconds ?? 5);
  const images = () => options.images ?? cliImageTools();

  const open = (conn: Connection) => connector(paramsOf(conn));
  async function withHost<T>(conn: Connection, fn: (x: SshExecutor) => Promise<T>): Promise<T> {
    const x = await open(conn);
    try {
      return await fn(x);
    } finally {
      x.close();
    }
  }

  // --- remote state --------------------------------------------------------

  async function readState(x: SshExecutor, app: string): Promise<RemoteState | undefined> {
    const out = await must(x, "read-state", `cat ${sh(`${appDir(app)}/state.json`)} 2>/dev/null || true`);
    return out.trim() ? (JSON.parse(out) as RemoteState) : undefined;
  }

  async function writeState(x: SshExecutor, state: RemoteState): Promise<void> {
    const dir = appDir(state.app);
    await must(
      x,
      "write-state",
      `mkdir -p ${sh(dir)} && cat > ${sh(`${dir}/state.json.tmp`)} && mv ${sh(`${dir}/state.json.tmp`)} ${sh(`${dir}/state.json`)}`,
      {
        stdin: `${JSON.stringify(state)}\n`,
      },
    );
  }

  async function requireState(x: SshExecutor, app: AppRef): Promise<RemoteState> {
    const state = await readState(x, app.name);
    if (!state) throw new LotseError("NOT_FOUND", `There is no app "${app.name}" on ${app.connection.settings.host}.`);
    return state;
  }

  async function readEnv(x: SshExecutor, app: string): Promise<EnvVar[]> {
    const out = await must(x, "read-env", `cat ${sh(`${appDir(app)}/env.json`)} 2>/dev/null || true`);
    return out.trim() ? (JSON.parse(out) as EnvVar[]) : [];
  }

  async function writeEnv(x: SshExecutor, app: string, vars: EnvVar[]): Promise<void> {
    const dir = appDir(app);
    const files = envFiles(vars);
    // Three files in one transfer, separated by a marker line that cannot occur in the content.
    const marker = `--lotse-${randomBytes(12).toString("hex")}--`;
    await must(
      x,
      "write-env",
      `umask 077; mkdir -p ${sh(dir)}; cd ${sh(dir)}
awk -v m=${sh(marker)} 'BEGIN{f="env.sh.tmp"} $0==m{n++; f=(n==1?"env.names.tmp":"env.json.tmp"); next} {print > f}'
touch env.sh.tmp env.names.tmp env.json.tmp
mv env.sh.tmp env.sh; mv env.names.tmp env.names; mv env.json.tmp env.json`,
      { stdin: `${files.script}${marker}\n${files.names}${marker}\n${files.json}\n` },
    );
  }

  // --- proxy ---------------------------------------------------------------

  async function writeSite(x: SshExecutor, conn: Connection, state: RemoteState, upstream?: string): Promise<void> {
    const config = siteConfig({
      app: state.app,
      defaultHost: state.defaultHost,
      domains: state.domains,
      upstream,
      static: state.kind === "static",
      tls: tlsMode(conn),
    });
    const file = siteFile(state.app);
    // Keep the previous file until Caddy has accepted the new configuration.
    await must(
      x,
      "switch-proxy",
      `cat > ${sh(`${file}.new`)}
[ -f ${sh(file)} ] && cp ${sh(file)} ${sh(`${file}.bak`)} || true
mv ${sh(`${file}.new`)} ${sh(file)}
if ! docker exec ${PROXY} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1; then
  if [ -f ${sh(`${file}.bak`)} ]; then mv ${sh(`${file}.bak`)} ${sh(file)}; else rm -f ${sh(file)}; fi
  docker exec ${PROXY} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  echo "Caddy rejected the new configuration; the previous one stays active." >&2
  exit 5
fi
rm -f ${sh(`${file}.bak`)}`,
      { stdin: config },
    );
  }

  // --- containers ----------------------------------------------------------

  /**
   * Starts a release next to the running one, waits for its health check and
   * only then moves traffic. On any failure the new container is removed and
   * the running version stays untouched.
   */
  async function* activate(
    x: SshExecutor,
    conn: Connection,
    state: RemoteState,
    release: Release,
    phase: "deploy" | "rollback",
    signal?: AbortSignal,
    releaseCommand?: string,
  ): AsyncGenerator<DeployEvent, RemoteState, void> {
    const app = state.app;
    const image = release.image as string;
    const container = `lotse-${app}-${release.id}-${randomBytes(2).toString("hex")}`;
    const port = state.port ?? 3000;
    const dir = appDir(app);
    const envArgs = `args=(); if [ -f ${sh(`${dir}/env.names`)} ]; then while read -r n; do [ -n "$n" ] && args+=(-e "$n"); done < ${sh(`${dir}/env.names`)}; . ${sh(`${dir}/env.sh`)}; fi`;

    if (releaseCommand) {
      yield event.log(phase, `Running release command: ${releaseCommand}`);
      const out = await x.run(
        "release-command",
        `${envArgs}\ndocker run --rm --network ${NETWORK} --label dev.lotse.app=${sh(app)} "\${args[@]}" ${sh(image)} sh -c ${sh(releaseCommand)} 2>&1`,
        { signal },
      );
      for (const line of out.stdout.trim().split("\n").filter(Boolean).slice(-40)) yield event.log(phase, line, "stdout");
      if (out.code !== 0) throw new LotseError("DEPLOY_FAILED", `The release command failed with exit code ${out.code}. The running version was not changed.`);
    }

    throwIfAborted(signal);
    yield event.log(phase, `Starting ${container}`);
    await must(
      x,
      "start-container",
      `${envArgs}
docker run -d --name ${sh(container)} --network ${NETWORK} --network-alias ${sh(container)} --restart no \\
  --label dev.lotse.app=${sh(app)} --label dev.lotse.release=${sh(release.id)} -e PORT=${port} "\${args[@]}" ${sh(image)} >/dev/null`,
    );

    const remove = () => x.run("remove-container", `docker rm -f ${sh(container)} >/dev/null 2>&1 || true`);
    try {
      const health = await x.run(
        "health-check",
        `for i in $(seq 1 ${healthSeconds}); do
  s=$(docker inspect -f '{{.State.Status}}' ${sh(container)} 2>/dev/null || echo gone)
  if [ "$s" != running ] && [ "$s" != created ]; then echo "The container is $s."; docker logs --tail 30 ${sh(container)} 2>&1 || true; exit 3; fi
  if docker exec ${PROXY} wget -q -T 3 -O /dev/null ${sh(`http://${container}:${port}${state.healthcheck}`)} 2>/dev/null; then echo healthy; exit 0; fi
  sleep 1
done
echo "No healthy answer from ${state.healthcheck} on port ${port} within ${healthSeconds} seconds."
docker logs --tail 30 ${sh(container)} 2>&1 || true
exit 4`,
        { signal },
      );
      if (health.code !== 0) {
        const lines = health.stdout.trim().split("\n");
        for (const line of lines.slice(1)) yield event.log(phase, line, "stderr");
        throw new LotseError("HEALTHCHECK_FAILED", `${lines[0] ?? "The health check failed."} The running version was not changed.`);
      }
      yield event.log(phase, "Health check passed; switching traffic.");
      throwIfAborted(signal);
      await writeSite(x, conn, state, `${container}:${port}`);
    } catch (err) {
      await remove();
      throw err;
    }

    // Traffic has moved. Everything below is cleanup and must not fail the release.
    const previous = state.current;
    const releases = [release, ...state.releases.filter((r) => r.id !== release.id)];
    const kept = releases.slice(0, KEEP_RELEASES);
    const next: RemoteState = { ...state, current: { ...release, container }, releases: kept };
    await writeState(x, next);
    const dropped = releases
      .slice(KEEP_RELEASES)
      .map((r) => r.image)
      .filter((i): i is string => Boolean(i));
    await x.run(
      "cleanup",
      `docker update --restart unless-stopped ${sh(container)} >/dev/null 2>&1 || true
${previous?.container ? `sleep ${drainSeconds}; docker stop -t 20 ${sh(previous.container)} >/dev/null 2>&1 || true; docker rm ${sh(previous.container)} >/dev/null 2>&1 || true` : ""}
${dropped.map((i) => `docker rmi ${sh(i)} >/dev/null 2>&1 || true`).join("\n")}`,
    );
    return next;
  }

  async function transferImage(
    x: SshExecutor,
    conn: Connection,
    artifact: Extract<BuildArtifact, { kind: "image" }>,
    target: string,
    signal?: AbortSignal,
  ): Promise<DeployEvent[]> {
    const events: DeployEvent[] = [];
    const registry = conn.settings.registry;
    if (registry) {
      const remote = `${registry.replace(/\/+$/, "")}/${target.split("/").pop()}`;
      const auth = conn.credentials.registryPassword
        ? { registry: remote.split("/")[0] as string, username: conn.credentials.registryUsername ?? "", password: conn.credentials.registryPassword }
        : undefined;
      for await (const e of images().push(artifact.image, remote, auth, signal)) events.push(e);
      if (auth) {
        await must(x, "registry-login", `docker login ${sh(auth.registry)} --username ${sh(auth.username)} --password-stdin >/dev/null 2>&1`, {
          stdin: auth.password,
        });
      }
      await must(x, "pull-image", `docker pull -q ${sh(remote)} >/dev/null && docker tag ${sh(remote)} ${sh(target)}`, { signal });
      events.push(event.log("deploy", `Pulled ${remote} on the server.`));
    } else {
      // No registry configured: stream the image directly over SSH.
      await must(x, "load-image", `docker load -q >/dev/null && docker tag ${sh(artifact.image)} ${sh(target)}`, {
        stdin: images().save(artifact.image),
        signal,
      });
      events.push(event.log("deploy", "Image transferred over SSH."));
    }
    return events;
  }

  function refOf(conn: Connection, state: RemoteState, app: AppRef, release: Release): DeploymentRef {
    const httpPort = Number(conn.settings.httpPort ?? 80);
    const suffix = httpPort === 80 ? "" : `:${httpPort}`;
    const domain = tlsMode(conn) !== "off" ? state.domains[0] : undefined;
    return {
      id: release.id,
      app: { ...app, id: app.name },
      url: domain ? `https://${domain}` : `http://${state.defaultHost}${suffix}`,
      createdAt: release.createdAt,
      version: release.id,
      // The default hostname may not resolve from everywhere; probe the server itself with the right Host header.
      probe: { url: `http://${conn.settings.host}${suffix}${state.healthcheck}`, headers: { Host: state.defaultHost } },
    };
  }

  // --- resources -----------------------------------------------------------

  async function provision(app: AppRef, res: ResourceSpec): Promise<ResourceRef> {
    if (res.type !== "postgres" && res.type !== "redis") {
      throw new LotseError("RESOURCE_UNSUPPORTED", `Own servers provide postgres and redis, not ${res.type}.`);
    }
    const name = resourceContainer(app.name, res.name);
    const volume = `${name}-data`;
    const labels = `--label dev.lotse.app=${sh(app.name)} --label dev.lotse.resource=${res.type} --label dev.lotse.resource-name=${sh(res.name)}`;
    const run =
      res.type === "postgres"
        ? `-v ${volume}:/var/lib/postgresql/data -e POSTGRES_USER=app -e POSTGRES_DB=app -e POSTGRES_PASSWORD="$PW" ${POSTGRES_IMAGE}`
        : `-v ${volume}:/data -e REDIS_PASSWORD="$PW" ${REDIS_IMAGE} sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --save 60 1 --dir /data'`;
    const ready =
      res.type === "postgres"
        ? `docker exec ${name} pg_isready -U app -d app`
        : `docker exec ${name} sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG'`;
    const key = res.type === "postgres" ? "POSTGRES_PASSWORD" : "REDIS_PASSWORD";
    const password = await withHost(app.connection, (x) =>
      must(
        x,
        `provision-${res.type}`,
        `read -r PW
if docker inspect ${name} >/dev/null 2>&1; then
  docker start ${name} >/dev/null
  PW=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${name} | grep '^${key}=' | cut -d= -f2-)
else
  docker volume inspect ${volume} >/dev/null 2>&1 || docker volume create --label dev.lotse.app=${sh(app.name)} ${volume} >/dev/null
  docker run -d --name ${name} --network ${NETWORK} --network-alias ${name} --restart unless-stopped ${labels} ${run} >/dev/null
fi
for i in $(seq 1 90); do ${ready} >/dev/null 2>&1 && break; sleep 1; done
${ready} >/dev/null
[ -x ${ROOT}/bin/lotse-backup ] || echo "backup-script-missing" >&2
echo "$PW"`,
        { stdin: `${randomBytes(24).toString("base64url")}\n` },
      ),
    );
    const pw = password.trim().split("\n").pop() as string;
    const url = res.type === "postgres" ? `postgres://app:${pw}@${name}:5432/app` : `redis://:${pw}@${name}:6379`;
    await ensureBackupScript(app.connection);
    return {
      type: res.type,
      name: res.name,
      id: name,
      provider: "ssh",
      env: [{ name: resourceEnvName(res.type, res.name), value: url, secret: true }],
      meta: { volume },
    };
  }

  /** Installs the backup script for servers that were prepared by hand, and the S3 settings if configured. */
  async function ensureBackupScript(conn: Connection): Promise<void> {
    await withHost(conn, async (x) => {
      await must(
        x,
        "install-backup-script",
        `mkdir -p ${ROOT}/bin ${ROOT}/backups; if [ -x ${ROOT}/bin/lotse-backup ]; then cat >/dev/null; else cat > ${ROOT}/bin/lotse-backup && chmod 755 ${ROOT}/bin/lotse-backup; fi`,
        {
          stdin: BACKUP_SCRIPT,
        },
      );
      if (conn.settings.s3Bucket && conn.credentials.s3AccessKey && conn.credentials.s3SecretKey) {
        const env = [
          `S3_BUCKET=${sh(conn.settings.s3Bucket)}`,
          `S3_ENDPOINT=${sh(conn.settings.s3Endpoint ?? "https://s3.amazonaws.com")}`,
          `S3_REGION=${sh(conn.settings.s3Region ?? "us-east-1")}`,
          `S3_ACCESS_KEY=${sh(conn.credentials.s3AccessKey)}`,
          `S3_SECRET_KEY=${sh(conn.credentials.s3SecretKey)}`,
        ].join("\n");
        await must(x, "write-backup-env", `umask 077; cat > ${ROOT}/backup.env`, { stdin: `${env}\nLOTSE_KEEP_BACKUPS=${KEEP_BACKUPS}\n` });
      }
    });
  }

  const BACKUP_ID = /^\d{8}T\d{6}Z\.(sql|rdb)\.gz$/;

  const adapter: HostingAdapter = {
    id: "ssh",
    displayName: "Own server (SSH)",
    auth: ["ssh"],
    capabilities,

    async connect(input: ConnectInput): Promise<Connection> {
      if (input.method !== "ssh") throw new LotseError("INVALID_INPUT", "Own servers are connected with an SSH key.");
      if (!input.privateKey && !input.password) {
        throw new LotseError("INVALID_INPUT", "Provide the private key generated by Lotse, or the server's password once so the key can be installed.");
      }
      const host = input.host.trim();
      const port = input.port ?? 22;
      const user = input.user ?? "root";
      const pair = input.privateKey
        ? { privateKey: input.privateKey, publicKey: publicKeyOf(input.privateKey, `lotse@${host}`) }
        : generateSshKeyPair(`lotse@${host}`);
      let hostKey = input.hostKey;

      if (input.password) {
        // The password is used exactly once, to install the public key. It is never stored.
        const first = await connector({ host, port, user, password: input.password, hostKey });
        try {
          hostKey = first.hostKey;
          await must(
            first,
            "install-key",
            `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; read -r KEY; grep -qxF "$KEY" ~/.ssh/authorized_keys || echo "$KEY" >> ~/.ssh/authorized_keys`,
            {
              stdin: `${pair.publicKey}\n`,
            },
          );
        } finally {
          first.close();
        }
      }

      let x: SshExecutor;
      try {
        x = await connector({ host, port, user, privateKey: pair.privateKey, hostKey });
      } catch (err) {
        if (err instanceof LotseError && err.code === "AUTH_FAILED" && !/host key/.test(err.message)) {
          throw new LotseError("AUTH_FAILED", `${user}@${host} did not accept the SSH key.`, {
            hints: [`Add this public key to ~/.ssh/authorized_keys of ${user} on the server, or enter the password once:\n${pair.publicKey}`],
            details: { publicKey: pair.publicKey },
          });
        }
        throw err;
      }
      try {
        const facts = await detectServer(x, pair.publicKey);
        let ip = host;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(host))
          ip = await lookup(host, 4).then(
            (r) => r.address,
            () => host,
          );
        const settings: Record<string, string> = {
          ...input.options,
          host,
          port: String(port),
          user,
          hostKey: x.hostKey,
          publicKey: pair.publicKey,
          ip,
          os: facts.name,
          arch: facts.arch,
        };
        return {
          adapter: "ssh",
          method: "ssh",
          account: { id: `${user}@${host}:${port}`, name: `${user}@${host}` },
          credentials: { privateKey: pair.privateKey, ...input.secrets },
          settings,
        };
      } finally {
        x.close();
      }
    },

    async verify(conn: Connection): Promise<VerifyResult> {
      return withHost(conn, async (x) => {
        const facts = await detectServer(x, conn.settings.publicKey ?? "");
        const missing: string[] = [];
        const warnings: string[] = [];
        if (facts.docker === "missing") missing.push("Docker is not installed. Run the server setup.");
        else if (!facts.dockerAccess) missing.push(`The user ${x.user} may not use Docker. Run the server setup.`);
        if (facts.docker !== "missing" && !facts.proxy) missing.push("The reverse proxy is not running. Run the server setup.");
        const plan = buildSetupPlan(conn.settings.host as string, facts, setupSettings(conn));
        if (!plan.os.supported)
          warnings.push(`${facts.name} is not a supported system (Ubuntu 24.04+ or Debian 12+). It works when Docker is installed, without automatic setup.`);
        else {
          if (!facts.firewall) warnings.push("The firewall is not active.");
          if (!facts.updates) warnings.push("Automatic security updates are not enabled.");
        }
        return { ok: missing.length === 0, account: `${x.user}@${conn.settings.host} (${facts.name})`, missingPermissions: missing, warnings };
      });
    },

    async plan(manifest: Manifest, conn: Connection): Promise<DeploymentPlan> {
      return withHost(conn, async (x) => {
        const out = await must(
          x,
          "plan-info",
          `echo "arch=$(uname -m)"
echo "proxy=$(docker inspect -f '{{.State.Running}}' ${PROXY} 2>/dev/null || echo missing)"`,
        );
        const info = Object.fromEntries(
          out
            .split("\n")
            .filter((l) => l.includes("="))
            .map((l) => l.split("=") as [string, string]),
        );
        if (info.proxy?.trim() !== "true") {
          throw new LotseError("PERMISSION_MISSING", `${conn.settings.host} is not set up for deployments yet.`, {
            hints: ["Run `lotse server setup` (or “Set up server” in the builder) first."],
          });
        }
        const state = await readState(x, manifest.name);
        const isStatic = manifest.runtime.kind === "static";
        const host = state?.defaultHost ?? defaultHostFor(manifest.name, conn.settings);
        const newDomains = manifest.domains.filter((d) => !state?.domains.includes(d));
        return {
          adapter: "ssh",
          app: { adapter: "ssh", name: manifest.name, id: state ? manifest.name : undefined, connection: conn },
          manifest,
          artifact: isStatic ? "static" : "image",
          firstDeployment: !state,
          steps: [
            {
              id: "app",
              title: state ? `Update ${manifest.name} on ${conn.settings.host}` : `Create ${manifest.name} on ${conn.settings.host}`,
              detail: `http://${host}`,
              action: state ? "update" : "create",
            },
            isStatic
              ? { id: "upload", title: "Upload the site and switch to it atomically", action: "create" as const }
              : {
                  id: "upload",
                  title: conn.settings.registry ? `Push the image to ${conn.settings.registry}` : "Transfer the image over SSH",
                  action: "create" as const,
                },
            ...(isStatic
              ? []
              : [{ id: "switch", title: "Start the new version next to the old one and switch after the health check", action: "update" as const }]),
            ...newDomains.map((d) => ({ id: `domain:${d}`, title: `Serve ${d} with a TLS certificate`, action: "update" as const, critical: true })),
          ],
          resources: [],
          warnings: [],
          meta: { platform: platformOf(info.arch?.trim() ?? "x86_64") },
        };
      });
    },

    async *deploy(plan: DeploymentPlan, artifact: BuildArtifact, ctx: DeployContext): AsyncIterable<DeployEvent> {
      const conn = ctx.connection;
      const manifest = plan.manifest;
      const app = manifest.name;
      throwIfAborted(ctx.signal);
      if (artifact.kind === "source") throw new LotseError("DEPLOY_FAILED", "The SSH adapter deploys built sites or images, not source code.");
      const x = await open(conn);
      try {
        const existing = await readState(x, app);
        const release: Release = { id: releaseId(), createdAt: Date.now() };
        const base: RemoteState = {
          app,
          kind: artifact.kind === "static" ? "static" : "image",
          port: artifact.kind === "image" ? (artifact.port ?? manifest.runtime.port) : undefined,
          healthcheck: manifest.runtime.healthcheck,
          defaultHost: existing?.defaultHost ?? defaultHostFor(app, conn.settings),
          domains: [...new Set([...(existing?.domains ?? []), ...manifest.domains])],
          current: existing?.current,
          releases: existing?.releases ?? [],
        };
        if (existing && existing.kind !== base.kind) {
          throw new LotseError(
            "DEPLOY_FAILED",
            `${app} is deployed as a ${existing.kind === "static" ? "static site" : "container"}; changing the kind needs a new app name or \`lotse destroy\` first.`,
          );
        }
        throwIfAborted(ctx.signal);

        let state: RemoteState;
        if (artifact.kind === "static") {
          const dir = appDir(app);
          const entries = await walkFiles(artifact.dir, { ignore: STATIC_SITE_IGNORE });
          yield event.log("deploy", `Uploading ${entries.length} files to ${conn.settings.host}`);
          const target = `${dir}/releases/${release.id}`;
          try {
            await must(x, "upload-static", `mkdir -p ${sh(target)} && tar -xzf - -C ${sh(target)} && chmod -R a+rX ${sh(target)}`, {
              stdin: tarStream(entries, { gzip: true }),
              signal: ctx.signal,
            });
            throwIfAborted(ctx.signal);
          } catch (err) {
            await x.run("remove-release", `rm -rf ${sh(target)}`);
            throw err;
          }
          // An atomic rename of the symlink: requests see either the old or the new release.
          await must(x, "switch-static", `cd ${sh(dir)} && ln -sfn ${sh(`releases/${release.id}`)} current.tmp && mv -T current.tmp current`);
          const releases = [release, ...base.releases].slice(0, KEEP_RELEASES);
          state = { ...base, current: release, releases };
          try {
            if (!existing || existing.domains.join() !== base.domains.join()) await writeSite(x, conn, state);
          } catch (err) {
            if (existing?.current)
              await x.run("switch-static", `cd ${sh(dir)} && ln -sfn ${sh(`releases/${existing.current.id}`)} current.tmp && mv -T current.tmp current`);
            throw err;
          }
          await writeState(x, state);
          await x.run(
            "prune-releases",
            `cd ${sh(`${dir}/releases`)} && ls -1 | sort -r | tail -n +${KEEP_RELEASES + 1} | while read -r old; do rm -rf "./$old"; done`,
          );
          yield event.log("deploy", `Release ${release.id} is live.`);
        } else {
          release.image = `${imageRepo(app)}:${release.id}`;
          yield event.log("deploy", `Transferring ${artifact.image} to ${conn.settings.host}`);
          yield* await transferImage(x, conn, artifact, release.image, ctx.signal);
          await writeEnv(
            x,
            app,
            ctx.env.filter((v) => v.name !== "PORT"),
          );
          try {
            state = yield* activate(x, conn, base, release, "deploy", ctx.signal, manifest.release?.command);
          } catch (err) {
            await x.run("remove-image", `docker rmi ${sh(release.image)} >/dev/null 2>&1 || true`);
            throw err;
          }
          yield event.log("deploy", `Release ${release.id} is live; the previous version was stopped.`);
        }
        const ref = refOf(conn, state, plan.app, release);
        yield event.status("deploy", "succeeded", ref.url, ref);
      } finally {
        x.close();
      }
    },

    async rollback(target: DeploymentRef, ctx: DeployContext): Promise<void> {
      await withHost(ctx.connection, async (x) => {
        const state = await requireState(x, target.app);
        const release = state.releases.find((r) => r.id === (target.version ?? target.id));
        if (!release) {
          throw new LotseError("ROLLBACK_FAILED", `Release ${target.id} is no longer on the server. The last ${KEEP_RELEASES} releases are kept.`);
        }
        if (state.kind === "static") {
          const dir = appDir(state.app);
          await must(
            x,
            "switch-static",
            `cd ${sh(dir)} && [ -d ${sh(`releases/${release.id}`)} ] && ln -sfn ${sh(`releases/${release.id}`)} current.tmp && mv -T current.tmp current`,
          );
          await writeState(x, { ...state, current: release });
          return;
        }
        const run = activate(x, ctx.connection, state, release, "rollback", ctx.signal);
        for (;;) {
          const next = await run.next();
          if (next.done) break;
        }
      });
    },

    async destroy(app: AppRef): Promise<void> {
      await withHost(app.connection, (x) =>
        must(
          x,
          "destroy",
          `rm -f ${sh(siteFile(app.name))}
docker exec ${PROXY} caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
docker ps -aq --filter label=dev.lotse.app=${sh(app.name)} | xargs -r docker rm -f >/dev/null
docker volume ls -q --filter label=dev.lotse.app=${sh(app.name)} | xargs -r docker volume rm >/dev/null
docker images -q ${sh(imageRepo(app.name))} | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true
rm -rf ${sh(appDir(app.name))}`,
        ),
      );
    },

    async setEnv(app: AppRef, vars: EnvVar[]): Promise<void> {
      await withHost(app.connection, async (x) => {
        const merged = new Map((await readEnv(x, app.name)).map((v) => [v.name, v]));
        for (const v of vars) if (v.name !== "PORT") merged.set(v.name, v);
        await writeEnv(x, app.name, [...merged.values()]);
        const state = await readState(x, app.name);
        // A running container picks up the new values through a zero-downtime restart.
        if (state?.kind === "image" && state.current?.image) {
          const run = activate(x, app.connection, state, state.current, "deploy");
          for (;;) if ((await run.next()).done) break;
        }
      });
    },

    async addDomain(app: AppRef, domain: string): Promise<DomainStatus> {
      const conn = app.connection;
      await withHost(conn, async (x) => {
        const state = await requireState(x, app);
        if (!state.domains.includes(domain)) {
          const next = { ...state, domains: [...state.domains, domain] };
          await writeSite(x, conn, next, state.current?.container ? `${state.current.container}:${state.port ?? 3000}` : undefined);
          await writeState(x, next);
        }
      });
      const ip = conn.settings.ip ?? conn.settings.host ?? "";
      const resolved = await (options.resolve ?? resolve4)(domain).catch(() => [] as string[]);
      if (resolved.includes(ip)) return { domain, state: "active", dnsRecords: [] };
      return {
        domain,
        state: "pending",
        dnsRecords: [{ type: "A", name: domain, value: ip }],
        message: resolved.length
          ? `The domain points to ${resolved.join(", ")}.`
          : "The domain does not resolve yet. Caddy requests the certificate as soon as it does.",
      };
    },

    provision,

    async *logs(app: AppRef, opts: LogOptions): AsyncIterable<LogLine> {
      const x = await open(app.connection);
      try {
        const state = await requireState(x, app);
        const container = state.kind === "image" ? state.current?.container : PROXY;
        if (!container) return;
        const args = ["--timestamps", "--tail", String(opts.tail ?? 100)];
        if (opts.since) args.push("--since", new Date(opts.since).toISOString());
        if (opts.follow) args.push("--follow");
        const channel = createChannel<LogLine>();
        const parse = (stream: "stdout" | "stderr") =>
          lineSplitter((raw) => {
            const m = raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/);
            channel.push({
              at: m ? Date.parse(m[1] as string) : Date.now(),
              stream,
              line: m ? (m[2] as string) : raw,
              source: state.kind === "image" ? "app" : "proxy",
            });
          });
        const out = parse("stdout");
        const err = parse("stderr");
        x.run("logs", `docker logs ${args.map(sh).join(" ")} ${sh(container)}`, {
          onStdout: (c) => out.write(c),
          onStderr: (c) => err.write(c),
          signal: opts.signal,
        }).then(
          () => {
            out.flush();
            err.flush();
            channel.close();
          },
          (e) => channel.close(e instanceof LotseError && e.code === "ABORTED" ? undefined : e),
        );
        let seen = 0;
        for await (const line of channel) {
          seen++;
          yield line;
        }
        if (seen === 0 && state.kind === "static") yield { at: Date.now(), stream: "system", line: "Static site: no requests logged yet.", source: "proxy" };
      } finally {
        x.close();
      }
    },

    async status(app: AppRef): Promise<AppStatus> {
      return withHost(app.connection, async (x) => {
        const state = await readState(x, app.name);
        if (!state?.current) return { state: "not-found", domains: [] };
        const ref = refOf(app.connection, state, app, state.current);
        const base = { url: ref.url, domains: [state.defaultHost, ...state.domains], deployment: { id: state.current.id, createdAt: state.current.createdAt } };
        if (state.kind === "static") return { state: "running", ...base };
        const out = await x.run("container-status", `docker inspect -f '{{.State.Status}}' ${sh(state.current.container ?? "")} 2>/dev/null || echo gone`);
        const s = out.stdout.trim();
        return {
          state: s === "running" ? "running" : s === "restarting" || s === "created" ? "deploying" : s === "gone" ? "stopped" : "failed",
          ...base,
          message: s === "running" ? undefined : `The container is ${s}.`,
        };
      });
    },

    server: {
      async planSetup(conn: Connection): Promise<SetupPlan> {
        return withHost(conn, async (x) => {
          const facts = await detectServer(x, conn.settings.publicKey ?? publicKeyOf(conn.credentials.privateKey as string));
          if (!facts.sudo && !(facts.dockerAccess && facts.deployUser)) {
            throw new LotseError(
              "PERMISSION_MISSING",
              `Setting up the server needs root access, but ${x.user} is neither root nor allowed to use sudo without a password.`,
            );
          }
          return buildSetupPlan(conn.settings.host as string, facts, setupSettings(conn));
        });
      },
      async *runSetup(conn, plan, approval) {
        if (approval.approved !== true) {
          throw new LotseError("APPROVAL_REQUIRED", "Setting up a server changes its system configuration and must be approved explicitly.");
        }
        const x = await open(conn);
        try {
          return yield* runSetupSteps({ conn, plan, executor: x, connect: connector, settings: setupSettings(conn), signal: approval.signal });
        } finally {
          x.close();
        }
      },
    },

    backups: {
      async listBackups(app: AppRef, resource: string): Promise<BackupInfo[]> {
        const out = await withHost(app.connection, (x) =>
          must(
            x,
            "list-backups",
            `d=${sh(backupDir(app.name, resource))}; [ -d "$d" ] || exit 0; for f in "$d"/*.gz; do [ -f "$f" ] && stat -c '%n %s %Y' "$f" || true; done`,
          ),
        );
        return out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [path = "", bytes = "0", mtime = "0"] = line.split(" ");
            return { id: path.split("/").pop() as string, resource, createdAt: Number(mtime) * 1000, bytes: Number(bytes), location: "local" as const };
          })
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async createBackup(app: AppRef, resource: string): Promise<BackupInfo> {
        await ensureBackupScript(app.connection);
        const out = await withHost(app.connection, (x) => must(x, "create-backup", `${ROOT}/bin/lotse-backup ${sh(app.name)} ${sh(resource)}`));
        const file = out
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("/"))
          .pop();
        if (!file) throw new LotseError("NOT_FOUND", `There is no database "${resource}" for ${app.name} on this server.`);
        const all = await (adapter.backups as NonNullable<HostingAdapter["backups"]>).listBackups(app, resource);
        return (
          all.find((b) => b.id === file.split("/").pop()) ?? {
            id: file.split("/").pop() as string,
            resource,
            createdAt: Date.now(),
            bytes: 0,
            location: "local",
          }
        );
      },
      async restoreBackup(app: AppRef, resource: string, backupId: string): Promise<void> {
        if (!BACKUP_ID.test(backupId)) throw new LotseError("INVALID_INPUT", `"${backupId}" is not a backup id.`);
        const file = `${backupDir(app.name, resource)}/${backupId}`;
        const container = resourceContainer(app.name, resource);
        const script = backupId.endsWith(".sql.gz")
          ? `[ -f ${sh(file)} ] || { echo "Backup not found." >&2; exit 2; }
gunzip -c ${sh(file)} | docker exec -i ${sh(container)} sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" "$POSTGRES_DB"' >/dev/null`
          : `[ -f ${sh(file)} ] || { echo "Backup not found." >&2; exit 2; }
docker stop ${sh(container)} >/dev/null
gunzip -c ${sh(file)} > /tmp/lotse-restore.rdb
docker cp /tmp/lotse-restore.rdb ${sh(container)}:/data/dump.rdb >/dev/null
rm -f /tmp/lotse-restore.rdb
docker start ${sh(container)} >/dev/null`;
        await withHost(app.connection, (x) => must(x, "restore-backup", script));
      },
    },
  };
  return adapter;
}

const pkg: AdapterPackage = { apiVersion: ADAPTER_API_VERSION, hosting: createSshAdapter };
export default pkg;
