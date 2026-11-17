/**
 * Planning logic of the deployment engine (specification section 7.3, step 1).
 * Pure functions: they compare a manifest with an adapter's capabilities.
 */
import { LotseError } from "./errors.js";
import type { Manifest } from "./manifest.js";
import type { AdapterRegistry } from "./registry.js";
import type { ResourceRecord } from "./state.js";
import type { Capabilities, HostingAdapter, PlannedResource, RuntimeKind } from "./types.js";

export interface RuntimeResolution {
  /** The adapter runtime the app will use. */
  runtime: RuntimeKind;
  /** True when a static site or server app is packaged into a container image for this target. */
  containerized: boolean;
  notes: string[];
}

function supportsRuntime(caps: Capabilities, kind: RuntimeKind): boolean {
  if (caps.runtimes.includes(kind)) return true;
  // Static sites and server apps can always be packaged into a container image.
  return kind !== "container" && caps.runtimes.includes("container");
}

function supportsLanguage(caps: Capabilities, manifest: Manifest): boolean {
  if (manifest.runtime.kind !== "server") return true;
  if (caps.runtimes.includes("container")) return true;
  return !manifest.runtime.language || caps.languages.includes(manifest.runtime.language);
}

/** Adapters that could run this manifest, used to suggest alternatives. */
export function suitableAdapters(manifest: Manifest, registry: AdapterRegistry, exclude?: string): HostingAdapter[] {
  return registry
    .listHosting()
    .filter((a) => a.id !== exclude)
    .filter((a) => supportsRuntime(a.capabilities, manifest.runtime.kind) && supportsLanguage(a.capabilities, manifest))
    .filter((a) => manifest.domains.length === 0 || a.capabilities.customDomains);
}

function alternativesHint(manifest: Manifest, registry: AdapterRegistry, exclude: string): string[] {
  const names = suitableAdapters(manifest, registry, exclude).map((a) => a.displayName);
  return names.length > 0 ? [`Providers that can run this app: ${names.join(", ")}.`] : [];
}

/**
 * Checks that the adapter can run the app described by the manifest.
 * Throws a `LotseError` with suggested alternatives otherwise.
 */
export function resolveRuntime(manifest: Manifest, adapter: HostingAdapter, registry: AdapterRegistry): RuntimeResolution {
  const caps = adapter.capabilities;
  const kind = manifest.runtime.kind;
  const notes: string[] = [];

  if (!supportsRuntime(caps, kind)) {
    throw new LotseError("RUNTIME_UNSUPPORTED", `${adapter.displayName} cannot run apps of kind "${kind}". It supports: ${caps.runtimes.join(", ")}.`, {
      hints: alternativesHint(manifest, registry, adapter.id),
    });
  }
  if (!supportsLanguage(caps, manifest)) {
    throw new LotseError(
      "LANGUAGE_UNSUPPORTED",
      `${adapter.displayName} has no container runtime and does not run ${manifest.runtime.language} server apps. It supports: ${caps.languages.join(", ") || "static sites only"}.`,
      { hints: alternativesHint(manifest, registry, adapter.id) },
    );
  }
  if (manifest.domains.length > 0 && !caps.customDomains) {
    throw new LotseError(
      "DOMAINS_UNSUPPORTED",
      `${adapter.displayName} does not support custom domains, but the manifest lists ${manifest.domains.join(", ")}.`,
      {
        hints: alternativesHint(manifest, registry, adapter.id),
      },
    );
  }

  const native = caps.runtimes.includes(kind);
  if (!native) {
    notes.push(
      kind === "static"
        ? `${adapter.displayName} has no static hosting; the site is packaged into a small web server image.`
        : `${adapter.displayName} runs server apps as containers; an image is built automatically.`,
    );
  }
  if (manifest.release && !caps.runtimes.includes("container")) {
    notes.push(`${adapter.displayName} cannot run the release command "${manifest.release.command}"; run it as part of your build instead.`);
  }
  return { runtime: native ? kind : "container", containerized: !native, notes };
}

export interface ResourcePlanInput {
  manifest: Manifest;
  adapter: HostingAdapter;
  registry: AdapterRegistry;
  /** Adapter ids of resource providers the user is signed in to. */
  connectedProviders: string[];
  /** Resources that already exist for this app. */
  existing: ResourceRecord[];
}

/**
 * Decides who provides each resource: the hosting provider itself, or an
 * external resource provider. Stops with a clear message when nobody can.
 */
export function planResources(input: ResourcePlanInput): PlannedResource[] {
  const { manifest, adapter, registry } = input;
  return manifest.resources.map((spec): PlannedResource => {
    const existing = input.existing.find((r) => r.name === spec.name && r.type === spec.type);
    if (existing) {
      return { spec, provider: existing.provider, native: existing.provider === adapter.id, action: "reuse" };
    }

    const wanted = spec.options?.provider;
    const nativeOk = adapter.capabilities.resources.includes(spec.type) && typeof adapter.provision === "function";
    if (nativeOk && (!wanted || wanted === adapter.id)) {
      return { spec, provider: adapter.id, native: true, action: "create" };
    }

    const candidates = registry.resourceProviders(spec.type).filter((p) => !wanted || p.id === wanted);
    if (candidates.length === 0) {
      throw new LotseError(
        "RESOURCE_UNSUPPORTED",
        wanted
          ? `Resource "${spec.name}" asks for provider "${wanted}", which is not installed or does not offer ${spec.type}.`
          : `${adapter.displayName} does not offer ${spec.type} ("${spec.name}"), and no installed resource adapter provides it.`,
        { hints: alternativesHintForResource(spec.type, registry) },
      );
    }
    const connected = candidates.find((p) => input.connectedProviders.includes(p.id));
    if (!connected) {
      const names = candidates.map((p) => `${p.displayName} (\`lotse connect ${p.id}\`)`).join(" or ");
      throw new LotseError(
        "RESOURCE_UNSUPPORTED",
        `${adapter.displayName} does not offer ${spec.type} ("${spec.name}"). An external provider can supply it: sign in to ${names} and run the deployment again.`,
        { details: { proposals: candidates.map((p) => p.id), resource: spec.name } },
      );
    }
    return { spec, provider: connected.id, native: false, action: "create" };
  });
}

function alternativesHintForResource(type: string, registry: AdapterRegistry): string[] {
  const hosts = registry
    .listHosting()
    .filter((a) => a.capabilities.resources.includes(type))
    .map((a) => a.displayName);
  return hosts.length > 0 ? [`Hosting providers with built-in ${type}: ${hosts.join(", ")}.`] : [];
}
