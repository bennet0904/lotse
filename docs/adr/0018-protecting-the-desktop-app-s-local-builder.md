# 18. Protecting the desktop app's local builder

Status: Accepted

## Context

Without sign-in, the desktop app's builder would answer to any program or web page that can reach its port on this computer, and it holds the user's provider credentials.

## Decision

The desktop app generates a random local access token at every start and puts it into an HttpOnly, SameSite=Strict cookie of its own window; the server refuses API and WebSocket requests without it. The server listens on 127.0.0.1 only and refuses requests under host names other than its own (against DNS rebinding). Provider sign-ins open in the system browser; the OAuth callback is tied to the sign-in attempt by its unguessable `state` and needs no cookie. The window may only navigate within the builder; previews open in app windows, other web addresses in the system browser, everything else is refused. The master key is kept encrypted by the operating system's keychain through Electron's `safeStorage`; where Linux has no keyring, it falls back to the Secret Service tool and then to a file only the user can read, with a warning.

## Consequences

Other users and web pages cannot use the local builder. Programs running as the same user can still read the user's files, which is outside the threat model of a desktop application.
