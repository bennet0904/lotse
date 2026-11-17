# 0. Record architecture decisions

Status: Accepted

## Context

Lotse makes decisions that are expensive to reverse: which languages it is written in, how adapters talk to the core, where credentials live. Contributors need to find out why things are the way they are, and the specification requires that changes to its fixed decisions go through a record in the repository.

## Decision

Every decision that shapes the project is written down as an Architecture Decision Record in `docs/adr`, numbered in order, in the format of this file: context, decision, consequences. A record is never edited to change its meaning; a new record supersedes it and both link to each other. Records 0001 to 0011 restate the fixed decisions D1 to D11 of the specification; later records cover decisions made during the implementation.

## Consequences

Changing a fixed decision starts with a pull request that adds a superseding record and is discussed before any code changes.
