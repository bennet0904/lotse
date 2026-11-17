# 12. Adapter references carry their connection

Status: Accepted

## Context

The specification's interface signatures (`status(app)`, `logs(app)`, `setEnv(app, vars)`, `setCiSecret(repo, name, value)`) do not pass credentials, yet every one of these calls needs them.

## Decision

`AppRef` and `RepoRef` carry the `Connection` they were obtained with. A `Connection` is plain data: `credentials` (secret) and `settings` (not secret). When references are persisted, the connection is stripped and restored from the credential store when they are loaded.

## Consequences

The signatures stay as specified, adapters stay stateless, and credentials never end up in the state files or the database outside the encrypted store.
