# Connecting accounts

Before you can publish, connect the places your apps should go. Open **Providers**. It lists everything Lotse supports in three groups — **Hosting**, **Git platforms** and **Databases and storage** — and, at the top, what you have connected. Each connected account shows who may use it (**Only me** or **Whole team**), and providers you have already connected are marked as connected in the list below.

## Sign in

Choose **Connect** next to a provider. Depending on the provider and your installation, you sign in in one of three ways.

### Continue at the provider (OAuth)

If your installation has an OAuth app for the provider (or the provider registers one automatically, as Railway does), the dialog offers **Continue at …**. The provider's page asks you to approve access; afterwards you return to Lotse and the account is connected. In the desktop app, the provider's page opens in your normal browser; come back to Lotse when you are done there.

Administrators set up OAuth apps once for an installation: see [OAuth apps and the GitHub App](../admin/provider-sign-in).

### API token

Without OAuth, the dialog guides you through creating a token at the provider:

1. Choose **Open the token page**. For self-hosted tools such as Coolify, Dokploy, GitLab or Forgejo, first enter the address of your instance.
2. Create a token with the permissions listed under **Required permissions**. Choose them exactly; more is not needed.
3. Copy the token into **Token** and choose **Connect**.

Lotse checks the token right away. If permissions are missing, it says which; the account is still connected, but publishing may fail until you create a token with the missing permissions.

### SSH key (your own server)

See [Your own server](./own-server).

## Name and who may use it

- **Name** tells accounts apart, e.g. _Production_ and _Testing_.
- **Who may use it** (web app): **Only me**, or **Whole team**. Team members can publish with a team account without ever seeing its credentials. Only Owners and Admins can connect team accounts.

## What is stored

Credentials are encrypted (AES-256-GCM) as soon as they arrive, and are never shown again, never written to logs and never given to the language model. Tokens that expire are refreshed automatically; if that fails, Lotse asks you to sign in again.

## Remove an account

Choose **Remove** next to the account. Its credentials are deleted. Apps already published with it keep running at the provider; to change them later, connect an account again.
