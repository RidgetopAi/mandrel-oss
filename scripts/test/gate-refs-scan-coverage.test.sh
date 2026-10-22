#!/usr/bin/env bash
# =============================================================================
# gate-refs-scan-coverage.test.sh — the internal-refs scan covers EVERY tracked file.
# =============================================================================
# `bash scripts/oss-gate.sh --list-scanned` prints the files the internal-refs ban covers (it uses
# the same pathspec as the scan itself). This test asserts that list equals `git ls-files` minus ONLY
# the exempt paths (OSS_GATE_REFS_EXEMPT in scripts/oss-gate/config.sh).
#
# THE CRITIC (scratch git repo holding a copy of the gate):
#   control  — unmodified config: scanned list == tracked minus the exempt paths.
#   mutant 1 — OSS_GATE_REFS_SCOPE narrowed to source directories: the coverage check goes RED.
#   mutant 2 — a file carrying the host-class probe from the pattern list under mcp-server/evals is
#              inside the scanned list.
#
# USAGE:  bash scripts/test/gate-refs-scan-coverage.test.sh
# Exit: 0 green, 1 a check failed, 2 could not measure.
# =============================================================================
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG ---------------------------------------------------------------------
GATE_CONFIG="${GATE_CONFIG:-scripts/oss-gate/config.sh}"
GATE_SCRIPT="${GATE_SCRIPT:-scripts/oss-gate.sh}"
MUTANT_NARROW_SCOPE="${MUTANT_NARROW_SCOPE:-mcp-server/src mandrel-command/backend/src}"
MUTANT_FILE="${MUTANT_FILE:-mcp-server/evals/zz-mutant/notes.md}"
MUTANT_LABEL="${MUTANT_LABEL:-$(awk -F'\t' '$1 == "host" { print $3; exit }' "$REPO_DIR/scripts/oss-gate/internal-refs.patterns")}"
[[ -n "$MUTANT_LABEL" ]] || { echo "CANNOT MEASURE: no host-class probe in the pattern list" >&2; exit 2; }

if [[ -t 1 ]]; then RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
else RED=""; GRN=""; BLD=""; RST=""; fi
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
cnm()  { printf '%sCANNOT MEASURE: %s%s\n' "$RED" "$*" "$RST" >&2; exit 2; }

command -v git >/dev/null 2>&1 || cnm "git is not installed"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || cnm "not a git work tree"
WORK="$(mktemp -d)" || cnm "mktemp failed"
trap 'rm -rf "$WORK"' EXIT

# allowlist_of <repo> — the exempt paths, as the gate's config defines them.
allowlist_of() {
  ( cd "$1" && . "$GATE_CONFIG" && printf '%s\n' "${OSS_GATE_REFS_EXEMPT[@]}" ) | LC_ALL=C sort
}
# expected_of <repo> — git ls-files minus the exempt paths.
expected_of() {
  git -C "$1" ls-files --cached | LC_ALL=C sort | LC_ALL=C comm -23 - <(allowlist_of "$1")
}
# scanned_of <repo> — what the gate says it scans.
scanned_of() { ( cd "$1" && bash "$GATE_SCRIPT" --list-scanned ); }

# coverage <repo> <label> — pass/fail: scanned list equals expected list.
coverage() {
  local exp got missing
  exp="$(expected_of "$1")"; got="$(scanned_of "$1")" || cnm "--list-scanned failed in $1"
  [[ -n "$exp" ]] || cnm "no tracked files in $1"
  missing="$(LC_ALL=C comm -23 <(echo "$exp") <(echo "$got") | head -5 | tr '\n' ' ')"
  if [[ "$exp" == "$got" ]]; then pass "$2: scan covers all $(echo "$exp" | wc -l | tr -d ' ') tracked files"
  else fail "$2: scan misses tracked files (e.g. ${missing:-none — extra entries listed})"; return 1; fi
}

hdr "Real tree"
allow="$(allowlist_of "$REPO_DIR")"
[[ -n "$allow" ]] || cnm "exempt list is empty or unreadable"
n_allow="$(echo "$allow" | wc -l | tr -d ' ')"
[[ "$n_allow" -le 2 ]] && pass "exempt list holds only $n_allow path(s): $(echo "$allow" | tr '\n' ' ')" \
  || fail "exempt list grew beyond the pattern list + allow-list: $allow"
coverage "$REPO_DIR" "real tree"

hdr "Critic (scratch repo with a copy of the gate)"
S="$WORK/scratch"
mkdir -p "$S/scripts/oss-gate" "$S/mcp-server/src" "$S/mcp-server/evals" "$S/docs"
git -C "$S" init -q || cnm "git init failed"
git -C "$S" config user.email t@example.com; git -C "$S" config user.name t
cp "$REPO_DIR/$GATE_SCRIPT" "$S/scripts/oss-gate.sh"
cp "$REPO_DIR"/scripts/oss-gate/config.sh "$REPO_DIR"/scripts/oss-gate/internal-refs.patterns "$S/scripts/oss-gate/"
printf '# allow-list\n' > "$S/scripts/oss-gate/internal-refs.allow"
echo 'export const a = 1;' > "$S/mcp-server/src/a.ts"
echo 'x' > "$S/mcp-server/evals/run.py"
echo 'doc' > "$S/docs/d.md"
git -C "$S" add -A

coverage "$S" "control (unmutated)" && true

# mutant 1: narrow the scan back to the source directories.
cp "$S/$GATE_CONFIG" "$WORK/config.orig"
sed -i "s#^OSS_GATE_REFS_SCOPE=.*#OSS_GATE_REFS_SCOPE=($MUTANT_NARROW_SCOPE)#" "$S/$GATE_CONFIG"
grep -q "^OSS_GATE_REFS_SCOPE=($MUTANT_NARROW_SCOPE)" "$S/$GATE_CONFIG" || cnm "mutant 1 did not land"
if ( coverage "$S" "mutant 1 (scope narrowed)" ) >"$WORK/m1.out"; then
  fail "mutant 1 stayed GREEN — the coverage check is blind to a narrowed scope"
else pass "mutant 1 (scope narrowed to source dirs) is RED"; fi
cp "$WORK/config.orig" "$S/$GATE_CONFIG"

# mutant 2: a brand-new eval file carrying an internal host name is inside the scan.
mkdir -p "$S/$(dirname "$MUTANT_FILE")"
echo "ssh $MUTANT_LABEL" > "$S/$MUTANT_FILE"
git -C "$S" add -A
git -C "$S" grep --cached -q -i -F "$MUTANT_LABEL" -- "$MUTANT_FILE" || cnm "mutant 2 did not land"
out="$(cd "$S" && bash scripts/oss-gate.sh --list-scanned | grep -c -F "$MUTANT_FILE")"
[[ "$out" -eq 1 ]] && pass "mutant 2 file is inside the scanned list" || fail "mutant 2 file is outside the scan"
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
