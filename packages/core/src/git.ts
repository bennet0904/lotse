/**
 * Local Git operations used for versioning projects and syncing them with a
 * Git platform (specification sections 11 and 12.1). Uses the `git` binary;
 * pushing happens over HTTPS with the adapter's token, which is passed through
 * the environment and never written to `.git/config` or the command line.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LotseError } from "./errors.js";
import { redact } from "./redact.js";
import type { AuthenticatedUrl } from "./types.js";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface PullResult {
  /** True when new commits from the remote were integrated. */
  updated: boolean;
  /** Files changed by the commits that were pulled. */
  files: string[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function authEnv(auth?: AuthenticatedUrl): Record<string, string> {
  if (!auth?.password) return {};
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  const origin = new URL(auth.url).origin;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

function runGit(cwd: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(new LotseError("GIT_FAILED", (err as NodeJS.ErrnoException).code === "ENOENT" ? "Git is not installed." : `Could not run git: ${err.message}`)),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export const DEFAULT_IDENTITY: GitIdentity = { name: "Lotse", email: "lotse@localhost" };

export class GitWorkspace {
  readonly dir: string;
  readonly #identity: GitIdentity;

  constructor(dir: string, identity: GitIdentity = DEFAULT_IDENTITY) {
    this.dir = dir;
    this.#identity = identity;
  }

  async #git(args: string[], env?: Record<string, string>, allowFail = false): Promise<RunResult> {
    const result = await runGit(
      this.dir,
      [
        "-c",
        `user.name=${this.#identity.name}`,
        "-c",
        `user.email=${this.#identity.email}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...this.#safe(),
        ...args,
      ],
      env,
    );
    if (result.code !== 0 && !allowFail) {
      throw new LotseError("GIT_FAILED", redact(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`));
    }
    return result;
  }

  /**
   * The builder's sandbox runs as another user than the server, so project
   * files may not belong to the user running git. The directory is one the
   * framework created itself, so it is declared safe for this call only.
   */
  #safe(): string[] {
    return ["-c", `safe.directory=${this.dir}`];
  }

  async isRepo(): Promise<boolean> {
    const r = await runGit(this.dir, [...this.#safe(), "rev-parse", "--is-inside-work-tree"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (r.code !== 0) return false;
    // A project inside someone else's repository is not "its own" repository.
    const top = await runGit(this.dir, [...this.#safe(), "rev-parse", "--show-prefix"]);
    return top.stdout.trim() === "";
  }

  async init(branch = "main"): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (await this.isRepo()) return;
    await this.#git(["init", "-q", "-b", branch]);
  }

  async currentBranch(): Promise<string> {
    return (await this.#git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
  }

  async head(): Promise<string | undefined> {
    const r = await this.#git(["rev-parse", "HEAD"], undefined, true);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async changedFiles(): Promise<string[]> {
    const r = await this.#git(["status", "--porcelain", "-z", "--untracked-files=all"]);
    return r.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
  }

  /** Commits every change. Returns the commit hash, or undefined when there was nothing to commit. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.#git(["add", "-A"]);
    const staged = await this.#git(["diff", "--cached", "--quiet"], undefined, true);
    if (staged.code === 0 && (await this.head())) return undefined;
    await this.#git(["commit", "-q", "--allow-empty", "-m", message]);
    return this.head();
  }

  async log(limit = 50): Promise<CommitInfo[]> {
    const r = await this.#git(["log", `-${limit}`, "--pretty=format:%H%x1f%s%x1f%an%x1f%aI%x1e"], undefined, true);
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = "", message = "", author = "", date = ""] = line.split("\x1f");
        return { sha, message, author, date };
      });
  }

  /**
   * Returns the project to an earlier state by adding a new commit with that
   * state's content. History is never rewritten.
   */
  async restore(sha: string): Promise<string | undefined> {
    const verify = await this.#git(["cat-file", "-e", `${sha}^{commit}`], undefined, true);
    if (verify.code !== 0) throw new LotseError("NOT_FOUND", `Commit ${sha} does not exist in this project.`);
    await this.#git(["read-tree", "-u", "--reset", sha]);
    return this.commitAll(`Restore version ${sha.slice(0, 8)}`);
  }

  async diff(from: string, to = "HEAD"): Promise<string[]> {
    const r = await this.#git(["diff", "--name-only", from, to]);
    return r.stdout.split("\n").filter(Boolean);
  }

  async setRemote(url: string, name = "origin"): Promise<void> {
    const existing = await this.#git(["remote", "get-url", name], undefined, true);
    if (existing.code === 0) await this.#git(["remote", "set-url", name, url]);
    else await this.#git(["remote", "add", name, url]);
  }

  async remoteUrl(name = "origin"): Promise<string | undefined> {
    const r = await this.#git(["remote", "get-url", name], undefined, true);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /**
   * Integrates outside changes before the next generation. If they conflict
   * with local commits, the merge is undone and `GIT_CONFLICT` lists the
   * affected files. Outside commits are never overwritten.
   */
  async pull(auth: AuthenticatedUrl, branch?: string): Promise<PullResult> {
    const target = branch ?? (await this.currentBranch());
    await this.setRemote(auth.url);
    const dirty = await this.changedFiles();
    if (dirty.length > 0) {
      throw new LotseError("GIT_CONFLICT", "The project has uncommitted changes; commit them before syncing.", { details: { files: dirty } });
    }
    const fetched = await this.#git(["fetch", "-q", "origin", target], authEnv(auth), true);
    if (fetched.code !== 0) {
      // An empty remote or a branch that does not exist yet is not an error.
      if (/couldn't find remote ref/i.test(fetched.stderr)) return { updated: false, files: [] };
      throw new LotseError("GIT_FAILED", redact(`git fetch failed: ${fetched.stderr.trim()}`));
    }
    const before = await this.head();
    const remote = (await this.#git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
    if (!before) {
      await this.#git(["reset", "-q", "--hard", remote]);
      return { updated: true, files: [] };
    }
    if (before === remote) return { updated: false, files: [] };
    const ancestor = await this.#git(["merge-base", "--is-ancestor", remote, "HEAD"], undefined, true);
    if (ancestor.code === 0) return { updated: false, files: [] };

    const merge = await this.#git(["merge", "--no-edit", "-m", "Merge changes from repository", remote], undefined, true);
    if (merge.code !== 0) {
      const conflicts = (await this.#git(["diff", "--name-only", "--diff-filter=U"], undefined, true)).stdout.split("\n").filter(Boolean);
      await this.#git(["merge", "--abort"], undefined, true);
      throw new LotseError(
        "GIT_CONFLICT",
        `Changes made in the repository conflict with changes made here${conflicts.length ? `: ${conflicts.join(", ")}` : ""}. Nothing was overwritten.`,
        { details: { files: conflicts }, hints: ["Resolve the conflict in the repository or restore an earlier version, then sync again."] },
      );
    }
    return { updated: true, files: await this.diff(before) };
  }

  /** Pushes the current branch. Never forces; a diverged remote yields `GIT_CONFLICT`. */
  async push(auth: AuthenticatedUrl, branch?: string): Promise<void> {
    const target = branch ?? (await this.currentBranch());
    await this.setRemote(auth.url);
    const r = await this.#git(["push", "-q", "origin", `HEAD:refs/heads/${target}`], authEnv(auth), true);
    if (r.code !== 0) {
      if (/rejected|non-fast-forward|fetch first/i.test(r.stderr)) {
        throw new LotseError("GIT_CONFLICT", "The repository contains commits that are not part of this project yet. Sync before pushing.", {
          details: { files: [] },
        });
      }
      throw new LotseError("GIT_FAILED", redact(`git push failed: ${r.stderr.trim()}`));
    }
  }

  /** Clones a repository into `dir`. Used when importing an existing repository. */
  static async clone(auth: AuthenticatedUrl, dir: string, branch?: string, identity?: GitIdentity): Promise<GitWorkspace> {
    await mkdir(dir, { recursive: true });
    const args = ["clone", "-q", ...(branch ? ["--branch", branch] : []), auth.url, "."];
    const r = await runGit(dir, args, authEnv(auth));
    if (r.code !== 0) throw new LotseError("GIT_FAILED", redact(`git clone failed: ${r.stderr.trim()}`));
    return new GitWorkspace(dir, identity);
  }
}

/**
 * Publishes a directory as the content of a branch (used for Pages hosting).
 * The new commit is added on top of the branch's existing history.
 * Returns the hash of the published commit.
 */
export async function publishDirectory(input: {
  dir: string;
  auth: AuthenticatedUrl;
  branch: string;
  message: string;
  /** Extra files written next to the content, e.g. a CI definition or `.nojekyll`. */
  extraFiles?: Record<string, string>;
  identity?: GitIdentity;
}): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "lotse-pages-"));
  try {
    const ws = new GitWorkspace(tmp, input.identity);
    await runGit(tmp, ["init", "-q", "-b", input.branch]);
    await ws.setRemote(input.auth.url);
    const env = authEnv(input.auth);
    const fetched = await runGit(tmp, ["fetch", "-q", "--depth", "1", "origin", input.branch], env);
    if (fetched.code === 0) {
      await runGit(tmp, ["reset", "-q", "--soft", "FETCH_HEAD"]);
    } else if (!/couldn't find remote ref/i.test(fetched.stderr)) {
      throw new LotseError("GIT_FAILED", redact(`git fetch failed: ${fetched.stderr.trim()}`));
    }
    for (const name of await readdir(tmp)) {
      if (name !== ".git") await rm(join(tmp, name), { recursive: true, force: true });
    }
    await cp(input.dir, tmp, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".git") });
    for (const [path, content] of Object.entries(input.extraFiles ?? {})) {
      await mkdir(join(tmp, path, ".."), { recursive: true });
      await writeFile(join(tmp, path), content, "utf8");
    }
    const sha = (await ws.commitAll(input.message)) ?? (await ws.head());
    const pushed = await runGit(tmp, ["push", "-q", "origin", `HEAD:refs/heads/${input.branch}`], env);
    if (pushed.code !== 0) throw new LotseError("GIT_FAILED", redact(`git push failed: ${pushed.stderr.trim()}`));
    return sha as string;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
