# lotse.yaml

Every app has a `lotse.yaml` in its main folder. It describes how the app runs, independent of any provider, so the same app can be published anywhere. The builder writes it for you; for your own projects, `lotse init` writes a first version.

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

| Field                 | Meaning                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`             | Always `1`.                                                                                                                                                                    |
| `name`                | The app's name at the provider: lowercase letters, digits and hyphens, starting with a letter, at most 50 characters.                                                          |
| `runtime.kind`        | `static` for files only, `server` for a program Lotse builds an image for, `container` for an app with its own `Dockerfile`.                                                   |
| `runtime.language`    | For `server`: `node`, `python`, `go` or `php`.                                                                                                                                 |
| `runtime.version`     | Language version, e.g. `22` or `"3.13"`.                                                                                                                                       |
| `runtime.port`        | The port the app listens on. Lotse also passes it as `PORT`.                                                                                                                   |
| `runtime.start`       | The command that starts the app.                                                                                                                                               |
| `runtime.healthcheck` | A path that answers with success when the app works, e.g. `/health`. Traffic switches to a new version only after it answers. Default `/`.                                     |
| `build.strategy`      | `static` (run the build command, publish the output folder), `auto` (build an image for the language) or `dockerfile` (build your `Dockerfile`). Usually chosen automatically. |
| `build.command`       | The build command, e.g. `npm run build`.                                                                                                                                       |
| `build.output`        | For static builds: the folder with the finished files, e.g. `dist`.                                                                                                            |
| `build.dockerfile`    | The Dockerfile's path, if not `Dockerfile`.                                                                                                                                    |
| `release.command`     | Runs in the new version before it receives traffic, typically database migrations.                                                                                             |
| `resources`           | Services the app needs: `type` (`postgres`, `redis`, `object-storage`) and `name`. `options.provider` asks for a specific provider, e.g. `neon`.                               |
| `env.public`          | Settings that are not secret, as name and value.                                                                                                                               |
| `env.secrets`         | Names of secrets. Their values are never in this file; see [Secrets](../publish/secrets).                                                                                      |
| `domains`             | Custom domains, added at every deployment.                                                                                                                                     |

## How resources reach the app

| Resource                                     | Environment variable                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| Postgres named `db` or `database`            | `DATABASE_URL` (Neon and Supabase also `DATABASE_URL_UNPOOLED`) |
| Postgres with another name, e.g. `analytics` | `ANALYTICS_DATABASE_URL`                                        |
| Redis named `redis` or `cache`               | `REDIS_URL`                                                     |
| Anything else, e.g. `files`                  | `FILES_URL`                                                     |

Editors that understand JSON schemas can check the file while you type. Add this first line:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@lotseai/core/schema/lotse.schema.json
```
