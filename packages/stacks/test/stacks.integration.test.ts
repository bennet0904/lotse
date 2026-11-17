/**
 * Every stack template in a real sandbox, the way the builder uses it:
 * bootstrap, scaffold, install, check, development server behind the gateway,
 * and the production build from lotse.yaml. Needs a container engine and
 * network access to the package registries; LOTSE_TEST_STACKS=react-vite,hono
 * limits the run to some stacks.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadManifest } from "@lotse/core";
import { DEFAULT_ALLOWED_HOSTS, DockerClient, type Sandbox, SandboxManager } from "@lotse/sandbox";
import { StackRegistry, scaffoldFiles } from "../src/index.js";

const available = await new DockerClient().ping().then(
  () => true,
  () => false,
);
const registry = new StackRegistry();
const wanted = process.env.LOTSE_TEST_STACKS?.split(",").map((s) => s.trim());
const stacks = registry.list().filter((s) => !wanted || wanted.includes(s.id));

/** A request to the app in the sandbox, through the gateway as the preview proxy sends it. */
function viaGateway(target: { url: string; headers: Record<string, string> }, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const req = request(
      { host: url.hostname, port: url.port, path, headers: { ...target.headers, host: "p-test-0000000000000000.localhost" }, timeout: 120_000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!available)("stacks in the sandbox", () => {
  const prefix = `lotse-it-${Date.now().toString(36)}s`;
  const manager = new SandboxManager({ namePrefix: prefix, subnetPrefix: "10.234", allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...registry.allowedHosts()] });
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lotse-stacks-"));
  });

  afterAll(async () => {
    await manager.shutdown({ removeGateway: true });
    await rm(root, { recursive: true, force: true });
  });

  it.each(stacks.map((s) => [s.id, s] as const))(
    "%s: scaffolds, installs, passes its check, serves the preview and builds",
    async (id, stack) => {
      const workdir = join(root, id, "workspace");
      const cacheDir = join(root, id, "cache");
      for (const [path, content] of Object.entries(stack.sandbox.helperFiles ?? {})) {
        await mkdir(dirname(join(cacheDir, path)), { recursive: true });
        await writeFile(join(cacheDir, path), content);
      }
      const sandbox: Sandbox = await manager.start({
        projectId: `stk-${id}`,
        workdir,
        cacheDir,
        image: stack.sandbox.image,
        env: { PORT: String(stack.sandbox.port), LOTSE_PREVIEW_HOST: "*.localhost" },
      });
      const run = async (command: string, timeoutMs = 900_000) => {
        const result = await sandbox.exec(command, { timeoutMs });
        expect(result.code, `${command}\n${result.output.slice(-3000)}`).toBe(0);
        return result.output;
      };

      if (stack.bootstrap) await run(stack.bootstrap);
      await scaffoldFiles(stack, workdir, { name: `test-${id}`, title: `Stack ${stack.name}` });
      const { uid, gid } = manager.user;
      if (process.getuid?.() === 0) execFileSync("chown", ["-R", `${uid}:${gid}`, workdir]);

      if (stack.sandbox.install) await run(stack.sandbox.install);
      if (stack.sandbox.check) await run(stack.sandbox.check, 300_000);

      await sandbox.startProcess("dev", stack.sandbox.dev, { PORT: String(stack.sandbox.port) });
      const listening = await sandbox.waitForPort(stack.sandbox.port, 180_000);
      expect(listening, await sandbox.processLogs("dev", 80)).toBe(true);
      const target = sandbox.previewTarget(stack.sandbox.port);
      // Some development servers compile the first page on demand; give them time.
      await expect.poll(async () => (await viaGateway(target, "/")).status, { timeout: 180_000, interval: 2000 }).toBe(200);

      const manifest = await loadManifest(workdir);
      if (manifest.runtime.kind !== "static" && manifest.runtime.healthcheck) {
        const health = await viaGateway(target, manifest.runtime.healthcheck);
        expect(health.status, health.body.slice(0, 500)).toBe(200);
      }
      await sandbox.stopProcess("dev");
      // The production build the deployment runs (stacks with a Dockerfile build there instead).
      if (manifest.build.command) await run(manifest.build.command);
      await manager.remove(`stk-${id}`);
    },
    1_800_000,
  );
});
