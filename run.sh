#!/usr/bin/env bash
# One-command start for the Mohkam backend.
#
#   ./run.sh
#
# A failed or interrupted `docker compose up` can leave this project's network
# behind, still holding a subnet from Docker's address pool. On the next start
# that shows up as:
#
#   failed to create network ...: all predefined address pools have been fully subnetted
#
# This script clears ONLY this project's own leftover networks (never other
# projects') before starting, so that error can't recur. Everything else is a
# plain `docker compose up -d --build`.
set -euo pipefail

cd "$(dirname "$0")"

project="$(basename "$PWD" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"

echo "→ removing any leftover networks from a previous failed run of this project…"
# Match this project's compose networks by name prefix. `docker network rm`
# refuses to remove a network that is still in use, so in-use networks are safe.
for net in $(docker network ls --format '{{.Name}}' | grep -E "^${project}[_-]" || true); do
  if docker network rm "$net" >/dev/null 2>&1; then
    echo "  removed orphaned network: $net"
  fi
done

echo "→ starting the stack…"
docker compose up -d --build

echo
echo "✓ Mohkam backend is starting."
echo "  API:           http://localhost:${API_PORT:-9222}"
echo "  Health:        curl http://localhost:${API_PORT:-9222}/readyz"
echo "  MinIO console: http://localhost:${MINIO_CONSOLE_PORT:-9001}  (mohkam / mohkam_local_dev)"
