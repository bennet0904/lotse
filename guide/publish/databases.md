# Databases and backups

When an app needs to store data on the server, its plan lists a database under **Needs**, and its `lotse.yaml` names it, e.g. a Postgres database called `db`. Lotse creates it at the first deployment and passes its address to the app (`DATABASE_URL`).

## Where the database comes from

- **From the hosting provider**, if it has one: your own server and Hetzner Cloud (Postgres and Redis as containers next to the app), Railway, Coolify and Dokploy.
- **From an external provider** otherwise: connect **Neon** or **Supabase** under _Providers → Databases and storage_. When you publish to a host without databases, e.g. Vercel, the plan shows _Create database "db" at Neon (external provider)_.

If neither is possible, the plan says so before anything is created, and names providers that would work.

Database addresses contain passwords; Lotse stores them encrypted like all credentials. With Neon and Supabase the app receives two addresses: `DATABASE_URL` through the provider's connection pooler for the app, and `DATABASE_URL_UNPOOLED` for migrations.

## Changes to the database structure

Apps whose stack has migrations (Django, Laravel, apps with a migration tool) declare a release command in `lotse.yaml`. It runs in the new version before it receives traffic, so the database is updated as part of every deployment.

## Backups on your own server

On your own server, every database is backed up every night; the last 14 backups are kept, and optionally also uploaded to [S3-compatible storage](../providers/own-server#backups).

In the project's **Publish** tab, open **Database backups**:

- The list shows every backup per database with time, size and where it is stored.
- **Back up … now** creates one immediately, e.g. before a risky change.
- **Restore** replaces the current content of the database with a backup. Lotse asks for confirmation — **Replace the data** — because changes made since then are lost.

With the command line:

```sh
lotse backup list db --target ssh
lotse backup create db --target ssh
lotse backup restore db <backup> --target ssh
```

## Backups elsewhere

Neon, Supabase, Railway and the other providers back up databases themselves, depending on your plan with them. Use their dashboards to restore.
