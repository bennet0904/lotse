import { envOptions, liveTransport, runLiveResource } from "@lotseai/adapter-testkit";
import { createNeonAdapter } from "../src/index.js";

const transport = liveTransport("neon");

// Needs LOTSE_LIVE_NEON_TOKEN of a test account; LOTSE_LIVE_NEON_ORG when it belongs to several organizations.
runLiveResource({
  transport,
  adapter: createNeonAdapter({ fetch: transport.fetch }),
  connect: (env) =>
    env.LOTSE_LIVE_NEON_TOKEN ? { method: "token", token: env.LOTSE_LIVE_NEON_TOKEN, options: envOptions({ orgId: env.LOTSE_LIVE_NEON_ORG }) } : undefined,
});
