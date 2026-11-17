# 17. OAuth clients come from a chain of sources

Status: Accepted

## Context

OAuth clients can come from the operator, from dynamic registration, or later from a project-run broker.

## Decision

The core resolves an OAuth client through an ordered list of sources (operator environment variables first, then RFC 7591 dynamic registration with the registered client cached in the credential store). Sign-in flows use PKCE and loopback redirects (RFC 8252) for the CLI and the desktop app.

## Consequences

A broker becomes one more source. When no source has a client, the user interface shows the token setup without an error.
