import { LotseError } from "./errors.js";
import {
  ADAPTER_API_VERSION,
  type AdapterOptions,
  type AdapterPackage,
  type GitProvider,
  type HostingAdapter,
  type ResourceAdapter,
  type ResourceType,
} from "./types.js";

/** Holds the adapters an instance has loaded. */
export class AdapterRegistry {
  readonly #hosting = new Map<string, HostingAdapter>();
  readonly #git = new Map<string, GitProvider>();
  readonly #resources = new Map<string, ResourceAdapter>();

  registerHosting(adapter: HostingAdapter): this {
    assertHostingAdapter(adapter);
    this.#hosting.set(adapter.id, adapter);
    return this;
  }

  /** Registers a Git provider and, if it offers one, its Pages hosting target. */
  registerGit(provider: GitProvider): this {
    this.#git.set(provider.id, provider);
    if (provider.pages) this.registerHosting(provider.pages);
    return this;
  }

  registerResource(adapter: ResourceAdapter): this {
    this.#resources.set(adapter.id, adapter);
    return this;
  }

  use(pkg: AdapterPackage, options?: AdapterOptions): this {
    assertAdapterPackage(pkg);
    if (pkg.hosting) this.registerHosting(pkg.hosting(options));
    if (pkg.git) this.registerGit(pkg.git(options));
    if (pkg.resource) this.registerResource(pkg.resource(options));
    return this;
  }

  hosting(id: string): HostingAdapter {
    const adapter = this.#hosting.get(id);
    if (!adapter) {
      throw new LotseError("ADAPTER_NOT_FOUND", `No hosting adapter "${id}" is installed.`, {
        hints: [`Available: ${[...this.#hosting.keys()].sort().join(", ") || "none"}`],
      });
    }
    return adapter;
  }

  git(id: string): GitProvider {
    const provider = this.#git.get(id);
    if (!provider) {
      throw new LotseError("ADAPTER_NOT_FOUND", `No Git adapter "${id}" is installed.`, {
        hints: [`Available: ${[...this.#git.keys()].sort().join(", ") || "none"}`],
      });
    }
    return provider;
  }

  resource(id: string): ResourceAdapter {
    const adapter = this.#resources.get(id);
    if (!adapter) {
      throw new LotseError("ADAPTER_NOT_FOUND", `No resource adapter "${id}" is installed.`, {
        hints: [`Available: ${[...this.#resources.keys()].sort().join(", ") || "none"}`],
      });
    }
    return adapter;
  }

  hasHosting(id: string): boolean {
    return this.#hosting.has(id);
  }

  listHosting(): HostingAdapter[] {
    return [...this.#hosting.values()];
  }
  listGit(): GitProvider[] {
    return [...this.#git.values()];
  }
  listResources(): ResourceAdapter[] {
    return [...this.#resources.values()];
  }

  /** Resource adapters that can provide the given resource type. */
  resourceProviders(type: ResourceType): ResourceAdapter[] {
    return this.listResources().filter((a) => a.resources.includes(type));
  }
}

function major(version: string): string {
  const [maj, min] = version.split(".");
  // In 0.x every minor may break, as usual under Semantic Versioning.
  return maj === "0" ? `0.${min}` : (maj ?? "");
}

export function assertAdapterPackage(pkg: unknown): asserts pkg is AdapterPackage {
  const p = pkg as Partial<AdapterPackage> | null;
  if (!p || typeof p !== "object" || typeof p.apiVersion !== "string") {
    throw new LotseError("ADAPTER_INVALID", "The package does not export a Lotse adapter (missing default export with `apiVersion`).");
  }
  if (major(p.apiVersion) !== major(ADAPTER_API_VERSION)) {
    throw new LotseError("ADAPTER_INVALID", `The adapter targets interface version ${p.apiVersion}, but this instance provides ${ADAPTER_API_VERSION}.`);
  }
  if (!p.hosting && !p.git && !p.resource) {
    throw new LotseError("ADAPTER_INVALID", "The adapter package exports neither a hosting, Git nor resource adapter.");
  }
}

const REQUIRED_METHODS = ["connect", "verify", "plan", "deploy", "rollback", "destroy", "setEnv", "logs", "status"] as const;

export function assertHostingAdapter(adapter: HostingAdapter): void {
  const a = adapter as unknown as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id as string)) problems.push("id must be a lowercase identifier");
  if (typeof a.displayName !== "string") problems.push("displayName is missing");
  if (!Array.isArray(a.auth) || a.auth.length === 0) problems.push("auth must list at least one sign-in method");
  if (!a.capabilities || typeof a.capabilities !== "object") problems.push("capabilities are missing");
  for (const method of REQUIRED_METHODS) {
    if (typeof a[method] !== "function") problems.push(`${method}() is missing`);
  }
  if (Array.isArray(a.auth) && a.auth.includes("oauth") && !a.oauth) problems.push('oauth metadata is required when auth contains "oauth"');
  if (problems.length > 0) {
    throw new LotseError("ADAPTER_INVALID", `Hosting adapter "${String(a.id)}" is invalid: ${problems.join("; ")}.`);
  }
}

/** Turns a short name from the instance configuration into candidate package names. */
export function adapterPackageCandidates(name: string): string[] {
  if (name.startsWith(".") || name.startsWith("/") || name.startsWith("@") || name.startsWith("file:") || name.startsWith("lotse-adapter-")) {
    return [name];
  }
  return [`@lotse/adapter-${name}`, `lotse-adapter-${name}`];
}

export type ImportFn = (specifier: string) => Promise<unknown>;

/**
 * Loads adapter packages by name. Adapters are regular npm packages named
 * `lotse-adapter-<name>` or published in the `@lotse/` scope
 * (specification section 14.1).
 */
export async function loadAdapters(
  names: string[],
  options: AdapterOptions & { registry?: AdapterRegistry; importFn?: ImportFn; settingsFor?: (name: string) => Record<string, unknown> | undefined } = {},
): Promise<AdapterRegistry> {
  const registry = options.registry ?? new AdapterRegistry();
  const importFn: ImportFn = options.importFn ?? ((specifier) => import(specifier));
  for (const name of names) {
    let lastError: unknown;
    let loaded = false;
    for (const candidate of adapterPackageCandidates(name)) {
      try {
        const mod = (await importFn(candidate)) as { default?: unknown };
        registry.use((mod.default ?? mod) as AdapterPackage, {
          fetch: options.fetch,
          env: options.env,
          settings: options.settingsFor?.(name) ?? options.settings,
        });
        loaded = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    if (!loaded) {
      throw new LotseError("ADAPTER_NOT_FOUND", `Adapter "${name}" could not be loaded.`, {
        cause: lastError,
        hints: [`Install it with \`npm install ${adapterPackageCandidates(name)[0]}\`.`],
      });
    }
  }
  return registry;
}
