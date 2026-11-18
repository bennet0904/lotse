# Deploying an existing project

The command line deploys any project — one the builder wrote, or one you already have — to any supported provider. [Install it](../start/cli) first.

## 1. Describe the project

In the project folder:

```sh
lotse init
```

Lotse looks at the project (e.g. `package.json`, `requirements.txt`, `go.mod`, `composer.json`, a `Dockerfile`) and writes a [`lotse.yaml`](./lotse-yaml). Check it: in particular the port, the start command and the health check path. `lotse validate` checks the file.

## 2. Sign in

```sh
lotse connect vercel
```

Without OAuth, Lotse shows the provider's token page, the permissions to choose, and asks for the token. In scripts, pass it with `--token` or `LOTSE_TOKEN`. Settings such as a team or the address of a self-hosted tool go in with `--option`, e.g. `lotse connect coolify --option baseUrl=https://coolify.example.com`.

For your own server:

```sh
lotse connect ssh --host 203.0.113.10        # generates a key; install it or enter the password once
lotse server setup                           # shows every change and asks before making it
```

`lotse connections` lists your accounts, `lotse verify` checks them.

## 3. Plan

```sh
lotse plan --target vercel
```

Shows what a deployment would do — create the project, create a database, deploy — and anything the provider cannot do, with alternatives. Nothing is changed.

## 4. Deploy

```sh
lotse deploy --target vercel
```

The first deployment to a provider asks for confirmation (`--yes` skips the question, e.g. in pipelines). Lotse builds the app, sets secrets, creates resources, deploys, waits until the app answers and prints its address. If the new version does not answer, the previous one is restored.

The provider of the first deployment becomes the project's default, so later you can run just `lotse deploy`. With only one provider connected, `--target` is never needed.

## Secrets

Secrets the app needs are declared in `lotse.yaml` under `env.secrets`. Set their values once:

```sh
lotse env set MAIL_PASSWORD          # asks for the value without showing it
lotse env list                       # shows which are set, never the values
```

`lotse env set NAME --apply` also updates the running app. Values are stored encrypted in `.lotse/`.

## After deploying

```sh
lotse status                 # is it running, and where
lotse logs --follow          # the app's logs
lotse history                # earlier deployments
lotse rollback               # back to the previous deployment (or --to <id>)
lotse domains add app.example.com
lotse destroy                # remove the app at the provider
```

All commands are listed in [Commands](./commands).
