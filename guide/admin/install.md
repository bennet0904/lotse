# Installing the web app

The web app is the builder for teams: several people, roles, sign-in with your identity provider, PostgreSQL. It runs as a container on a Linux server, next to the container engine that runs the sandboxes.

## What you need

- **A Linux server** with Docker Engine (or Podman with its Docker-compatible socket). Plan about 1 GB of memory for Lotse itself and 2 CPU cores and 2 GB of memory for each sandbox running at the same time.
- **Two DNS names** pointing to the server: one for the builder, e.g. `lotse.example.com`, and a wildcard for previews, e.g. `*.preview.lotse.example.com`.
- **An identity provider** that speaks OpenID Connect: Keycloak, Authentik, Microsoft Entra ID, Google Workspace, …
- **A reverse proxy** that terminates HTTPS for both names. The example below uses Caddy.
- **A language model**: an API key, or a model server such as Ollama that the server can reach.

## 1. Register Lotse at your identity provider

Create an OpenID Connect client (a "confidential" web application) with

- redirect URI `https://lotse.example.com/api/v1/auth/callback`,
- scopes `openid`, `email`, `profile`.

Note the issuer URL, the client ID and the client secret.

## 2. Configure

```sh
git clone https://github.com/bennet0904/lotse.git
cd lotse/deploy
cp .env.example .env
```

Fill in `.env`:

| Setting                                                                 | Value                                                                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LOTSE_PUBLIC_URL`                                                      | `https://lotse.example.com`                                                                                                         |
| `LOTSE_PREVIEW_DOMAIN`                                                  | `preview.lotse.example.com`                                                                                                         |
| `LOTSE_MASTER_KEY`                                                      | A new key from `npx @lotseai/cli secrets generate-key`. **Keep a copy somewhere safe**: without it, stored accounts cannot be read. |
| `POSTGRES_PASSWORD`                                                     | A long random password                                                                                                              |
| `LOTSE_OIDC_ISSUER`, `LOTSE_OIDC_CLIENT_ID`, `LOTSE_OIDC_CLIENT_SECRET` | From step 1                                                                                                                         |
| `DOCKER_GID`                                                            | The group of the Docker socket: `stat -c %g /var/run/docker.sock`                                                                   |
| `ANTHROPIC_API_KEY` (optional)                                          | Or set up models later under **Settings → Language models**                                                                         |

All further settings are in the [configuration reference](./configuration).

## 3. Start

```sh
sudo install -d -o 1000 -g 1000 /srv/lotse     # projects and sandbox caches
docker compose up -d
docker compose logs -f lotse                   # wait for "Lotse is running at …"
```

Lotse listens on `127.0.0.1:4780`; the database runs in its own container.

## 4. Reverse proxy

The proxy forwards both the builder's name and every preview name to `127.0.0.1:4780`, keeps the `Host` header and passes WebSockets through (Caddy does both by default). The wildcard certificate for previews needs a DNS challenge, i.e. a Caddy build with your DNS provider's plugin:

```
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

Preview addresses contain a token derived from a secret of the installation, so they cannot be guessed. They are not protected by sign-in, so previews can be shared with people who have no account.

## 5. First sign-in

Open `https://lotse.example.com` and sign in. **The first person to sign in becomes the Owner**, so do this yourself right away. Then:

1. **Settings → Language models**: set up a model, if not done in `.env`.
2. **Providers**: connect the hosting accounts the team should use, as _Whole team_.
3. Optionally, **Settings → GitHub App** and OAuth apps, so people can sign in to providers with one click: see [OAuth apps and the GitHub App](./provider-sign-in).
4. Invite your colleagues: they sign in with the identity provider and start as Members. See [People and sign-in](./people).

## About the sandboxes

- The builder starts a container per project through the Docker socket mounted into its container. **Whoever controls this socket controls the host.** Run Lotse on a server that runs nothing else, and prefer a rootless Docker or Podman socket (`LOTSE_ENGINE_SOCKET` in `.env`).
- The data folder is mounted at the same path inside and outside the container (`/srv/lotse`), because sandboxes mount project folders by their path on the host.
- The builder's container uses the host network, because the sandbox gateway publishes previews on the host's loopback address only.
- For stronger isolation, install [gVisor](https://gvisor.dev/docs/user_guide/install/) and set `LOTSE_SANDBOX_RUNTIME=runsc`.
- Sandboxes reach only package registries (npm, PyPI, the Go proxy, Packagist). Allow more with `LOTSE_SANDBOX_ALLOWED_HOSTS`.
