# 15. One schema for SQLite and PostgreSQL

Status: Accepted

## Context

The web app uses PostgreSQL, the desktop app and single-user installations SQLite, and both must stay in sync.

## Decision

The Drizzle schema is defined once and instantiated for both dialects; migrations are portable SQL applied by the server at start. Numbers are stored as BIGINT and read as JavaScript numbers.

## Consequences

Every database test runs against SQLite (both drivers) and PostgreSQL.
