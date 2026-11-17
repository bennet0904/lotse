# 8. Nine hosting providers in version 1 (D8)

Status: Accepted

## Context

Users want both convenient platforms and control over their own infrastructure.

## Decision

Version 1 ships adapters for Vercel, own server over SSH and Coolify (first wave) and Netlify, Cloudflare, Railway, Fly.io, Hetzner Cloud and Dokploy (second wave), behind one `HostingAdapter` interface with declared capabilities. Where a host lacks a resource, an external provider (Neon, Supabase) supplies it.

## Consequences

A large adapter surface; every adapter must pass the shared contract suite on every pull request and live tests nightly, and has a named maintainer.
