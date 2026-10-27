#!/usr/bin/env bash
# NOT-IN-CI: run by scripts/oss-gate.sh stage H (every scripts/test/*.test.sh); not a CI gate stage.
#
# Executes every fenced bash block in loop/README.md whose first line is `# doctest`, in order, in
# one throwaway directory, against the real CLI wired to a FakeBoard (loop/test/support/doctest-cli.ts)
# and stand-in `claude` and `gh` programs on PATH. Fails on any non-zero block, on fewer than
# $LOOP_DOCTEST_MIN_BLOCKS blocks, or when the executed blocks do not cover every command in
# $REQUIRED_COMMANDS. Each block runs in its own bash, so it must set up its own environment.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP="$REPO/loop"
README="${LOOP_DOCTEST_README:-$LOOP/README.md}"
MIN_BLOCKS="${LOOP_DOCTEST_MIN_BLOCKS:-5}"
REQUIRED_COMMANDS=("mandrel-loop doctor" "mandrel-loop once" "mandrel-loop status" "mandrel-loop lint" "mandrel-loop service --print")
BUILD="$LOOP/.doctest-build"

fail() { echo "loop-readme-doctest FAIL: $*" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loop-doctest.XXXXXX")" || fail "mktemp failed"
trap 'rm -rf "$BUILD" "$WORK"' EXIT

[[ -f "$README" ]] || fail "no README at $README"
cd "$LOOP" || fail "cannot cd to $LOOP"
[[ -x node_modules/.bin/tsc ]] || npm ci --silent >/dev/null 2>&1 || fail "npm ci failed in loop/"

rm -rf "$BUILD"
node_modules/.bin/tsc --outDir "$BUILD" --rootDir . --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --strict --skipLibCheck --types node test/support/doctest-cli.ts || fail "doctest CLI does not compile"
ln -s "$LOOP/cards" "$BUILD/cards"
ln -s "$LOOP/package.json" "$BUILD/package.json"
# FakeBoard reads its server rules from the punch-contract golden, which tsc does not emit.
ln -s "$LOOP/test/fixtures" "$BUILD/test/fixtures"

# Stand-ins: `mandrel-loop` (real CLI, FakeBoard), `gh` (auth succeeds), `claude` (prints an empty plan).
BIN="$WORK/bin"; mkdir -p "$BIN" "$WORK/home" "$WORK/run"
printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$BUILD/test/support/doctest-cli.js" >"$BIN/mandrel-loop"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/gh"
printf '#!/usr/bin/env bash\ncat >/dev/null\necho "[]"\n' >"$BIN/claude"
chmod +x "$BIN"/*

# Extract: a block opens at ```bash and counts only when its first line is `# doctest`.
mkdir -p "$WORK/blocks"
awk -v dir="$WORK/blocks" '
  /^```bash[ \t]*$/ && !inb { inb=1; first=1; keep=0; next }
  /^```[ \t]*$/ && inb { inb=0; if (keep) close(f); next }
  inb && first { first=0; if ($0 ~ /^# doctest[ \t]*$/) { keep=1; n++; f=sprintf("%s/%03d.sh", dir, n); print > f } ; next }
  inb && keep { print > f }
' "$README"

shopt -s nullglob
blocks=("$WORK"/blocks/*.sh)
(( ${#blocks[@]} >= MIN_BLOCKS )) || fail "found ${#blocks[@]} '# doctest' block(s) in $README, need at least $MIN_BLOCKS"

ran=0
for b in "${blocks[@]}"; do
  ran=$((ran + 1))
  echo "--- doctest block $ran/${#blocks[@]}"
  sed 1d "$b" | sed 's/^/  | /'
  out="$(cd "$WORK/run" && env -i PATH="$BIN:$PATH" HOME="$WORK/home" LANG=C bash -euo pipefail "$b" 2>&1)"; rc=$?
  [[ -n "$out" ]] && sed 's/^/  > /' <<<"$out"
  (( rc == 0 )) || fail "block $ran exited $rc"
done

for cmd in "${REQUIRED_COMMANDS[@]}"; do
  grep -qF -- "$cmd" "${blocks[@]}" || fail "no executed block covers: $cmd"
done
echo "loop-readme-doctest: executed $ran doctest blocks"
echo "loop-readme-doctest PASS"
