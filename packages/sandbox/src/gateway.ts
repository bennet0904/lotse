/**
 * The sandbox gateway: the only way in and out of sandbox networks.
 *
 *   egress  (port 3128): an HTTP proxy that only reaches allow-listed hosts,
 *                        by default the package registries
 *   ingress (port 8080): forwards preview requests from the builder to a
 *                        sandbox; requires a key only the builder knows
 *
 * It runs as a container that is attached to every sandbox network. The script
 * is passed on the command line, so no file needs to be mounted.
 */

/** Package registries reachable from a sandbox by default (specification section 12.4). */
export const DEFAULT_ALLOWED_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "packagist.org",
  "repo.packagist.org",
];

export const GATEWAY_EGRESS_PORT = 3128;
export const GATEWAY_INGRESS_PORT = 8080;

export const GATEWAY_SCRIPT = String.raw`
const http = require("node:http");
const net = require("node:net");
const dns = require("node:dns");
const fs = require("node:fs");
const allow = (process.env.ALLOW_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const key = process.env.INGRESS_KEY || "";
const allowed = (host) => {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  return allow.some((a) => a === "*" || host === a || (a.startsWith(".") && host.endsWith(a)));
};
const deny = (socket, host) => {
  console.log("egress denied: " + host);
  socket.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nLotse sandbox: outbound access to " + host + " is not allowed.\n");
};

// --- name resolution ----------------------------------------------------------
// Docker answers every name through one embedded resolver. Podman lists one resolver per network,
// and the resolver of an internal sandbox network knows no outside names (and the outside one no
// sandbox names). The system resolver takes whichever "not found" arrives first, so on failure the
// resolvers are asked one after the other.
const resolvConf = () => {
  const servers = [], search = [];
  try {
    for (const line of fs.readFileSync("/etc/resolv.conf", "utf8").split("\n")) {
      const ns = /^\s*nameserver\s+(\S+)/.exec(line);
      if (ns) servers.push(ns[1]);
      const s = /^\s*search\s+(.+)$/.exec(line);
      if (s) search.push(...s[1].trim().split(/\s+/).filter((d) => d !== "."));
    }
  } catch {}
  return { servers, search };
};
const known = new Map();
const ask = (server, name) => new Promise((resolve) => {
  const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
  try { resolver.setServers([server]); } catch { return resolve(null); }
  resolver.resolve4(name, (err, addresses) => resolve(!err && addresses && addresses.length ? addresses[0] : null));
});
const lookup = (host, options, callback) => {
  if (typeof options === "function") { callback = options; options = {}; }
  const done = (address) => (options && options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4));
  if (net.isIP(host)) return done(host);
  const cached = known.get(host);
  if (cached && cached.until > Date.now()) return done(cached.address);
  dns.lookup(host, { family: 4 }, async (err, address) => {
    if (!err) return done(address);
    const { servers, search } = resolvConf();
    const names = host.includes(".") ? [host] : [host, ...search.map((d) => host + "." + d)];
    for (const server of servers) for (const name of names) {
      const found = await ask(server, name);
      if (found) { known.set(host, { address: found, until: Date.now() + 30000 }); return done(found); }
    }
    callback(err);
  });
};

// --- egress: allow-listed forward proxy -------------------------------------
const egress = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  if (url.protocol !== "http:" || !allowed(url.hostname)) {
    console.log("egress denied: " + url.hostname);
    res.writeHead(403, { "content-type": "text/plain" }).end("Lotse sandbox: outbound access to " + url.hostname + " is not allowed.\n");
    return;
  }
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  const upstream = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers, lookup }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
egress.on("connect", (req, socket, head) => {
  const [host, port = "443"] = String(req.url).split(":");
  socket.on("error", () => {});
  if (!allowed(host) || !["443", "80"].includes(port)) return deny(socket, host);
  const upstream = net.connect({ port: Number(port), host, lookup }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});
egress.listen(${GATEWAY_EGRESS_PORT}, "0.0.0.0");

// --- ingress: preview requests from the builder ------------------------------
const targetOf = (req) => {
  if (!key || req.headers["x-lotse-key"] !== key) return null;
  // Only sandbox containers can be targets, never the gateway itself or other hosts.
  const m = /^((?:[a-z0-9]+-)*sbx-[a-z0-9-]+):(\d{1,5})$/.exec(String(req.headers["x-lotse-target"] || ""));
  return m ? { host: m[1], port: Number(m[2]) } : null;
};
const strip = (headers) => {
  const out = { ...headers };
  delete out["x-lotse-key"];
  delete out["x-lotse-target"];
  return out;
};
const ingress = http.createServer((req, res) => {
  const target = targetOf(req);
  if (!target) { res.writeHead(403, { "content-type": "text/plain" }).end("forbidden\n"); return; }
  const upstream = http.request({ host: target.host, port: target.port, path: req.url, method: req.method, headers: strip(req.headers), lookup }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", "x-lotse-preview": "unreachable" });
    res.end("The app in the sandbox is not answering (" + err.code + ").\n");
  });
  req.pipe(upstream);
});
// WebSocket upgrades, e.g. for hot module reloading.
ingress.on("upgrade", (req, socket, head) => {
  const target = targetOf(req);
  socket.on("error", () => {});
  if (!target) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  const upstream = net.connect({ port: target.port, host: target.host, lookup }, () => {
    const headers = strip(req.headers);
    upstream.write(req.method + " " + req.url + " HTTP/1.1\r\n" + Object.entries(headers).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});
ingress.listen(${GATEWAY_INGRESS_PORT}, "0.0.0.0");
process.on("SIGTERM", () => process.exit(0));
console.log("lotse gateway ready; egress allow-list: " + (allow.join(", ") || "(none)"));
`;
