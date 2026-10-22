#!/usr/bin/env bash
# Every tracked .md must match the allow-list in scripts/oss-gate/md-allowlist.txt; a stranger finds
# internal engineering reports first, so a stray one fails the gate and is NAMED.
# Measures the git INDEX (like the rest of oss-gate). $MD_ALLOWLIST_ROOT overrides the repo root and
# $MD_ALLOWLIST_FILE the list (relative to the root) — for mutation probes.
set -uo pipefail

ROOT="${MD_ALLOWLIST_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LIST="$ROOT/${MD_ALLOWLIST_FILE:-scripts/oss-gate/md-allowlist.txt}"

[[ -r "$LIST" ]] || { echo "md-allowlist CANNOT MEASURE: allow-list missing: $LIST" >&2; exit 2; }
patterns=()
while IFS= read -r line; do
  line="${line%%$'\r'}"
  [[ -z "${line// }" || "$line" == \#* ]] && continue
  patterns+=("${line//\*\*/*}")
done < "$LIST"
((${#patterns[@]})) || { echo "md-allowlist FAIL: $LIST has no patterns (a hollow allow-list admits nothing)" >&2; exit 1; }

files="$(git -C "$ROOT" ls-files -z -- '*.md' '*.MD' '*.markdown' 2>/dev/null | tr '\0' '\n')" \
  || { echo "md-allowlist CANNOT MEASURE: git ls-files failed" >&2; exit 2; }

total=0; fails=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  total=$((total + 1))
  ok=0
  for p in "${patterns[@]}"; do
    # shellcheck disable=SC2053
    [[ "$f" == $p ]] && { ok=1; break; }
  done
  if ((!ok)); then echo "md-allowlist FAIL: tracked Markdown outside the allow-list: $f" >&2; fails=$((fails + 1)); fi
done <<< "$files"

((total > 0)) || { echo "md-allowlist FAIL: no tracked .md found (vacuous measurement)" >&2; exit 1; }
if ((fails)); then echo "md-allowlist: $fails of $total tracked .md file(s) outside ${LIST#"$ROOT"/}" >&2; exit 1; fi
echo "md-allowlist ok: $total tracked .md file(s), all on the allow-list"
