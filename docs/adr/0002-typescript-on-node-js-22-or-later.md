# 2. TypeScript on Node.js 22 or later (D2)

Status: Accepted

## Context

Provider SDKs, language-model libraries and user-interface frameworks all live in the JavaScript ecosystem, and so do most potential contributors.

## Decision

All packages are written in TypeScript with `strict` checking and run on Node.js 22 LTS or later. The repository is a pnpm workspace; packages are ES modules built with TypeScript project references.

## Consequences

One language from the CLI to the user interface. Native modules are avoided where possible (the SSH client is pure JavaScript; the desktop app uses Node.js's built-in SQLite, see ADR 0016).
