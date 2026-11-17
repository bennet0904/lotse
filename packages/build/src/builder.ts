/**
 * Build strategies (specification section 7.5):
 *   static      the project's build command plus an output folder
 *   auto        Railpack or Cloud Native Buildpacks, with generated Dockerfiles as fallback
 *   dockerfile  the user's own Dockerfile, built with BuildKit
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  type BuildArtifact,
  type Builder,
  type BuildRequest,
  DEFAULT_IGNORE,
  type DeployEvent,
  event,
  LotseError,
  type Manifest,
  STATIC_SITE_IGNORE,
  tarStream,
  walkFiles,
} from "@lotseai/core";
import { detectProject, type ProjectInfo } from "./detect.js";
import { generateDockerfile, STATIC_IMAGE_PORT, staticSiteDockerfile } from "./dockerfile.js";
import { asEvents, type CommandRunner, capture, exec, hostRunner } from "./process.js";

export type ContainerRuntime = "docker" | "podman";
export type AutoTool = "railpack" | "pack" | "dockerfile";

export interface LocalBuilderOptions {
  /** Runs install and build commands. Defaults to the host shell. */
  runner?: CommandRunner;
  /** Container CLI. Detected when omitted; Podman is an equal alternative to Docker. */
  runtime?: ContainerRuntime;
  /** Tool for the auto strategy. Detected when omitted. */
  autoTool?: AutoTool;
  /** Target platform of images, e.g. `linux/amd64`. Defaults to the platform of the container engine. */
  platform?: string;
  /** Prefix of image names, e.g. a registry path. Defaults to `lotse`. */
  imagePrefix?: string;
  /** Skips dependency installation for static builds (used when a sandbox already installed them). */
  skipInstall?: boolean;
}

async function onPath(file: string, args: string[]): Promise<boolean> {
  try {
    return (await exec(file, args, { onOutput: () => {} })) === 0;
  } catch {
    return false;
  }
}

let detectedRuntime: Promise<ContainerRuntime> | undefined;

/** Finds a usable container CLI: `LOTSE_CONTAINER_RUNTIME`, then Docker, then Podman. */
export function detectContainerRuntime(env: Record<string, string | undefined> = process.env): Promise<ContainerRuntime> {
  const forced = env.LOTSE_CONTAINER_RUNTIME;
  if (forced === "docker" || forced === "podman") return Promise.resolve(forced);
  detectedRuntime ??= (async () => {
    if (await onPath("docker", ["version", "--format", "{{.Server.Version}}"])) return "docker" as const;
    if (await onPath("podman", ["version", "--format", "{{.Version}}"])) return "podman" as const;
    detectedRuntime = undefined;
    throw new LotseError("BUILD_FAILED", "Building a container image needs Docker or Podman, but neither is running.", {
      hints: ["Install Docker Engine, Docker Desktop, OrbStack or Podman and start it."],
    });
  })();
  return detectedRuntime;
}

function imageTag(prefix: string, manifest: Manifest): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `${prefix.replace(/\/+$/, "")}/${manifest.name}:${stamp}`;
}

async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  const entries = await walkFiles(dir, { ignore: STATIC_SITE_IGNORE });
  return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) };
}

function inside(root: string, path: string): string {
  const full = isAbsolute(path) ? path : resolve(root, path);
  if (full !== root && !full.startsWith(`${root}/`) && !full.startsWith(`${root}\\`)) {
    throw new LotseError("BUILD_FAILED", `"${path}" points outside the project directory.`);
  }
  return full;
}

export class LocalBuilder implements Builder {
  readonly #opts: LocalBuilderOptions;

  constructor(options: LocalBuilderOptions = {}) {
    this.#opts = options;
  }

  async *build(request: BuildRequest): AsyncGenerator<DeployEvent, BuildArtifact, void> {
    const { manifest, workdir } = request;
    const root = resolve(workdir);
    if (request.artifact === "source") {
      yield event.log("build", "The provider builds from source; nothing to build locally.");
      return { kind: "source", dir: root, ignore: DEFAULT_IGNORE };
    }
    const info = await detectProject(root);
    if (request.artifact === "static") {
      // Some platforms run server code from a build output folder (e.g. a bundled Worker).
      if (manifest.runtime.kind !== "static" && !manifest.build.output) {
        throw new LotseError("BUILD_FAILED", `This target deploys the build output of the app, but lotse.yaml has no \`build.output\` folder.`, {
          hints: ["Set `build.command` and `build.output` so that the build produces the files to deploy."],
        });
      }
      return yield* this.#static(request, root, info);
    }
    if (manifest.runtime.kind === "static") {
      const site = yield* this.#static(request, root, info);
      return yield* this.#staticImage(request, site.dir);
    }
    if (manifest.build.strategy === "dockerfile") return yield* this.#dockerfile(request, root);
    return yield* this.#auto(request, root, info);
  }

  async *#run(command: string, request: BuildRequest, cwd: string): AsyncGenerator<DeployEvent, void, void> {
    yield event.log("build", `$ ${command}`);
    const runner = this.#opts.runner ?? hostRunner;
    const code = yield* asEvents((onOutput) => runner.run(command, { cwd, env: request.env, signal: request.signal, onOutput }));
    if (request.signal?.aborted) throw new LotseError("ABORTED", "The build was aborted.");
    if (code !== 0) throw new LotseError("BUILD_FAILED", `\`${command}\` failed with exit code ${code}.`);
  }

  async *#static(request: BuildRequest, root: string, info: ProjectInfo): AsyncGenerator<DeployEvent, Extract<BuildArtifact, { kind: "static" }>, void> {
    const { manifest } = request;
    const command = manifest.build.command ?? info.buildCommand;
    if (command) {
      if (info.installCommand && !this.#opts.skipInstall) yield* this.#run(info.installCommand, request, root);
      yield* this.#run(command, request, root);
    }
    const output = inside(root, manifest.build.output ?? (command ? (info.outputDir ?? "dist") : (info.outputDir ?? ".")));
    const exists = await stat(output).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!exists) {
      throw new LotseError(
        "BUILD_FAILED",
        `The output folder "${manifest.build.output ?? info.outputDir ?? "dist"}" does not exist${command ? " after the build" : ""}.`,
        {
          hints: ["Set `build.output` in lotse.yaml to the folder that contains index.html."],
        },
      );
    }
    const stats = await dirStats(output);
    if (stats.files === 0) throw new LotseError("BUILD_FAILED", `The output folder "${output}" is empty.`);
    const hasIndex = await stat(join(output, "index.html")).then(
      () => true,
      () => false,
    );
    if (!hasIndex) yield event.log("build", "Warning: the output folder has no index.html.", "stderr");
    yield event.log("build", `Static site ready: ${stats.files} files, ${(stats.bytes / 1024).toFixed(1)} kB`);
    return { kind: "static", dir: output, ...stats };
  }

  /** `docker build` / `podman build`. A tar stream on stdin replaces the context directory when given. */
  async *#containerBuild(
    request: BuildRequest,
    tag: string,
    source: { context: string; dockerfile?: string } | { tar: Readable },
    port?: number,
  ): AsyncGenerator<DeployEvent, Extract<BuildArtifact, { kind: "image" }>, void> {
    const runtime = this.#opts.runtime ?? (await detectContainerRuntime());
    const args = ["build", "--tag", tag];
    const platform = request.platform ?? this.#opts.platform;
    if (platform) args.push("--platform", platform);
    for (const [name, value] of Object.entries(request.env)) args.push("--build-arg", `${name}=${value}`);
    if ("tar" in source) args.push("-");
    else {
      if (source.dockerfile) args.push("--file", source.dockerfile);
      args.push(source.context);
    }
    yield event.log("build", `$ ${runtime} build --tag ${tag}`);
    const code = yield* asEvents((onOutput) =>
      exec(runtime, args, {
        env: { DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" },
        signal: request.signal,
        stdin: "tar" in source ? source.tar : undefined,
        onOutput,
      }),
    );
    if (request.signal?.aborted) throw new LotseError("ABORTED", "The build was aborted.");
    if (code !== 0) throw new LotseError("BUILD_FAILED", `The image build failed with exit code ${code}.`);
    return this.#describeImage(runtime, tag, port);
  }

  async #describeImage(runtime: ContainerRuntime, tag: string, port?: number): Promise<Extract<BuildArtifact, { kind: "image" }>> {
    const out = await capture(runtime, ["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", tag]);
    const [digest = "", platform = ""] = out.trim().split(" ");
    return { kind: "image", image: tag, digest, platform, runtime, port };
  }

  async *#dockerfile(request: BuildRequest, root: string): AsyncGenerator<DeployEvent, BuildArtifact, void> {
    const file = inside(root, request.manifest.build.dockerfile ?? "Dockerfile");
    const exists = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) {
      throw new LotseError("BUILD_FAILED", `The build strategy is "dockerfile", but ${request.manifest.build.dockerfile ?? "Dockerfile"} does not exist.`, {
        hints: ["Add a Dockerfile or switch to `build.strategy: auto`."],
      });
    }
    const tag = imageTag(this.#opts.imagePrefix ?? "lotse", request.manifest);
    return yield* this.#containerBuild(request, tag, { context: root, dockerfile: file }, request.manifest.runtime.port);
  }

  async #autoTool(): Promise<AutoTool> {
    if (this.#opts.autoTool) return this.#opts.autoTool;
    const forced = process.env.LOTSE_AUTO_BUILDER;
    if (forced === "railpack" || forced === "pack" || forced === "dockerfile") return forced;
    if (await onPath("railpack", ["--version"])) return "railpack";
    if (await onPath("pack", ["version"])) return "pack";
    return "dockerfile";
  }

  async *#auto(request: BuildRequest, root: string, info: ProjectInfo): AsyncGenerator<DeployEvent, BuildArtifact, void> {
    const { manifest } = request;
    const tag = imageTag(this.#opts.imagePrefix ?? "lotse", manifest);
    const tool = await this.#autoTool();
    const port = manifest.runtime.port;

    if (tool === "railpack" || tool === "pack") {
      const runtime = this.#opts.runtime ?? (await detectContainerRuntime());
      const args =
        tool === "railpack"
          ? [
              "build",
              root,
              "--name",
              tag,
              ...(manifest.runtime.start ? ["--start-cmd", manifest.runtime.start] : []),
              ...(manifest.build.command ? ["--build-cmd", manifest.build.command] : []),
            ]
          : ["build", tag, "--path", root, "--builder", "paketobuildpacks/builder-jammy-base", "--env", `BP_WEB_SERVER_PORT=${port}`];
      yield event.log("build", `$ ${tool} build (${tool === "railpack" ? "Railpack" : "Cloud Native Buildpacks"})`);
      const code = yield* asEvents((onOutput) => exec(tool, args, { cwd: root, signal: request.signal, onOutput }));
      if (request.signal?.aborted) throw new LotseError("ABORTED", "The build was aborted.");
      if (code !== 0) throw new LotseError("BUILD_FAILED", `${tool} failed with exit code ${code}.`);
      return this.#describeImage(runtime, tag, port);
    }

    const dockerfile = generateDockerfile(info, manifest);
    yield event.log("build", `Building a ${manifest.runtime.language ?? info.language} image from a generated Dockerfile.`);
    const entries = (await walkFiles(root)).filter((e) => e.path !== "Dockerfile");
    const tar = tarStream(entries, { extra: [{ path: "Dockerfile", content: dockerfile }] });
    return yield* this.#containerBuild(request, tag, { tar }, port);
  }

  async *#staticImage(request: BuildRequest, siteDir: string): AsyncGenerator<DeployEvent, BuildArtifact, void> {
    const { dockerfile, caddyfile } = staticSiteDockerfile();
    const entries = (await walkFiles(siteDir, { ignore: STATIC_SITE_IGNORE })).filter((e) => e.path !== "Dockerfile" && e.path !== "Caddyfile.lotse");
    const tar = tarStream(entries, {
      extra: [
        { path: "Dockerfile", content: dockerfile },
        { path: "Caddyfile.lotse", content: caddyfile },
      ],
    });
    yield event.log("build", "Packaging the static site into a web server image.");
    const tag = imageTag(this.#opts.imagePrefix ?? "lotse", request.manifest);
    return yield* this.#containerBuild(request, tag, { tar }, STATIC_IMAGE_PORT);
  }
}
