/**
 * The adapters that ship with Lotse (specification section 10): the hosting
 * providers of both waves, the Git platforms with their Pages hosting, and the
 * external database providers. The CLI and the builder register exactly this
 * list; further adapters are loaded by name through the configuration.
 */
import cloudflare from "@lotse/adapter-cloudflare";
import coolify from "@lotse/adapter-coolify";
import dokploy from "@lotse/adapter-dokploy";
import fly from "@lotse/adapter-fly";
import forgejo from "@lotse/adapter-forgejo";
import github from "@lotse/adapter-github";
import gitlab from "@lotse/adapter-gitlab";
import hetzner from "@lotse/adapter-hetzner";
import neon from "@lotse/adapter-neon";
import netlify from "@lotse/adapter-netlify";
import railway from "@lotse/adapter-railway";
import ssh from "@lotse/adapter-ssh";
import supabase from "@lotse/adapter-supabase";
import vercel from "@lotse/adapter-vercel";
import { type AdapterOptions, type AdapterPackage, AdapterRegistry } from "@lotse/core";

/** Hosting providers, in the order they are offered: first wave, then second wave. */
export const HOSTING_ADAPTERS: AdapterPackage[] = [vercel, ssh, coolify, netlify, cloudflare, railway, fly, hetzner, dokploy];
/** Git platforms; each also registers its Pages hosting. */
export const GIT_ADAPTERS: AdapterPackage[] = [github, gitlab, forgejo];
/** External providers for resources a hosting provider does not offer itself. */
export const RESOURCE_ADAPTERS: AdapterPackage[] = [neon, supabase];

export const BUILT_IN_ADAPTERS: AdapterPackage[] = [...HOSTING_ADAPTERS, ...GIT_ADAPTERS, ...RESOURCE_ADAPTERS];

/** A registry with every built-in adapter. */
export function builtInRegistry(options?: AdapterOptions): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const pkg of BUILT_IN_ADAPTERS) registry.use(pkg, options);
  return registry;
}
