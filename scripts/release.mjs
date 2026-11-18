#!/usr/bin/env node
/**
 * Prepares a release: raises the shared version of core, CLI and builder, raises
 * the version of every adapter that changed since the last release, and adds a
 * section to CHANGELOG.md. Commit the result, open a pull request, merge it and
 * tag the merge commit with the printed tag; the release workflow does the rest.
 *
 *   node scripts/release.mjs <patch|minor|major|X.Y.Z> [--adapter <name>=<patch|minor|major|X.Y.Z|skip>]... [--since <ref>] [--dry-run]
 *
 * Every package in packages/ shares one version, except the provider adapters
 * (packages/adapter-*, without the test kit), which are versioned on their own.
 * A changed adapter gets a patch release unless --adapter says otherwise;
 * --adapter also releases an adapter that did not change.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/** Constants in the sources that must carry the shared version. */
export const VERSION_CONSTANTS = [
  { file: "packages/cli/src/cli.ts", name: "CLI_VERSION" },
  { file: "packages/server/src/http.ts", name: "SERVER_VERSION" },
];

/** Provider adapters are versioned on their own; everything else in packages/ shares one version. */
export const isAdapter = (dir) => dir.startsWith("adapter-") && dir !== "adapter-testkit";

/** The next version: a release type applied to the current version, or an explicit version. */
export function bumpVersion(current, spec) {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`"${current}" is not a version`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const pre = Boolean(match[4]);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  // 1.2.0-rc.1 becomes 1.2.0, as with npm version.
  if (spec === "patch") return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  if (!SEMVER.test(spec)) throw new Error(`"${spec}" is neither patch, minor, major nor a version like 1.2.3`);
  if (compareVersions(spec, current) <= 0) throw new Error(`${spec} is not higher than the current version ${current}`);
  return spec;
}

/** Orders two versions; a pre-release comes before its release. */
export function compareVersions(a, b) {
  const [pa, pb] = [SEMVER.exec(a), SEMVER.exec(b)];
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4].localeCompare(pb[4], "en", { numeric: true });
}

/** The package directory a changed file belongs to, if the change can affect what is published (tests cannot). */
export function packageOfFile(file) {
  const match = /^packages\/([^/]+)\/(.+)$/.exec(file);
  if (!match || match[2].startsWith("test/")) return undefined;
  return match[1];
}

/**
 * The versions of the release. `packages` are { dir, name, version }; `changedFiles`
 * are paths relative to the repository; `adapterSpecs` maps adapter directories to a
 * release type, a version or "skip".
 */
export function planRelease({ packages, changedFiles, spec, adapterSpecs = {} }) {
  const core = packages.find((p) => p.dir === "core");
  if (!core) throw new Error("packages/core is missing");
  const version = bumpVersion(core.version, spec);
  const changed = new Set(changedFiles.map(packageOfFile).filter(Boolean));
  for (const dir of Object.keys(adapterSpecs)) {
    if (!packages.some((p) => p.dir === dir && isAdapter(p.dir))) throw new Error(`There is no adapter "${dir}"`);
  }
  const bumps = [];
  for (const pkg of packages) {
    if (!isAdapter(pkg.dir)) {
      bumps.push({ ...pkg, from: pkg.version, to: version, shared: true });
      continue;
    }
    const adapterSpec = adapterSpecs[pkg.dir] ?? (changed.has(pkg.dir) ? "patch" : "skip");
    if (adapterSpec === "skip") continue;
    bumps.push({ ...pkg, from: pkg.version, to: bumpVersion(pkg.version, adapterSpec), shared: false });
  }
  return { version, tag: `v${version}`, bumps };
}

/** The changelog line of a commit on main: pull request merges use the pull request's title. */
export function entryTitle(subject, body = "") {
  const merge = /^Merge pull request #(\d+) from \S+$/.exec(subject.trim());
  if (!merge) return subject.trim();
  const title = body.trim().split("\n")[0]?.trim();
  return `${title || subject.trim()} (#${merge[1]})`;
}

/** A CHANGELOG.md section: what changed in core, CLI and builder, in each released adapter, and elsewhere. */
export function changelogSection({ plan, entries, date }) {
  const adapters = plan.bumps.filter((b) => !b.shared);
  const sharedDirs = new Set(plan.bumps.filter((b) => b.shared).map((b) => b.dir));
  const groups = [{ title: `Core, CLI and builder ${plan.version}`, items: [] }];
  const byAdapter = new Map(adapters.map((b) => [b.dir, { title: `${b.name} ${b.to}`, items: [] }]));
  const other = { title: "Other changes", items: [] };
  for (const entry of entries) {
    const dirs = new Set(entry.files.map(packageOfFile).filter(Boolean));
    const targets = [];
    if ([...dirs].some((d) => sharedDirs.has(d))) targets.push(groups[0]);
    for (const dir of dirs) if (byAdapter.has(dir)) targets.push(byAdapter.get(dir));
    // Handbook, documentation, CI and tests.
    if (targets.length === 0) targets.push(other);
    for (const target of targets) target.items.push(entry.title);
  }
  const sections = [...groups, ...[...byAdapter.values()].sort((a, b) => a.title.localeCompare(b.title)), other];
  let text = `## ${plan.tag} (${date})\n`;
  for (const section of sections) {
    if (section.items.length === 0 && section !== groups[0]) continue;
    text += `\n### ${section.title}\n\n`;
    text += section.items.length > 0 ? section.items.map((item) => `- ${item}`).join("\n") : "- No changes of their own; released with the new version.";
    text += "\n";
  }
  return text;
}

const CHANGELOG_HEADER = `# Changelog

All notable changes, newest first. Core, CLI and builder share one version; adapters are versioned on their own and listed with the release that published them.
`;

/** CHANGELOG.md with the new section above the previous releases. */
export function insertSection(existing, section) {
  const current = existing?.trim() ? existing : CHANGELOG_HEADER;
  const at = current.search(/^## /m);
  if (at === -1) return `${current.trimEnd()}\n\n${section}`;
  return `${current.slice(0, at)}${section}\n${current.slice(at)}`;
}

/** Replaces the top-level "version" of a package.json without reformatting the rest. */
export function setManifestVersion(text, version) {
  let replaced = false;
  const result = text.replace(/^(\s{2}"version":\s*")[^"]*(")/m, (_, start, end) => {
    replaced = true;
    return `${start}${version}${end}`;
  });
  if (!replaced) throw new Error('No top-level "version" field');
  return result;
}

/** Replaces `export const NAME = "…";` in a source file. */
export function setConstant(text, name, version) {
  const pattern = new RegExp(`(export const ${name} = ")[^"]*(";)`);
  if (!pattern.test(text)) throw new Error(`export const ${name} not found`);
  return text.replace(pattern, `$1${version}$2`);
}

export async function readPackages(root) {
  const packages = [];
  for (const dir of (await readdir(join(root, "packages"))).sort()) {
    const manifest = await readFile(join(root, "packages", dir, "package.json"), "utf8").catch(() => undefined);
    if (!manifest) continue;
    const { name, version } = JSON.parse(manifest);
    packages.push({ dir, name, version });
  }
  return packages;
}

/** Writes the new versions and the changelog. */
export async function applyRelease(root, plan, section) {
  const update = async (file, change) => {
    const path = join(root, file);
    await writeFile(path, change(await readFile(path, "utf8")));
  };
  for (const bump of plan.bumps) await update(`packages/${bump.dir}/package.json`, (text) => setManifestVersion(text, bump.to));
  await update("package.json", (text) => setManifestVersion(text, plan.version));
  for (const constant of VERSION_CONSTANTS) await update(constant.file, (text) => setConstant(text, constant.name, plan.version));
  const changelog = join(root, "CHANGELOG.md");
  await writeFile(changelog, insertSection(await readFile(changelog, "utf8").catch(() => ""), section));
}

/** The last release tag reachable from HEAD, or undefined before the first release. */
export function lastReleaseTag(git) {
  try {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Files changed since `since` (everything if undefined) and the commits on the first-parent line since then. */
export function history(git, since) {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  const changedFiles = since
    ? git(["diff", "--name-only", since, "HEAD"]).split("\n").filter(Boolean)
    : git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const entries = [];
  const log = git(["log", "--first-parent", "--format=%H%x1f%P%x1f%s%x1f%b%x1e", ...range]);
  for (const record of log.split("\x1e")) {
    if (!record.trim()) continue;
    const [hash, parents, subject, body] = record.replace(/^\n/, "").split("\x1f");
    const parent = parents.trim().split(" ")[0];
    const files = (parent ? git(["diff", "--name-only", parent, hash]) : git(["ls-tree", "-r", "--name-only", hash])).split("\n").filter(Boolean);
    entries.push({ title: entryTitle(subject, body), files });
  }
  // Oldest first, as the changes happened.
  return { changedFiles, entries: entries.reverse() };
}

export function parseArgs(argv) {
  const options = { spec: undefined, adapterSpecs: {}, since: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--since") options.since = argv[++i];
    else if (arg === "--adapter") {
      const [name, spec] = (argv[++i] ?? "").split("=");
      if (!name || !spec) throw new Error("--adapter expects <name>=<patch|minor|major|X.Y.Z|skip>, e.g. --adapter fly=minor");
      const dir = name.replace(/^@lotseai\//, "").replace(/^(adapter-)?/, "adapter-");
      options.adapterSpecs[dir] = spec;
    } else if (!arg.startsWith("-") && !options.spec) options.spec = arg;
    else throw new Error(`Unknown argument "${arg}"`);
  }
  if (!options.spec) {
    throw new Error("usage: release.mjs <patch|minor|major|X.Y.Z> [--adapter <name>=<patch|minor|major|X.Y.Z|skip>]... [--since <ref>] [--dry-run]");
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  // Without the full history and the tags, the last release cannot be found.
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") throw new Error("This clone is shallow; run git fetch --unshallow --tags first.");
  const since = options.since ?? lastReleaseTag(git);
  const { changedFiles, entries } = history(git, since);
  const plan = planRelease({ packages: await readPackages(root), changedFiles, spec: options.spec, adapterSpecs: options.adapterSpecs });
  const section = changelogSection({ plan, entries, date: new Date().toISOString().slice(0, 10) });

  console.log(since ? `Changes since ${since}.` : "No earlier release tag; every package counts as changed.");
  for (const bump of plan.bumps) console.log(`  ${bump.name.padEnd(32)} ${bump.from} -> ${bump.to}`);
  if (options.dryRun) {
    console.log(`\n${section}`);
    return;
  }
  await applyRelease(root, plan, section);
  console.log(`
Updated the versions and CHANGELOG.md. Next:
  1. Review and edit the new section of CHANGELOG.md.
  2. git switch -c release/${plan.tag} && git add -A CHANGELOG.md package.json packages && git commit -s -m "Release ${plan.tag}" && git push -u origin release/${plan.tag}
  3. Open a pull request and merge it.
  4. Tag the merge commit on main: git switch main && git pull && git tag ${plan.tag} && git push origin ${plan.tag}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
