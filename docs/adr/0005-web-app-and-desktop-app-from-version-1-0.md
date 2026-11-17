# 5. Web app and desktop app from version 1.0 (D5)

Status: Accepted

## Context

Teams want a shared instance with sign-in and roles; individuals want something they install and that keeps data on their machine.

## Decision

The builder ships as a web app (Docker image, PostgreSQL, OpenID Connect, roles Owner/Admin/Member) and as a desktop app (Electron, SQLite, single user). Both run the same server and the same user interface; the desktop app starts the server locally inside Electron.

## Consequences

One code base for both. The desktop app needs its own protections for a builder without sign-in, see ADR 0018.
