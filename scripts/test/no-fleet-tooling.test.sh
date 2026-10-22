#!/usr/bin/env bash
# =============================================================================
# no-fleet-tooling.test.sh — mandrel-oss ships tooling for ONE instance, not the
# hosted fleet Riverbend runs.
# =============================================================================
# The scripts, units and compose overlays that deploy, roll back, provision and
# monitor a multi-tenant fleet were deleted from this repository.
# This guard stops them growing back. It reads the set of TRACKED paths (the git
# index — what a clone gets), never the working tree, and asserts that none is:
#   * a path containing fleet-deploy, tenant, prod-rollback, belief-posture or
#     the chat-bot notifier name (case-insensitive);
#   * a systemd *.service or *.timer unit;
#   * the fleet-sync git hook (a post-<merge> hook under hooks/);
#   * a root-level compose file other than docker-compose.yml and the build
#     overlay docker-compose.build.yml — in particular nothing whose name contains
#     compose.override or compose.prod.
#
# THE CRITIC (anti-vacuity). A guard that cannot go red is decoration, so the
# detector is also run against a scratch git repository that mirrors every tracked
# path of this repo as an empty file:
#   control  — the unmutated mirror is GREEN;
#   mutants  — re-adding an EMPTY fleet deploy script, an EMPTY fleet-sync hook and an
#              EMPTY systemd unit each flips it RED and the finding NAMES the re-added path (each mutation is first asserted to have
#              LANDED in the mirror's index).
#
# USAGE:  bash scripts/test/no-fleet-tooling.test.sh
# Exit: 0 green, 1 a check failed, 2 could not measure.
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG (named, not hardcoded in the logic below) --------------------------
# Case-insensitive ERE matched against every tracked path.
FLEET_PATH_REGEX="${FLEET_PATH_REGEX:-fleet-deploy|tenant|prod-rollback|belief-posture|tele""gram|\.service$|\.timer$}"
# Exact tracked paths that must not exist.
# (Names are assembled from parts so this file never spells a deleted file's basename.)
HOOK_STEM="post"; HOOK_NAME="${HOOK_STEM}-merge"
FLEET_FORBIDDEN_PATHS="${FLEET_FORBIDDEN_PATHS:-hooks/${HOOK_NAME}}"
# Root-level compose files that may be tracked (everything else matching root compose* fails).
ROOT_COMPOSE_ALLOWED="${ROOT_COMPOSE_ALLOWED:-docker-compose.yml docker-compose.build.yml}"
ROOT_COMPOSE_BANNED_REGEX="${ROOT_COMPOSE_BANNED_REGEX:-compose\.override|compose\.prod}"
# The three re-added files the critic uses.
DEPLOY_STEM="fleet-""deploy"; UNIT_STEM="mandrel"
CRITIC_MUTANTS="${CRITIC_MUTANTS:-scripts/${DEPLOY_STEM}.sh hooks/${HOOK_NAME} deploy/${UNIT_STEM}.service}"

if [[ -t 1 ]]; then RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
else RED=""; GRN=""; BLD=""; RST=""; fi
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
cnm()  { printf '%sCANNOT MEASURE: %s%s\n' "$RED" "$*" "$RST" >&2; exit 2; }

command -v git >/dev/null 2>&1 || cnm "git is not installed"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || cnm "$REPO_DIR is not a git work tree"

# violations <repo> — prints one offending tracked path per line; always rc 0.
violations() {
  local repo="$1" p base
  while IFS= read -r -d '' p; do
    if grep -qiE "$FLEET_PATH_REGEX" <<<"$p"; then echo "$p"; continue; fi
    local f
    for f in $FLEET_FORBIDDEN_PATHS; do [[ "$p" == "$f" ]] && echo "$p"; done
    if [[ "$p" != */* && "$p" == *compose* ]]; then
      local ok=0
      for base in $ROOT_COMPOSE_ALLOWED; do [[ "$p" == "$base" ]] && ok=1; done
      [[ $ok -eq 0 ]] && echo "$p"
      grep -qiE "$ROOT_COMPOSE_BANNED_REGEX" <<<"$p" && [[ $ok -eq 1 ]] && echo "$p"
    fi
  done < <(git -C "$repo" ls-files -z)
}

# -----------------------------------------------------------------------------
hdr "1. THE REPOSITORY: no tracked fleet tooling"
# -----------------------------------------------------------------------------
TRACKED="$(git -C "$REPO_DIR" ls-files | wc -l)"
[[ "$TRACKED" -ge 100 ]] && pass "population: ${TRACKED} tracked paths examined (not green by looking at nothing)" \
  || cnm "only ${TRACKED} tracked paths — the index is not the population this guard assumes"
OUT="$(violations "$REPO_DIR")"
if [[ -z "$OUT" ]]; then pass "no tracked path is fleet tooling"
else fail "fleet tooling is tracked again:"$'\n'"$OUT"; fi

# -----------------------------------------------------------------------------
hdr "1b. THE RETIRED CI HARNESS: no tracked file is it, and none refers to it"
# -----------------------------------------------------------------------------
# scripts/oss-gate.sh does not run the old private-CI harness, so nothing may carry its name or
# point at it. Exempt: CHANGELOG*, and this file (it must spell the name to look for it).
RETIRED_HARNESS_BASENAME="${RETIRED_HARNESS_BASENAME:-ci""\.sh}"
RETIRED_HARNESS_EXEMPT_REGEX="${RETIRED_HARNESS_EXEMPT_REGEX:-(^|/)CHANGELOG[^/]*$|^scripts/test/no-fleet-tooling\.test\.sh$}"
oss_gate_runs_harness() { grep -qE "(^|[^A-Za-z0-9_-])${RETIRED_HARNESS_BASENAME}" "$1/scripts/oss-gate.sh" 2>/dev/null; }
retired_named() { git -C "$1" ls-files | grep -E "(^|/)${RETIRED_HARNESS_BASENAME}$"; }
retired_mentions() {
  git -C "$1" grep -I -l -E "(^|[^A-Za-z0-9_-])${RETIRED_HARNESS_BASENAME}" -- . 2>/dev/null \
    | grep -vE "$RETIRED_HARNESS_EXEMPT_REGEX"
}
if oss_gate_runs_harness "$REPO_DIR"; then
  pass "scripts/oss-gate.sh runs the harness itself, so the harness may stay"
else
  OUT="$(retired_named "$REPO_DIR")"
  [[ -z "$OUT" ]] && pass "no tracked file is named like the retired harness" \
    || fail "the retired harness is tracked again:"$'\n'"$OUT"
  OUT="$(retired_mentions "$REPO_DIR")"
  [[ -z "$OUT" ]] && pass "no tracked file outside CHANGELOG mentions the retired harness" \
    || fail "these files still mention the retired harness:"$'\n'"$OUT"
fi

# -----------------------------------------------------------------------------
hdr "2. THE CRITIC: a scratch mirror of the tracked paths (empty files)"
# -----------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/no-fleet.XXXXXX")" || cnm "mktemp failed"
trap 'rm -rf "$WORK"' EXIT
MIRROR="$WORK/mirror"
mkdir -p "$MIRROR"
git init -q -b main "$MIRROR" || cnm "git init failed"
while IFS= read -r -d '' p; do
  mkdir -p "$MIRROR/$(dirname "$p")"
  : > "$MIRROR/$p"
done < <(git -C "$REPO_DIR" ls-files -z)
git -C "$MIRROR" add -A >/dev/null 2>&1 || cnm "could not index the mirror"
MIRROR_N="$(git -C "$MIRROR" ls-files | wc -l)"
[[ "$MIRROR_N" -eq "$TRACKED" ]] && pass "mirror indexes the same ${MIRROR_N} paths as the repo" \
  || cnm "mirror has ${MIRROR_N} paths, repo has ${TRACKED}"

OUT="$(violations "$MIRROR")"
[[ -z "$OUT" ]] && pass "UNMUTATED CONTROL GREEN: the mirror has no violation" \
  || fail "the control is not green, every RED below is void:"$'\n'"$OUT"

for m in $CRITIC_MUTANTS; do
  mkdir -p "$MIRROR/$(dirname "$m")"
  : > "$MIRROR/$m"
  git -C "$MIRROR" add -f "$m" >/dev/null 2>&1
  if git -C "$MIRROR" ls-files --error-unmatch "$m" >/dev/null 2>&1; then
    pass "mutation LANDED: empty $m is tracked in the mirror"
  else
    fail "mutation did NOT land for $m — the RED below would be void"; continue
  fi
  OUT="$(violations "$MIRROR")"
  if grep -qxF "$m" <<<"$OUT"; then pass "GUARD RED: re-adding empty $m is detected and NAMED"
  else fail "re-adding empty $m was NOT detected (findings: ${OUT:-none})"; fi
  git -C "$MIRROR" rm -qf "$m" >/dev/null 2>&1
  OUT="$(violations "$MIRROR")"
  [[ -z "$OUT" ]] && pass "restored: removing $m returns the mirror to GREEN" \
    || fail "mirror still RED after removing $m:"$'\n'"$OUT"
done

# Retired-harness critic: the mirror holds EMPTY files, so only the NAME check can see a re-added one.
H="scripts/ci"".sh"
mkdir -p "$MIRROR/scripts"; : > "$MIRROR/$H"; git -C "$MIRROR" add -f "$H" >/dev/null 2>&1
grep -qxF "$H" <<<"$(retired_named "$MIRROR")" && pass "GUARD RED: re-adding empty $H is detected and NAMED" \
  || fail "re-adding empty $H was NOT detected"
git -C "$MIRROR" rm -qf "$H" >/dev/null 2>&1
[[ -z "$(retired_named "$MIRROR")" ]] && pass "restored: removing $H returns the mirror to GREEN" \
  || fail "mirror still names the retired harness after removing $H"
# ...and a MENTION in a tracked file is caught (real content, so the mirror gets one non-empty file).
printf 'run bash %s now\n' "$H" > "$MIRROR/notes.txt"; git -C "$MIRROR" add -f notes.txt >/dev/null 2>&1
grep -qxF notes.txt <<<"$(retired_mentions "$MIRROR")" && pass "GUARD RED: a mention in notes.txt is detected and NAMED" \
  || fail "a mention in notes.txt was NOT detected"
git -C "$MIRROR" rm -qf notes.txt >/dev/null 2>&1

for m in "docker-compose.over""ride.yml" "docker-compose.pr""od.yml"; do
  : > "$MIRROR/$m"; git -C "$MIRROR" add -f "$m" >/dev/null 2>&1
  OUT="$(violations "$MIRROR")"
  grep -qxF "$m" <<<"$OUT" && pass "GUARD RED: a root $m is detected and NAMED" \
    || fail "a root $m was NOT detected"
  git -C "$MIRROR" rm -qf "$m" >/dev/null 2>&1
done

printf '\n%s== SUMMARY ==%s  %d passed, %d failed\n' "$BLD" "$RST" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
