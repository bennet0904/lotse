import { envOptions, liveTransport, runLiveDeployment } from "@lotse/adapter-testkit";
import { createCloudflareAdapter } from "../src/index.js";

const transport = liveTransport("cloudflare");

// Needs LOTSE_LIVE_CLOUDFLARE_TOKEN of a test account; LOTSE_LIVE_CLOUDFLARE_ACCOUNT when the token reaches several accounts.
runLiveDeployment({
  transport,
  adapter: createCloudflareAdapter({ fetch: transport.fetch }),
  app: "static",
  connect: (env) =>
    env.LOTSE_LIVE_CLOUDFLARE_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_CLOUDFLARE_TOKEN, options: envOptions({ accountId: env.LOTSE_LIVE_CLOUDFLARE_ACCOUNT }) }
      : undefined,
});
