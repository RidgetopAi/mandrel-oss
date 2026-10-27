#!/usr/bin/env bash
# =============================================================================
# openapi-drift-self-provision.sh — the ONE place the OpenAPI drift stage may install
# its toolchain, and only when its caller opts in (OPENAPI_DRIFT_SELF_PROVISION=1).
# -----------------------------------------------------------------------------
# WHY THIS IS A SEPARATE FILE
#   scripts/test/openapi-artifact-drift.test.sh NEVER installs by default: under a gate
#   whose tree is its OWN working tree, an interrupted reinstall leaves
#   mandrel-command/node_modules half-empty (`tsc: not found` in the next stage).
#   A gate on a bare single-use checkout needs the opposite: with no deps stage, the drift
#   stage is COULD-NOT-MEASURE, never the RED a stale checked-in artifact must produce.
#   Such a caller sets OPENAPI_DRIFT_SELF_PROVISION=1, and the drift test runs this file
#   when — and only when — that flag is 1 and its toolchain does not resolve.
#
# ROOT-LEVEL install, never member-scoped (a past incident — a scoped `npm ci -w <member>`
# strips sibling members' deps in a shared tree). mandrel-command IS the npm workspace
# root (members backend/frontend/shared); ONE root `npm ci` hoists and links every
# member. The caller owns a fresh, single-use checkout, so there is no sibling stage to
# strip and no concurrent reader to race.
#
# USAGE:  bash scripts/lib/openapi-drift-self-provision.sh <repo-dir> <log-file>
# EXIT:   0 installed · 2 could not (lockfile missing, or npm ci failed: an
#         environmental fact about the box, never a verdict on the commit)
# =============================================================================
set -uo pipefail
REPO_DIR="${1:?repo dir}"; LOG="${2:?log file}"
MC_ROOT="$REPO_DIR/mandrel-command"
if [[ ! -f "$MC_ROOT/package-lock.json" ]]; then
  echo "mandrel-command/package-lock.json missing — cannot self-provision (fail-closed)" >&2
  exit 2
fi
echo "  self-provisioning: root-level \`npm ci --include=dev\` in mandrel-command"
echo "  (OPENAPI_DRIFT_SELF_PROVISION=1; this checkout is single-use, so there is nothing to race or strip)."
if ( cd "$MC_ROOT" && npm ci --include=dev ) >"$LOG" 2>&1; then
  echo "  self-provisioned: mandrel-command deps installed from the lockfile"
  exit 0
fi
tail -20 "$LOG" | sed 's/^/      /' >&2
echo "self-provisioning npm ci FAILED in mandrel-command — see the log tail above (an ENVIRONMENTAL fact about this box, e.g. no network to the registry; not a verdict on the commit)" >&2
exit 2
