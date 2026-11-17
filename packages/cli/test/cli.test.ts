import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Io, run } from "../src/index.js";
import { baseUrl, provider } from "./fixtures/fake-adapter.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-adapter.ts", import.meta.url));
let root: string;
let project: string;

async function cli(args: string[], options: { env?: Record<string, string>; answers?: string[]; interactive?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    cwd: project,
    env: { LOTSE_CONFIG_DIR: join(root, "config"), LOTSE_ADAPTERS: FAKE, ...options.env },
    interactive: options.interactive ?? false,
    color: false,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    prompt: async () => answers.shift() ?? "",
    openBrowser: () => {},
  };
  const code = await run(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(async () => {
  provider.reset();
  root = await mkdtemp(join(tmpdir(), "lotse-cli-"));
  project = join(root, "My Site");
  await mkdir(project);
  await writeFile(join(project, "index.html"), "<h1>hi</h1>");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const connect = () => cli(["connect", "fake"], { env: { LOTSE_TOKEN: "fake-token-123456" } });

describe("lotse init and validate", () => {
  it("writes a manifest that fits the project and refuses to overwrite it", async () => {
    const first = await cli(["init"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Detected static (static).");
    expect(await readFile(join(project, "lotse.yaml"), "utf8")).toContain("name: my-site");
    expect((await cli(["validate"])).out).toContain("Valid. my-site: static, build strategy static.");
    const again = await cli(["init"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("lotse.yaml already exists.");
    expect((await cli(["init", "--force", "--name", "other"])).code).toBe(0);
  });

  it("explains what is wrong with a manifest", async () => {
    await writeFile(join(project, "lotse.yaml"), "version: 1\nname: Bad Name\nruntime:\n  kind: static\n");
    const result = await cli(["validate"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("name: must start with a letter");
    const missing = await cli(["validate", "-C", ".."]);
    expect(missing.err).toContain("Run `lotse init` to create one.");
  });
});

describe("lotse connect", () => {
  it("stores the account encrypted and never prints the token", async () => {
    const result = await connect();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Connected Fake Cloud as ada.");
    expect(result.out + result.err).not.toContain("fake-token-123456");
    expect(await readFile(join(root, "config/credentials.json"), "utf8")).not.toContain("fake-token-123456");
    expect((await cli(["connections"])).out).toMatch(/fake\s+ada\s+token/);
    expect((await cli(["connections", "show", "fake"])).out).toContain('"token": "[redacted]"');
    expect((await cli(["verify", "fake"])).out).toContain("OK  Fake Cloud (ada)");
  });

  it("guides through the token setup when asked interactively", async () => {
    const result = await cli(["connect", "fake"], { interactive: true, answers: ["fake-typed-token-1"] });
    expect(result.code).toBe(0);
    expect(result.out).toContain("1. Open https://fake.example/tokens");
    expect(result.out).toContain("Required permissions:");
  });

  it("reports rejected credentials and unknown adapters", async () => {
    const rejected = await cli(["connect", "fake"], { env: { LOTSE_TOKEN: "nope" } });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toContain("did not accept the token");
    const unknown = await cli(["connect", "nowhere", "--token", "x"]);
    expect(unknown.err).toContain('No hosting adapter "nowhere" is installed.');
    expect(unknown.err).toContain("Available:");
  });

  it("lists adapters with their capabilities", async () => {
    await connect();
    const { out } = await cli(["adapters"]);
    expect(out).toMatch(/fake\s+Fake Cloud\s+token\s+static, server\s+-\s+native\s+connected/);
    expect(out).toMatch(/ssh\s+Own server \(SSH\)\s+ssh/);
    expect(out).toMatch(/github\s+GitHub\s+token/);
  });
});

describe("lotse deploy", () => {
  beforeEach(async () => {
    await cli(["init"]);
    await connect();
  });

  it("shows the plan without changing anything", async () => {
    const result = await cli(["plan"]);
    expect(result.out).toContain("First deployment of my-site to Fake Cloud");
    expect(result.out).toContain("+ Create my-site");
    expect(provider.apps.size).toBe(0);
  });

  it("asks before the first deployment to a new target", async () => {
    const refused = await cli(["deploy"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("first deployment to a new target needs approval");
    expect(provider.apps.size).toBe(0);

    const declined = await cli(["deploy"], { interactive: true, answers: ["n"] });
    expect(declined.code).toBe(1);

    const approved = await cli(["deploy"], { interactive: true, answers: ["y"] });
    expect(approved.code).toBe(0);
    expect(approved.out).toContain(`Live at ${baseUrl}/?app=my-site`);
    // Later deployments to the same target need no approval.
    expect((await cli(["deploy"])).code).toBe(0);
    expect(provider.apps.get("my-site")?.deployments).toEqual(["dep-1", "dep-2"]);
    expect(JSON.parse(await readFile(join(project, ".lotse/config.json"), "utf8"))).toEqual({ target: "fake" });
  });

  it("keeps credentials out of the output, also as JSON", async () => {
    const result = await cli(["deploy", "--yes", "--json"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("fake-token-123456");
    const events = result.out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(events.at(-1)).toMatchObject({ type: "status", phase: "finish", state: "succeeded", deployment: { id: "dep-1", app: { name: "my-site" } } });
    expect(events.find((e) => e.type === "log" && e.phase === "deploy").line).toBe("uploading with token [redacted]");
  });

  it("stores secrets encrypted and passes them to the deployment", async () => {
    await writeFile(
      join(project, "lotse.yaml"),
      "version: 1\nname: my-site\nruntime:\n  kind: static\nenv:\n  public:\n    APP_NAME: Demo\n  secrets:\n    - API_KEY\n",
    );
    const missing = await cli(["deploy", "--yes"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("No value is stored for secret API_KEY");

    expect((await cli(["env", "set", "OTHER", "x"])).err).toContain('"OTHER" is not declared in lotse.yaml');
    expect((await cli(["env", "set", "API_KEY", "s3cr3t-value-1"])).code).toBe(0);
    expect(await readFile(join(project, ".lotse/secrets.json"), "utf8")).not.toContain("s3cr3t-value-1");
    expect((await cli(["env", "list"])).out).toMatch(/API_KEY\s+secret\s+\(set\)/);

    const result = await cli(["deploy", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("s3cr3t-value-1");
    expect(provider.contexts[0]?.env).toEqual([
      { name: "APP_NAME", value: "Demo", secret: false },
      { name: "API_KEY", value: "s3cr3t-value-1", secret: true },
    ]);
  });

  it("rolls back, shows history, status and logs", async () => {
    await cli(["deploy", "--yes"]);
    await cli(["deploy"]);
    expect((await cli(["history"])).out).toMatch(/dep-2\s+live[\s\S]*dep-1\s+superseded/);
    const back = await cli(["rollback"]);
    expect(back.out).toContain(`Restored dep-1 at ${baseUrl}/?app=my-site`);
    expect(provider.apps.get("my-site")?.live).toBe("dep-1");
    expect((await cli(["status"])).out).toMatch(/STATE\s+running/);
    expect((await cli(["logs"])).out).toContain("GET / 200");
  });

  it("deploys previews next to the live version", async () => {
    await cli(["deploy", "--yes"]);
    const preview = await cli(["deploy", "--preview", "pr-7"]);
    expect(preview.out).toContain(`Preview ready: ${baseUrl}/?preview=pr-7`);
    expect(provider.apps.get("my-site")?.live).toBe("dep-1");
  });

  it("asks before attaching domains and before deleting", async () => {
    await cli(["deploy", "--yes"]);
    expect((await cli(["domains", "add", "app.example.com"])).err).toContain("Changing domains needs approval");
    const added = await cli(["domains", "add", "app.example.com", "--yes"]);
    expect(added.out).toContain("create DNS record: CNAME app.example.com → edge.fake.example");

    const refused = await cli(["destroy"]);
    expect(refused.code).toBe(1);
    expect(provider.apps.has("my-site")).toBe(true);
    expect((await cli(["destroy", "--yes"])).out).toContain("Removed my-site from fake.");
    expect(provider.apps.has("my-site")).toBe(false);
  });

  it("takes the account from the environment in CI", async () => {
    const exported = await cli(["connections", "export", "fake"]);
    expect(exported.err).toContain("LOTSE_CONNECTION_FAKE");
    await rm(join(root, "config"), { recursive: true });
    const withoutAccount = await cli(["deploy", "--target", "fake", "--yes"]);
    expect(withoutAccount.err).toContain('Not signed in to "fake"');
    const inCi = await cli(["deploy", "--target", "fake", "--yes"], { env: { LOTSE_CONNECTION_FAKE: exported.out.trim() } });
    expect(inCi.code).toBe(0);
    expect(provider.contexts.at(-1)?.connection.credentials.token).toBe("fake-token-123456");
  });
});
