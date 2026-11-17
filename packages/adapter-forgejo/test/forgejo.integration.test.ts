/**
 * The Forgejo adapter against a real Forgejo instance in a throwaway
 * container: repositories, pushing over HTTPS-style token auth, Actions
 * secrets, the generated workflow, comments, Pages, and conflict handling.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, collectEvents, GitWorkspace, type HostingAdapter, type LotseError, parseManifest, type RepoRef } from "@lotseai/core";
import { createForgejoProvider } from "../src/index.js";

const IMAGE = "codeberg.org/forgejo/forgejo:13";
const docker = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!docker)("forgejo adapter against a real instance", () => {
  const container = `lotse-it-forgejo-${Date.now().toString(36)}`;
  const provider = createForgejoProvider();
  let baseUrl = "";
  let conn: Connection;
  let repo: RepoRef;
  let work = "";
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: { authorization: `token ${conn.credentials.token}`, "content-type": "application/json", ...init?.headers },
    });
    return (res.status === 204 ? undefined : await res.json()) as T;
  };

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--label",
        "dev.lotse.test=1",
        "-p",
        `127.0.0.1:${port}:3000`,
        "-e",
        "FORGEJO__security__INSTALL_LOCK=true",
        "-e",
        `FORGEJO__server__ROOT_URL=${baseUrl}/`,
        "-e",
        "FORGEJO__database__DB_TYPE=sqlite3",
        "-e",
        "FORGEJO__actions__ENABLED=true",
        "-e",
        "FORGEJO__log__LEVEL=Warn",
        IMAGE,
      ],
      { stdio: "pipe" },
    );
    for (let i = 0; i < 120; i++) {
      if (
        await fetch(`${baseUrl}/api/v1/version`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const cli = (...args: string[]) => execFileSync("docker", ["exec", "-u", "git", container, "forgejo", ...args], { encoding: "utf8" });
    cli(
      "admin",
      "user",
      "create",
      "--username",
      "ada",
      "--password",
      "Passw0rd-for-tests!",
      "--email",
      "ada@example.test",
      "--admin",
      "--must-change-password=false",
    );
    const token = cli("admin", "user", "generate-access-token", "--username", "ada", "--scopes", "all", "--raw").trim().split("\n").pop() as string;
    conn = await provider.connect({ method: "token", token, options: { baseUrl, pagesDomain: "pages.example.test" } });
    work = await mkdtemp(join(tmpdir(), "lotse-forgejo-"));
  });

  afterAll(async () => {
    execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
    await rm(work, { recursive: true, force: true });
  });

  it("signs in and rejects a wrong token", async () => {
    expect(conn.account.name).toBe("ada");
    await expect(provider.connect({ method: "token", token: "0000000000000000000000000000000000000000", options: { baseUrl } })).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("creates a repository and pushes the project's commits", async () => {
    repo = await provider.createRepo(conn, { name: "customer-portal", private: true, description: "Created by the integration test" });
    expect(repo).toMatchObject({ owner: "ada", name: "customer-portal", private: true, cloneUrl: `${baseUrl}/ada/customer-portal.git` });

    const ws = new GitWorkspace(join(work, "project"));
    await ws.init();
    await writeFile(join(ws.dir, "index.html"), "<h1>one</h1>\n");
    await writeFile(join(ws.dir, "notes.txt"), "builder\n");
    await ws.commitAll("First version");
    const auth = await provider.remoteUrl(repo, conn);
    await ws.push(auth);
    // The token is not stored in the repository's configuration.
    expect(await readFile(join(ws.dir, ".git/config"), "utf8")).not.toContain(conn.credentials.token);

    const listed = await provider.listRepos(conn, "customer");
    expect(listed.map((r) => `${r.owner}/${r.name}`)).toEqual(["ada/customer-portal"]);
    // Forgejo indexes a push in the background; the content appears a moment later.
    await expect
      .poll(async () => Buffer.from((await api<{ content?: string }>("/repos/ada/customer-portal/contents/index.html")).content ?? "", "base64").toString(), {
        timeout: 30_000,
      })
      .toBe("<h1>one</h1>\n");
  });

  it("pulls outside changes and stops on conflicts without overwriting them", async () => {
    const ws = new GitWorkspace(join(work, "project"));
    const auth = await provider.remoteUrl(repo, conn);
    // Someone edits a file on the platform.
    const current = await api<{ sha: string }>("/repos/ada/customer-portal/contents/notes.txt");
    await api("/repos/ada/customer-portal/contents/notes.txt", {
      method: "PUT",
      body: JSON.stringify({ content: Buffer.from("outside\n").toString("base64"), sha: current.sha, message: "Outside edit" }),
    });
    await api("/repos/ada/customer-portal/contents/added.txt", {
      method: "POST",
      body: JSON.stringify({ content: Buffer.from("new\n").toString("base64"), message: "Outside file" }),
    });

    // The builder changed the same file in the meantime.
    await writeFile(join(ws.dir, "notes.txt"), "builder again\n");
    await ws.commitAll("Builder edit");
    const err = (await ws.pull(auth).catch((e) => e)) as LotseError;
    expect(err.code).toBe("GIT_CONFLICT");
    expect(err.details.files).toEqual(["notes.txt"]);
    await expect(ws.push(auth)).rejects.toMatchObject({ code: "GIT_CONFLICT" });
    const remote = await api<{ content: string }>("/repos/ada/customer-portal/contents/notes.txt");
    expect(Buffer.from(remote.content, "base64").toString()).toBe("outside\n");

    // After taking the outside version, the next sync succeeds and brings the new file.
    await ws.restore((await ws.log())[1]?.sha as string);
    await writeFile(join(ws.dir, "other.txt"), "no conflict\n");
    await ws.commitAll("Unrelated change");
    const pulled = await ws.pull(auth);
    expect(pulled.updated).toBe(true);
    expect(pulled.files).toEqual(expect.arrayContaining(["added.txt", "notes.txt"]));
    await ws.push(auth);
  });

  it("stores CI secrets and writes the deploy workflow", async () => {
    await provider.setCiSecret?.(repo, "LOTSE_CONNECTION_SSH", "secret-connection-value");
    const secrets = await api<{ name: string }[]>("/repos/ada/customer-portal/actions/secrets");
    expect(secrets.map((s) => s.name)).toEqual(["LOTSE_CONNECTION_SSH"]);
    expect(JSON.stringify(secrets)).not.toContain("secret-connection-value");

    const target = { adapter: "ssh", branch: "main", secrets: ["LOTSE_CONNECTION_SSH"], cliVersion: "0.1.0" };
    await provider.writeWorkflow?.(repo, target);
    const read = async () =>
      Buffer.from((await api<{ content: string }>("/repos/ada/customer-portal/contents/.forgejo/workflows/lotse-deploy.yml")).content, "base64").toString();
    expect(await read()).toContain("npx --yes @lotseai/cli@0.1.0 deploy --target ssh --yes");
    expect(await read()).toContain("LOTSE_CONNECTION_SSH: ${{ secrets.LOTSE_CONNECTION_SSH }}");
    // Writing it again updates the file instead of failing.
    await provider.writeWorkflow?.(repo, { ...target, cliVersion: "0.2.0" });
    expect(await read()).toContain("@lotseai/cli@0.2.0");
  });

  it("comments on a request", async () => {
    const issue = await api<{ number: number }>("/repos/ada/customer-portal/issues", { method: "POST", body: JSON.stringify({ title: "Preview" }) });
    await provider.comment?.(repo, issue.number, "Preview: https://preview.example.test");
    const comments = await api<{ body: string }[]>(`/repos/ada/customer-portal/issues/${issue.number}/comments`);
    expect(comments.map((c) => c.body)).toEqual(["Preview: https://preview.example.test"]);
  });

  it("hosts a static site on the pages branch and takes it offline again", async () => {
    const pages = provider.pages as HostingAdapter;
    const pagesConn = { ...conn, adapter: "codeberg-pages" };
    const site = join(work, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), "<h1>site v1</h1>\n");
    const manifest = parseManifest("version: 1\nname: landing\nruntime:\n  kind: static\n");

    const plan = await pages.plan(manifest, pagesConn);
    expect(plan.firstDeployment).toBe(true);
    const run = async function* () {
      yield* pages.deploy(plan, { kind: "static", dir: site, files: 1, bytes: 16 }, { connection: pagesConn, workdir: site, env: [], resources: [] });
    };
    const first = await collectEvents(run() as never);
    const done = first.events.at(-1) as { deployment: { url: string; app: { id: string; meta: Record<string, string> }; id: string } };
    expect(done.deployment.url).toBe("https://ada.pages.example.test/landing");
    const branch = async () =>
      Buffer.from((await api<{ content?: string }>("/repos/ada/landing/contents/index.html?ref=pages")).content ?? "", "base64").toString();
    await expect.poll(branch, { timeout: 30_000 }).toBe("<h1>site v1</h1>\n");

    // A second deployment adds a commit on top of the first.
    await writeFile(join(site, "index.html"), "<h1>site v2</h1>\n");
    const again = await pages.plan(manifest, pagesConn);
    expect(again.firstDeployment).toBe(false);
    for await (const _ of pages.deploy(
      again,
      { kind: "static", dir: site, files: 1, bytes: 16 },
      { connection: pagesConn, workdir: site, env: [], resources: [] },
    )) {
      // drain
    }
    await expect.poll(branch, { timeout: 30_000 }).toBe("<h1>site v2</h1>\n");
    const commits = await api<unknown[]>("/repos/ada/landing/commits?sha=pages");
    expect(commits.length).toBe(2);

    const app = { adapter: "codeberg-pages", name: "landing", id: "ada/landing", meta: { repo: "ada/landing" }, connection: pagesConn };
    expect(await pages.status(app)).toMatchObject({ state: "running", url: "https://ada.pages.example.test/landing" });
    await pages.destroy(app, { connection: pagesConn, workdir: site, env: [], resources: [] });
    const branches = await api<{ name: string }[]>("/repos/ada/landing/branches");
    expect((branches ?? []).map((b) => b.name)).not.toContain("pages");
    // The repository itself is kept.
    expect((await provider.listRepos(conn, "landing")).length).toBe(1);
  });
});
