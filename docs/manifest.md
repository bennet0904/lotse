# lotse.yaml

Every app that Lotse deploys is described by a `lotse.yaml` in its root folder. The file is provider-neutral: the same manifest deploys to any hosting provider that supports what it asks for. `lotse init` writes one after looking at the project; `lotse validate` checks it.

The authoritative definition is the JSON schema in [`packages/core/schema/lotse.schema.json`](../packages/core/schema/lotse.schema.json), generated from the code. Editors that understand JSON schemas can use it for completion:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@lotseai/core/schema/lotse.schema.json
```

## Example

```yaml
version: 1
name: guest-book
runtime:
  kind: server
  language: node
  version: 22
  port: 3000
  start: npm start
  healthcheck: /health
build:
  strategy: auto
  command: npm run build
release:
  command: npm run migrate
resources:
  - type: postgres
    name: db
env:
  public:
    LOG_LEVEL: info
  secrets:
    - SESSION_SECRET
domains:
  - guestbook.example.com
```

## Fields

| Field                 | Required            | Meaning                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`             | yes                 | Format version, currently `1`.                                                                                                                                                                                                                                                                                                                     |
| `name`                | yes                 | App name: lowercase letters, digits and hyphens, starting with a letter, at most 50 characters. Unique per provider account.                                                                                                                                                                                                                       |
| `runtime.kind`        | yes                 | `static` (files only), `server` (a process Lotse builds an image for) or `container` (an image built from your Dockerfile).                                                                                                                                                                                                                        |
| `runtime.language`    | for `server`        | `node`, `python`, `go`, `php`, …                                                                                                                                                                                                                                                                                                                   |
| `runtime.version`     | no                  | Language version, e.g. `22` or `"3.13"`.                                                                                                                                                                                                                                                                                                           |
| `runtime.port`        | no                  | Port the app listens on. It is also passed to the app as `PORT`.                                                                                                                                                                                                                                                                                   |
| `runtime.start`       | no                  | Command that starts a server app.                                                                                                                                                                                                                                                                                                                  |
| `runtime.healthcheck` | no                  | Path that answers 2xx when the app is healthy. A deployment only switches traffic to the new version after this check passes. Defaults to `/`.                                                                                                                                                                                                     |
| `build.strategy`      | no                  | `static` (run `command`, publish `output`), `auto` (detect the language and build an image) or `dockerfile` (build your `Dockerfile`). Defaults to `static` for static apps and `auto` otherwise.                                                                                                                                                  |
| `build.command`       | no                  | Build command, e.g. `npm run build`.                                                                                                                                                                                                                                                                                                               |
| `build.output`        | for `static` builds | Folder with the files to publish, relative to the app root.                                                                                                                                                                                                                                                                                        |
| `build.dockerfile`    | no                  | Path of the Dockerfile for the `dockerfile` strategy.                                                                                                                                                                                                                                                                                              |
| `release.command`     | no                  | Runs in the new version before it receives traffic, e.g. database migrations.                                                                                                                                                                                                                                                                      |
| `resources[]`         | no                  | Services the app needs: `type` (`postgres`, `redis`, `object-storage`), `name`, and `options`. Connection values are injected as environment variables, e.g. `DATABASE_URL` for a Postgres resource named `db` (otherwise `<NAME>_DATABASE_URL`), `REDIS_URL` for `redis`/`cache`. `options.provider` chooses an external provider such as `neon`. |
| `env.public`          | no                  | Non-secret environment values, stored in the manifest.                                                                                                                                                                                                                                                                                             |
| `env.secrets`         | no                  | Names of secrets. Values never go into the manifest: they are set with `lotse env set NAME` (or in the builder) and stored encrypted.                                                                                                                                                                                                              |
| `domains[]`           | no                  | Custom domains. Lotse shows the DNS records to create when the provider needs them.                                                                                                                                                                                                                                                                |

## How the manifest picks a provider

`lotse plan` compares the manifest with what the chosen provider declares it can do (runtimes, languages, resources, custom domains, rollbacks). If the provider lacks something, the plan says so and names alternatives: other providers that support it, or an external resource provider such as Neon for a Postgres database. Nothing is changed until you deploy.
