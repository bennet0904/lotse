# Configuration reference

All settings of an installation are environment variables (in the web app: the `.env` file next to `compose.yaml`). Language models can also be set up in the user interface under **Settings → Language models**; those settings take precedence. The builder (web app and desktop app) reads them at start; the CLI reads them on every call.

## Builder server

| Variable                                           | Default                                   | Meaning                                                                                                      |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `LOTSE_PUBLIC_URL`                                 | `http://localhost:<port>`                 | Address people use to reach the builder. OAuth redirects and preview addresses are derived from it.          |
| `LOTSE_HOST`                                       | `127.0.0.1`                               | Address to listen on. `0.0.0.0` inside a container.                                                          |
| `LOTSE_PORT`                                       | `4780`                                    | Port to listen on.                                                                                           |
| `LOTSE_ALLOWED_HOSTS`                              |                                           | Further host names a single-user builder answers to (it refuses others as protection against DNS rebinding). |
| `LOTSE_DATA_DIR`                                   | `./data`                                  | Projects, sandbox caches and, for SQLite, the database.                                                      |
| `LOTSE_DATABASE_URL`                               | `sqlite:<data dir>/lotse.db`              | `sqlite:<path>` or `postgres://user:password@host:port/database`.                                            |
| `LOTSE_SQLITE_DRIVER`                              | `better-sqlite3` (`node` inside Electron) | SQLite driver: `better-sqlite3` or `node` (the SQLite built into Node.js).                                   |
| `LOTSE_AUTH`                                       | `none`                                    | `none`: one user without sign-in. `oidc`: several users, sign-in with OpenID Connect.                        |
| `LOTSE_OIDC_ISSUER`                                |                                           | Issuer URL of the identity provider. Required for `oidc`.                                                    |
| `LOTSE_OIDC_CLIENT_ID`, `LOTSE_OIDC_CLIENT_SECRET` |                                           | Client registered at the identity provider, with redirect URI `<LOTSE_PUBLIC_URL>/api/v1/auth/callback`.     |
| `LOTSE_OIDC_SCOPES`                                | `openid,email,profile`                    | Scopes requested at sign-in.                                                                                 |
| `LOTSE_LOCAL_TOKEN`                                |                                           | Single-user mode only: requests must carry this value in the `lotse_local` cookie. The desktop app sets it.  |
| `LOTSE_UI_DIR`                                     | built UI next to the server               | Folder with the built user interface.                                                                        |
| `LOTSE_JOB_CONCURRENCY`                            | `2`                                       | Builds, generations and deployments that run at the same time.                                               |
| `LOTSE_ADAPTERS`                                   |                                           | Further adapter packages, comma-separated, e.g. `lotse-adapter-acme`.                                        |
| `LOTSE_STACKS`                                     |                                           | Further stack template packages, comma-separated.                                                            |

The first person to sign in with OpenID Connect becomes the owner; later ones are members until an owner or admin changes their role.

## Credential store

| Variable                                                                        | Meaning                                                                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_MASTER_KEY`                                                              | Master key (32 bytes, base64) of the AES-256-GCM credential store. Create one with `lotse secrets generate-key`. Required for the web app unless Vault is used. |
| `LOTSE_VAULT_ADDR`, `LOTSE_VAULT_TOKEN` (or `VAULT_ADDR`, `VAULT_TOKEN`)        | HashiCorp Vault or OpenBao holding the master key instead.                                                                                                      |
| `LOTSE_VAULT_PATH`, `LOTSE_VAULT_MOUNT`, `LOTSE_VAULT_FIELD`, `VAULT_NAMESPACE` | Location of the key in a KV v2 engine (mount defaults to `secret`, field to `master_key`).                                                                      |

Single-user installations without either fall back to the operating system's keychain (desktop app, CLI) or a key file with owner-only permissions in the data directory.

## Language models

| Variable                                                     | Meaning                                                                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_MODEL`                                                | Default model as `<provider>:<model>`, e.g. `anthropic:claude-opus-5-5`, `openai:<model>`, `ollama:qwen3-coder`, `lmstudio:<model>`, `openai-compatible:<model>`. |
| `LOTSE_PLAN_MODEL`                                           | Model for the planning step, if it should differ.                                                                                                                 |
| `LOTSE_MAX_CORRECTIONS`                                      | How often build and runtime errors are fed back to the model (default 3).                                                                                         |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`                    | Anthropic.                                                                                                                                                        |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`                          | OpenAI.                                                                                                                                                           |
| `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`                       | Local models (defaults `http://127.0.0.1:11434` and `http://127.0.0.1:1234`).                                                                                     |
| `LOTSE_OPENAI_COMPATIBLE_URL`, `LOTSE_OPENAI_COMPATIBLE_KEY` | Any other OpenAI-compatible API.                                                                                                                                  |

Users can choose another model per project. Token usage and estimated cost are shown per project.

## Sandboxes and previews

| Variable                                        | Default            | Meaning                                                                                                                                              |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_PREVIEW_DOMAIN`                          | `localhost`        | Previews are served at `p-<project>-<token>.<domain>`. Needs a wildcard DNS record for the web app.                                                  |
| `LOTSE_DOCKER_HOST` (or `DOCKER_HOST`)          | detected           | Container engine: `unix:///path/to.sock`, `npipe:////./pipe/name` or `tcp://host:port`. Docker, Podman, OrbStack and Colima are found automatically. |
| `LOTSE_SANDBOX_CPUS`, `LOTSE_SANDBOX_MEMORY_MB` | `2`, `2048`        | Limits per sandbox.                                                                                                                                  |
| `LOTSE_SANDBOX_IDLE_MINUTES`                    | `30`               | Idle sandboxes are paused after this time and resumed on the next access.                                                                            |
| `LOTSE_SANDBOX_RUNTIME`                         | engine default     | OCI runtime for sandboxes, e.g. `runsc` for gVisor.                                                                                                  |
| `LOTSE_SANDBOX_ALLOWED_HOSTS`                   | package registries | Hosts sandboxes may reach, comma-separated. `.example.com` allows subdomains.                                                                        |
| `LOTSE_SANDBOX_PREFIX`                          | `lotse`            | Prefix of container and network names.                                                                                                               |

## Builds

| Variable                  | Meaning                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_CONTAINER_RUNTIME` | `docker` or `podman` for image builds (default: whichever is installed).                                                                |
| `LOTSE_AUTO_BUILDER`      | Tool for the `auto` build strategy: `railpack`, `pack` or `dockerfile` (default: the first one installed, else a generated Dockerfile). |

## Git platforms and OAuth

| Variable                                                                   | Meaning                                                                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_OAUTH_<PROVIDER>_CLIENT_ID`, `LOTSE_OAUTH_<PROVIDER>_CLIENT_SECRET` | OAuth app of the instance for a provider, e.g. `LOTSE_OAUTH_VERCEL_CLIENT_ID`. See [OAuth apps and the GitHub App](./provider-sign-in). |
| `LOTSE_OAUTH_PORT`                                                         | Fixed port for the CLI's loopback redirect.                                                                                             |
| `LOTSE_GITHUB_URL`                                                         | GitHub Enterprise Server instead of github.com.                                                                                         |
| `LOTSE_GITLAB_URL`                                                         | Self-managed GitLab instead of gitlab.com.                                                                                              |
| `LOTSE_FORGEJO_URL`                                                        | Forgejo or Gitea instance instead of Codeberg.                                                                                          |
| `LOTSE_NEON_REGION`, `LOTSE_SUPABASE_REGION`                               | Default region of databases created at Neon or Supabase.                                                                                |

## CLI

| Variable             | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `LOTSE_CONFIG_DIR`   | Where accounts and settings are kept (default `~/.config/lotse`).          |
| `LOTSE_TOKEN`        | API token for `lotse connect`, instead of `--token`.                       |
| `LOTSE_SSH_PASSWORD` | Server password used once to install the SSH key, instead of `--password`. |
| `LOTSE_DEBUG`        | Print stack traces of errors.                                              |

In CI pipelines generated by `lotse git ci`, the CLI reads its accounts and secrets from CI secrets instead of the local store:

| Variable                     | Meaning                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `LOTSE_CONNECTION_<ADAPTER>` | The account for an adapter, as base64 JSON.                      |
| `LOTSE_VAULT`                | Resource connection values (e.g. database URLs), as base64 JSON. |
| `LOTSE_SECRET_<NAME>`        | Value of the app secret `<NAME>` declared in `lotse.yaml`.       |
| `LOTSE_MASTER_KEY`           | Not needed in CI; set it only to read an encrypted store.        |

## Desktop app

| Variable                 | Default                    | Meaning                                                              |
| ------------------------ | -------------------------- | -------------------------------------------------------------------- |
| `LOTSE_DESKTOP_PORT`     | `4781`                     | Port of the local builder; another free port is used if it is taken. |
| `LOTSE_DESKTOP_DATA_DIR` | the app's user data folder | Where projects, the database and the sealed master key are kept.     |
