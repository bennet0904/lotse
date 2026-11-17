import { loadCassette, runHostingContract, scenarioOf } from "@lotse/adapter-testkit";
import { createVercelAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => createVercelAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } }),
  connectInput: { method: "token", token: "vercel-test-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "prj_1", previousDeployment: { id: "dpl_0", url: "https://lotse-reference-old.vercel.app" } },
});

describe("vercel specifics", () => {
  const connection = {
    adapter: "vercel",
    method: "token" as const,
    account: { id: "usr_1", name: "ada" },
    credentials: { token: "vercel-test-token-123456" },
    settings: { teamId: "team_9" },
  };

  it("uploads only the files Vercel is missing and sends the digest header", async () => {
    const scenario = scenarioOf(cassette, "deploy");
    const adapter = createVercelAdapter({ fetch: scenario.fetch, settings: { pollIntervalMs: 1 } });
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseManifest } = await import("@lotse/core");
    const dir = await mkdtemp(join(tmpdir(), "lotse-vercel-"));
    try {
      await writeFile(join(dir, "index.html"), "<!doctype html><title>Reference</title><h1>Lotse reference app</h1>\n");
      await writeFile(join(dir, "health"), "ok\n");
      const conn = { ...connection, settings: {} };
      const plan = await adapter.plan(parseManifest("version: 1\nname: lotse-reference\nruntime:\n  kind: static\n"), conn);
      const env = [
        { name: "APP_NAME", value: "Reference", secret: false },
        { name: "API_KEY", value: "s3cr3t-value", secret: true },
      ];
      for await (const _ of adapter.deploy(plan, { kind: "static", dir, files: 2, bytes: 71 }, { connection: conn, workdir: dir, env, resources: [] })) {
        // drain
      }
      const uploads = scenario.transport.requests.filter((r) => r.url.endsWith("/v2/files"));
      expect(uploads.map((u) => u.headers["x-vercel-digest"]).sort()).toEqual([
        "92a949fd41844e1bb8c6812cdea102708fde23a4",
        "99669826553891f3b5cfae5754f4dc38e3ff851e",
      ]);
      expect(uploads.every((u) => u.headers.authorization === "Bearer vercel-test-token-123456")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scopes every request to the team when one is configured", async () => {
    const scenario = scenarioOf(cassette, "status");
    const adapter = createVercelAdapter({ fetch: scenario.fetch });
    await adapter.status({ adapter: "vercel", name: "lotse-reference", id: "prj_1", connection });
    expect(new URL(scenario.transport.requests[0]?.url ?? "").searchParams.get("teamId")).toBe("team_9");
  });

  it("asks Vercel to build server apps from source", async () => {
    const scenario = scenarioOf(cassette, "plan");
    const adapter = createVercelAdapter({ fetch: scenario.fetch });
    const { parseManifest } = await import("@lotse/core");
    const plan = await adapter.plan(parseManifest("version: 1\nname: lotse-reference\nruntime:\n  kind: server\n  language: node\n"), {
      ...connection,
      settings: {},
    });
    expect(plan.artifact).toBe("source");
    expect(plan.warnings[0]).toMatch(/serverless functions/);
  });
});
