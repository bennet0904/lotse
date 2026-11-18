# Commands

`lotse <command> --help` explains every command and option. All commands work in the current folder; `-C <folder>` runs them for another project.

## Projects

| Command                        | Does                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lotse init`                   | Writes `lotse.yaml` after looking at the project (`--name`, `--force`).                                                                                                                               |
| `lotse validate`               | Checks `lotse.yaml`.                                                                                                                                                                                  |
| `lotse plan`                   | Shows what a deployment would change, without changing anything.                                                                                                                                      |
| `lotse deploy`                 | Builds and deploys. `--yes` skips the first-deployment question, `--preview <id>` deploys a preview, `--comment <request>` posts its address on a pull request, `--json` prints events as JSON lines. |
| `lotse status`                 | Whether the app runs, and where.                                                                                                                                                                      |
| `lotse logs`                   | The app's logs (`--follow`, `--tail <lines>`).                                                                                                                                                        |
| `lotse history`                | Earlier deployments.                                                                                                                                                                                  |
| `lotse rollback`               | Returns to the previous deployment, or `--to <deployment>`.                                                                                                                                           |
| `lotse destroy`                | Removes the app at the provider. `--with-resources` also deletes databases at external providers.                                                                                                     |
| `lotse env set <name> [value]` | Stores a secret (asks for the value if omitted); `--apply` also updates the running app.                                                                                                              |
| `lotse env list`               | Lists the app's variables, never secret values.                                                                                                                                                       |
| `lotse env unset <name>`       | Removes a stored secret.                                                                                                                                                                              |
| `lotse domains add <domain>`   | Adds a custom domain and shows the DNS records to create.                                                                                                                                             |

Most commands take `--target <provider>`; it can be left out once the project has a default.

## Accounts and servers

| Command                                    | Does                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lotse adapters`                           | Lists all providers with what they support, and which are connected.                                                                                                          |
| `lotse connect <provider>`                 | Signs in: OAuth, token (`--token`) or, for `ssh`, `--host`, `--user`, `--port`, `--key`, `--password`. `--option name=value` and `--secret name=value` pass further settings. |
| `lotse connections`                        | Lists accounts. `show <id>` without credentials, `remove <id>`, `export <id>` as a CI secret value.                                                                           |
| `lotse verify [provider]`                  | Checks that accounts work and have the permissions deployments need.                                                                                                          |
| `lotse server setup`                       | Sets up a fresh server after showing every change (`--yes` approves them).                                                                                                    |
| `lotse backup list <database>`             | Lists backups on your own server.                                                                                                                                             |
| `lotse backup create <database>`           | Creates a backup now.                                                                                                                                                         |
| `lotse backup restore <database> <backup>` | Replaces the database content with a backup, after confirmation.                                                                                                              |

## Git

| Command                       | Does                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lotse git link [owner/name]` | Links the project to a repository; `--create` (and `--public`) creates it, `--provider github               | gitlab | forgejo`. |
| `lotse git push`              | Commits all changes and pushes them.                                                                        |
| `lotse git pull`              | Brings in changes made elsewhere; stops on conflicts.                                                       |
| `lotse git ci`                | Sets up automatic deployments: writes the pipeline and stores the credentials as CI secrets (`--previews`). |

## Other

| Command                       | Does                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `lotse secrets generate-key`  | Prints a new master key for `LOTSE_MASTER_KEY`.           |
| `lotse create adapter <name>` | Creates a package for a new provider adapter, with tests. |
