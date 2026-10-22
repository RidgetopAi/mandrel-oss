#!/usr/bin/env bash
# loop-unit.test.sh — the reference Punch List loop package (loop/) builds, answers --version
# from its package.json, passes its vitest suite, and is wired into the repository gate.
#   1. loop/package.json declares bin `mandrel-loop`; after `npm run build`,
#      `node dist/cli.js --version` prints exactly its `version` field.
#   2. scripts/oss-gate/config.sh lists `loop` in OSS_GATE_NPM_ROOTS, OSS_GATE_TYPECHECK and
#      OSS_GATE_LINT_DIRS, and the internal-refs scan (`oss-gate.sh --list-scanned`) covers loop/src.
#   3. loop's vitest suite passes (a failing vitest case makes this script exit non-zero).
# Dependencies are installed from the lockfile when loop/node_modules is absent (stage D of the
# oss-gate has normally done that already).
#
# USAGE:  bash scripts/test/loop-unit.test.sh
# Exit: 0 green, 1 a check failed, 2 could not measure.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG (named, not hardcoded in the logic below) --------------------------
LOOP_DIR="${LOOP_DIR:-$REPO_DIR/loop}"
GATE_CONFIG="${GATE_CONFIG:-$REPO_DIR/scripts/oss-gate/config.sh}"
BIN_NAME="${BIN_NAME:-mandrel-loop}"
GATE_LISTS="${GATE_LISTS:-OSS_GATE_NPM_ROOTS OSS_GATE_TYPECHECK OSS_GATE_LINT_DIRS}"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
cnm() { printf 'CANNOT MEASURE: %s\n' "$*" >&2; exit 2; }

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || cnm "node/npm not on PATH"
[[ -f "$LOOP_DIR/package.json" ]] || { bad "loop/package.json is missing"; exit 1; }

echo "== 1. package, build and --version =="
want="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$LOOP_DIR/package.json")"
bin="$(node -e 'process.stdout.write(String((require(process.argv[1]).bin||{})[process.argv[2]]||""))' "$LOOP_DIR/package.json" "$BIN_NAME")"
[[ -n "$bin" ]] && ok "bin '$BIN_NAME' -> $bin" || bad "package.json declares no bin '$BIN_NAME'"

if [[ ! -d "$LOOP_DIR/node_modules" ]]; then
  ( cd "$LOOP_DIR" && npm ci --include=dev --no-audit --no-fund ) >/dev/null 2>&1 || cnm "npm ci failed in loop/"
fi
if ( cd "$LOOP_DIR" && npm run -s build ) >/dev/null 2>&1; then ok "npm run build"; else bad "npm run build failed"; fi
got="$(cd "$LOOP_DIR" && node dist/cli.js --version 2>&1)"
if [[ -n "$want" && "$got" == "$want" ]]; then ok "--version prints '$got' (package.json version)"
else bad "--version printed '$got', package.json says '$want'"; fi

echo "== 2. gate wiring =="
for list in $GATE_LISTS; do
  found="$(bash -c 'source "$1"; eval "printf \"%s\n\" \"\${$2[@]}\""' _ "$GATE_CONFIG" "$list" | grep -cE '^loop($|\|)')"
  [[ "$found" -ge 1 ]] && ok "$list lists loop" || bad "$list does not list loop"
done
n_scanned="$(cd "$REPO_DIR" && bash scripts/oss-gate.sh --list-scanned | grep -c '^loop/src/')"
if [[ "$n_scanned" -ge 1 ]]; then ok "the internal-refs scan covers loop/src ($n_scanned files)"
else bad "the internal-refs scan covers no file under loop/src"; fi

echo "== 3. vitest suite =="
if ( cd "$LOOP_DIR" && npm test ) >/tmp/loop-vitest.$$ 2>&1; then ok "loop vitest suite passes"
else bad "loop vitest suite failed"; tail -25 /tmp/loop-vitest.$$ | sed 's/^/      /'; fi
rm -f /tmp/loop-vitest.$$

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
