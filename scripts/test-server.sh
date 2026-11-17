#!/usr/bin/env bash
# Starts a throwaway "server" for the SSH adapter tests: a privileged container
# that behaves like a fresh Ubuntu or Debian VM (systemd, sshd, no Docker).
# Only resources named lotse-test* are created or removed.
#
#   scripts/test-server.sh up [ubuntu|debian]     prints the server's IP address
#   scripts/test-server.sh down [ubuntu|debian]
#   scripts/test-server.sh ip [ubuntu|debian]
set -euo pipefail
cmd="${1:-up}"
os="${2:-ubuntu}"
here="$(cd "$(dirname "$0")" && pwd)"
name="lotse-testserver-$os"
network="lotse-test"
case "$os" in
  ubuntu) base="ubuntu:24.04" ;;
  debian) base="debian:12" ;;
  *) echo "unknown system: $os" >&2; exit 2 ;;
esac

ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name"; }

case "$cmd" in
  up)
    docker network inspect "$network" >/dev/null 2>&1 || docker network create --subnet 10.213.7.0/24 --label dev.lotse.test=1 "$network" >/dev/null
    docker build -q --build-arg "BASE=$base" -t "lotse-testserver:$os" "$here/test-server" >/dev/null
    if ! docker inspect "$name" >/dev/null 2>&1; then
      docker run -d --name "$name" --hostname "lotse-test-$os" --privileged --cgroupns=private \
        --network "$network" --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec \
        --memory "${LOTSE_TEST_SERVER_MEMORY:-1536m}" --label dev.lotse.test=1 "lotse-testserver:$os" >/dev/null
    else
      docker start "$name" >/dev/null
    fi
    for _ in $(seq 1 60); do
      if docker exec "$name" bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' 2>/dev/null; then ip_of; exit 0; fi
      sleep 1
    done
    echo "the SSH server did not start" >&2
    docker logs --tail 20 "$name" >&2 || true
    exit 1
    ;;
  ip) ip_of ;;
  down)
    docker rm -f -v "$name" >/dev/null 2>&1 || true
    if [ -z "$(docker ps -aq --filter network="$network")" ]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
    ;;
  *) echo "usage: $0 up|down|ip [ubuntu|debian]" >&2; exit 2 ;;
esac
