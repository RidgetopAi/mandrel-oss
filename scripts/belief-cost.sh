#!/usr/bin/env bash
#
# belief-cost.sh — today's supersession spend, the daily cap, and whether the cap is reached.
#
# Runs the COMPILED cost rollup (mcp-server/dist/cli/beliefCostMain.js, plain JavaScript) with
# `node` INSIDE the running mcp-server container, which already has the database env. The image
# has no tsx/npx, so nothing here needs them. READ-ONLY over the append-only ledger
# (belief_adjudication_costs).
#
# USAGE:
#   bash scripts/belief-cost.sh              # human summary, default window
#   bash scripts/belief-cost.sh --days 30    # 30-day window
#   bash scripts/belief-cost.sh --json       # machine-readable (todayUsd, dailySpendCapUsd, capReached)
#
# Environment:
#   BELIEF_COST_SERVICE=mcp-server   compose service to exec into
#   BELIEF_COST_LOCAL=1              run on the host instead (needs `npm run build` in mcp-server and
#                                    DATABASE_* in the environment; BELIEF_COST_DB_ENV=/path/env may
#                                    supply KEY=VAL lines)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="dist/cli/beliefCostMain.js"

# Silence the logger console banner so stdout is a CLEAN report / JSON.
if [[ "${BELIEF_COST_LOCAL:-0}" == "1" ]]; then
  if [[ -n "${BELIEF_COST_DB_ENV:-}" && -r "${BELIEF_COST_DB_ENV}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${BELIEF_COST_DB_ENV}"
    set +a
  fi
  cd "$REPO_DIR/mcp-server"
  export LOG_CONSOLE=false AIDIS_LOG_CONSOLE=false
  exec node "$ENTRY" "$@"
fi

cd "$REPO_DIR"
# ambient-scrub-exempt: `compose exec` runs a command inside the ALREADY-RUNNING container; it creates no container, so no interpolated value is delivered anywhere.
exec docker compose exec -T -e LOG_CONSOLE=false -e AIDIS_LOG_CONSOLE=false \
  "${BELIEF_COST_SERVICE:-mcp-server}" node "$ENTRY" "$@"
