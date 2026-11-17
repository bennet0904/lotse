import { envOptions, liveTransport, runLiveGit } from "@lotse/adapter-testkit";
import { createGitlabProvider } from "../src/index.js";

const transport = liveTransport("gitlab");

// Needs LOTSE_LIVE_GITLAB_TOKEN and LOTSE_LIVE_GITLAB_REPO (group/name of a disposable test project); LOTSE_LIVE_GITLAB_URL for a self-managed instance.
runLiveGit({
  transport,
  provider: createGitlabProvider({ fetch: transport.fetch }),
  connect: (env) =>
    env.LOTSE_LIVE_GITLAB_TOKEN
      ? { method: "token", token: env.LOTSE_LIVE_GITLAB_TOKEN, options: envOptions({ baseUrl: env.LOTSE_LIVE_GITLAB_URL }) }
      : undefined,
  repo: (env) => env.LOTSE_LIVE_GITLAB_REPO,
});
