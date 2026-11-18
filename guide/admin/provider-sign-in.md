# OAuth apps and the GitHub App

This page is for the administrators of an installation. It explains how to offer "Continue at …" buttons for signing in to providers. How people connect accounts is described in [Connecting accounts](../providers/connecting).

Lotse signs in to a provider in one of three ways:

1. **OAuth 2.0** with PKCE, when the instance has an OAuth app for the provider. The user clicks "Continue at …" and approves access at the provider.
2. **API token** with a guided setup otherwise. Lotse links to the provider's token page, lists the exact permissions to choose and checks the token before storing it. This always works and is the default.
3. **SSH key** for your own servers. Lotse generates the key pair; you install the public key or enter the server's password once.

Credentials are stored encrypted (AES-256-GCM) and are never shown again, never logged and never given to the language model. OAuth tokens are refreshed before they expire; if a refresh fails, Lotse asks you to sign in again.

## Where OAuth apps come from

An OAuth app is registered once per installation, by its operator. Lotse looks for a client in this order:

1. **Environment variables** of the operator: `LOTSE_OAUTH_<PROVIDER>_CLIENT_ID` and `LOTSE_OAUTH_<PROVIDER>_CLIENT_SECRET`.
2. For GitHub, the installation's **GitHub App** (see below).
3. **Dynamic client registration** (RFC 7591) for providers that offer it: the installation registers itself on the first sign-in. Railway does this; nothing needs to be configured.

If no client is available, the user interface offers the token setup without showing an error.

### Redirect addresses

Register the redirect address that matches how Lotse is used:

| Used through | Redirect address                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app      | `<LOTSE_PUBLIC_URL>/api/v1/oauth/callback`, e.g. `https://lotse.example.com/api/v1/oauth/callback`                                                                              |
| Desktop app  | `http://localhost:4781/api/v1/oauth/callback` (4781 is the desktop app's default port, see `LOTSE_DESKTOP_PORT`)                                                                |
| CLI          | `http://127.0.0.1:<port>/oauth/callback`, a loopback address (RFC 8252). Most providers accept any port for loopback addresses; otherwise fix the port with `LOTSE_OAUTH_PORT`. |

## Providers

The variable prefix is `LOTSE_OAUTH_<PROVIDER>`, e.g. `LOTSE_OAUTH_VERCEL_CLIENT_ID`.

### Vercel

1. Open the Vercel dashboard, go to **Settings → Apps** of the team that should own the app and choose **Create** (Vercel's "Sign in with Vercel" apps).
2. Enter a name (e.g. "Lotse at Example Inc.") and add the redirect address from the table above.
3. Enable the scopes `openid`, `email`, `profile` and `offline_access` and the permissions to manage projects and deployments.
4. Copy the client ID and generate a client secret. Set `LOTSE_OAUTH_VERCEL_CLIENT_ID` and `LOTSE_OAUTH_VERCEL_CLIENT_SECRET`.

Token setup instead: [vercel.com/account/settings/tokens](https://vercel.com/account/settings/tokens), scoped to the account or team that should own the deployments.

### Netlify

1. Open **User settings → Applications → OAuth applications** at [app.netlify.com](https://app.netlify.com/user/applications) and choose **New OAuth app**.
2. Enter a name and the redirect address.
3. Set `LOTSE_OAUTH_NETLIFY_CLIENT_ID` and `LOTSE_OAUTH_NETLIFY_CLIENT_SECRET` from the app's client ID and secret.

Netlify OAuth tokens have the full access of the user; there are no scopes to choose.

### Cloudflare

Cloudflare offers OAuth only to approved partners. Most installations use the token setup: at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) create a custom token with the permissions Lotse lists (account settings read, Workers scripts edit, zone read for custom domains). If your organization has a Cloudflare OAuth client, set `LOTSE_OAUTH_CLOUDFLARE_CLIENT_ID` and `LOTSE_OAUTH_CLOUDFLARE_CLIENT_SECRET` and register the redirect address with Cloudflare.

### Railway

Nothing to do: Railway supports dynamic client registration, and each installation registers itself on the first sign-in. To use an OAuth app you created yourself at Railway (**Account settings → Developer → OAuth apps**), set `LOTSE_OAUTH_RAILWAY_CLIENT_ID` and `LOTSE_OAUTH_RAILWAY_CLIENT_SECRET`.

### Fly.io, Hetzner Cloud, Coolify, Dokploy

These providers have no OAuth for third-party apps. Lotse uses the token setup:

- **Fly.io**: an organization token from [fly.io/tokens/create](https://fly.io/tokens/create). A deploy token of a single app is not enough, because Lotse creates the app.
- **Hetzner Cloud**: in the project that should contain the server, **Security → API tokens**, with _Read & Write_.
- **Coolify**: on your instance, **Keys & Tokens → API tokens**, with `read`, `write` and `deploy`. Enter the instance's address as well.
- **Dokploy**: on your instance, **Settings → Profile → API keys**. Enter the instance's address as well.

### GitHub

GitHub sign-ins use the installation's **GitHub App**, not an OAuth app: users choose which repositories Lotse may access, and tokens are short-lived.

**Register the GitHub App with the manifest flow** (web app, as an Owner or Admin):

1. Open **Settings** in Lotse, section **GitHub App**. Optionally enter an organization to own the app.
2. Choose **Register at GitHub**. GitHub shows a form with the app's permissions and addresses already filled in; pick a name and confirm.
3. GitHub sends you back to Lotse, which stores the app's ID, private key, client secret and webhook secret in the encrypted store. Nothing is copied by hand.
4. Choose **Install the app** and select the accounts, organizations and repositories Lotse may use. People then connect GitHub on the providers page.

The app asks for: contents (read and write), metadata (read), workflows and Actions secrets (write, for push-to-deploy), pull requests (write, for preview comments), Pages (write, for GitHub Pages) and administration (write, to create repositories). Its webhook reports pushes made outside Lotse so that projects can pull them before the next change.

**Manual registration** (GitHub Enterprise accounts, where the manifest flow is not available; or GitHub Enterprise Server with `LOTSE_GITHUB_URL`):

1. Create a GitHub App in the enterprise or organization settings: homepage `<LOTSE_PUBLIC_URL>`, callback URL `<LOTSE_PUBLIC_URL>/api/v1/oauth/callback`, webhook URL `<LOTSE_PUBLIC_URL>/api/v1/git/github/webhook` with a random secret, the permissions listed above, and the events _push_ and _pull request_.
2. Set `LOTSE_OAUTH_GITHUB_CLIENT_ID` and `LOTSE_OAUTH_GITHUB_CLIENT_SECRET` from the app's client ID and a generated client secret.

Token setup instead: a fine-grained personal access token at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) with the repository permissions Lotse lists.

### GitLab

1. On gitlab.com or your instance, open **Preferences → Applications** (or a group's **Settings → Applications**) and add an application.
2. Enter the redirect address, keep **Confidential** checked and select the scope `api`.
3. Set `LOTSE_OAUTH_GITLAB_CLIENT_ID` and `LOTSE_OAUTH_GITLAB_CLIENT_SECRET`. For a self-managed instance also set `LOTSE_GITLAB_URL`.

### Forgejo, Gitea and Codeberg

1. On the instance, open **Settings → Applications → Manage OAuth2 applications** and create a confidential application with the redirect address.
2. Set `LOTSE_OAUTH_FORGEJO_CLIENT_ID` and `LOTSE_OAUTH_FORGEJO_CLIENT_SECRET`. For an instance other than Codeberg set `LOTSE_FORGEJO_URL`.

Lotse requests the scopes `write:repository`, `write:user` and `write:issue`.

### Neon

Neon issues OAuth clients to registered partner applications. If you have one, register the redirect address with Neon and set `LOTSE_OAUTH_NEON_CLIENT_ID` and `LOTSE_OAUTH_NEON_CLIENT_SECRET`; Lotse requests the project scopes and `offline_access`. Otherwise use an API key from [console.neon.tech/app/settings/api-keys](https://console.neon.tech/app/settings/api-keys).

### Supabase

1. In the Supabase dashboard, open the organization's **OAuth Apps** and add an application with the redirect address.
2. Grant it the scopes for projects (read and write), database (read) and organizations (read).
3. Set `LOTSE_OAUTH_SUPABASE_CLIENT_ID` and `LOTSE_OAUTH_SUPABASE_CLIENT_SECRET`.

Token setup instead: a personal access token from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

### Own server (SSH)

No OAuth. `lotse connect ssh --host <address>` (or **Providers → Own server** in the builder) generates an Ed25519 key pair. Install the public key in `~/.ssh/authorized_keys`, or enter the server's password once so Lotse installs it; the password is not stored. Lotse pins the server's host key on first contact and refuses to connect if it changes.
