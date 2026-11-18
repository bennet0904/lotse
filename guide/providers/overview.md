# Choosing a provider

Every provider runs apps differently. Lotse knows what each one supports and checks it before publishing: if your app needs something the provider cannot do, the plan says so and suggests providers that can.

## Hosting providers

| Provider                                               | Runs                      | Languages                | Databases       | Rollback       | Preview deployments |
| ------------------------------------------------------ | ------------------------- | ------------------------ | --------------- | -------------- | ------------------- |
| **Your own server** (SSH)                              | static, server, container | Node.js, Python, Go, PHP | Postgres, Redis | yes            | —                   |
| **Hetzner Cloud**                                      | static, server, container | Node.js, Python, Go, PHP | Postgres, Redis | yes            | —                   |
| **Vercel**                                             | static, server            | Node.js, Python          | —               | yes            | yes                 |
| **Netlify**                                            | static, server            | Node.js                  | —               | yes            | yes                 |
| **Cloudflare**                                         | static, server            | Node.js                  | object storage  | yes            | —                   |
| **Railway**                                            | server, container         | Node.js, Python, Go, PHP | Postgres, Redis | yes            | —                   |
| **Fly.io**                                             | server, container         | Node.js, Python, Go, PHP | —               | by redeploying | —                   |
| **Coolify** (self-hosted)                              | static, server, container | Node.js, Python, Go, PHP | Postgres, Redis | yes            | —                   |
| **Dokploy** (self-hosted)                              | static, server, container | Node.js, Python, Go, PHP | Postgres, Redis | —              | —                   |
| **GitHub Pages**, **GitLab Pages**, **Codeberg Pages** | static                    | —                        | —               | —              | —                   |

All of them support custom domains except GitLab Pages and Codeberg Pages, where you set domains in the platform itself.

::: warning Pre-release
Publishing to your own server and to Hetzner Cloud is tested against real machines. The other platform connections are built from each provider's documentation and have not yet been tested against the real services. Report problems on [GitHub](https://github.com/bennet0904/lotse/issues).
:::

## Databases from elsewhere

If your app needs a Postgres database and your hosting provider has none (Vercel, Netlify, Cloudflare, Fly.io), connect **Neon** or **Supabase** under _Databases and storage_. Lotse then creates the database there when you publish and passes its address to the app. See [Databases and backups](../publish/databases).

## Which one to pick

- **A website or single-page app without a backend:** any provider. GitHub Pages and Cloudflare are free for most uses; your own server costs a few euros a month and hosts many apps.
- **A Node.js app:** Vercel or Netlify for the least effort, your own server for full control.
- **A Python, Go or PHP app, or anything with a database:** your own server, Hetzner Cloud, Railway, Coolify or Dokploy.
- **You already run Coolify or Dokploy:** connect it; Lotse uses it like any other provider.
- **You want your data in the EU:** your own server or Hetzner Cloud in a European location.

You can publish the same app to several providers, and move it later: the app's `lotse.yaml` is the same for all of them.

## Notes per provider

**Vercel** — The token's scope decides which personal account or team owns the projects.

**Netlify** — A personal access token of the account that should own the sites.

**Cloudflare** — A custom API token with the permissions Lotse lists. If the token can reach several accounts, enter the account ID.

**Railway** — Sign in with Railway works without any setup. Otherwise use an account or workspace token; a project token is not enough, because Lotse creates the project.

**Fly.io** — An organization token from `fly.io/tokens/create`; a deploy token of one app is not enough.

**Hetzner Cloud** — A token with _Read & Write_ of the project that should contain the server. Lotse creates the server for you after you approve it (Hetzner bills it by the hour until you delete it), then sets it up like [your own server](./own-server).

**Coolify** — Enter your instance's address and a token with the permissions _read_, _write_ and _deploy_, not a root token. For server apps, Lotse builds a container image and Coolify needs a registry it can pull from.

**Dokploy** — Enter your instance's address and an API key of a user who may create projects.

**GitHub, GitLab, Forgejo / Codeberg** — See [Git platforms](../git/repository).
