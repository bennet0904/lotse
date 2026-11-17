export { createSshAdapter, default, type SshAdapterOptions } from "./adapter.js";
export {
  connectWithSsh2,
  type ExecOptions,
  type ExecResult,
  fingerprint,
  generateSshKeyPair,
  publicKeyOf,
  type SshConnector,
  type SshExecutor,
  type SshKeyPair,
  type SshParams,
  sh,
} from "./executor.js";
export * from "./layout.js";
export { BACKUP_SCRIPT, buildSetupPlan, detectServer, isSupportedOs, platformOf, type ServerFacts, type SetupSettings } from "./setup.js";
