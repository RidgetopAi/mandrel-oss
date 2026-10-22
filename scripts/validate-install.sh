#!/usr/bin/env bash
# Mandrel install validator — checks a RUNNING container stack. Needs only the container
# runtime: everything is executed INSIDE the containers (no host psql, node, curl or redis-cli).
#
# Usage: ./scripts/validate-install.sh
# Exit codes: 0 all checks passed · 1 a check failed (including /health reporting mock embeddings)
#
# Tunables: MANDREL_RUNTIME (default docker) · MANDREL_PG_SERVICE / MANDREL_MCP_SERVICE /
# MANDREL_REDIS_SERVICE (compose service names) · MANDREL_HEALTH_URL (as seen INSIDE the mcp-server container)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
RUNTIME="${MANDREL_RUNTIME:-docker}"
PG_SERVICE="${MANDREL_PG_SERVICE:-postgres}"
MCP_SERVICE="${MANDREL_MCP_SERVICE:-mcp-server}"
REDIS_SERVICE="${MANDREL_REDIS_SERVICE:-redis}"
HEALTH_URL="${MANDREL_HEALTH_URL:-http://localhost:8080/health}"
EXTENSIONS=(vector pg_trgm pgcrypto uuid-ossp)

# DB identity comes from .env when present (compose reads the same file).
env_get() { [[ -f "$ROOT/.env" ]] && grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2-; }
PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-mandrel}"
PG_DB="$(env_get POSTGRES_DB)"; PG_DB="${PG_DB:-mandrel}"

PASSED=0; FAILED=0
pass() { printf '[ok]   %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '[FAIL] %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       hint: %s\n' "$2"; FAILED=$((FAILED + 1)); }
dcx()  { "$RUNTIME" compose exec -T "$@"; }

echo; echo "Mandrel install validator"; echo "========================="

if command -v "$RUNTIME" >/dev/null 2>&1 && "$RUNTIME" compose version >/dev/null 2>&1; then
  pass "container runtime with compose ($RUNTIME)"
else
  fail "container runtime with compose not found ($RUNTIME)" "install Docker Engine or Docker Desktop: https://docs.docker.com/engine/install/"
  echo; echo "Result: $PASSED passed, $FAILED failed"; exit 1
fi

[[ -f "$ROOT/.env" ]] && pass ".env exists" || fail ".env not found" "run ./install.sh"
if [[ -n "$(env_get MCP_AUTH_TOKEN)" ]]; then pass "MCP_AUTH_TOKEN is set"; else fail "MCP_AUTH_TOKEN is empty" "run ./install.sh"; fi

if dcx "$PG_SERVICE" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
  pass "PostgreSQL accepts connections (inside $PG_SERVICE)"
  for ext in "${EXTENSIONS[@]}"; do
    got="$(dcx "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -tA -c "SELECT 1 FROM pg_extension WHERE extname = '$ext';" 2>/dev/null | tr -d '[:space:]')"
    [[ "$got" == "1" ]] && pass "extension $ext installed" || fail "extension $ext not installed" "$RUNTIME compose logs $MCP_SERVICE (migrations create it)"
  done
else
  fail "PostgreSQL is not accepting connections" "$RUNTIME compose logs $PG_SERVICE"
fi

if [[ "$(dcx "$REDIS_SERVICE" redis-cli ping 2>/dev/null | tr -d '[:space:]')" == "PONG" ]]; then
  pass "Redis answers PING (inside $REDIS_SERVICE)"
else
  fail "Redis did not answer PING" "$RUNTIME compose logs $REDIS_SERVICE"
fi

body="$(dcx "$MCP_SERVICE" wget -qO- "$HEALTH_URL" 2>/dev/null)"
if [[ -z "$body" ]]; then
  fail "MCP server /health did not respond" "$RUNTIME compose logs $MCP_SERVICE"
elif ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"' <<<"$body"; then
  fail "MCP server /health is not healthy: $body" "$RUNTIME compose logs $MCP_SERVICE"
else
  pass "MCP server /health reports healthy"
  mode="$(grep -oE '"embeddings"[[:space:]]*:[[:space:]]*"[a-z]+"' <<<"$body" | sed -E 's/.*:[[:space:]]*"([a-z]+)"/\1/')"
  case "$mode" in
    real) pass "embeddings are real" ;;
    mock) fail "server reports MOCK embeddings — search results would be meaningless" "check MANDREL_EMBEDDER and the model cache; remove MANDREL_EMBEDDINGS_ALLOW_MOCK; $RUNTIME compose logs $MCP_SERVICE" ;;
    *)    fail "/health does not report an embeddings mode (got: '${mode:-none}')" "the server image may be out of date: $RUNTIME compose up -d --build" ;;
  esac
fi

echo; echo "Result: $PASSED passed, $FAILED failed"
(( FAILED == 0 )) && { echo "All checks passed."; exit 0; }
echo "Some checks failed."; exit 1
