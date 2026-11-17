import { liveTransport, runLiveDeployment } from "@lotse/adapter-testkit";
import { createNetlifyAdapter } from "../src/index.js";

const transport = liveTransport("netlify");

// Needs LOTSE_LIVE_NETLIFY_TOKEN of a test account.
runLiveDeployment({
  transport,
  adapter: createNetlifyAdapter({ fetch: transport.fetch }),
  app: "static",
  connect: (env) => (env.LOTSE_LIVE_NETLIFY_TOKEN ? { method: "token", token: env.LOTSE_LIVE_NETLIFY_TOKEN } : undefined),
});
