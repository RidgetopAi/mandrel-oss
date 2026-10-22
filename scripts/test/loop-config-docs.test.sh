#!/usr/bin/env bash
# Every config key the loop's loader (loop/src/settings.ts) accepts must have a row in
# docs/loop/runtime-setup.md, and no row may name a key the loader rejects. The key set is DERIVED
# from the loader's schema by loop/test/config-keys-documented.test.ts; a failure names the key.
#
# USAGE:  bash scripts/test/loop-config-docs.test.sh
# Exit: 0 green, 1 a key is undocumented or stale, 2 could not measure.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG (named, not hardcoded in the logic below) --------------------------
LOOP_DIR="${LOOP_DIR:-$REPO_DIR/loop}"
KEY_TEST="${KEY_TEST:-test/config-keys-documented.test.ts}"

command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || { echo "CANNOT MEASURE: node/npm not on PATH" >&2; exit 2; }
if [[ ! -d "$LOOP_DIR/node_modules" ]]; then
  ( cd "$LOOP_DIR" && npm ci --include=dev --no-audit --no-fund ) >/dev/null 2>&1 \
    || { echo "CANNOT MEASURE: npm ci failed in loop/" >&2; exit 2; }
fi

log="$(mktemp "${TMPDIR:-/tmp}/loop-config-docs.XXXXXX")"
trap 'rm -f "$log"' EXIT
if ( cd "$LOOP_DIR" && npx --no-install vitest run "$KEY_TEST" ) >"$log" 2>&1; then
  echo "  [PASS] every loader config key is documented in docs/loop/runtime-setup.md"
  exit 0
fi
grep -E 'config key "|rows in docs/loop|ENOENT' "$log" | sort -u | sed 's/^/  [FAIL] /'
echo "  --- vitest tail ---"; tail -25 "$log" | sed 's/^/      /'
exit 1
