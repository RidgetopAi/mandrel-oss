#!/usr/bin/env bash
# NOT-IN-CI: run by scripts/oss-gate.sh stage H (every scripts/test/*.test.sh); not a the CI gate stage.
#
# Docs a stranger follows must resolve. Checks (1) README.md links loop/README.md, (2) every relative
# Markdown link in README.md, loop/README.md and each docs-folder file they link points at an
# existing file, (3) loop/README.md names the setup steps a first run needs.
# $DOC_LINKS_ROOT overrides the repository root (the self-test points it at a mutated copy).
set -uo pipefail

ROOT="${DOC_LINKS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
fails=0
fail() { echo "doc-links FAIL: $*" >&2; fails=$((fails + 1)); }

# Prints "<target>" for each relative link target in a file (anchors/queries stripped, fences skipped).
links_of() {
  awk '/^```/ { f = !f; next } !f' "$1" \
    | grep -oE '\]\([^)[:space:]]+\)' | sed -E 's/^\]\(//; s/\)$//' \
    | grep -vE '^(https?:|mailto:|#)' | sed -E 's/[#?].*$//' | grep -v '^$' || true
}

declare -A seen=()
queue=("$ROOT/README.md" "$ROOT/loop/README.md")
while ((${#queue[@]})); do
  file="${queue[0]}"; queue=("${queue[@]:1}")
  [[ -n "${seen[$file]:-}" ]] && continue
  seen[$file]=1
  [[ -f "$file" ]] || { fail "doc file missing: ${file#"$ROOT"/}"; continue; }
  dir="$(dirname "$file")"
  while IFS= read -r target; do
    [[ -z "$target" ]] && continue
    resolved="$(cd "$dir" 2>/dev/null && realpath -m -- "$target")"
    if [[ ! -e "$resolved" ]]; then
      fail "${file#"$ROOT"/} links missing file: $target"
    elif [[ "$resolved" == "$ROOT/docs/"* && "$resolved" == *.md ]]; then
      queue+=("$resolved")
    fi
  done < <(links_of "$file")
done

grep -qE '\]\(loop/README\.md\)' "$ROOT/README.md" 2>/dev/null || fail "README.md does not link loop/README.md"

LR="$ROOT/loop/README.md"
need() { grep -qE -- "$2" "$LR" 2>/dev/null || fail "loop/README.md lacks $1 (/$2/)"; }
need "gh auth setup-git" 'gh auth setup-git'
need "git config user.email" 'git config .*user\.email'
need "a project_create example with X-Connection-ID" 'X-Connection-ID: .*'
need "the project_create request" 'mcp/tools/project_create'
need "the ready command" 'mandrel-loop ready <task-id>'
need "a non-npm-link install" 'npm install -g --prefix'
models="$(grep -oE '"(worker|critic)": "[^"]+"' "$LR" | grep -E '^"(worker|critic)": "claude-' | sed -E 's/^"[a-z]+": //' | sort -u | wc -l)"
(( models >= 2 )) || fail "loop/README.md has no worker and critic example with two different model ids"

(( fails == 0 )) || { echo "doc-links: $fails problem(s)" >&2; exit 1; }
echo "doc-links: ok (${#seen[@]} docs checked)"
