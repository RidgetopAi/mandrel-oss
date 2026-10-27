#!/usr/bin/env bash
# NOT-IN-CI: run by scripts/oss-gate.sh stage H (every scripts/test/*.test.sh); not a CI gate stage.
#
# End to end for the reference loop: one punch from ready to merged, in pr mode and again in direct
# mode, against a temp bare origin + clone, a FakeBoard, and fake `claude` and `gh` scripts.
# The driver is loop/test/support/e2e-driver.ts, compiled into a throwaway dir inside loop/ so the
# package's node_modules resolve.
#
# Fails when a mode does not print the stage sequence below, or when the whole run takes longer
# than $LOOP_E2E_BUDGET_SECONDS of wall clock (measured here, by bash's $SECONDS).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP="$REPO/loop"
EXPECTED_STAGES="ready claimed verifying evidence merged"
BUDGET="${LOOP_E2E_BUDGET_SECONDS:-120}"
BUILD="$LOOP/.e2e-build"

fail() { echo "loop-e2e FAIL: $*" >&2; exit 1; }
trap 'rm -rf "$BUILD"' EXIT

SECONDS=0
cd "$LOOP" || fail "cannot cd to $LOOP"
[[ -x node_modules/.bin/tsc ]] || npm ci --silent >/dev/null 2>&1 || fail "npm ci failed in loop/"

rm -rf "$BUILD"
node_modules/.bin/tsc --outDir "$BUILD" --rootDir . --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --skipLibCheck --types node test/support/e2e-driver.ts || fail "driver does not compile"
# The compiled modules read cards/ and package.json relative to themselves.
ln -s "$LOOP/cards" "$BUILD/cards"
ln -s "$LOOP/package.json" "$BUILD/package.json"
# FakeBoard reads its server rules from the punch-contract golden, which tsc does not emit.
ln -s "$LOOP/test/fixtures" "$BUILD/test/fixtures"

OUT="$(node "$BUILD/test/support/e2e-driver.js" 2>&1)" || { echo "$OUT" >&2; fail "driver exited non-zero"; }
echo "$OUT"

for mode in pr direct; do
  grep -q "^mode=$mode stages=$EXPECTED_STAGES ticks=" <<<"$OUT" || fail "$mode: stage sequence is not: $EXPECTED_STAGES"
done

ELAPSED=$SECONDS
echo "loop-e2e: both modes merged in ${ELAPSED}s (budget ${BUDGET}s)"
(( ELAPSED <= BUDGET )) || fail "took ${ELAPSED}s, budget is ${BUDGET}s"
echo "loop-e2e PASS"
