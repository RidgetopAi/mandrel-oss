#!/usr/bin/env bash
# =============================================================================
# run-xai-grok.sh — MEASUREMENT-ONLY grok-4.3 (xAI) adjudicator run for the
# Phase-4 belief-layer bake-off. Drives xaiAdjRun.ts over
# the decision-run 80 pairs (or the 6-case scorecard) with the grok-4.3 config.
#
# grok-4.3 config notes (measured 2026-07-07, all via probes):
#   - openai-compat wire, endpoint https://api.x.ai (provider appends /v1/chat/completions)
#   - response_format json_object: SUPPORTED (verified)
#   - seed=0 REJECTED by xAI ("Seed must be positive") -> use seed=1
#   - grok-4.3 is a REASONING model, reasoning FORCED-ON (no off toggle); reasoning_effort
#     only scales reasoning UP (low=585 vs omitted=489 vs high=875 reasoning tokens on a
#     probe) -> OMIT reasoning_effort for the thinking-minimized config (thinking-hurts).
#   - top_k: accepted by xAI but omitted (strict-host pattern, matches Groq treatment).
#   - pricing (from /v1/models/grok-4.3): input $12.5/M, cached $2/M, output $25/M;
#     cost_in_usd_ticks / 1e9 = USD per call (verified against usage).
#
# Usage:  bash run-xai-grok.sh <label> [pairs|cases]
# Reads the key from $XAI_KEY_FILE (default ~/.config/mandrel-evals/xai.env) by NAME (XAI_API_KEY); value never printed.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LABEL="${1:?usage: run-xai-grok.sh <label> [pairs|cases]}"
MODE="${2:-pairs}"

# Key (value never echoed).
XAI_KEY_FILE="${XAI_KEY_FILE:-$HOME/.config/mandrel-evals/xai.env}"
[ -r "$XAI_KEY_FILE" ] || { echo "run-xai-grok: key file $XAI_KEY_FILE is missing or unreadable" >&2; exit 2; }
set -a; . "$XAI_KEY_FILE"; set +a

export MANDREL_BELIEF_ADJUDICATOR_PROVIDER=openai-compat
export MANDREL_BELIEF_ADJUDICATOR_MODEL=grok-4.3
export MANDREL_BELIEF_ADJUDICATOR_ENDPOINT=https://api.x.ai
export MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV=XAI_API_KEY
export MANDREL_BELIEF_ADJUDICATOR_TEMPERATURE=0
export MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K=false
export MANDREL_BELIEF_ADJUDICATOR_STRUCTURED_OUTPUT=true
export MANDREL_BELIEF_ADJUDICATOR_REASONING_EFFORT=""
export MANDREL_BELIEF_ADJUDICATOR_SEED="${GROK_SEED:-1}"
export MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS=8192
export MANDREL_BELIEF_ADJUDICATOR_TIMEOUT_MS=120000

export ADJRUN_MODE="$MODE"
export ADJRUN_LABEL="$LABEL"
export ADJRUN_OUT="${ADJRUN_OUT:-$HERE/decision-run}"
export ADJRUN_PAIRS="${ADJRUN_PAIRS:-$HERE/decision-run/pairs.json}"
export ADJRUN_CASES="${ADJRUN_CASES:-$HERE/cases.json}"

cd "$REPO/mcp-server"
exec npx tsx "$HERE/xaiAdjRun.ts"
