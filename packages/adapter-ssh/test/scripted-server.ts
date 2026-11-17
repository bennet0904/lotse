import { Readable } from "node:stream";
import type { Scenario } from "@lotse/adapter-testkit";
import { LotseError } from "@lotse/core";
import { type ExecOptions, type ExecResult, generateSshKeyPair, type RemoteState, type SshConnector } from "../src/index.js";

/**
 * The SSH adapter talks to a server instead of an HTTP API, so the contract
 * runs against a scripted server: every remote operation has a name, and the
 * script answers by name.
 */
export const READ_ONLY = new Set(["probe-sudo", "detect", "plan-info", "read-state", "read-env", "container-status", "logs", "list-backups", "health-check"]);

export const deployed: RemoteState = {
  app: "lotse-reference",
  kind: "static",
  healthcheck: "/",
  defaultHost: "lotse-reference.203-0-113-10.sslip.io",
  domains: [],
  current: { id: "2026111612000001", createdAt: 1794830000000 },
  releases: [
    { id: "2026111612000001", createdAt: 1794830000000 },
    { id: "2026111611000000", createdAt: 1794826400000 },
  ],
};

const FACTS = `id=ubuntu\nversion=24.04\nname=Ubuntu 24.04.3 LTS\ncodename=noble\narch=x86_64\nuid=0\nsystemd=yes\ndocker=29.1.0\ndockerAccess=yes\ndeployUser=yes\ndeployKey=yes\nproxy=yes\nfirewall=yes\nupdates=yes\nbackupTimer=yes\n`;

export const servers = new Map<string, { ops: { op: string; script: string; stdin?: string }[] }>();
export const key = generateSshKeyPair("contract");
export const otherKey = generateSshKeyPair("unknown");

export function scriptedServer(scenario: Scenario): SshConnector {
  const record = { ops: [] as { op: string; script: string; stdin?: string }[] };
  servers.set(scenario.name, record);
  const hasApp = !["plan", "deploy", "connect", "verify"].includes(scenario.name);
  return async (params) => {
    if (scenario.name === "connect-invalid" || params.privateKey === otherKey.privateKey) {
      throw new LotseError("AUTH_FAILED", `${params.user}@${params.host} did not accept the SSH key.`);
    }
    return {
      user: params.user,
      hostKey: "SHA256:contractHostKeyFingerprint0000000000000000000",
      async run(op: string, script: string, options: ExecOptions = {}): Promise<ExecResult> {
        if (options.signal?.aborted) throw new LotseError("ABORTED", "The operation was aborted.");
        let stdin: string | undefined;
        if (typeof options.stdin === "string") stdin = options.stdin;
        else if (options.stdin instanceof Readable) for await (const _ of options.stdin) stdin = "[stream]";
        record.ops.push({ op, script, stdin });
        const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
        switch (op) {
          case "probe-sudo":
            return ok("root\n");
          case "detect":
            return ok(FACTS);
          case "plan-info":
            return ok("arch=x86_64\nproxy=true\n");
          case "read-state":
            return ok(hasApp ? JSON.stringify(deployed) : "");
          case "container-status":
            return ok("running\n");
          case "logs":
            options.onStdout?.("2026-11-16T12:00:01.000000000Z 203.0.113.7 GET / 200\n2026-11-16T12:00:02.000000000Z 203.0.113.7 GET /health 200\n");
            return ok();
          default:
            return ok();
        }
      },
      close() {},
    };
  };
}
