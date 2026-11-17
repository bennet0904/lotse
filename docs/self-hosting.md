# Running the web app

The web app is the builder for teams: several people, roles (Owner, Admin, Member), sign-in with OpenID Connect, PostgreSQL. It runs as one container next to a container engine that runs the sandboxes.

## Requirements

- A Linux server with Docker Engine (or Podman with its Docker-compatible socket). 2 CPU cores and 2 GB memory per concurrently running sandbox, plus about 1 GB for the builder.
- PostgreSQL 14 or later (the compose file brings one).
- An identity provider that speaks OpenID Connect (Keycloak, Authentik, Entra ID, Google Workspace, …).
- Two DNS names: one for the builder (e.g. `lotse.example.com`) and a wildcard for previews (e.g. `*.preview.lotse.example.com`).
- A reverse proxy that terminates TLS for both.

## Install

```sh
git clone https://github.com/lotse-dev/lotse && cd lotse/deploy
cp .env.example .env
# fill in LOTSE_PUBLIC_URL, LOTSE_PREVIEW_DOMAIN, LOTSE_MASTER_KEY, POSTGRES_PASSWORD,
# the LOTSE_OIDC_* values and a model key
sudo install -d -o 1000 -g 1000 /srv/lotse
docker compose up -d
```

Create the master key with `npx @lotse/cli secrets generate-key` and keep a copy outside the server: without it, stored credentials cannot be read. Alternatively keep it in HashiCorp Vault or OpenBao (`LOTSE_VAULT_*`, see [configuration.md](configuration.md)).

The first person who signs in becomes the owner. Owners and admins manage roles and see the audit log under **Settings**; members only see their own projects and personal accounts, and can deploy with team accounts without seeing their credentials.

## Reverse proxy

The builder listens on `127.0.0.1:4780`. It serves the builder at `LOTSE_PUBLIC_URL` and every preview at its own host name under `LOTSE_PREVIEW_DOMAIN`, so the proxy forwards both names to the same address and keeps the `Host` header. WebSockets must be passed through (job progress, hot reloading in previews).

With Caddy and a DNS provider plugin for the wildcard certificate:

```caddyfile
lotse.example.com {
	reverse_proxy 127.0.0.1:4780
}

*.preview.lotse.example.com {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:4780
}
```

Preview addresses contain a token derived from a secret of the installation, so they cannot be guessed; they are not protected by sign-in, so that previews can be shared.

## Sandboxes

Every project's sandbox is a container on the host's engine, started by the builder through the socket mounted into its container. Keep in mind:

- **The socket is powerful.** Whoever controls the Docker socket controls the host. The builder only creates containers and networks with its own prefix and label, but the socket itself is not restricted. Prefer a rootless Docker or Podman socket (`LOTSE_ENGINE_SOCKET` in the compose file) on a server that runs nothing else.
- **Same path inside and outside.** Sandboxes mount their project folder by its path on the host, so the data directory is mounted at the same path in the builder's container (`/srv/lotse` by default).
- **Host networking.** The sandbox gateway publishes previews on the host's loopback address only; the builder's container uses the host network to reach it.
- **gVisor.** For stronger isolation between sandboxes and the host, install [gVisor](https://gvisor.dev/docs/user_guide/install/) and set `LOTSE_SANDBOX_RUNTIME=runsc`.
- **Network egress** from sandboxes goes only to the package registries (npm, PyPI, Go proxy, Packagist and those a stack adds). Extend the list with `LOTSE_SANDBOX_ALLOWED_HOSTS`.

## Provider sign-in

Without further setup, users connect providers with the guided token setup. To offer "Continue at Vercel" and similar buttons, register OAuth apps for the installation, and register the installation's GitHub App under **Settings → GitHub App**. Both are described in [oauth.md](oauth.md).

## Updates and backups

- Update with `docker compose pull && docker compose up -d`. Database migrations run when the builder starts.
- Back up the PostgreSQL database, the data directory (`/srv/lotse`: project workspaces and their Git history) and the master key.
- Releases are signed. Verify an image before deploying it: `cosign verify ghcr.io/lotse-dev/lotse:<version> --certificate-identity-regexp 'https://github.com/lotse-dev/lotse/' --certificate-oidc-issuer https://token.actions.githubusercontent.com`.
