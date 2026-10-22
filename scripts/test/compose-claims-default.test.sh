#!/usr/bin/env bash
# the main compose file's mcp-server defaults MANDREL_TASK_CLAIM_ENABLED to true
# (the reference loop requires claims) and stays overridable from .env.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/docker-compose.yml"

line="$(grep -E '^[[:space:]]*MANDREL_TASK_CLAIM_ENABLED:' "$COMPOSE" || true)"
[ "$(printf '%s\n' "$line" | grep -c .)" = 1 ] || { echo "FAIL: expected exactly one MANDREL_TASK_CLAIM_ENABLED declaration in docker-compose.yml, got: $line"; exit 1; }
case "$line" in
  *'${MANDREL_TASK_CLAIM_ENABLED:-true}'*) ;;
  *) echo "FAIL: MANDREL_TASK_CLAIM_ENABLED must be \${MANDREL_TASK_CLAIM_ENABLED:-true} (default on, .env-overridable); got: $line"; exit 1 ;;
esac
# It must sit inside the mcp-server service.
svc="$(awk '/^  [A-Za-z0-9_-]+:[[:space:]]*$/ {s=$1} /MANDREL_TASK_CLAIM_ENABLED:/ {print s; exit}' "$COMPOSE")"
[ "$svc" = "mcp-server:" ] || { echo "FAIL: declaration is under service '$svc', not mcp-server"; exit 1; }
echo "PASS: mcp-server defaults MANDREL_TASK_CLAIM_ENABLED to true, overridable from .env"
