# Testing

Lotse is tested at six levels (specification section 14.2). All are Vitest projects in [`vitest.config.ts`](../vitest.config.ts) and run against the TypeScript sources, so no build is needed first (except for the desktop app's end-to-end test).

| Level       | Command                 | What it needs                                                                   | When it runs                     |
| ----------- | ----------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| Unit        | `pnpm test:unit`        | nothing                                                                         | every pull request               |
| Contract    | `pnpm test:contract`    | nothing: replays recorded API responses                                         | every pull request               |
| Integration | `pnpm test:integration` | Docker or Podman, Git, network access to package registries                     | every pull request               |
| SSH         | `pnpm test:ssh`         | a fresh Ubuntu or Debian machine (see below)                                    | nightly                          |
| Live        | `pnpm test:live`        | test accounts at the providers                                                  | nightly and before every release |
| End-to-end  | `pnpm test:e2e`         | Docker, Playwright's Chromium, a built workspace, a display for the desktop app | before every release             |

## Integration tests

They use the local container engine and create only containers, networks and images whose names start with `lotse-it-` (labelled `dev.lotse.test=1` or `dev.lotse.prefix`). They cover the sandbox (isolation, limits, egress allow-list, preview gateway), every stack template (scaffold, install, check, preview, production build; `LOTSE_TEST_STACKS=react-vite,hono` limits the run), the server with SQLite and PostgreSQL, the builder's API, the Forgejo adapter against a real Forgejo instance, and the image builder.

To run them against Podman, point `LOTSE_DOCKER_HOST` at its socket, e.g. `unix://$XDG_RUNTIME_DIR/podman/podman.sock`.

## SSH tests

They set up and deploy to a fresh machine over SSH: key installation with a one-time password, host-key pinning, the approved setup (deployment user, Docker, Caddy, firewall, unattended upgrades, backups), zero-downtime replacement, rollback, Postgres backup and restore, custom domains, logs and removal.

Locally, a container plays the fresh machine:

```sh
scripts/test-server.sh up ubuntu      # or debian
LOTSE_TEST_SSH_HOST=$(scripts/test-server.sh ip ubuntu) pnpm test:ssh
LOTSE_TEST_SSH_HOST=$(scripts/test-server.sh ip debian) LOTSE_TEST_SSH_CONTAINER=lotse-testserver-debian pnpm test:ssh
scripts/test-server.sh down
```

The nightly workflow runs them against both images.

## Live tests

Each adapter has a live test that deploys the reference app with a test account and removes it again; Git platforms push to a disposable repository; database providers create a database, connect to it and remove it. They are skipped when their variables are not set:

| Adapter       | Variables                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel        | `LOTSE_LIVE_VERCEL_TOKEN` (`LOTSE_LIVE_VERCEL_TEAM_ID`)                                                                                   |
| Netlify       | `LOTSE_LIVE_NETLIFY_TOKEN`                                                                                                                |
| Cloudflare    | `LOTSE_LIVE_CLOUDFLARE_TOKEN` (`LOTSE_LIVE_CLOUDFLARE_ACCOUNT`)                                                                           |
| Railway       | `LOTSE_LIVE_RAILWAY_TOKEN`                                                                                                                |
| Fly.io        | `LOTSE_LIVE_FLY_TOKEN` (`LOTSE_LIVE_FLY_ORG`)                                                                                             |
| Hetzner Cloud | `LOTSE_LIVE_HETZNER_TOKEN` (`LOTSE_LIVE_HETZNER_TYPE`, `LOTSE_LIVE_HETZNER_LOCATION`); creates a server billed by the hour and deletes it |
| Coolify       | `LOTSE_LIVE_COOLIFY_URL`, `LOTSE_LIVE_COOLIFY_TOKEN` (`LOTSE_LIVE_COOLIFY_REGISTRY`)                                                      |
| Dokploy       | `LOTSE_LIVE_DOKPLOY_URL`, `LOTSE_LIVE_DOKPLOY_TOKEN`                                                                                      |
| GitHub        | `LOTSE_LIVE_GITHUB_TOKEN`, `LOTSE_LIVE_GITHUB_REPO`                                                                                       |
| GitLab        | `LOTSE_LIVE_GITLAB_TOKEN`, `LOTSE_LIVE_GITLAB_REPO` (`LOTSE_LIVE_GITLAB_URL`)                                                             |
| Forgejo       | `LOTSE_LIVE_FORGEJO_TOKEN`, `LOTSE_LIVE_FORGEJO_REPO` (`LOTSE_LIVE_FORGEJO_URL`)                                                          |
| Neon          | `LOTSE_LIVE_NEON_TOKEN` (`LOTSE_LIVE_NEON_ORG`)                                                                                           |
| Supabase      | `LOTSE_LIVE_SUPABASE_TOKEN` (`LOTSE_LIVE_SUPABASE_ORG`)                                                                                   |

`LOTSE_RECORD=<folder>` writes each run's API traffic, credentials scrubbed, to `<folder>/<adapter>.live.json`; see [adapters.md](adapters.md).

## End-to-end tests

- `tests/e2e/ui.test.ts`: the builder in a real browser with a scripted model, a real sandbox and an in-memory provider: prompt, plan, approval, generation, preview, change, earlier version, publish, roll back.
- `tests/e2e/prompt-to-deploy.test.ts`: prompt to deployment on a fresh server over SSH with a fixed model and fixed prompts (needs `LOTSE_TEST_SSH_HOST`).
- `tests/e2e/desktop.test.ts`: the desktop app in Electron: start, local access protection, link handling, data and master key across restarts. Needs a display (`xvfb-run -a pnpm test:e2e` on Linux). `LOTSE_DESKTOP_APP=packages/desktop/bundle` tests the bundled app, `LOTSE_DESKTOP_EXECUTABLE=packages/desktop/release/linux-unpacked/lotse` a packaged one.

`LOTSE_SCREENSHOT_DIR` makes the UI test save screenshots.

## Type checks and lint

```sh
pnpm typecheck   # packages, test files and the UI
pnpm lint        # Biome: lint and formatting
```
