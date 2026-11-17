import { liveTransport, runLiveDeployment } from "@lotseai/adapter-testkit";
import { createVercelAdapter } from "../src/index.js";

const transport = liveTransport("vercel");

// Needs LOTSE_LIVE_VERCEL_TOKEN (and optionally LOTSE_LIVE_VERCEL_TEAM_ID) of a test account.
runLiveDeployment({
  transport,
  adapter: createVercelAdapter({ fetch: transport.fetch }),
  app: "static",
  connect: (env) =>
    env.LOTSE_LIVE_VERCEL_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_VERCEL_TOKEN, options: env.LOTSE_LIVE_VERCEL_TEAM_ID ? { teamId: env.LOTSE_LIVE_VERCEL_TEAM_ID } : undefined }
      : undefined,
});
