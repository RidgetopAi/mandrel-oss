#!/usr/bin/env bash
# compose-fresh-clone.test.sh — static half of "docker compose works from a fresh clone":
#   1. every variable the compose file interpolates in a required form (${VAR:?..} / ${VAR?..})
#      has a `VAR=` line in .env.example; .env.example has POSTGRES_PASSWORD, MCP_AUTH_TOKEN,
#      MANDREL_EMBEDDER=minilm.
#   2. every service other than postgres/redis has a `build:` whose Dockerfile exists, and the
#      postgres image tag is an exact version (not latest, not empty).
# Overridable for mutation probes: COMPOSE_FILE, ENV_EXAMPLE.
# Exit 0 = pass, 1 = fail.
#
# USAGE:  bash scripts/test/compose-fresh-clone.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-$REPO_DIR/docker-compose.yml}"
ENVEX="${ENV_EXAMPLE:-$REPO_DIR/.env.example}"
BASE_SERVICES_RE='^(postgres|redis)$'

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }

[[ -f "$COMPOSE" && -f "$ENVEX" ]] || { bad "missing compose or env example"; exit 1; }

echo "== 1. .env.example covers every required variable =="
mapfile -t required < <(grep -v '^\s*#' "$COMPOSE" | grep -oE '\$\{[A-Za-z_][A-Za-z_0-9]*:?\?' | sed -E 's/^\$\{//; s/:?\?$//' | sort -u)
[[ ${#required[@]} -gt 0 ]] || bad "no required-form variables found (parser broken?)"
for v in "${required[@]}"; do
  if grep -qE "^${v}=" "$ENVEX"; then ok "required $v has a line in .env.example"; else bad "required $v is missing from .env.example"; fi
done
for v in POSTGRES_PASSWORD MCP_AUTH_TOKEN; do
  if grep -qE "^${v}=" "$ENVEX"; then ok "$v present"; else bad "$v missing from .env.example"; fi
done
if grep -qE '^MANDREL_EMBEDDER=minilm[[:space:]]*$' "$ENVEX"; then ok "MANDREL_EMBEDDER=minilm"; else bad "MANDREL_EMBEDDER=minilm missing"; fi

echo "== 2. services build locally; postgres is pinned =="
# Emit "<service>\t<has_build>\t<context>\t<dockerfile>" per service, from the 2-space-indented keys.
rows="$(awk '
  /^services:/ {ins=1; next}
  ins && /^[^ #]/ {ins=0}
  ins && /^  [A-Za-z0-9_-]+:[ ]*$/ { if (svc) print svc "\t" b "\t" c "\t" d; svc=$1; sub(/:$/,"",svc); b=0; c="."; d="Dockerfile"; inb=0; next }
  ins && /^    build:/ { b=1; inb=1; v=$0; sub(/^    build:[ ]*/,"",v); if (v!="") {c=v; d="Dockerfile"; inb=0}; next }
  ins && inb && /^      context:/ { v=$0; sub(/^      context:[ ]*/,"",v); gsub(/["\047]/,"",v); c=v; next }
  ins && inb && /^      dockerfile:/ { v=$0; sub(/^      dockerfile:[ ]*/,"",v); gsub(/["\047]/,"",v); d=v; next }
  ins && inb && /^    [^ ]/ {inb=0}
  END { if (svc) print svc "\t" b "\t" c "\t" d }
' "$COMPOSE")"
apps=0
while IFS=$'\t' read -r svc hasb ctx df; do
  [[ -n "$svc" ]] || continue
  [[ "$svc" =~ $BASE_SERVICES_RE ]] && continue
  apps=$((apps + 1))
  if [[ "$hasb" != 1 ]]; then bad "$svc has no build: section"; continue; fi
  if [[ -f "$REPO_DIR/$ctx/$df" ]]; then ok "$svc builds from $ctx/$df (exists)"; else bad "$svc Dockerfile missing: $ctx/$df"; fi
done <<< "$rows"
[[ $apps -gt 0 ]] || bad "no application services found"

pg_image="$(awk '/^  postgres:/ {p=1; next} p && /^  [A-Za-z0-9_-]+:/ {p=0} p && /^    image:/ {sub(/^    image:[ ]*/,""); gsub(/["\047]/,""); print; exit}' "$COMPOSE")"
tag="${pg_image#*:}"
if [[ -z "$pg_image" || "$pg_image" != *:* || -z "$tag" || "$tag" == latest ]]; then
  bad "postgres image not pinned to an exact version (got '${pg_image}')"
elif [[ "$tag" =~ [0-9]+\.[0-9]+ ]]; then ok "postgres image pinned: $pg_image"
else bad "postgres tag '$tag' is not an exact version"; fi

echo "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
