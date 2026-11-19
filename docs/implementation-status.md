# Implementation status

State of version 0.1.0 against the specification, and how each part has been verified. "Verified" means an automated test in this repository exercises it against the real thing named; "replayed" means against recorded or documented API responses only.

## Summary

| Area                                                                                                                 | State | Verified how                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| Manifest, JSON schema, planning, capability checks                                                                   | Done  | Unit tests                                                                                              |
| Deployment engine (plan, build, deploy, health check, rollback, abort)                                               | Done  | Unit tests; real deployments over SSH                                                                   |
| Credential store (AES-256-GCM; key from environment, Vault/OpenBao, keychain, file)                                  | Done  | Unit tests; Vault/OpenBao against a mocked API                                                          |
| Sign-in: OAuth 2.0 + PKCE, dynamic registration, token setup, SSH keys                                               | Done  | Unit and server tests with local OAuth servers; SSH key installation on real machines                   |
| Hosting adapters, wave 1: SSH, Vercel, Coolify                                                                       | Done  | SSH: real Ubuntu 24.04 and Debian 12 machines. Vercel, Coolify: replayed                                |
| Hosting adapters, wave 2: Netlify, Cloudflare, Railway, Fly.io, Hetzner Cloud, Dokploy                               | Done  | Replayed; Hetzner hands over to the SSH adapter, which is verified                                      |
| Git platforms: GitHub, GitLab, Forgejo (code, CI secrets, workflows, comments, Pages)                                | Done  | Forgejo: a real Forgejo 13 instance. GitHub, GitLab: replayed                                           |
| GitHub App via the manifest flow, webhook for outside pushes                                                         | Done  | Server tests against a mocked GitHub API                                                                |
| Resource providers: Neon, Supabase, Postgres on own server                                                           | Done  | Neon, Supabase: replayed. Postgres and Redis on own server: real machines, including backup and restore |
| CLI (all commands, `lotse create adapter`, CI pipeline generation)                                                   | Done  | CLI tests; smoke run against a real server; generated adapter passes the contract suite                 |
| Builder: plan, scaffold, implement, self-correct, Git history, usage and cost                                        | Done  | Server and end-to-end tests with a scripted model                                                       |
| Stacks: static, React + Vite, Next.js, Hono; FastAPI, Django, Go, Laravel (beta)                                     | Done  | Every stack in a real sandbox: scaffold, install, check, preview through the gateway, production build  |
| Sandbox: container per project, limits, egress allow-list, preview gateway, pause after idle, gVisor option          | Done  | Real Docker 29 and rootless Podman 5.7                                                                  |
| Web app: users, roles, OpenID Connect, PostgreSQL, job queue, WebSocket, audit log                                   | Done  | Server tests with a mock identity provider; SQLite (both drivers) and PostgreSQL 16                     |
| User interface in English and German                                                                                 | Done  | Playwright end-to-end tests in Chromium                                                                 |
| Desktop app (Electron, SQLite, keychain, Podman as an equal alternative)                                             | Done  | Linux: from the workspace, bundled and packaged, under Xvfb                                             |
| Web app container image and compose file                                                                             | Done  | Image built and run with SQLite and PostgreSQL; compose file validated                                  |
| Handbook for users and operators (guide/, GitHub Pages)                                                              | Done  | Built, links and anchors checked                                                                        |
| Project organization: README, SECURITY.md, CONTRIBUTING.md (DCO), CODEOWNERS, ADRs                                   | Done  |                                                                                                         |
| CI, nightly live and SSH tests with automatic issues and status page, signed releases with SBOMs, dependency updates | Done  | Workflows checked with actionlint; never run on GitHub                                                  |

Measured against the specification's performance goals: a static site deploys to an own server in about 3 seconds, and a sandbox starts in 0.5 to 1 second with its image present (goals: under 2 minutes and under 15 seconds).

## Not verified against the real services

Read this before relying on an adapter.

- **Provider APIs.** The recorded responses (cassettes) of Vercel, Netlify, Cloudflare, Railway, Fly.io, Hetzner Cloud, Coolify, Dokploy, GitHub, GitLab, Neon and Supabase were written from each provider's API documentation (`"source": "documentation"` in each cassette), not recorded from real accounts. Their adapters have never talked to the real service. Where the documentation is wrong or incomplete, the adapter is too. The least certain parts are Dokploy's response shapes, Cloudflare's OAuth scopes and Railway's source upload, which uses the endpoint of Railway's CLI. The live tests exist for every adapter and record the real traffic when run with `LOTSE_RECORD`; running them with test accounts is the next step.
- **Codeberg.** The Forgejo adapter was verified against a self-hosted Forgejo instance, not against codeberg.org, and Codeberg Pages' serving of the `pages` branch was not observed.
- **Language models.** No real model has been called. The pipeline (planning, tools, self-correction, usage tracking) is tested with a scripted model through the Vercel AI SDK's model interface. Prompt quality with real models is unmeasured.
- **Desktop app on macOS and Windows.** Built and run only on Linux. The keychain path through Electron's `safeStorage` is unit-tested with a stand-in; on the test machine, without a keyring, the app used and verified the protected-file fallback. Code signing and notarization are configured but untested. The macOS release builds separate `arm64` and `x64` apps on an arm64 runner; the `x64` app has not been started on an Intel Mac.
- **Podman beyond Linux.** Rootless Podman was verified on Linux. Podman machines on macOS and Windows are supported by socket detection only. On Ubuntu, rootless Podman's default network helper (`pasta`) is blocked by the distribution's AppArmor profile when containers are removed; `slirp4netns` works.
- **Production builds of the beta stacks.** FastAPI, Django, Go and Laravel run in the sandbox and pass their checks, but their deployment images (generated Dockerfiles) have not been deployed end to end.
- **Web app behind a reverse proxy.** The compose file with host networking was validated but not started on the development machine, which runs other services. OpenID Connect was tested against a mock identity provider only.
- **The GitHub App manifest flow** was tested against a mocked GitHub API.

## Not implemented

- Signing in to the builder with GitHub, GitLab or Forgejo (specification section 11.4, a MAY).
- A central OAuth broker (planned for a later version; the client-source chain is ready for it, see ADR 0017).
- Mirroring the repository to Codeberg (planned in the specification).

## Placeholders still to replace

- Further maintainers in `.github/CODEOWNERS`; every adapter is maintained by @bennet0904 for now.
- Signing secrets for the desktop app (`DESKTOP_CSC_LINK`, `DESKTOP_CSC_KEY_PASSWORD`, `APPLE_*`) and test-account secrets for the nightly live tests.
