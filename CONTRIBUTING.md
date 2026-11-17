# Contributing to Lotse

Thank you for helping. Lotse is built in the open, and contributions of every size are welcome: bug reports, fixes, adapters for new providers, stack templates, translations and documentation.

The project language is English throughout: code, comments, commit messages, issues, pull requests and documentation.

## Developer Certificate of Origin

Contributions are made under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). There is no Contributor License Agreement. By signing off a commit you certify that you wrote it or otherwise have the right to submit it under the project's license (Apache 2.0).

Sign off every commit:

```sh
git commit -s -m "Add rollback to the Fly.io adapter"
```

This adds a line `Signed-off-by: Your Name <you@example.com>` with the name and e-mail of your Git configuration. A check on every pull request verifies that all commits are signed off; dependency updates opened by Dependabot are exempt. To fix a missing sign-off on the last commit, run `git commit --amend -s`; for several commits, `git rebase --signoff main`.

## Getting started

```sh
pnpm install
pnpm build
pnpm test:unit && pnpm test:contract
pnpm lint            # pnpm format applies the formatting
```

See [docs/testing.md](docs/testing.md) for the other test levels and what they need.

## Pull requests

- Keep a pull request to one topic. Describe what changes for users and why.
- Add or update tests. Every adapter must pass the shared contract suite; changes to an adapter come with updated recorded responses (cassettes).
- Update the documentation and, for user-visible text, both the English and the German messages in `packages/ui/src/locales`.
- The user interface must stay usable with the keyboard and a screen reader (WCAG 2.2 AA).
- Never commit credentials, recorded responses with real tokens, or `.lotse/` state.

## Adapters

Adapters are regular npm packages named `lotse-adapter-<name>` or published in the `@lotseai/` scope. `lotse create adapter <name>` generates a package with the contract tests already wired up. [docs/adapters.md](docs/adapters.md) explains the interface, recorded responses and live tests.

Every adapter in this repository has at least one named maintainer, listed in [.github/CODEOWNERS](.github/CODEOWNERS). Maintainers review changes to their adapter and receive the automatic issue when its live tests fail two nights in a row. To add an adapter here, you commit to maintaining it.

## Architecture decisions

Decisions that shape the project are documented as ADRs in [docs/adr](docs/adr). Changing one of the fixed decisions D1 to D11 of the specification requires a new ADR that supersedes the old one, discussed in a pull request before the implementation.

## Versioning and releases

Releases follow [Semantic Versioning](https://semver.org/).

- Core, CLI and builder (server, user interface, desktop app, sandbox, agent, stacks) are versioned together.
- Adapters are versioned independently. Each declares the adapter interface version it implements (`apiVersion`).
- The adapter interface itself follows Semantic Versioning: breaking changes only in a new major version, and anything removed is marked as deprecated at least one minor version in advance.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
