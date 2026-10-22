#!/usr/bin/env bash
# contributing-stub.test.sh — checks the CONTRIBUTING.md stub at the repo root:
# the file exists, line 1 is exactly "# Contributing", and at least one more
# non-empty line follows. Exit 0 = pass, 1 = fail.
#
# USAGE:  bash scripts/test/contributing-stub.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FILE="${CONTRIBUTING_FILE:-$REPO_DIR/CONTRIBUTING.md}"
EXPECTED_FIRST_LINE="# Contributing"
MIN_EXTRA_NONEMPTY_LINES=1

fail() { printf '  [FAIL] %s\n' "$*"; exit 1; }

[[ -f "$FILE" ]] || fail "missing: $FILE"
first="$(head -n 1 "$FILE")"
[[ "$first" == "$EXPECTED_FIRST_LINE" ]] || fail "first line is '$first', expected '$EXPECTED_FIRST_LINE'"
extra="$(tail -n +2 "$FILE" | grep -c '[^[:space:]]')"
(( extra >= MIN_EXTRA_NONEMPTY_LINES )) || fail "only $extra non-empty line(s) after the heading, need $MIN_EXTRA_NONEMPTY_LINES"
printf '  [PASS] %s: heading + %s non-empty line(s)\n' "$FILE" "$extra"
