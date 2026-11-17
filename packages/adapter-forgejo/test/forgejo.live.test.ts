import { envOptions, liveTransport, runLiveGit } from "@lotse/adapter-testkit";
import { createForgejoProvider } from "../src/index.js";

const transport = liveTransport("forgejo");

// Needs LOTSE_LIVE_FORGEJO_TOKEN and LOTSE_LIVE_FORGEJO_REPO (owner/name of a disposable test repository); LOTSE_LIVE_FORGEJO_URL for an instance other than Codeberg.
runLiveGit({
  transport,
  provider: createForgejoProvider({ fetch: transport.fetch }),
  connect: (env) =>
    env.LOTSE_LIVE_FORGEJO_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_FORGEJO_TOKEN, options: envOptions({ baseUrl: env.LOTSE_LIVE_FORGEJO_URL }) }
      : undefined,
  repo: (env) => env.LOTSE_LIVE_FORGEJO_REPO,
});
