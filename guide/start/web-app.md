# Web app for teams

The web app is the builder on a server for several people. Compared with the desktop app it adds:

- **Sign-in** with your organization's identity provider (OpenID Connect: Keycloak, Authentik, Entra ID, Google Workspace, …).
- **Roles:** the first person to sign in becomes _Owner_. Owners and _Admins_ manage people, settings and the audit log; _Members_ see their own projects.
- **Team accounts:** a provider account connected for the whole team can be used by every member to publish, without anyone seeing its credentials.
- **An audit log** of sign-ins, deployments and changes to credentials.
- **PostgreSQL** as the database.

It runs as a container next to Docker or Podman, which runs the sandboxes. Installing it takes about half an hour if you have a server, a domain and an identity provider: see [Installing the web app](../admin/install).

Once it runs, everyone uses it in the browser exactly as described in this handbook; the desktop app and the web app look and work the same.
