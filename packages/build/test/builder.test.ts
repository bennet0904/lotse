import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEvents, parseManifest } from "@lotse/core";
import { type CommandRunner, LocalBuilder } from "../src/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lotse-build-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const site = (extra = "") => parseManifest(`version: 1\nname: site\nruntime:\n  kind: static\n${extra}`);

describe("static build strategy", () => {
  it("uses the folder as it is when there is no build command", async () => {
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
    await writeFile(join(dir, "style.css"), "h1{}");
    const { result, events } = await collectEvents(new LocalBuilder().build({ manifest: site(), workdir: dir, artifact: "static", env: {} }));
    expect(result).toMatchObject({ kind: "static", dir, files: 2 });
    expect(events.at(-1)).toMatchObject({ type: "log", line: expect.stringContaining("Static site ready: 2 files") });
  });

  it("runs the build command with the public environment and streams its output", async () => {
    await writeFile(join(dir, "build.sh"), 'mkdir -p out && echo "<h1>$APP_NAME</h1>" > out/index.html && echo built');
    const manifest = site("build:\n  command: sh build.sh\n  output: out\n");
    const { result, events } = await collectEvents(new LocalBuilder().build({ manifest, workdir: dir, artifact: "static", env: { APP_NAME: "Demo" } }));
    expect(result).toMatchObject({ kind: "static", dir: join(dir, "out"), files: 1 });
    expect(await readFile(join(dir, "out/index.html"), "utf8")).toBe("<h1>Demo</h1>\n");
    const lines = events.flatMap((e) => (e.type === "log" ? [e.line] : []));
    expect(lines).toEqual(expect.arrayContaining(["$ sh build.sh", "built"]));
  });

  it("runs commands through the given runner, e.g. inside a sandbox", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^8" } }));
    const commands: string[] = [];
    const runner: CommandRunner = {
      async run(command, options) {
        commands.push(command);
        if (command.includes("build")) {
          await mkdir(join(options.cwd, "dist"));
          await writeFile(join(options.cwd, "dist/index.html"), "ok");
        }
        options.onOutput("done", "stdout");
        return 0;
      },
    };
    const { result } = await collectEvents(new LocalBuilder({ runner }).build({ manifest: site(), workdir: dir, artifact: "static", env: {} }));
    expect(commands).toEqual(["npm install", "npm run build"]);
    expect(result).toMatchObject({ kind: "static", dir: join(dir, "dist") });
  });

  it("fails with a clear message when the build breaks or produces nothing", async () => {
    const failing = site("build:\n  command: sh -c 'echo broken >&2; exit 3'\n  output: out\n");
    await expect(collectEvents(new LocalBuilder().build({ manifest: failing, workdir: dir, artifact: "static", env: {} }))).rejects.toMatchObject({
      code: "BUILD_FAILED",
      message: expect.stringContaining("exit code 3"),
    });
    const missing = site("build:\n  command: 'true'\n  output: nowhere\n");
    await expect(collectEvents(new LocalBuilder().build({ manifest: missing, workdir: dir, artifact: "static", env: {} }))).rejects.toThrow(
      /output folder "nowhere" does not exist after the build/,
    );
    const escaping = site("build:\n  output: ../..\n");
    await expect(collectEvents(new LocalBuilder().build({ manifest: escaping, workdir: dir, artifact: "static", env: {} }))).rejects.toThrow(
      /outside the project directory/,
    );
  });

  it("hands the source over untouched when the provider builds itself", async () => {
    const { result } = await collectEvents(new LocalBuilder().build({ manifest: site(), workdir: dir, artifact: "source", env: {} }));
    expect(result).toMatchObject({ kind: "source", dir });
  });

  it("builds the output folder of a server app for targets that deploy build output", async () => {
    const server = parseManifest("version: 1\nname: api\nruntime:\n  kind: server\n  language: node\n");
    await expect(collectEvents(new LocalBuilder().build({ manifest: server, workdir: dir, artifact: "static", env: {} }))).rejects.toThrow(
      /has no `build.output` folder/,
    );
    await writeFile(join(dir, "build.sh"), "mkdir -p dist && echo 'export default {}' > dist/index.js");
    const bundled = parseManifest("version: 1\nname: api\nruntime:\n  kind: server\n  language: node\nbuild:\n  command: sh build.sh\n  output: dist\n");
    const { result } = await collectEvents(new LocalBuilder().build({ manifest: bundled, workdir: dir, artifact: "static", env: {} }));
    expect(result).toMatchObject({ kind: "static", dir: join(dir, "dist"), files: 1 });
  });
});
