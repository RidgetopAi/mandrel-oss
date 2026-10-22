#!/usr/bin/env bash
# =============================================================================
# run-subq.sh — MEASUREMENT-ONLY SubQ Snap bake-off.
# Drives scripts/adjScore.ts (the SAME provider factory the live pipeline uses) over the
# decision-run 80 pairs with one of four configs, then score-subq.py scores the runs.
#
#   snap-compact  provider=subq, Snap-native short verdict question (BELIEF_SUBQ rubric=compact)
#   snap-full     provider=subq, the canonical rubric text as the verdict instructions
#   sonnet5       provider=anthropic claude-sonnet-5, CURRENT prompt (tier-2 baseline)
#   tiered-snap   provider=tiered, tier1=subq (rubric from SUBQ_TIER1_RUBRIC, default compact)
#                 → tier2=claude-sonnet-5 on {supersedes,contests}
#
# sonnet5 / tiered-snap honour CLAUDE_MODEL (default claude-sonnet-5) for the Claude model, and
# CLAUDE_TOOL_CHOICE / CLAUDE_THINKING_TYPE (default: the config defaults) — claude-sonnet-5-5
# needs CLAUDE_TOOL_CHOICE=auto (it rejects a forced tool_choice) and CLAUDE_THINKING_TYPE=between_tools.
# Every subq config honours SUBQ_SAME_SUBJECT_FROM (noul|verdict, default verdict — the product default) — see
# BELIEF_SUBQ_CONFIG.sameSubjectFrom.
#
# Usage:  bash run-subq.sh <config> <label> [outdir]
# Keys are read from files BY NAME, values never printed:
#   SUBQ_KEY_FILE      (default ~/.config/mandrel-evals/subq.env, line `SUBQ-API-KEY=<value>` — the
#                       hyphenated name is not shell-sourceable, so it is cut, not sourced)
#   ANTHROPIC_KEY_FILE (default ~/.config/mandrel-evals/anthropic.env, line `ANTHROPIC_API_KEY=<value>`)
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONFIG="${1:?usage: run-subq.sh <snap-compact|snap-full|sonnet5|tiered-snap> <label> [outdir]}"
LABEL="${2:?usage: run-subq.sh <config> <label> [outdir]}"
OUT="${3:-$HERE/out/subq-bakeoff}"

load_subq_key() {
  local f="${SUBQ_KEY_FILE:-$HOME/.config/mandrel-evals/subq.env}"
  [ -r "$f" ] || { echo "run-subq: SubQ key file $f is missing or unreadable" >&2; exit 2; }
  # `|| true`: a file without the key line must reach the friendly exit-2 below, not die
  # silently with grep's rc=1 under set -euo pipefail.
  SUBQ_API_KEY="$(grep -m1 '^SUBQ-API-KEY=' "$f" | cut -d= -f2- || true)"
  [ -n "$SUBQ_API_KEY" ] || { echo "run-subq: no SUBQ-API-KEY line in $f" >&2; exit 2; }
  export SUBQ_API_KEY
}
load_anthropic_key() {
  local f="${ANTHROPIC_KEY_FILE:-$HOME/.config/mandrel-evals/anthropic.env}"
  [ -r "$f" ] || { echo "run-subq: Anthropic key file $f is missing or unreadable" >&2; exit 2; }
  ANTHROPIC_API_KEY="$(grep -m1 -E '^(export )?ANTHROPIC_API_KEY=' "$f" | cut -d= -f2- | tr -d '"' || true)"
  [ -n "$ANTHROPIC_API_KEY" ] || { echo "run-subq: no ANTHROPIC_API_KEY line in $f" >&2; exit 2; }
  export ANTHROPIC_API_KEY
}
subq_env() { # $1 = env prefix (MANDREL_BELIEF_ADJUDICATOR / MANDREL_BELIEF_TIER1)
  export "$1_PROVIDER=subq" "$1_MODEL=subq-snap-preview" \
         "$1_ENDPOINT=https://api.subq.ai" "$1_API_KEY_ENV=SUBQ_API_KEY"
  export MANDREL_BELIEF_SUBQ_SAME_SUBJECT_FROM="${SUBQ_SAME_SUBJECT_FROM:-verdict}"
}

claude_env() { # $1 = env prefix (MANDREL_BELIEF_ADJUDICATOR / MANDREL_BELIEF_TIER2)
  export "$1_PROVIDER=anthropic" "$1_MODEL=${CLAUDE_MODEL:-claude-sonnet-5}" "$1_API_KEY_ENV=ANTHROPIC_API_KEY"
  if [ -n "${CLAUDE_TOOL_CHOICE:-}" ]; then export "$1_ANTHROPIC_TOOL_CHOICE=$CLAUDE_TOOL_CHOICE"; fi
  if [ -n "${CLAUDE_THINKING_TYPE:-}" ]; then export "$1_ANTHROPIC_THINKING_TYPE=$CLAUDE_THINKING_TYPE"; fi
}

case "$CONFIG" in
  snap-compact) load_subq_key; subq_env MANDREL_BELIEF_ADJUDICATOR; export MANDREL_BELIEF_SUBQ_RUBRIC=compact ;;
  snap-full)    load_subq_key; subq_env MANDREL_BELIEF_ADJUDICATOR; export MANDREL_BELIEF_SUBQ_RUBRIC=full ;;
  sonnet5)
    load_anthropic_key
    claude_env MANDREL_BELIEF_ADJUDICATOR ;;
  tiered-snap)
    load_subq_key; load_anthropic_key
    export MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered
    subq_env MANDREL_BELIEF_TIER1
    export MANDREL_BELIEF_SUBQ_RUBRIC="${SUBQ_TIER1_RUBRIC:-compact}"
    claude_env MANDREL_BELIEF_TIER2 ;;
  *) echo "run-subq: unknown config '$CONFIG'" >&2; exit 2 ;;
esac

export ADJRUN_LABEL="$LABEL" ADJRUN_OUT="$OUT"
export ADJRUN_PAIRS="${ADJRUN_PAIRS:-$HERE/decision-run/pairs.json}"
cd "$REPO/mcp-server"
exec npx tsx scripts/adjScore.ts
