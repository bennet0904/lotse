import { liveTransport, runLiveDeployment } from "@lotse/adapter-testkit";
import { createDokployAdapter } from "../src/index.js";

const transport = liveTransport("dokploy");

// Needs LOTSE_LIVE_DOKPLOY_URL and LOTSE_LIVE_DOKPLOY_TOKEN (an API key) of a test instance.
runLiveDeployment({
  transport,
  adapter: createDokployAdapter({ fetch: transport.fetch }),
  app: "server",
  connect: (env) =>
    env.LOTSE_LIVE_DOKPLOY_URL && env.LOTSE_LIVE_DOKPLOY_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_DOKPLOY_TOKEN, options: { baseUrl: env.LOTSE_LIVE_DOKPLOY_URL } }
      : undefined,
});
