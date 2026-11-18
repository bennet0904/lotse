# Lotse

Lotse turns a description of an app into a running app and publishes it where you choose: a hosting platform, a Git platform's Pages, or your own server. It is two things that also work apart:

- **A hosting core** with a command-line tool. It deploys any existing project described by a `lotse.yaml` to nine hosting providers and three Git platforms, through one provider-agnostic interface.
- **An app builder** on top of it. You describe an app; a language model plans it, writes it in an isolated sandbox with a live preview, and you publish it with one click.

Lotse is open source under the [Apache License 2.0](LICENSE). It collects no telemetry and needs no service run by the project.

> **Status: pre-release (0.1.0).** Lotse is the working name until the first public release. See [docs/implementation-status.md](docs/implementation-status.md) for what has been tested against real systems and what has not.

## What it supports

| Area                     | Supported                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Hosting providers        | Vercel, own server over SSH, Coolify, Netlify, Cloudflare, Railway, Fly.io, Hetzner Cloud, Dokploy                    |
| Git platforms            | GitHub, GitLab, Forgejo/Gitea (Codeberg): code storage, push-to-deploy pipelines, preview comments, Pages hosting     |
| Databases from elsewhere | Neon, Supabase, for hosts without their own Postgres                                                                  |
| App stacks               | Static site, React + Vite, Next.js, Hono; FastAPI, Django, Go `net/http` and Laravel (beta)                           |
| Language models          | Anthropic, OpenAI, Ollama, LM Studio, any OpenAI-compatible API (through the Vercel AI SDK)                           |
| Sign-in                  | OAuth 2.0 with PKCE where the instance has an OAuth app, otherwise a guided API-token setup; SSH keys for own servers |
| Delivery                 | CLI; web app for teams (Docker, PostgreSQL, OpenID Connect); desktop app (Electron, SQLite, Docker or Podman)         |

## Quick start

### Deploy an existing project with the CLI

```sh
npm install -g @lotseai/cli
cd my-app
lotse init                 # writes lotse.yaml after looking at the project
lotse connect vercel       # or ssh, netlify, cloudflare, …; guides you through the token setup
lotse plan --target vercel # shows what would change, changes nothing
lotse deploy --target vercel
```

Your own server needs only SSH access and Ubuntu 24.04 or Debian 12 or later:

```sh
lotse connect ssh --host 203.0.113.10        # generates a key; you install it or enter the password once
lotse server setup --target ssh              # shows every change and asks before making it
lotse deploy --target ssh
```

`lotse --help` lists all commands, including rollbacks, logs, custom domains, backups and Git sync.

### Run the builder for a team

```sh
cp deploy/.env.example deploy/.env           # set LOTSE_MASTER_KEY, OpenID Connect, a model key
docker compose -f deploy/compose.yaml up -d
```

The handbook explains the [installation step by step](https://bennet0904.github.io/lotse/admin/install): identity provider, preview domain, reverse proxy and sandbox isolation.

### Use the desktop app

Download the installer for your platform from the [releases page](https://github.com/bennet0904/lotse/releases/latest). The desktop app needs a container runtime for previews: Podman, Docker Desktop, Docker Engine or OrbStack. See the [handbook](https://bennet0904.github.io/lotse/start/desktop).

## Documentation

**[The Lotse handbook](https://bennet0904.github.io/lotse/)** explains how to install, build, publish and operate: the desktop app, the builder, providers, publishing, Git platforms, the command line and running the web app for a team. Its sources are in [`guide/`](guide/).

For developers:

- [lotse.yaml JSON schema](packages/core/schema/lotse.schema.json)
- [Writing an adapter](docs/adapters.md) · [Testing](docs/testing.md) · [Implementation status](docs/implementation-status.md)
- [Architecture decisions](docs/adr/)
- [Security model and reporting vulnerabilities](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Repository layout

| Package                    | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `@lotseai/core`            | Manifest, adapter interfaces, deployment engine, sign-in, Git and CI helpers               |
| `@lotseai/secrets`         | AES-256-GCM credential store; master key from environment, Vault/OpenBao, keychain or file |
| `@lotseai/build`           | Detects the project type and builds static artifacts or container images                   |
| `@lotseai/adapter-*`       | One package per provider; `@lotseai/adapters` lists the built-in ones                      |
| `@lotseai/adapter-testkit` | Contract test suite, replay of recorded API responses, live-test helpers                   |
| `@lotseai/cli`             | The `lotse` command                                                                        |
| `@lotseai/stacks`          | Templates for the app stacks                                                               |
| `@lotseai/agent`           | Plan, scaffold, implement and self-correct, through the Vercel AI SDK                      |
| `@lotseai/sandbox`         | One container per project, with an egress allow-list and a preview gateway                 |
| `@lotseai/server`          | HTTP and WebSocket API, job queue, users, SQLite or PostgreSQL                             |
| `@lotseai/ui`              | The builder's user interface (React), in English and German                                |
| `@lotseai/desktop`         | Electron shell that runs the builder locally                                               |

## Development

Requirements: Node.js 22 or later, pnpm 12, Git, and Docker or Podman for the integration tests.

```sh
pnpm install
pnpm build         # TypeScript project references and the UI
pnpm test:unit     # unit tests
pnpm test:contract # every adapter against recorded API responses
pnpm lint
```

[docs/testing.md](docs/testing.md) describes the integration, SSH, live and end-to-end tests and what they need.
