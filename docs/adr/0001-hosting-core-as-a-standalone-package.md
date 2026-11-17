# 1. Hosting core as a standalone package (D1)

Status: Accepted

## Context

Prompt-to-app builders come and go. The part that is hard to get right, and useful on its own, is deploying an app reliably to many providers.

## Decision

The hosting core (`@lotse/core`, the adapters, `@lotse/build`, `@lotse/secrets`, `@lotse/cli`) is a standalone set of packages with no dependency on the builder. The builder (`@lotse/agent`, `@lotse/sandbox`, `@lotse/server`, `@lotse/ui`, `@lotse/desktop`) is built on top and uses the core like any other program would.

## Consequences

Other tools can use the core directly. The CLI is usable after phase 1 of the roadmap without the builder. The core's public API has to stay stable for outside users, so it follows Semantic Versioning.
