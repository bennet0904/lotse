/** Names and paths the adapter uses on a server. */
export const ROOT = "/opt/lotse";
export const NETWORK = "lotse";
export const PROXY = "lotse-caddy";
export const DEPLOY_USER = "lotse";
export const PROXY_IMAGE = "caddy:2";
export const POSTGRES_IMAGE = "postgres:17-alpine";
export const REDIS_IMAGE = "redis:7-alpine";
/** Images and static releases kept per app for fast rollback (specification section 10.3). */
export const KEEP_RELEASES = 3;
export const KEEP_BACKUPS = 14;

export const appDir = (app: string) => `${ROOT}/apps/${app}`;
export const siteFile = (app: string) => `${ROOT}/caddy/conf/sites/${app}.caddy`;
export const backupDir = (app: string, resource: string) => `${ROOT}/backups/${app}/${resource}`;
export const resourceContainer = (app: string, resource: string) => `lotse-${app}-res-${resource}`;
export const imageRepo = (app: string) => `lotse/${app}`;

export interface RemoteState {
  app: string;
  kind: "image" | "static";
  port?: number;
  healthcheck: string;
  defaultHost: string;
  domains: string[];
  current?: Release;
  /** Newest first. */
  releases: Release[];
}

export interface Release {
  id: string;
  createdAt: number;
  image?: string;
  container?: string;
}

/** The main Caddyfile. Per-app site files are imported from `sites/`. */
export function mainCaddyfile(email?: string): string {
  return `# Managed by Lotse.
${email ? `{\n\temail ${email}\n}\n\n` : ""}:80 {
\trespond "No app is published at this address." 404
}

import /etc/caddy/sites/*.caddy
`;
}

export interface SiteInput {
  app: string;
  defaultHost: string;
  domains: string[];
  /** `container:port` for apps that run as a container. */
  upstream?: string;
  /** Static sites are served from the app's `current` release. */
  static?: boolean;
  /** auto: Let's Encrypt, internal: Caddy's own CA (testing), off: plain HTTP. */
  tls: "auto" | "internal" | "off";
}

/** Caddy configuration of one app. Caddy routes several apps on a server by domain name. */
export function siteConfig(input: SiteInput): string {
  const handler = input.static
    ? `\troot * /srv/apps/${input.app}/current\n\tencode zstd gzip\n\ttry_files {path} {path}/index.html {path}.html /index.html\n\tfile_server\n`
    : `\tencode zstd gzip\n\treverse_proxy ${input.upstream}\n`;
  let out = `# Managed by Lotse. Changes are overwritten by the next deployment.\nhttp://${input.defaultHost} {\n${handler}}\n`;
  if (input.domains.length > 0) {
    const names = input.domains.map((d) => (input.tls === "off" ? `http://${d}` : d)).join(", ");
    out += `\n${names} {\n${input.tls === "internal" ? "\ttls internal\n" : ""}${handler}}\n`;
  }
  return out;
}

/** Hostname every app gets without any DNS setup. */
export function defaultHostFor(app: string, settings: Record<string, string>): string {
  if (settings.baseDomain) return `${app}.${settings.baseDomain}`;
  const ip = settings.ip ?? settings.host ?? "";
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `${app}.${ip.replace(/\./g, "-")}.sslip.io` : `${app}.${ip}`;
}

export function releaseId(now = new Date()): string {
  return (
    now
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 14) +
    Math.floor(Math.random() * 36 ** 2)
      .toString(36)
      .padStart(2, "0")
  );
}
