# 6. Docker-based sandbox for previews (D6)

Status: Accepted

## Context

Generated code must run somewhere to be previewed and checked, in any of the supported languages, without endangering the host.

## Decision

Each project gets its own container from the Docker Engine API, which Docker, Podman, OrbStack and Colima all serve. Details of the isolation are in ADR 0014.

## Consequences

Any language with a container image works. A container runtime is a requirement on the desktop; Podman is supported as an equal alternative to Docker Desktop because of its licensing.
