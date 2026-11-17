# Security policy

Lotse holds credentials for hosting providers, Git platforms and servers, and it runs code written by a language model. We take reports about its security seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report. If you cannot use GitHub, say so in a public issue _without any details_ and a maintainer will arrange another private channel.

Please include:

- the affected package and version (or commit),
- what an attacker can do, and under which conditions,
- steps to reproduce, ideally a minimal example,
- whether the issue is already known elsewhere.

## What happens next

- **Within 7 days** a maintainer confirms the report and gives a first assessment. This is a commitment, not a target.
- We keep you informed while we work on a fix, agree on a disclosure date with you, and credit you in the advisory unless you prefer otherwise.
- Fixes are released for the latest minor version. Security advisories are published through GitHub and listed in the release notes.

## Scope

In scope are all packages in this repository: the core, the CLI, the adapters, the builder (server, sandbox, agent, user interface) and the desktop app, including their default configuration.

Particularly relevant are:

- credentials leaving the credential store, appearing in logs, error messages, the language model's context or the user interface;
- a sandbox reaching the host, the builder's database, other projects, or network destinations outside its allow-list;
- the language model triggering a critical action (deleting an app, setting up a server, changing domains, a first deployment to a new target) without the user's approval;
- prompt injection through files, packages or web content that leads to any of the above;
- sign-in, session and access-control flaws in the web app; access to the desktop app's local builder from other users or web pages.

Out of scope are vulnerabilities in the hosting providers themselves, issues that need an already compromised host or user account, and denial of service by a signed-in user against their own instance.

## How Lotse protects you

The security model is described in section 13.2 of the specification and in [docs/adr](docs/adr). In short: credentials stay in the core and are encrypted with AES-256-GCM; logs are scrubbed before they reach the model; critical actions need explicit approval; generated code runs in an unprivileged container per project with no access to the host and only allow-listed network egress; the desktop app's local builder only answers to its own window.
