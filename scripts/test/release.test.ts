import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRelease,
  bumpVersion,
  changelogSection,
  entryTitle,
  history,
  insertSection,
  lastReleaseTag,
  parseArgs,
  planRelease,
  readPackages,
  satisfiesRange,
  setManifestVersion,
  // @ts-expect-error -- plain JavaScript module without type declarations
} from "../release.mjs";

const packages = [
  { dir: "adapter-fly", name: "@lotseai/adapter-fly", version: "0.1.0", corePeer: ">=0.1.0 <1.0.0" },
  { dir: "adapter-testkit", name: "@lotseai/adapter-testkit", version: "0.1.0" },
  { dir: "adapter-vercel", name: "@lotseai/adapter-vercel", version: "0.3.2", corePeer: ">=0.1.0 <1.0.0" },
  { dir: "cli", name: "@lotseai/cli", version: "0.1.0" },
  { dir: "core", name: "@lotseai/core", version: "0.1.0" },
  { dir: "server", name: "@lotseai/server", version: "0.1.0" },
];

describe("release", () => {
  it("raises versions", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("0.1.3", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.4.3", "major")).toBe("1.0.0");
    expect(bumpVersion("1.2.0-rc.1", "patch")).toBe("1.2.0");
    expect(bumpVersion("1.2.0-rc.1", "1.2.0-rc.2")).toBe("1.2.0-rc.2");
    expect(bumpVersion("1.1.0", "1.2.0-rc.1")).toBe("1.2.0-rc.1");
    expect(() => bumpVersion("0.2.0", "0.1.9")).toThrow(/not higher/);
    expect(() => bumpVersion("0.2.0", "next")).toThrow(/neither/);
  });

  it("gives core, CLI and builder one version and releases only the adapters that changed", () => {
    const plan = planRelease({
      packages,
      changedFiles: ["packages/adapter-fly/src/index.ts", "packages/adapter-vercel/test/vercel.contract.test.ts", "guide/index.md"],
      spec: "minor",
    });
    expect(plan.tag).toBe("v0.2.0");
    expect(plan.bumps.map((b: { dir: string; to: string }) => `${b.dir}@${b.to}`)).toEqual([
      "adapter-fly@0.1.1",
      // The test kit belongs to the core; test-only changes do not release an adapter.
      "adapter-testkit@0.2.0",
      "cli@0.2.0",
      "core@0.2.0",
      "server@0.2.0",
    ]);
  });

  it("lets the release choose the type of an adapter release or skip it", () => {
    const plan = planRelease({
      packages,
      changedFiles: ["packages/adapter-fly/src/index.ts"],
      spec: "patch",
      ...parseArgs(["patch", "--adapter", "fly=skip", "--adapter", "@lotseai/adapter-vercel=minor"]),
    });
    expect(plan.bumps.filter((b: { shared: boolean }) => !b.shared).map((b: { dir: string; to: string }) => `${b.dir}@${b.to}`)).toEqual([
      "adapter-vercel@0.4.0",
    ]);
    expect(() => planRelease({ packages, changedFiles: [], spec: "patch", adapterSpecs: { "adapter-testkit": "minor" } })).toThrow(/no adapter/);
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["patch", "--adapter", "fly"])).toThrow(/expects/);
  });

  it("refuses a core version outside the peer range of an adapter", () => {
    expect(satisfiesRange("0.2.0", ">=0.1.0 <1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0-rc.1", ">=0.1.0 <1.0.0")).toBe(true);
    expect(satisfiesRange("2.1.0", ">=0.1.0 <1.0.0 || >=2.0.0 <3.0.0")).toBe(true);
    expect(satisfiesRange("0.1.0", "0.1.0")).toBe(true);
    expect(() => satisfiesRange("0.1.0", "^0.1.0")).toThrow(/Cannot read/);
    expect(() => planRelease({ packages, changedFiles: [], spec: "major" })).toThrow(
      /outside the peer range of @lotseai\/adapter-fly \(>=0.1.0 <1.0.0\), @lotseai\/adapter-vercel/,
    );
  });

  it("finds @lotseai/core as a peer dependency of every adapter in the repository", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const adapters = (await readPackages(root)).filter((p: { dir: string }) => p.dir.startsWith("adapter-") && p.dir !== "adapter-testkit");
    expect(adapters.length).toBeGreaterThan(0);
    for (const adapter of adapters) {
      const manifest = JSON.parse(await readFile(join(root, "packages", adapter.dir, "package.json"), "utf8"));
      // A regular dependency would install a second core next to the CLI's when their versions differ.
      expect(manifest.dependencies?.["@lotseai/core"], adapter.name).toBeUndefined();
      // The workspace protocol keeps core linked when the web app image installs production dependencies only.
      expect(manifest.peerDependencies["@lotseai/core"], adapter.name).toMatch(/^workspace:/);
      expect(manifest.devDependencies?.["@lotseai/core"], adapter.name).toBeUndefined();
      expect(satisfiesRange(JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8")).version, adapter.corePeer)).toBe(true);
    }
  });

  it("lists the changes per package in the changelog", () => {
    expect(entryTitle("Merge pull request #18 from someone/branch", "Build the desktop app for Intel Macs\n\nMore text")).toBe(
      "Build the desktop app for Intel Macs (#18)",
    );
    expect(entryTitle("Fix the health check (#21)", "")).toBe("Fix the health check (#21)");
    const plan = planRelease({ packages, changedFiles: ["packages/adapter-fly/src/index.ts"], spec: "minor" });
    const section = changelogSection({
      plan,
      date: "2026-11-18",
      entries: [
        { title: "Add rollback to the Fly.io adapter (#30)", files: ["packages/adapter-fly/src/index.ts", "packages/core/src/types.ts"] },
        { title: "Explain releases (#31)", files: ["CONTRIBUTING.md"] },
      ],
    });
    expect(section).toBe(`## v0.2.0 (2026-11-18)

### Core, CLI and builder 0.2.0

- Add rollback to the Fly.io adapter (#30)

### @lotseai/adapter-fly 0.1.1

- Add rollback to the Fly.io adapter (#30)

### Other changes

- Explain releases (#31)
`);
    const first = insertSection("", section);
    expect(first).toMatch(/^# Changelog\n[\s\S]*\n## v0\.2\.0/);
    const second = insertSection(first, section.replace("v0.2.0", "v0.3.0"));
    expect(second.indexOf("## v0.3.0")).toBeLessThan(second.indexOf("## v0.2.0"));
    expect(second.startsWith("# Changelog")).toBe(true);
  });

  it("changes only the version of a manifest", () => {
    const manifest = '{\n  "name": "@lotseai/core",\n  "version": "0.1.0",\n  "dependencies": {\n    "x": {\n      "version": "1"\n    }\n  }\n}\n';
    expect(setManifestVersion(manifest, "0.2.0")).toBe(manifest.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  });

  describe("in a repository", () => {
    let root: string;
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const write = async (file: string, text: string) => {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), text);
    };
    const commit = (message: string) => {
      git(["add", "-A"]);
      git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message]);
    };

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "lotse-release-"));
      git(["init", "-q", "-b", "main"]);
      await write("package.json", '{\n  "name": "lotse",\n  "version": "0.1.0"\n}\n');
      for (const pkg of packages) {
        const peer = pkg.corePeer ? `,\n  "peerDependencies": {\n    "@lotseai/core": "${pkg.corePeer}"\n  }` : "";
        await write(`packages/${pkg.dir}/package.json`, `{\n  "name": "${pkg.name}",\n  "version": "${pkg.version}"${peer}\n}\n`);
      }
      await write("packages/cli/src/cli.ts", 'export const CLI_VERSION = "0.1.0";\n');
      await write("packages/server/src/http.ts", 'export const SERVER_VERSION = "0.1.0";\n');
      commit("Initial");
    });

    afterEach(() => rm(root, { recursive: true, force: true }));

    it("prepares a release from the changes since the last tag", async () => {
      expect(lastReleaseTag(git)).toBeUndefined();
      git(["tag", "v0.1.0"]);
      await write("packages/adapter-vercel/src/index.ts", "export {};\n");
      commit("Retry Vercel deployments (#40)");
      await write("packages/core/src/index.ts", "export {};\n");
      commit("Merge pull request #41 from someone/branch\n\nValidate domains in the manifest");

      const since = lastReleaseTag(git);
      expect(since).toBe("v0.1.0");
      const { changedFiles, entries } = history(git, since);
      expect(entries.map((e: { title: string }) => e.title)).toEqual(["Retry Vercel deployments (#40)", "Validate domains in the manifest (#41)"]);
      const plan = planRelease({ packages: await readPackages(root), changedFiles, spec: "minor" });
      await applyRelease(root, plan, changelogSection({ plan, entries, date: "2026-11-18" }));

      expect(JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8")).version).toBe("0.2.0");
      expect(JSON.parse(await readFile(join(root, "packages/adapter-vercel/package.json"), "utf8")).version).toBe("0.3.3");
      expect(JSON.parse(await readFile(join(root, "packages/adapter-fly/package.json"), "utf8")).version).toBe("0.1.0");
      expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.2.0");
      expect(await readFile(join(root, "packages/cli/src/cli.ts"), "utf8")).toContain('CLI_VERSION = "0.2.0"');
      expect(await readFile(join(root, "packages/server/src/http.ts"), "utf8")).toContain('SERVER_VERSION = "0.2.0"');
      const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
      expect(changelog).toContain("### @lotseai/adapter-vercel 0.3.3\n\n- Retry Vercel deployments (#40)");
      expect(changelog).toContain("### Core, CLI and builder 0.2.0\n\n- Validate domains in the manifest (#41)");
    });
  });
});
