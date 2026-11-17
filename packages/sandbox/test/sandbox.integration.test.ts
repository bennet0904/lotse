/**
 * Runs against the local container engine. Everything it creates carries a
 * unique `lotse-it-…` prefix and is removed afterwards.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient, detectRuntimes, type Sandbox, SandboxManager } from "../src/index.js";

const docker = new DockerClient();
const available = await docker.ping().then(
  () => true,
  () => false,
);
const IMAGE = "node:22-alpine";

describe.skipIf(!available)("sandbox", () => {
  const prefix = `lotse-it-${Date.now().toString(36)}`;
  const manager = new SandboxManager({ namePrefix: prefix, subnetPrefix: "10.232" });
  let root = "";
  let a: Sandbox;
  let b: Sandbox;
  let startMs = 0;

  const start = (id: string) => manager.start({ projectId: id, workdir: join(root, id, "workspace"), cacheDir: join(root, id, "cache"), image: IMAGE });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lotse-sandbox-"));
    await docker.ensureImage(IMAGE);
    await manager.ensureGateway();
    const t0 = Date.now();
    a = await start("alpha");
    startMs = Date.now() - t0;
    b = await start("beta");
  });

  afterAll(async () => {
    await manager.shutdown({ removeGateway: true });
    await rm(root, { recursive: true, force: true });
  });

  it("starts in under 15 seconds when the base image is present", () => {
    expect(startMs).toBeLessThan(15_000);
  });

  it("runs commands in the project directory without root privileges", async () => {
    const id = await a.exec("id -u; pwd");
    expect(id.code).toBe(0);
    const [uid, cwd] = id.output.trim().split("\n");
    expect(uid).not.toBe("0");
    expect(cwd).toBe("/workspace");
    // No way to become root, and no capabilities.
    expect((await a.exec("grep CapEff /proc/self/status")).output).toMatch(/CapEff:\s+0000000000000000/);
  });

  it("shares the project directory and nothing else", async () => {
    await writeFile(join(root, "alpha/workspace/from-host.txt"), "host");
    expect((await a.exec("cat from-host.txt && echo sandbox > from-sandbox.txt")).output.trim()).toBe("host");
    expect(await readFile(join(root, "alpha/workspace/from-sandbox.txt"), "utf8")).toBe("sandbox\n");
    // Files created inside belong to the sandbox user, not to root.
    expect((await stat(join(root, "alpha/workspace/from-sandbox.txt"))).uid).toBe(manager.user.uid);
    // The other project's files and the host's files are not there.
    expect((await a.exec(`ls ${root} 2>&1; ls /root 2>&1; ls /var/run/docker.sock 2>&1`)).output).not.toMatch(/beta|\.claude|docker\.sock$/m);
  });

  it("applies the default limits of 2 CPU cores and 2 GB of memory", async () => {
    expect(manager.limits).toEqual({ cpus: 2, memoryMb: 2048 });
    const out = (await a.exec("cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max")).output.trim().split("\n");
    expect(out[0]).toBe(String(2048 * 1024 * 1024));
    expect(out[1]).toBe("200000 100000");
    expect(out[2]).toBe("512");
  });

  it("streams output line by line and reports exit codes", async () => {
    const lines: string[] = [];
    const result = await a.exec("echo one; echo two >&2; exit 3", { onOutput: (line, stream) => lines.push(`${stream}:${line}`) });
    expect(result.code).toBe(3);
    expect(lines.sort()).toEqual(["stderr:two", "stdout:one"]);
  });

  it("ends commands that run too long", async () => {
    const t0 = Date.now();
    const result = await a.exec("sleep 60", { timeoutMs: 1000 });
    expect(result.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await a.exec("pgrep sleep | wc -l")).output.trim()).toBe("1"); // only the container's own `sleep infinity`
  });

  it("reaches package registries through the gateway and nothing else", async () => {
    // Direct connections are impossible: the sandbox network has no route out.
    const direct = await a.exec(
      "env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm ping --registry https://registry.npmjs.org --fetch-retries=0 --fetch-timeout=4000 2>&1",
      { timeoutMs: 30_000 },
    );
    expect(direct.code).not.toBe(0);
    // The npm registry is on the allow-list.
    const registry = await a.exec("npm view is-odd version 2>&1", { timeoutMs: 60_000 });
    expect(registry.output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    // Everything else is refused by the gateway.
    const other = await a.exec("npm ping --registry https://example.org --fetch-retries=0 2>&1", { timeoutMs: 30_000 });
    expect(other.code).not.toBe(0);
    expect(other.output).toMatch(/403|ECONNRESET|tunneling socket|E403|proxy/i);
  });

  it("serves the preview through the gateway only", async () => {
    await a.startProcess("dev", `node -e "require('http').createServer((q,r)=>r.end('hello from alpha '+q.url)).listen(3000,'0.0.0.0')"`);
    expect(await a.waitForPort(3000, 20_000)).toBe(true);
    expect(await a.processRunning("dev")).toBe(true);

    const target = a.previewTarget(3000);
    const res = await fetch(`${target.url}/page?x=1`, { headers: target.headers });
    expect(await res.text()).toBe("hello from alpha /page?x=1");
    // Without the builder's key the gateway refuses.
    expect((await fetch(`${target.url}/`, { headers: { "x-lotse-target": target.headers["x-lotse-target"] as string } })).status).toBe(403);
    // And it never forwards to anything but sandboxes.
    expect((await fetch(`${target.url}/`, { headers: { ...target.headers, "x-lotse-target": "localhost:3128" } })).status).toBe(403);

    await a.stopProcess("dev");
    expect(await a.processRunning("dev")).toBe(false);
    expect((await fetch(`${target.url}/`, { headers: target.headers })).status).toBe(502);
  });

  it("keeps projects apart from each other", async () => {
    await a.startProcess("dev", `node -e "require('http').createServer((q,r)=>r.end('alpha')).listen(3000,'0.0.0.0')"`);
    await a.waitForPort(3000, 20_000);
    // Beta cannot resolve or reach alpha's container…
    const reach = await b.exec(
      `node -e "require('net').connect({host:'${a.container}',port:3000,timeout:2000}).on('connect',()=>{console.log('REACHED');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)}).on('timeout',()=>{console.log('timeout');process.exit(1)})"`,
      { timeoutMs: 15_000 },
    );
    expect(reach.output).not.toContain("REACHED");
    // …and cannot use the gateway's ingress to get there, because it lacks the key.
    const viaGateway = await b.exec(
      `node -e "fetch('http://lotse-gateway:8080/',{headers:{'x-lotse-target':'${a.container}:3000'}}).then(r=>console.log('status',r.status))"`,
      { timeoutMs: 15_000 },
    );
    expect(viaGateway.output.trim()).toBe("status 403");
    await a.stopProcess("dev");
  });

  it("pauses idle sandboxes and resumes them on the next access", async () => {
    expect(await manager.sweep()).toEqual([]);
    const paused = await manager.sweep(Date.now() + 31 * 60_000);
    expect(paused.sort()).toEqual(["alpha", "beta"]);
    expect(await a.state()).toBe("paused");
    expect((await a.exec("echo back")).output.trim()).toBe("back");
    expect(await a.state()).toBe("running");
    await b.resume();
  });

  it("finds running sandboxes again after a restart of the server", async () => {
    const other = new SandboxManager({ namePrefix: prefix });
    const found = await other.get("alpha");
    expect(found?.container).toBe(a.container);
    expect((await found?.exec("echo again"))?.output.trim()).toBe("again");
    expect(await other.get("missing")).toBeUndefined();
  });

  it("removes a sandbox with its network", async () => {
    await manager.remove("beta");
    expect(await b.state()).toBe("stopped");
    const networks = await docker.request<{ Name: string }[]>("GET", "/networks");
    expect(networks.map((n) => n.Name)).not.toContain(`${prefix}-sbx-net-beta`);
    expect(networks.map((n) => n.Name)).toContain(`${prefix}-sbx-net-alpha`);
  });
});

describe("runtime detection", () => {
  it("reports the engine or explains how to get one", async () => {
    const status = await detectRuntimes();
    expect(status.ready).toBe(available);
    if (status.ready) expect(status.engine?.version).toMatch(/^\d+\./);
    const none = await detectRuntimes({ DOCKER_HOST: "unix:///nonexistent/docker.sock" });
    expect(none.ready).toBe(false);
    expect(none.guidance.steps.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!available)("concurrent starts", () => {
  it("shares one start between callers that ask for the same project at the same time", async () => {
    const prefix = `lotse-it-${Date.now().toString(36)}c`;
    const manager = new SandboxManager({ namePrefix: prefix, subnetPrefix: "10.233" });
    const root = await mkdtemp(join(tmpdir(), "lotse-sandbox-"));
    try {
      const options = { projectId: "gamma", workdir: join(root, "w"), cacheDir: join(root, "c"), image: IMAGE };
      const [one, two, three] = await Promise.all([manager.start(options), manager.start(options), manager.get("gamma")]);
      expect(one).toBe(two);
      expect(three).toBe(one);
      expect((await one.exec("echo ok")).output.trim()).toBe("ok");
    } finally {
      await manager.shutdown({ removeGateway: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
