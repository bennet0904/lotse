# 7. Several languages from the start (D7)

Status: Accepted

## Context

Many apps people want are not JavaScript apps, and many hosting targets run containers anyway.

## Decision

Version 1.0 ships stack templates for a static site, React + Vite, Next.js and Hono, and, labelled beta, FastAPI, Django, Go `net/http` and Laravel. Templates are strict: they fix the layout and the commands, and the model fills in the app. Stacks are packages, so the community can add more.

## Consequences

Each stack must pass the sandbox test (scaffold, install, check, preview, production build) before its beta label is removed.
