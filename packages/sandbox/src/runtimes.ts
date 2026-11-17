/**
 * Detection of local container runtimes for the desktop app (specification
 * section 12.5). Docker Desktop needs a paid license in larger companies, so
 * Podman is supported as an equal alternative.
 */
import { execFile } from "node:child_process";
import { DockerClient, detectEndpoint } from "./docker.js";

export type RuntimeName = "docker-desktop" | "docker-engine" | "podman" | "orbstack" | "colima";

export interface RuntimeStatus {
  /** A runtime is installed and its engine answers. */
  ready: boolean;
  /** Installed runtimes, running or not. */
  installed: RuntimeName[];
  engine?: { name: string; version: string; socket?: string };
  /** What to tell the user when nothing is ready. `state` and the link ids let user interfaces translate it. */
  guidance: { state: "missing" | "stopped"; title: string; steps: string[]; links: { id: string; label: string; url: string }[] };
}

function has(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], (err) => resolve(!err));
  });
}

export async function detectRuntimes(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RuntimeStatus> {
  const installed: RuntimeName[] = [];
  if (await has("orbctl")) installed.push("orbstack");
  if (await has("podman")) installed.push("podman");
  if (await has("colima")) installed.push("colima");
  if (await has("docker")) installed.push(platform === "linux" ? "docker-engine" : "docker-desktop");

  let engine: RuntimeStatus["engine"];
  try {
    const endpoint = detectEndpoint(env);
    const info = await new DockerClient(endpoint).ping();
    engine = { ...info, socket: endpoint.socketPath };
  } catch {
    // nothing is running
  }

  const links = [
    { id: "podman", label: "Podman Desktop (free, also for companies)", url: "https://podman-desktop.io/downloads" },
    ...(platform === "darwin" ? [{ id: "orbstack", label: "OrbStack", url: "https://orbstack.dev/download" }] : []),
    platform === "linux"
      ? { id: "docker-engine", label: "Docker Engine", url: "https://docs.docker.com/engine/install/" }
      : { id: "docker-desktop", label: "Docker Desktop (paid license for larger companies)", url: "https://www.docker.com/products/docker-desktop/" },
  ];
  const guidance: RuntimeStatus["guidance"] =
    installed.length === 0
      ? {
          state: "missing",
          title: "A container runtime is needed to run and preview apps",
          steps: [
            "Install one of the runtimes below. Podman is free for every use.",
            "Start it once so that its engine is running.",
            "Return here; Lotse detects it automatically.",
          ],
          links,
        }
      : {
          state: "stopped",
          title: `${installed.join(", ")} is installed but not running`,
          steps: installed.includes("podman")
            ? ["Start Podman Desktop, or run `podman machine start`.", "Enable the Docker-compatible socket (Podman Desktop: Settings → Docker Compatibility)."]
            : ["Start the application and wait until its engine is running."],
          links: [],
        };
  return { ready: Boolean(engine), installed, engine, guidance };
}
