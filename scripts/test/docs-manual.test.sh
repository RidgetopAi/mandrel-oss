#!/usr/bin/env bash
# The user manual (docs/manual/) and every other doc under docs/ must not rot: no link to a missing
# file or heading anchor, no MANDREL_* name that docs/reference/configuration.md does not list, all
# seven manual chapters present, README.md linking the manual. The checks live in lib/docs-check.mjs.
# Self-test (anti-vacuity): on a throwaway copy of the docs an unmutated control must be GREEN and each
# seeded defect must be RED with a finding that names it.
# Usage: bash scripts/test/docs-manual.test.sh [--check-only]   ($DOCS_CHECK_ROOT overrides the repo root)
# Exit codes: 0 passed · 1 a check failed · 2 could not measure
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DOCS_CHECK_ROOT:-$(cd "$HERE/../.." && pwd)}"
CHECK="$HERE/lib/docs-check.mjs"
command -v node >/dev/null 2>&1 || { echo "docs-manual CANNOT MEASURE: node is not on PATH" >&2; exit 2; }
[[ -f "$CHECK" ]] || { echo "docs-manual CANNOT MEASURE: $CHECK missing" >&2; exit 2; }

if ! node "$CHECK" "$ROOT"; then echo "docs-manual: the docs under docs/ have problems (above)" >&2; exit 1; fi
[[ "${1:-}" == "--check-only" ]] && exit 0

# --- self-test on a copy ---------------------------------------------------------------------------
tmp="$(mktemp -d "${TMPDIR:-/tmp}/docs-manual.XXXXXX")" || { echo "docs-manual CANNOT MEASURE: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$tmp"' EXIT
# A copy of docs/ and README.md; every other top-level entry is a symlink, so links out of docs/ still resolve.
fresh() {
  local e; rm -rf "$tmp/r"; mkdir -p "$tmp/r"
  for e in "$ROOT"/* "$ROOT"/.[!.]*; do
    [[ -e "$e" ]] || continue
    case "${e##*/}" in docs|README.md|.git) ;; *) ln -s "$e" "$tmp/r/${e##*/}" ;; esac
  done
  cp -r "$ROOT/docs" "$tmp/r/docs"; cp "$ROOT/README.md" "$tmp/r/README.md"
}
bad=0
expect_red() { # <name> <expected finding substring>
  local out; out="$(node "$CHECK" "$tmp/r" 2>&1)" && { echo "docs-manual FAIL: mutant '$1' was not detected" >&2; bad=1; return; }
  grep -qF -- "$2" <<<"$out" || { echo "docs-manual FAIL: mutant '$1' went RED without naming '$2': $out" >&2; bad=1; }
}

fresh
node "$CHECK" "$tmp/r" >/dev/null 2>&1 || { echo "docs-manual FAIL: control (unmutated copy) is not GREEN" >&2; bad=1; }

fresh; printf '\nSee [gone](missing-chapter.md).\n' >> "$tmp/r/docs/manual/index.md"
expect_red "link to a missing file" "links missing file: missing-chapter.md"
fresh; printf '\nSee [gone](install.md#no-such-heading).\n' >> "$tmp/r/docs/manual/index.md"
expect_red "link to a missing heading" "install.md#no-such-heading"
fresh; printf '\nSet MANDREL_NOT_A_REAL_SETTING=1.\n' >> "$tmp/r/docs/manual/supersession.md"
expect_red "unknown MANDREL_* setting" "MANDREL_NOT_A_REAL_SETTING"
fresh; rm "$tmp/r/docs/manual/operations.md"
expect_red "missing chapter" "docs/manual/operations.md is missing"
fresh; sed -i 's#(docs/manual/index.md)#(docs/manual/nope.md)#' "$tmp/r/README.md"
expect_red "README no longer links the manual" "README.md"

(( bad == 0 )) || exit 1
echo "docs-manual: ok (control GREEN, 5 mutants RED)"
