import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient, detectEndpoint, endpointCandidates } from "../src/index.js";

describe("finding the container engine", () => {
  it("follows DOCKER_HOST in all its forms, LOTSE_DOCKER_HOST first", () => {
    expect(detectEndpoint({ DOCKER_HOST: "unix:///run/user/1000/podman/podman.sock" })).toEqual({ socketPath: "/run/user/1000/podman/podman.sock" });
    expect(detectEndpoint({ DOCKER_HOST: "tcp://10.0.0.5:2376" })).toEqual({ host: "10.0.0.5", port: 2376 });
    expect(detectEndpoint({ DOCKER_HOST: "npipe:////./pipe/podman-machine-default" })).toEqual({ socketPath: "\\\\.\\pipe\\podman-machine-default" });
    expect(detectEndpoint({ DOCKER_HOST: "unix:///a.sock", LOTSE_DOCKER_HOST: "unix:///b.sock" })).toEqual({ socketPath: "/b.sock" });
  });

  it("knows where Docker, Podman, OrbStack and Colima put their sockets", () => {
    const linux = endpointCandidates({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux");
    expect(linux).toEqual(
      expect.arrayContaining(["/var/run/docker.sock", "/run/user/1000/docker.sock", "/run/user/1000/podman/podman.sock", "/run/podman/podman.sock"]),
    );
    expect(endpointCandidates({ TMPDIR: "/var/folders/xy/T" }, "darwin")).toContain("/var/folders/xy/T/podman/podman-machine-default-api.sock");
    // Docker Desktop and Podman machines on Windows serve named pipes.
    expect(endpointCandidates({}, "win32")).toEqual(["\\\\.\\pipe\\docker_engine", "\\\\.\\pipe\\podman-machine-default"]);
  });

  it("picks up a runtime that is started after the builder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lotse-engine-"));
    try {
      const env = { XDG_RUNTIME_DIR: dir };
      const client = new DockerClient(undefined, env);
      const before = client.endpoint.socketPath;
      if (process.platform === "linux") {
        await writeFile(join(dir, "docker.sock"), "");
        // Only when nothing earlier in the list exists, which is the case without a system-wide Docker.
        if (before !== "/var/run/docker.sock") expect(client.endpoint.socketPath).toBe(join(dir, "docker.sock"));
      }
      expect(new DockerClient({ socketPath: "/fixed.sock" }, env).endpoint).toEqual({ socketPath: "/fixed.sock" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
