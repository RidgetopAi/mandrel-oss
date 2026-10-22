#!/usr/bin/env bash
# =============================================================================
# check-no-nul-bytes.sh — no tracked TEXT file may contain a NUL byte.
# =============================================================================
# WHY THIS EXISTS (folded in from lane M-7)
#   A NUL byte was shipped inside a TypeScript file. Git classifies a blob
#   containing a NUL as BINARY, so `git diff` renders it as
#
#       Binary files a/foo.ts and b/foo.ts differ
#
#   and the change becomes UNREVIEWABLE. A script carrying a live UPDATE
#   statement reached review that way. Nothing caught it: not the test suite
#   (the file still parsed), not tsc, not gitleaks (which scans for secret
#   SHAPES, and a redacted binary blob has none).
#
#   That is the real cost and it is not "a weird character got in". It is that
#   the review surface silently stopped showing the diff, so the guard that
#   catches everything else — a human reading the change — was switched off
#   with no signal.
#
# THE POPULATION THIS GUARD ENUMERATES, STATED PRECISELY (CLASSES.md C3)
#   Every file TRACKED BY GIT whose name matches one of TEXT_GLOBS below,
#   anywhere in the repository. `git ls-files` is the enumerator on purpose:
#     - it is the index, so it cannot be narrowed by a .gitignore, by the
#       directory the author happened to be standing in, or by a tool that
#       silently skips symlinks;
#     - it covers the WHOLE repo, not one package.
#   Untracked files are deliberately OUT of scope: a NUL only becomes a
#   review problem once it is committed, and this runs before that.
#
# WHAT IT MATCHES
#   The presence of at least one 0x00 byte in the file's bytes. That is the
#   exact property git uses to call a blob binary, so this guard and the thing
#   it protects against are the same predicate — there is no gap to evade and
#   no regex to sharpen. No claim is made about any other unreviewable-diff
#   cause (a huge minified line, a .gitattributes override); those are
#   different problems and this guard does not pretend to cover them.
#
# THERE IS NO ALLOWLIST, AND NONE IS NEEDED — the escape is the escape hatch.
#   This guard forbids a RAW NUL byte in a text file. It does not forbid the
#   VALUE zero: every language here can write it as an escape ('\u0000' in
#   TS/JS, '\x00' in a shell $'...'), which is the identical string at runtime
#   and leaves the file diffable. So legitimate uses have a first-class
#   spelling and never need an exception — which matters, because a guard with
#   a named-exception mechanism is a guard with an off switch.
#
#   This is not theoretical. The FIRST run of this guard, against the base ref,
#   found TWO pre-existing offenders that had been in shipped history for
#   weeks and that nobody had noticed:
#     mandrel-command/backend/src/__tests__/profileIdentityHardening.test.ts
#       — a test case feeding a username containing a NUL
#     mcp-server/src/config/handoffCarriedFieldsConfig.ts
#       — a NUL-prefixed sentinel, chosen because no env var can contain a NUL
#   Both intents were correct and both are still expressed, as escapes. Two
#   whole files had been undiffable in review and no signal existed to say so.
#
# EXIT CODES — three states, never two (CLASSES.md C1)
#   0  GREEN — a non-empty population was scanned and no NUL was found
#   1  RED   — at least one file contains a NUL; every offender is NAMED
#   2  CANNOT MEASURE — not a git repo, or the population came back EMPTY.
#      An empty population is NOT a pass: a scanner over nothing reports the
#      same GREEN as a clean repo, and that is how this guard would rot.
#
# USAGE
#   bash scripts/check-no-nul-bytes.sh            # every tracked text file
#   bash scripts/check-no-nul-bytes.sh --staged   # only what is staged, read
#                                                 # from the INDEX (what is
#                                                 # about to become history)
#
# SINGLE SOURCE. Both callers run THIS file, so the rule exists once:
#   - hooks/pre-commit           -> --staged, blocks the byte before history
#   - mcp-server/src/tests/noNulBytesInTrackedText.contract.test.ts
#                                -> full scan, rides the gate's vitest stage
#                                   where nothing can bypass it
# =============================================================================
set -uo pipefail

# ── CONFIG ───────────────────────────────────────────────────────────────────
# The text kinds a human is expected to READ in a diff. Extend this list when a
# new readable kind appears; do NOT add a per-file exception (see the header —
# a named exception is an off switch, and the escape spelling makes one
# unnecessary).
TEXT_GLOBS=('*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.md' '*.json' '*.sql' '*.sh' '*.bash' '*.yml' '*.yaml')

RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'

STAGED=0
case "${1:-}" in
  --staged) STAGED=1 ;;
  '') ;;
  *) printf 'usage: %s [--staged]\n' "$0" >&2; exit 2 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf '%s[no-nul] CANNOT MEASURE: not inside a git repository.%s\n' "$RED" "$RST" >&2
  exit 2
}
cd "$REPO_ROOT" || exit 2

# ── ENUMERATE ────────────────────────────────────────────────────────────────
# -z + a NUL-delimited read: a path containing a newline cannot silently split
# one entry into two and drop half the population.
files=()
if (( STAGED )); then
  # Added/copied/modified/renamed only — a DELETED path has no blob to read.
  while IFS= read -r -d '' f; do files+=("$f"); done < <(
    git diff --cached --name-only --diff-filter=ACMR -z -- "${TEXT_GLOBS[@]}"
  )
else
  while IFS= read -r -d '' f; do files+=("$f"); done < <(
    git ls-files -z -- "${TEXT_GLOBS[@]}"
  )
fi

if (( ${#files[@]} == 0 )); then
  if (( STAGED )); then
    # Nothing staged that this guard covers is a legitimate no-op, not a
    # failure to measure — the hook must not block a commit of, say, only .png.
    printf '%s[no-nul] no staged text files to scan — nothing to check.%s\n' "$GRN" "$RST"
    exit 0
  fi
  printf '%s[no-nul] CANNOT MEASURE: the tracked-text population is EMPTY.%s\n' "$RED" "$RST" >&2
  printf '  Expected thousands of files from `git ls-files`. An empty population\n' >&2
  printf '  would report the same GREEN as a clean repo, so this is a hard error.\n' >&2
  exit 2
fi

# ── THE PREDICATE, plus a SELF-CHECK that fails CLOSED ──────────────────────
# `grep -P '\x00'` is the fastest correct spelling (0.07s over ~1,750 files vs
# 40s for a per-file `tr -d`), but -P is a build-time option: the control host runs
# ugrep, CI runs GNU grep, and a grep without PCRE would print an error to
# stderr and exit non-zero-but-not-1 — which a careless caller reads as "no
# matches", i.e. a silent GREEN over an unscanned population.
#
# So the predicate is exercised against a synthetic POSITIVE and a synthetic
# NEGATIVE before it is trusted. If either answer is wrong, this exits 2
# (CANNOT MEASURE) rather than reporting on a scan it could not perform.
has_nul() { grep -qaP '\x00'; }   # stdin -> 0 = NUL present, 1 = absent

if ! printf 'a\000b' | has_nul; then
  printf '%s[no-nul] CANNOT MEASURE: the NUL predicate did not match a NUL byte.%s\n' "$RED" "$RST" >&2
  printf '  `grep -P` is probably unavailable in this environment. Refusing to\n' >&2
  printf '  report GREEN from a predicate that cannot detect the thing it looks for.\n' >&2
  exit 2
fi
if printf 'ab' | has_nul; then
  printf '%s[no-nul] CANNOT MEASURE: the NUL predicate matched NUL-free input.%s\n' "$RED" "$RST" >&2
  exit 2
fi

# ── SCAN ─────────────────────────────────────────────────────────────────────
offenders=()
if (( STAGED )); then
  # Read each blob from the INDEX — the bytes that are about to become history,
  # which are not necessarily the bytes in the worktree.
  for f in "${files[@]}"; do
    if git show ":$f" 2>/dev/null | has_nul; then offenders+=("$f"); fi
  done
else
  # One batched grep over the whole population.
  while IFS= read -r f; do
    [[ -n "$f" ]] && offenders+=("$f")
  done < <(printf '%s\0' "${files[@]}" | xargs -0 -r grep -laP '\x00' 2>/dev/null)
fi

if (( ${#offenders[@]} > 0 )); then
  printf '\n%s%s[no-nul] BLOCKED: %d tracked text file(s) contain a NUL byte.%s\n' \
    "$BLD" "$RED" "${#offenders[@]}" "$RST" >&2
  for o in "${offenders[@]}"; do printf '  %s\n' "$o" >&2; done
  printf '\n%s  Git renders these as `Binary files ... differ`, so their diff is\n' "$RED" >&2
  printf '  UNREVIEWABLE — the change would reach review with its contents hidden.\n' >&2
  printf '  If the NUL is ACCIDENTAL, strip it:\n' >&2
  printf '    tr -d %s\\000%s < FILE > FILE.clean && mv FILE.clean FILE\n' "'" "'" >&2
  printf '  If the VALUE zero is INTENDED, write it as an escape instead — same string at\n' >&2
  printf '  runtime, diffable file:  %s\\u0000%s in TS/JS, $%s\\x00%s in shell.%s\n' "'" "'" "'" "'" "$RST" >&2
  exit 1
fi

printf '%s[no-nul] %d tracked text file(s) scanned, no NUL bytes.%s\n' "$GRN" "${#files[@]}" "$RST"
exit 0
