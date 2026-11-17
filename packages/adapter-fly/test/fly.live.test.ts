import { liveTransport, runLiveDeployment } from "@lotse/adapter-testkit";
import { createFlyAdapter } from "../src/index.js";

const transport = liveTransport("fly");

// Needs LOTSE_LIVE_FLY_TOKEN (an org token) of a test organization.
runLiveDeployment({
  transport,
  adapter: createFlyAdapter({ fetch: transport.fetch }),
  app: "server",
  connect: (env) =>
    env.LOTSE_LIVE_FLY_TOKEN ? { method: "token", token: env.LOTSE_LIVE_FLY_TOKEN, options: { org: env.LOTSE_LIVE_FLY_ORG ?? "personal" } } : undefined,
});
