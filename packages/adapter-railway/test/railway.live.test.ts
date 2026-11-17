import { liveTransport, runLiveDeployment } from "@lotseai/adapter-testkit";
import { createRailwayAdapter } from "../src/index.js";

const transport = liveTransport("railway");

// Needs LOTSE_LIVE_RAILWAY_TOKEN of a test account.
runLiveDeployment({
  transport,
  adapter: createRailwayAdapter({ fetch: transport.fetch }),
  app: "server",
  connect: (env) => (env.LOTSE_LIVE_RAILWAY_TOKEN ? { method: "token", token: env.LOTSE_LIVE_RAILWAY_TOKEN } : undefined),
});
