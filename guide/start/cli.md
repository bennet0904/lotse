# Command line

The `lotse` command deploys an existing project to any supported provider. It does not need the builder or a language model.

## Install

You need [Node.js](https://nodejs.org) 22 or later.

```sh
npm install -g @lotseai/cli
lotse --help
```

Or run it without installing:

```sh
npx @lotseai/cli --help
```

## Quick start

```sh
cd my-app
lotse init                 # looks at the project and writes lotse.yaml
lotse connect vercel       # signs in; guides you through creating a token
lotse plan --target vercel # shows what would change, changes nothing
lotse deploy --target vercel
```

The next steps are in [Deploying an existing project](../cli/deploy). All commands are listed in [Commands](../cli/commands).

## Where the CLI keeps things

| What                                          | Where                                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and settings for all projects        | `~/.config/lotse` (or `LOTSE_CONFIG_DIR`)                                                                                                                                    |
| Deployment history and secrets of one project | `.lotse/` in the project folder; secrets are encrypted                                                                                                                       |
| The encryption key                            | `~/.config/lotse/master.key`, readable only by you. `LOTSE_MASTER_KEY` or HashiCorp Vault can provide it instead ([configuration](../admin/configuration#credential-store)). |

Lotse puts a `.gitignore` into `.lotse/` that keeps the encrypted secrets out of Git. Keep a copy of `master.key`: without it, stored accounts and secrets cannot be read.
