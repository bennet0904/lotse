# Security

Lotse holds credentials for your providers and servers and runs code written by a language model. This page explains how it protects them, and what you should do as an administrator.

## Credentials

- All provider accounts, secrets of apps, database addresses and model keys are encrypted with AES-256-GCM before they are stored.
- The **master key** that encrypts them comes from `LOTSE_MASTER_KEY`, from HashiCorp Vault or OpenBao, or (desktop app) from the operating system's keychain. It is never stored in the database. **Keep a copy of it outside the server.** Without it, stored credentials cannot be read; with it and a copy of the database, they can.
- Credentials are never shown in the user interface again, never written to logs, and never given to the language model. Logs and error messages are scrubbed of known secrets before anyone sees them.

## The language model

- It works only inside a project's sandbox and only on that project.
- It cannot publish, remove apps, set up servers or change domains. Those actions need a person to confirm them; the model can only propose them.
- Content from files, packages and web pages is treated as data, not as instructions.

## Sandboxes

- Each project runs in its own container, as an unprivileged user, with all capabilities dropped, limits of 2 CPU cores, 2 GB memory and 512 processes, and access only to its own project folder.
- Sandboxes have no route to the internet, the host, the builder's database or other projects. They reach only allow-listed package registries, through a gateway.
- Previews are served through the same gateway, keyed with a secret only the builder knows.
- Optionally, gVisor isolates sandboxes further from the host kernel (`LOTSE_SANDBOX_RUNTIME=runsc`).

## Your checklist

- Run the web app on a dedicated server, behind HTTPS.
- Keep a copy of the master key and of the database backups in a safe place.
- Give Owner and Admin roles sparingly; review the audit log from time to time.
- Prefer team accounts with the minimum permissions Lotse lists, and tokens with an expiration date.
- Keep Lotse updated ([Updates and backups](./maintenance)).

## Reporting a vulnerability

Please report vulnerabilities privately as described in the [security policy](https://github.com/bennet0904/lotse/security/policy). We respond within 7 days.
