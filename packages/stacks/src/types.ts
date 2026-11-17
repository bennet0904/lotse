import type { RuntimeKind } from "@lotse/core";

export interface ScaffoldContext {
  /** Manifest name of the app: lowercase letters, digits and hyphens. */
  name: string;
  /** Human-readable title. */
  title: string;
}

export interface StackSandbox {
  /** Container image the project runs in during development. */
  image: string;
  /** Installs dependencies. Runs after scaffolding and whenever the dependency file changes. */
  install?: string;
  /** Files whose change requires a new install. */
  installTriggers?: string[];
  /** Starts the development server on `port`. */
  dev: string;
  port: number;
  /** Whether the development server picks up file changes itself. Otherwise it is restarted. */
  hotReload: boolean;
  /** Fast check for errors (type check, compile, lint), fed back to the model. */
  check?: string;
  /** Hosts the package manager needs beyond the default registries. */
  allowedHosts?: string[];
  /** Helper files written outside the project (into the sandbox cache), e.g. a preview server. */
  helperFiles?: Record<string, string>;
}

/**
 * A stack template (specification section 12.3). Templates are deliberately
 * strict: the model fills in an app, it does not choose the project layout.
 */
export interface StackTemplate {
  id: string;
  name: string;
  language: "html" | "typescript" | "python" | "go" | "php";
  runtime: RuntimeKind;
  description: string;
  /** Stacks are labelled beta until end-to-end tests have proven them. */
  beta: boolean;
  sandbox: StackSandbox;
  /** The runnable base project, including `lotse.yaml`. Paths are relative to the project root. */
  files(ctx: ScaffoldContext): Record<string, string>;
  /** Command run in the sandbox before the template files are written, e.g. a framework installer. */
  bootstrap?: string;
  /** Conventions the model must follow in this stack. */
  guidance: string;
}
