import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cassette, liveTransport, ReplayTransport } from "../src/index.js";

describe("recording live runs", () => {
  let server: Server;
  let base = "";
  let dir = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        // A provider echoing a token it issued, as token endpoints do.
        res.end(JSON.stringify({ path: req.url, received: body ? JSON.parse(body) : null, refreshed: "fresh-token-issued-later-0001" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "lotse-record-"));
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("does nothing unless LOTSE_RECORD is set", async () => {
    const transport = liveTransport("example", {});
    expect(transport.fetch).toBeUndefined();
    await transport.save();
  });

  it("writes every interaction with secrets scrubbed, also those learned later", async () => {
    const transport = liveTransport("example", { LOTSE_RECORD: dir });
    transport.protect("secret-api-token-0001");
    const call = transport.fetch as typeof fetch;
    await call(`${base}/v1/user?token=secret-api-token-0001`);
    await call(`${base}/v1/deployments`, { method: "POST", body: JSON.stringify({ name: "site", auth: "secret-api-token-0001" }) });
    // A token that only became known after these requests is removed from them too.
    transport.protect("fresh-token-issued-later-0001");
    await transport.save();

    const raw = await readFile(join(dir, "example.live.json"), "utf8");
    expect(raw).not.toMatch(/secret-api-token-0001|fresh-token-issued-later-0001/);
    const cassette = JSON.parse(raw) as Cassette;
    expect(cassette).toMatchObject({ adapter: "example", source: "live" });
    expect(cassette.scenarios.live?.map((i) => `${i.request.method} ${new URL(i.request.url).pathname}`)).toEqual(["GET /v1/user", "POST /v1/deployments"]);
    expect(cassette.scenarios.live?.[1]?.request.body).toEqual({ name: "site", auth: "[redacted]" });

    // The recording replays like any cassette; scrubbed values stay scrubbed in the request bodies it matches.
    const replay = new ReplayTransport(cassette.scenarios.live ?? []);
    const res = await replay.fetch(`${base}/v1/deployments`, { method: "POST", body: JSON.stringify({ name: "site", auth: "[redacted]" }) });
    expect(await res.json()).toMatchObject({ path: "/v1/deployments" });
  });
});
