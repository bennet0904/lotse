# Troubleshooting

## "A container runtime is needed to run and preview apps"

No container runtime is running. Install and start one as described for the [desktop app](../start/desktop#a-container-runtime). If it is installed but not running, start it (Podman: `podman machine start`, or start Podman Desktop) and enable its Docker-compatible socket. Lotse finds it on the next action.

## The plan or build fails right away with an error about the model

- **"… API key …" or "401":** no key or a wrong key for the model's provider. Check **Settings → Language models**.
- **A local model does not answer:** check that Ollama or LM Studio is running and that the model named in the settings is downloaded (`ollama list`). In the web app, the address must be reachable from the server.
- **"… is not a model name":** write models as `provider:model`, e.g. `ollama:qwen3-coder`.

## The app still has errors after the automatic corrections

Lotse tried to fix the errors three times. Ask it to fix them again, describe what you see, or restore the last working version under **Versions** and describe the change in smaller steps. Some models handle certain stacks better than others; a more capable model often solves it.

## The preview does not appear

- **"The app is starting":** the app has not answered yet. Large apps take a while to install the first time; the page reloads by itself.
- **"The preview is not running":** the sandbox was paused or stopped. Open the project; it starts again.
- **The preview stays empty or shows an error page:** the app itself has an error. Ask the model to look at the error, e.g. _"The preview shows a blank page."_
- **Web app:** the preview domain needs a wildcard DNS record and certificate; see [Installing the web app](../admin/install#_4-reverse-proxy).

## Installing packages fails in the sandbox

Sandboxes can reach only package registries (npm, PyPI, the Go proxy, Packagist). Packages downloaded from elsewhere, e.g. directly from GitHub, are blocked. Ask the model to use a package from a registry instead, or (web app) allow the host with `LOTSE_SANDBOX_ALLOWED_HOSTS`.

## Connecting a provider fails

- **"did not accept the token" / 401:** the token is wrong, expired or was revoked. Create a new one.
- **"Missing for deployments":** the token lacks permissions; create one with exactly those listed.
- **No "Continue at …" button:** the installation has no OAuth app for this provider. Use a token, or ask your administrator ([OAuth apps](../admin/provider-sign-in)).
- **"sign in again":** a stored sign-in expired and could not be refreshed. Remove the account and connect it again.

## Publishing fails

- **"… does not support …" in the plan:** the provider cannot run this kind of app (e.g. Python on Netlify) or lacks a database. The plan lists providers that can; for databases, connect [Neon or Supabase](../publish/databases).
- **"The new version did not answer":** the app started at the provider but its health check failed; the previous version keeps running. Open **Logs** to see why. Common causes: the app listens on a fixed port instead of `PORT`, a secret has no value, the database is not reachable yet.
- **Building fails:** the error is shown in **Progress → Details**. Ask the model to fix the build.
- **Secret missing:** enter its value when publishing, or under **Secrets**.

## My own server

- **Cannot connect:** check the address, user and port; that port 22 is reachable; and that the public key is in `~/.ssh/authorized_keys` of that user (or enter the password once).
- **"The host key changed":** the server is not the one Lotse knows, e.g. after reinstalling it. If you reinstalled it, remove the account and connect it again. If not, someone may be intercepting the connection; do not continue.
- **Setup skips steps:** the system is not Ubuntu 24.04+ or Debian 12+. Docker must be installed by hand there.
- **The app's address does not work:** the sslip.io address needs port 80 open. For your own domains, check the DNS records with `dig +short app.example.com`.

## Credentials cannot be read after a reinstall or move

The master key changed. Restore the old `LOTSE_MASTER_KEY` (web app), or, in the desktop app after moving to a new computer, connect the accounts again.

## "Credentials are not protected by a keychain" (Linux desktop)

No keyring was found, so the key is kept in a file only your user can read. Install and unlock GNOME Keyring or KWallet to keep it in the keychain instead.

## The app is not signed (macOS, Windows)

Pre-release builds are not signed yet; see [how to open them](../start/desktop#install).
