# 14. Sandbox isolation through a gateway container

Status: Accepted

## Context

Sandboxes need package registries but must not reach anything else, and the builder must reach the preview without exposing it to the network.

## Decision

Every project runs in its own container on its own internal network without a route outside. A gateway container is attached to every sandbox network: its egress side is an HTTP proxy that only connects to allow-listed hosts (by default the package registries); its ingress side forwards preview requests from the builder, keyed with a secret only the builder knows, and is published on 127.0.0.1 only. Sandboxes run as an unprivileged user with all capabilities dropped, `no-new-privileges`, limits of 2 CPUs, 2 GB memory and 512 processes, and see only their own project and cache directories. gVisor can be selected as runtime. On rootless engines the sandbox user is mapped so that it can write the project directory (Podman `keep-id`).

## Consequences

Works the same on Docker and Podman. The gateway resolves names itself because Podman gives each network its own resolver.
