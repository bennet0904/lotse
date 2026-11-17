import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace, type LotseError, publishDirectory } from "../src/index.js";

let root: string;
let remote: string;
const auth = () => ({ url: `file://${remote}`, username: "", password: "" });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Outside", "-c", "user.email=outside@example.test", ...args], { cwd, encoding: "utf8" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lotse-git-"));
  remote = join(root, "remote.git");
  await mkdir(remote);
  git(remote, "init", "-q", "--bare", "-b", "main");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("git workspace", () => {
  it("commits every change and can return to an earlier state", async () => {
    const ws = new GitWorkspace(join(root, "project"));
    await ws.init();
    await writeFile(join(ws.dir, "index.html"), "v1");
    const first = await ws.commitAll("Initial version");
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await ws.commitAll("Nothing changed")).toBeUndefined();

    await writeFile(join(ws.dir, "index.html"), "v2");
    await writeFile(join(ws.dir, "extra.txt"), "new");
    await ws.commitAll("Second version");

    await ws.restore(first as string);
    expect(await readFile(join(ws.dir, "index.html"), "utf8")).toBe("v1");
    await expect(readFile(join(ws.dir, "extra.txt"), "utf8")).rejects.toThrow();
    // History is kept: restoring adds a commit instead of rewriting.
    expect((await ws.log()).map((c) => c.message)).toEqual([`Restore version ${(first as string).slice(0, 8)}`, "Second version", "Initial version"]);
  });

  it("pushes commits and pulls outside changes before the next generation", async () => {
    const ws = new GitWorkspace(join(root, "project"));
    await ws.init();
    await writeFile(join(ws.dir, "a.txt"), "a");
    await ws.commitAll("Add a");
    await ws.push(auth());
    expect(await ws.pull(auth())).toEqual({ updated: false, files: [] });

    const other = join(root, "other");
    git(root, "clone", "-q", remote, other);
    await writeFile(join(other, "b.txt"), "b");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "Outside change");
    git(other, "push", "-q");

    expect(await ws.pull(auth())).toEqual({ updated: true, files: ["b.txt"] });
    expect(await readFile(join(ws.dir, "b.txt"), "utf8")).toBe("b");
  });

  it("stops on conflicts, names the files and overwrites nothing", async () => {
    const ws = new GitWorkspace(join(root, "project"));
    await ws.init();
    await writeFile(join(ws.dir, "a.txt"), "base\n");
    await ws.commitAll("Base");
    await ws.push(auth());

    const other = join(root, "other");
    git(root, "clone", "-q", remote, other);
    await writeFile(join(other, "a.txt"), "outside\n");
    git(other, "commit", "-q", "-am", "Outside edit");
    git(other, "push", "-q");

    await writeFile(join(ws.dir, "a.txt"), "builder\n");
    await ws.commitAll("Builder edit");

    // Pushing is refused rather than forced.
    await expect(ws.push(auth())).rejects.toMatchObject({ code: "GIT_CONFLICT" });
    const err = (await ws.pull(auth()).catch((e) => e)) as LotseError;
    expect(err.code).toBe("GIT_CONFLICT");
    expect(err.details.files).toEqual(["a.txt"]);
    // The working tree is back to the builder's last commit, and the outside commit is still on the remote.
    expect(await readFile(join(ws.dir, "a.txt"), "utf8")).toBe("builder\n");
    expect(await ws.changedFiles()).toEqual([]);
    expect(git(remote, "log", "--format=%s", "main").trim().split("\n")[0]).toBe("Outside edit");
  });

  it("publishes a directory to a branch on top of its history", async () => {
    const site = join(root, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<h1>one</h1>");
    const first = await publishDirectory({ dir: site, auth: auth(), branch: "pages", message: "Deploy 1", extraFiles: { ".nojekyll": "" } });
    await writeFile(join(site, "index.html"), "<h1>two</h1>");
    const second = await publishDirectory({ dir: site, auth: auth(), branch: "pages", message: "Deploy 2" });
    expect(second).not.toBe(first);
    expect(git(remote, "log", "--format=%s", "pages").trim().split("\n")).toEqual(["Deploy 2", "Deploy 1"]);
    expect(git(remote, "show", "pages:index.html")).toBe("<h1>two</h1>");
    // Files that are no longer part of the site are removed.
    expect(() => git(remote, "show", "pages:.nojekyll")).toThrow();
  });
});
