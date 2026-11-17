# 9. Git platforms as a separate adapter type (D9)

Status: Accepted

## Context

Users keep their code on GitHub, GitLab or Forgejo, and some hosts have no Git integration of their own.

## Decision

`GitProvider` is a separate interface for code storage, CI secrets, generated push-to-deploy workflows, preview comments and Pages hosting. Lotse never overwrites commits made outside: it pulls before pushing and stops on conflicts.

## Consequences

Push-to-deploy works for every hosting target through the generated pipeline, which runs the Lotse CLI.
