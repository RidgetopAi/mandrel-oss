#!/usr/bin/env bash
# =============================================================================
# openapi-drift-no-reinstall.test.sh — the drift test must never reinstall in place
# -----------------------------------------------------------------------------
# scripts/test/openapi-artifact-drift.test.sh used to reinstall dependencies when its
# toolchain did not resolve, assuming a single-use checkout. Under scripts/oss-gate.sh
# that directory is the gate's own working tree: an interrupted reinstall left
# mandrel-command/node_modules half-empty and the next stage failed with `tsc: not found`.
#
# WHAT THIS ASSERTS
#   1. the drift test source contains no install invocation (static check);
#   2. in a COPY of the repo with the TypeScript compiler removed from
#      mandrel-command/node_modules, the drift test exits 2 (could-not-measure),
#      names the missing tool, and leaves the copy's node_modules listing identical.
#
# Exit: 0 all assertions pass · 1 an assertion failed · 2 could not measure.
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRIFT_REL="scripts/test/openapi-artifact-drift.test.sh"
MISSING_TOOL_PKG="${OPENAPI_NO_REINSTALL_REMOVED_PKG:-typescript}"
EXPECT_RC=2

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  [FAIL] %s\n' "$*"; }
die()  { printf 'COULD NOT MEASURE: %s\n' "$*" >&2; exit 2; }

NM="$REPO_DIR/mandrel-command/node_modules"
[[ -d "$NM/$MISSING_TOOL_PKG" ]] \
  || die "$NM/$MISSING_TOOL_PKG absent — install mandrel-command deps first (this test needs a populated tree to copy)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/openapi-no-reinstall-XXXXXX")" || die "mktemp failed"
trap 'rm -rf "$TMP"' EXIT
COPY="$TMP/repo"

echo "== 1. the drift test contains no install invocation =="
if grep -En '(^|[^[:alnum:]_`-])npm[[:space:]]+(ci|install|i)([[:space:]]|$)' "$REPO_DIR/$DRIFT_REL" \
     | grep -Ev '^[0-9]+:[[:space:]]*#' >/dev/null; then
  fail "$DRIFT_REL invokes npm ci/install"
else
  pass "$DRIFT_REL has no npm ci/install invocation"
fi

echo "== 2. copy the repo, remove the compiler, run the drift test there =="
mkdir -p "$COPY"
# Everything except .git is a real copy (node_modules reflinked where the filesystem allows).
( cd "$REPO_DIR" && tar --exclude=./.git --exclude=./mandrel-command/node_modules -cf - . ) \
  | ( cd "$COPY" && tar -xf - ) || die "repo copy failed"
cp -a --reflink=auto "$NM" "$COPY/mandrel-command/node_modules" 2>/dev/null || die "node_modules copy failed"

CNM="$COPY/mandrel-command/node_modules"
rm -rf "${CNM:?}/$MISSING_TOOL_PKG" "$CNM/.bin/tsc" "$CNM/.bin/tsserver"
[[ ! -e "$CNM/$MISSING_TOOL_PKG" ]] || die "could not remove $MISSING_TOOL_PKG from the copy"
# Node resolves upward: the gate's tree can also carry the compiler in a node_modules ABOVE
# mandrel-command (repo root, backend), which would keep it resolvable. Remove it from every
# such directory in the copy so the tool is genuinely unresolvable from where the test looks.
for up in "$COPY/node_modules" "$COPY/mandrel-command/backend/node_modules" "$COPY/mandrel-command/frontend/node_modules"; do
  rm -rf "${up:?}/$MISSING_TOOL_PKG" "$up/.bin/tsc" "$up/.bin/tsserver"
done

list() { ( cd "$CNM" && find . -mindepth 1 -maxdepth 2 -printf '%P %y\n' | LC_ALL=C sort ); }
list >"$TMP/before.txt"

OUT="$TMP/out.txt"
bash "$COPY/$DRIFT_REL" >"$OUT" 2>&1
RC=$?
list >"$TMP/after.txt"

if [[ "$RC" -eq "$EXPECT_RC" ]]; then pass "exit code is $EXPECT_RC (could-not-measure)"
else fail "exit code is $RC, expected $EXPECT_RC"; tail -15 "$OUT" | sed 's/^/      /'; fi

if grep -q "COULD NOT MEASURE:.*'$MISSING_TOOL_PKG'" "$OUT"; then pass "output names the missing tool '$MISSING_TOOL_PKG'"
else fail "output does not name '$MISSING_TOOL_PKG'"; tail -15 "$OUT" | sed 's/^/      /'; fi

if cmp -s "$TMP/before.txt" "$TMP/after.txt"; then
  pass "mandrel-command/node_modules listing identical before and after ($(wc -l <"$TMP/after.txt") entries)"
else
  fail "node_modules listing CHANGED (the test reinstalled in place):"; diff "$TMP/before.txt" "$TMP/after.txt" | head -10 | sed 's/^/      /'
fi

echo; echo "passed=$PASS failed=$FAIL"
[[ "$FAIL" -eq 0 ]]
