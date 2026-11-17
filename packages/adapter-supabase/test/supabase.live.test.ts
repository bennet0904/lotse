import { envOptions, liveTransport, runLiveResource } from "@lotse/adapter-testkit";
import { createSupabaseAdapter } from "../src/index.js";

const transport = liveTransport("supabase");

// Needs LOTSE_LIVE_SUPABASE_TOKEN of a test account; LOTSE_LIVE_SUPABASE_ORG when it belongs to several organizations.
runLiveResource({
  transport,
  adapter: createSupabaseAdapter({ fetch: transport.fetch }),
  connect: (env) =>
    env.LOTSE_LIVE_SUPABASE_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_SUPABASE_TOKEN, options: envOptions({ organization: env.LOTSE_LIVE_SUPABASE_ORG }) }
      : undefined,
});
