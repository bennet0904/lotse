import { liveTransport, runLiveDeployment } from "@lotseai/adapter-testkit";
import { createCoolifyAdapter } from "../src/index.js";

const transport = liveTransport("coolify");

// Needs LOTSE_LIVE_COOLIFY_URL and LOTSE_LIVE_COOLIFY_TOKEN of a test instance, and
// LOTSE_LIVE_COOLIFY_REGISTRY (a registry the instance can pull from) for container deployments.
runLiveDeployment({
  transport,
  adapter: createCoolifyAdapter({ fetch: transport.fetch }),
  app: "server",
  connect: (env) =>
    env.LOTSE_LIVE_COOLIFY_URL && env.LOTSE_LIVE_COOLIFY_TOKEN
      ? {
          method: "token",
          token: env.LOTSE_LIVE_COOLIFY_TOKEN,
          options: { baseUrl: env.LOTSE_LIVE_COOLIFY_URL, ...(env.LOTSE_LIVE_COOLIFY_REGISTRY ? { registry: env.LOTSE_LIVE_COOLIFY_REGISTRY } : {}) },
        }
      : undefined,
});
