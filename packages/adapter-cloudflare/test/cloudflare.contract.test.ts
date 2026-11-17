import { loadCassette, runHostingContract, scenarioOf } from "@lotseai/adapter-testkit";
import { assetHash, createCloudflareAdapter } from "../src/index.js";

const cassette = await loadCassette(new URL("./cassette.json", import.meta.url));

runHostingContract({
  cassette,
  create: (scenario) => createCloudflareAdapter({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "cloudflare-test-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "lotse-reference", previousDeployment: { id: "dep_0", version: "ver_0" } },
});

describe("cloudflare specifics", () => {
  it("hashes assets the way Cloudflare's direct upload expects", () => {
    // sha256 of the base64 content followed by the extension, first 32 hex characters.
    // Reference values computed independently (Python: hashlib and base64).
    expect(assetHash(Buffer.from("ok\n"), "health")).toBe("fe8621a1e49b6f83c9578df2a377cd0d");
    expect(assetHash(Buffer.from("<!doctype html><title>Reference</title><h1>Lotse reference app</h1>\n"), "index.html")).toBe(
      "9014dc6ec3bb246ccc2ebf72dcc514fe",
    );
    expect(assetHash(Buffer.from("a"), "x.html")).not.toBe(assetHash(Buffer.from("a"), "x.css"));
    expect(assetHash(Buffer.from("a"), "x.html")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("authenticates asset uploads with the session token, not the account token", async () => {
    const scenario = scenarioOf(cassette, "deploy");
    const adapter = createCloudflareAdapter({ fetch: scenario.fetch });
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseManifest } = await import("@lotseai/core");
    const dir = await mkdtemp(join(tmpdir(), "lotse-cf-"));
    try {
      await writeFile(join(dir, "index.html"), "<!doctype html><title>Reference</title><h1>Lotse reference app</h1>\n");
      await writeFile(join(dir, "health"), "ok\n");
      const conn = {
        adapter: "cloudflare",
        method: "token" as const,
        account: { id: "acc_1", name: "Ada" },
        credentials: { token: "cloudflare-test-token-123456" },
        settings: { accountId: "acc_1" },
      };
      const plan = await adapter.plan(parseManifest("version: 1\nname: lotse-reference\nruntime:\n  kind: static\n"), conn);
      for await (const _ of adapter.deploy(
        plan,
        { kind: "static", dir, files: 2, bytes: 71 },
        { connection: conn, workdir: dir, env: [{ name: "API_KEY", value: "s3cr3t-value", secret: true }], resources: [] },
      )) {
        // drain
      }
      const upload = scenario.transport.requests.find((r) => r.url.includes("/workers/assets/upload"));
      expect(upload?.headers.authorization).toBe("Bearer upload-jwt-000000000000");
      const put = scenario.transport.requests.find((r) => r.method === "PUT");
      expect(put).toBeDefined();
      const metadata = (put as { body: { metadata: { assets: { jwt: string }; bindings: { name: string; type: string }[]; main_module?: string } } }).body
        .metadata;
      expect(metadata.assets.jwt).toBe("completion-jwt-00000000");
      expect(metadata.bindings).toEqual([{ name: "API_KEY", type: "secret_text", text: "s3cr3t-value" }]);
      expect(metadata.main_module).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
