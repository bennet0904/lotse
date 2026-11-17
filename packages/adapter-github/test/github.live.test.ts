import { liveTransport, runLiveGit } from "@lotseai/adapter-testkit";
import { createGithubProvider } from "../src/index.js";

const transport = liveTransport("github");

// Needs LOTSE_LIVE_GITHUB_TOKEN and LOTSE_LIVE_GITHUB_REPO (owner/name of a disposable test repository).
runLiveGit({
  transport,
  provider: createGithubProvider({ fetch: transport.fetch }),
  connect: (env) => (env.LOTSE_LIVE_GITHUB_TOKEN ? { method: "token", token: env.LOTSE_LIVE_GITHUB_TOKEN } : undefined),
  repo: (env) => env.LOTSE_LIVE_GITHUB_REPO,
});
