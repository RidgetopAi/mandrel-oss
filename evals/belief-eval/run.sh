#!/usr/bin/env bash
# =============================================================================
# run.sh — the Phase-4 belief-eval (the belief-layer design §5). ONE command to score the
# belief layer against the six-case scorecard on a DISPOSABLE DB.
#
# What it does (never touches prod — a ci_*-prefixed throwaway DB, dropped on exit):
#   1. provision + migrate a throwaway Postgres (scripts/provision-test-db.sh — the
#      same helper the CI gate uses, so extensions + migrations can't drift);
#   2. run scripts/beliefEval.ts against it with the gemma embedder + the local
#      ollama adjudicator (qwen2.5:1.5b by default);
#   3. score axes ① supersession accuracy + ② conflict precision; write a JSON
#      report to evals/belief-eval/out/ and print a summary; exit non-zero on FAIL.
#
# CONFIG (configs-not-hardcoded) — override any belief knob via env, e.g.:
#   MANDREL_BELIEF_ADJUDICATOR_MODEL=qwen2.5:3b bash evals/belief-eval/run.sh
#
# Reproduce:  bash evals/belief-eval/run.sh
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # -> evals/..  (repo root)
REPO_DIR="$(cd "$REPO_DIR/.." && pwd)"
MCP_DIR="$REPO_DIR/mcp-server"

DB="ci_belief_eval_$$_$(date +%s)"
GRN=$'\033[32m'; RED=$'\033[31m'; RST=$'\033[0m'

cleanup() {
  bash "$REPO_DIR/scripts/provision-test-db.sh" "$DB" --drop >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== provisioning disposable DB $DB (+ migrate) =="
bash "$REPO_DIR/scripts/provision-test-db.sh" "$DB" >&2

# Clean, deterministic DB creds for this same DB name.
eval "$(bash "$REPO_DIR/scripts/provision-test-db.sh" "$DB" --print-env | sed 's/^/export /')"

echo "== running belief-eval (embedder=gemma, adjudicator=${MANDREL_BELIEF_ADJUDICATOR_MODEL:-qwen2.5:1.5b}) =="
set +e
(
  cd "$MCP_DIR" && \
  NODE_ENV=test \
  MANDREL_EMBEDDER="${MANDREL_EMBEDDER:-gemma}" \
  MANDREL_OLLAMA_ENDPOINT="${MANDREL_OLLAMA_ENDPOINT:-http://127.0.0.1:11434}" \
  npx tsx scripts/beliefEval.ts
)
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  echo "${GRN}belief-eval GATE PASS${RST}"
else
  echo "${RED}belief-eval GATE FAIL (rc=$RC) — see report in evals/belief-eval/out/${RST}"
fi
exit $RC
