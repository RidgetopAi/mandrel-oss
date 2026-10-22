#!/usr/bin/env bash
# Docs install pointers (stranger test #3 GAP-4/5/6, NIT-1/3):
#  - every doc line naming the Node 22 requirement has a nodejs.org link within 3 lines;
#  - connect-an-agent.md links the Claude Code install page before its first `claude mcp add`;
#  - supersession.md names possibly_supersedes and does not claim a plain supersedes edge is added;
#  - every project_create curl in the README/manual/loop docs sends X-Actor-ID;
#  - the documented `npm pack` leaves no untracked .tgz (git ignores it).
# Usage: bash scripts/test/docs-install-pointers.test.sh   ($DOCS_ROOT overrides the repo root)
# Exit codes: 0 passed · 1 a check failed · 2 could not measure
set -uo pipefail
ROOT="${DOCS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT" || { echo "docs-install-pointers CANNOT MEASURE: no $ROOT" >&2; exit 2; }
command -v git >/dev/null || { echo "docs-install-pointers CANNOT MEASURE: git missing" >&2; exit 2; }
fail=0; bad() { echo "docs-install-pointers FAIL: $*" >&2; fail=1; }

DOCS=(README.md loop/README.md docs/manual/*.md docs/loop/*.md)
n=0
for f in "${DOCS[@]}"; do
  [[ -f "$f" ]] || continue
  while IFS=: read -r ln _; do
    n=$((n+1)); lo=$((ln>3?ln-3:1)); hi=$((ln+3))
    win=$(sed -n "${lo},${hi}p" "$f")
    grep -q 'https\?://nodejs\.org' <<<"$win" || bad "$f:$ln names Node 22 with no nodejs.org link within 3 lines"
  done < <(grep -nE 'Node(\.js)? 22' "$f")
done
[[ $n -gt 0 ]] || bad "no line names the Node 22 requirement (check is vacuous)"

c=docs/manual/connect-an-agent.md
first_add=$(grep -n 'claude mcp add' "$c" | head -1 | cut -d: -f1)
link=$(grep -nE 'https://docs\.(claude|anthropic)\.com/[^ )>]*claude-code|https://claude\.com/claude-code' "$c" | head -1 | cut -d: -f1)
{ [[ -n "$first_add" && -n "$link" ]] && (( link < first_add )); } || bad "$c: Claude Code install link (line ${link:-none}) not before first 'claude mcp add' (line ${first_add:-none})"

s=docs/manual/supersession.md
grep -q 'possibly_supersedes' "$s" || bad "$s does not mention possibly_supersedes"
grep -qiE 'adds a `supersedes` edge|supersedes. edge is added' "$s" README.md && bad "plain 'supersedes edge is added' claim remains"

m=0
for f in "${DOCS[@]}"; do
  [[ -f "$f" ]] || continue
  while IFS= read -r ln; do
    m=$((m+1))
    win=$(sed -n "${ln},$((ln+8))p" "$f")
    grep -q 'X-Actor-ID' <<<"$win" || bad "$f:$ln project_create curl sends no X-Actor-ID"
  done < <(grep -n 'curl.*/project_create' "$f" | cut -d: -f1)
done
[[ $m -gt 0 ]] || bad "no project_create curl found (check is vacuous)"

git check-ignore -q loop/mandrel-loop-0.0.0.tgz || bad "a packed .tgz is not covered by .gitignore"

exit $fail
