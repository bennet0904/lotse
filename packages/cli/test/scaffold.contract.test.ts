import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cassette, runHostingContract } from "@lotseai/adapter-testkit";
import type { AdapterOptions, HostingAdapter } from "@lotseai/core";
import { assertAdapterPackage } from "@lotseai/core";
import { scaffoldAdapter } from "../src/index.js";

// `lotse create adapter` must produce a package whose contract tests pass as generated.
const parent = await mkdtemp(join(tmpdir(), "lotse-scaffold-"));
const result = await scaffoldAdapter(parent, "acme-cloud", "Acme Cloud");
const cassette = JSON.parse(await readFile(join(result.dir, "test/cassette.json"), "utf8")) as Cassette;
const mod = (await import(join(result.dir, "src/index.ts"))) as { default: unknown; createAcmeCloudAdapter: (o: AdapterOptions) => HostingAdapter };

runHostingContract({
  cassette,
  create: (scenario) => mod.createAcmeCloudAdapter({ fetch: scenario.fetch }),
  connectInput: { method: "token", token: "example-token-123456" },
  invalidConnectInput: { method: "token", token: "wrong-token-000000" },
  manifest: "version: 1\nname: lotse-reference\nruntime:\n  kind: static\n",
  fixtures: { appId: "site_1", previousDeployment: { id: "dep_0" } },
});

describe("lotse create adapter", () => {
  it("creates a complete package", async () => {
    expect(result.files).toEqual([
      ".gitignore",
      "README.md",
      "package.json",
      "src/index.ts",
      "test/acme-cloud.contract.test.ts",
      "test/cassette.json",
      "tsconfig.json",
    ]);
    const pkg = JSON.parse(await readFile(join(result.dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("lotse-adapter-acme-cloud");
    expect(pkg.keywords).toContain("lotse-adapter");
    expect(await readFile(join(result.dir, "test/acme-cloud.contract.test.ts"), "utf8")).toContain("createAcmeCloudAdapter");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).not.toContain("__");
    expect(() => assertAdapterPackage(mod.default)).not.toThrow();
  });

  it("validates the name and does not overwrite", async () => {
    await expect(scaffoldAdapter(parent, "Acme Cloud")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(scaffoldAdapter(parent, "acme-cloud")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
