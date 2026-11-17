# 13. Contract tests against recorded responses

Status: Accepted

## Context

The contract suite must run on every pull request without accounts at nine providers, but must still exercise each adapter's real request sequence.

## Decision

Each adapter has a cassette of request/response pairs per scenario (connect, verify, plan, deploy, failed deploy, status, logs, environment, domains, rollback, destroy; for Git: repositories, CI secrets, workflows, comments). A replay transport answers from the cassette and reports interactions that were never used. Cassettes record whether they were recorded live or written from the provider's API documentation; `LOTSE_RECORD=1` re-records them against a test account with secrets scrubbed.

## Consequences

Fast, deterministic tests. Cassettes written from documentation can be wrong where the documentation is; live tests (nightly) are what proves an adapter against the real service. As of version 0.1.0 all provider cassettes are written from documentation, see docs/implementation-status.md.
