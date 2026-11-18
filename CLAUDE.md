# Working on Lotse

Lotse turns a prompt into a running app and deploys it to many providers. This file is read by Claude when it works on issues and pull requests of this repository.

## Layout

- `packages/core` — manifest (`lotse.yaml`), adapter interfaces (`src/types.ts`), deployment engine, sign-in, Git and CI helpers.
- `packages/adapter-*` — one package per provider; `packages/adapters` lists the built-in ones. `packages/adapter-testkit` has the contract suite, the replay of recorded API responses (cassettes) and live-test helpers.
- `packages/cli` — the `lotse` command. `packages/server` — HTTP/WebSocket API, jobs, SQLite/PostgreSQL. `packages/ui` — React user interface. `packages/desktop` — Electron shell.
- `packages/agent`, `packages/sandbox`, `packages/stacks` — the builder: model pipeline, container per project, app templates.
- `guide/` — the user handbook (VitePress), published on GitHub Pages. `docs/` — developer documentation and ADRs (`docs/adr`).

## Commands

```sh
pnpm install && pnpm build    # TypeScript project references and the UI
pnpm lint                     # Biome; `pnpm format` applies fixes
pnpm typecheck                # packages, tests and the UI
pnpm test:unit                # fast, no network
pnpm test:contract            # every adapter against its cassette
pnpm test:integration         # needs Docker; slower
pnpm --filter @lotseai/guide build   # the handbook; fails on dead links
```

Before opening a pull request, run at least `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` and `pnpm test:contract`, and say in the pull request which tests you ran and what you could not run (live tests need provider accounts; SSH and end-to-end tests need a test server).

## Rules

- **English** in code, comments, commits, issues and documentation. User-visible text in the UI goes into both `packages/ui/src/locales/en.ts` and `de.ts` (informal German, "du").
- **Tests with every change.** Adapters must keep passing the contract suite; changes to how an adapter talks to its API come with updated cassettes. Never put real tokens into cassettes or tests.
- **Credentials never leak.** They stay in the core, encrypted. Never log them, never put them into events, errors, metadata, the UI or the language model's context.
- **Critical actions need approval.** Publishing for the first time, deleting apps, setting up servers, changing domains and restoring backups must keep requiring explicit user confirmation.
- **The handbook follows the product.** When you change what users see or do, update the matching page in `guide/`. Do not document features that do not exist.
- **The adapter interface is versioned** (`ADAPTER_API_VERSION`). Breaking changes only in a new major version, deprecated at least one minor version earlier.
- **Match the surrounding code** in naming, comments and structure. Prefer small, focused pull requests; one issue, one pull request.
- **Dependencies:** add them only when needed, with exact reasons, and keep Node.js 22 as the lowest supported version.
- **Decisions** that change the architecture or one of the fixed decisions D1–D11 need an ADR in `docs/adr` first; propose it in the pull request instead of implementing it silently.

## When something is unclear

Ask in the issue instead of guessing, especially about provider behavior that the documentation does not settle. Implementation status, including what is not yet verified against real services, is in `docs/implementation-status.md`.
