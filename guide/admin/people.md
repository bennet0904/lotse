# People and sign-in

In the web app, people sign in with your organization's identity provider (OpenID Connect). There are no separate Lotse passwords.

## Roles

| Role       | Can                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Everything, including making others Owner. The first person to sign in becomes Owner.                                                   |
| **Admin**  | Manage people (except Owners), settings, the GitHub App and language models; connect team accounts; see all projects and the audit log. |
| **Member** | Build and publish their own projects, connect personal accounts, publish with team accounts.                                            |

New people start as Members. Owners and Admins change roles under **Settings → People**.

## Team accounts

Provider accounts connected with **Who may use it: Whole team** can be used by everyone to publish, but nobody sees their credentials, and only Owners and Admins can connect or remove them. Personal accounts are visible and usable only by their owner.

## Removing someone

Remove the person at your identity provider; they can no longer sign in. Their projects stay, and Owners and Admins can still open them.

## Audit log

**Settings → Audit log** lists sign-ins, deployments, removals, domain changes, backup restores, changes to accounts, secrets and language-model settings, and the registration of the GitHub App — with time, person, target and IP address. It is visible to Owners and Admins.

## Single-user installations

Without `LOTSE_AUTH=oidc`, the builder has one user and no sign-in, like the desktop app. Use this only on your own computer: such a builder answers only to requests for its own address.
