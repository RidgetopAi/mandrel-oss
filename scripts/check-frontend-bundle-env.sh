#!/usr/bin/env bash
# =============================================================================
# check-frontend-bundle-env.sh — no env-object dump / no VITE_ key may ship in
# the built Command-UI frontend bundle.
#
# THE CLASS THIS GUARDS
#   A single dynamic read (`import.meta.env[name]`) makes Vite inline the ENTIRE
#   env object into the chunk — every loaded VITE_ var, readers or not. On the
#   on-host deploy paths that meant the untracked frontend/.env.production.local
#   shipped verbatim to every tenant (measured 2026-08-03: VITE_MCP_BASE_URL, a
#   var with NO reader in src, present in 3 chunks of prod's build/assets).
#
# WHY THIS IS THE CHOKE POINT (CLASSES.md C3)
#   Source-level bans (the .eslintrc.cjs env-access rule) catch the shapes they
#   enumerate; the BUILT BUNDLE is what every leak — any shape, any tool, any
#   future path — must pass through. This script hands the verdict to the
#   artifact itself.
#
# POPULATION SCANNED (stated per C3): every *.js file under the given build dir,
#   recursively. Source maps (*.js.map) are EXCLUDED on purpose: they embed the
#   original SOURCE (which legitimately names VITE_ vars in comments/types); env
#   VALUES only ever land in the executable .js, which is what browsers load.
#
# WHAT IS RED
#   P1  any VITE_* KEY NAME surviving in shipped JS. After static replacement a
#       read leaves only its VALUE — a surviving KEY NAME means the env object
#       (or its key list) was embedded.
#   P2  Vite's env-object literal itself — the five standard keys in their fixed
#       order (measured from a real mutated build:
#       `{BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,SSR:!1,...}`). This
#       catches a dynamic read even when ZERO VITE_ vars are loaded (the CI
#       clean-checkout case, where P1 has nothing to bite on).
#
# ON RED THIS SCRIPT PRINTS KEY NAMES ONLY — NEVER VALUES. Its output flows to
#   CI logs, deploy output, and chat failure text; an env file can
#   hold secrets, and a guard that prints the secret it just caught has
#   recreated the leak one surface over (Reviewer finding F1 on this task).
#   Anyone diagnosing a RED reads the VALUE off the named file locally, where
#   the leak already is — the report never needs to carry it.
#
# FALSE-POSITIVE POLICY (C3 corollary — a guard that blocks correct work gets
#   deleted): a legit hit is expected to be ~never (the fixed tree ships zero
#   VITE_ text; verified as the control). If one ever appears, amend the pattern
#   HERE with a written reason — no env-var kill switch is provided, deliberately.
#
# EXIT CODES — three states, never conflated (CLASSES.md C1):
#   0  GREEN  — scanned, nothing found
#   1  RED    — env leak found in shipped JS
#   2  CANNOT MEASURE — no build dir / no JS files / the instrument itself
#      failed; NOT a green
# =============================================================================
set -u

# LOCALE PIN — load-bearing, do not remove (Reviewer F4, measured 2026-08-03).
# The deploy population runs TWO greps: GNU 3.11 on prod-host (LANG=en_US.UTF-8),
# GNU 3.12 on the control host (C.UTF-8). grep 3.11's `[ -~]` RANGE semantics are
# locale-dependent: under en_US.UTF-8 the P2 signature pattern returns rc=1
# ("no match") against a file that literally contains the env dump — a wrong
# answer that LOOKS measured, so the three-state handling below correctly does
# not fire and the hole is silent. Same command under LC_ALL=C matches.
# Pinning here covers every grep/sort/range in this file at once (the repo
# idiom — the CI gate pins LC_ALL=C for sort in three places).
export LC_ALL=C

# --- named patterns (configs-not-hardcoded: the tunables live here, once) ----
# P1: a VITE_ env KEY NAME in shipped JS.
#   * The LEFT BOUNDARY `(^|[^A-Za-z0-9_])` is load-bearing: without it an
#     unrelated identifier like INVITE_CODE submatches as VITE_CODE — a real
#     false-positive class (Reviewer finding F3), and a guard that REDs on
#     legitimate code gets deleted. POSIX ERE has no \b, so the boundary is
#     spelled as a group; the display code below strips the captured boundary
#     character before printing. No right boundary is needed — any run of
#     identifier chars after VITE_ IS the key name being detected.
#   * `{2,}` requires two-plus identifier chars after the prefix. Stated
#     honestly: the literal five-char string "VITE_" alone does NOT trip this,
#     by design — a bare prefix names no key and can carry no value.
readonly P1_VITE_KEY='(^|[^A-Za-z0-9_])VITE_[A-Za-z0-9_]{2,}'
# P2: Vite's inlined env-object signature — the five standard keys, fixed order,
# tolerant of minified (!0/!1, unquoted keys) and unminified (quoted) output.
# The gap matcher is [ -~] (printable ASCII), NOT `.`. Measured population,
# 2026-08-03: GNU grep 3.11 on prod-host (the prod build host) and
# GNU grep 3.12 on the control host (where the CI gate STAGE 5b gate runs); grep 3.11's
# `[ -~]` range semantics are LOCALE-DEPENDENT, which is why this script pins
# LC_ALL=C at the top — without the pin, prod-host's en_US.UTF-8 turned this
# pattern into a silent rc=1 miss against a real dump (Reviewer F4). The
# class is kept over `.` because Claude Code agent INTERACTIVE shells shim
# `grep` to ugrep via a shell function (not exported to child processes), and
# ugrep expands `.` into a UTF-8 multibyte alternation and rejects the bounded
# repeat as "exceeds complexity limits" — with the pin, an agent re-running
# the pattern by hand gets the gate's verdict instead of an instrument error.
# Minified JS here is ASCII. (The rc>1 handling below makes any future
# instrument failure loud rather than a silent pass.)
readonly P2_ENV_DUMP='["'\'']?BASE_URL["'\'']?:[ -~]{1,80}["'\'']?DEV["'\'']?:[ -~]{1,16}["'\'']?MODE["'\'']?:[ -~]{1,60}["'\'']?PROD["'\'']?:[ -~]{1,16}["'\'']?SSR["'\'']?:'

BUILD_DIR="${1:-}"

if [[ -z "$BUILD_DIR" ]]; then
  echo "check-frontend-bundle-env: CANNOT MEASURE — no build dir argument given." >&2
  echo "usage: $0 <frontend-build-dir>" >&2
  exit 2
fi
if [[ ! -d "$BUILD_DIR" ]]; then
  echo "check-frontend-bundle-env: CANNOT MEASURE — build dir '$BUILD_DIR' does not exist." >&2
  exit 2
fi

mapfile -t JS_FILES < <(find "$BUILD_DIR" -type f -name '*.js' ! -name '*.map' | sort)
if [[ "${#JS_FILES[@]}" -eq 0 ]]; then
  echo "check-frontend-bundle-env: CANNOT MEASURE — zero .js files under '$BUILD_DIR'." >&2
  echo "(an empty population is the value that slips through — this is NOT a green)" >&2
  exit 2
fi

# Scratch for grep's stderr — mktemp'd, because parallel gate/deploy runs share
# /tmp and a fixed filename would interleave two runs' diagnostics (Reviewer N2).
GREP_ERR="$(mktemp "${TMPDIR:-/tmp}/check-fe-bundle-env.XXXXXX")" || {
  echo "check-frontend-bundle-env: CANNOT MEASURE — mktemp failed." >&2
  exit 2
}
trap 'rm -f "$GREP_ERR"' EXIT

FAIL=0
for pat_name in P1_VITE_KEY P2_ENV_DUMP; do
  pat="${!pat_name}"
  # -a: minified JS can trip grep's binary heuristic; these are text files.
  # THREE STATES, kept separate (CLASSES.md C1): grep rc 0 = match, 1 = no
  # match, >1 = grep itself failed (pattern rejection, I/O error). A failed
  # instrument is CANNOT MEASURE, never "no leak".
  GREP_RC=0
  hits="$(grep -alE "$pat" "${JS_FILES[@]}" 2>"$GREP_ERR")" || GREP_RC=$?
  if [[ "$GREP_RC" -gt 1 ]]; then
    echo "check-frontend-bundle-env: CANNOT MEASURE — grep failed (rc=$GREP_RC) on pattern $pat_name:" >&2
    sed 's/^/  | /' "$GREP_ERR" >&2
    exit 2
  fi
  if [[ -n "$hits" ]]; then
    FAIL=1
    echo "RED [$pat_name]: env leak in shipped frontend JS:"
    while IFS= read -r f; do
      echo "  $f"
      # KEY NAMES ONLY — never a context window. A window around the match
      # captures the VALUE sitting next to the key, and this output flows to CI
      # logs / deploy output / chat (Reviewer F1: a canary VALUE printed
      # verbatim here). Display-only, so a failure must not mask the RED (|| true).
      if [[ "$pat_name" == "P1_VITE_KEY" ]]; then
        # PIPEFAIL-BOOLEAN-OK: status is not consumed. The `|| true` here is
        # pre-existing and deliberate (display-only rendering must never mask the
        # RED that the caller already decided); nothing downstream branches on this
        # pipeline's exit code, so a SIGPIPE-promoted 141 changes no decision.
        grep -aoE "$pat" "$f" 2>/dev/null \
          | sed 's/^[^A-Za-z0-9_]*//' | sort -u | head -10 \
          | sed 's/^/    leaked key: /' || true
      else
        echo "    | Vite env-object literal signature present (BASE_URL/DEV/MODE/PROD/SSR, in order)"
      fi
    done <<<"$hits"
  fi
done

if [[ "$FAIL" -eq 1 ]]; then
  echo
  echo "The built bundle contains env-object material. Root causes to check:"
  echo "  * a dynamic/aliased 'import.meta.env' read in src (run: npm run lint)"
  echo "  * an env file loaded into the build that should not exist (envDir is"
  echo "    pinned to frontend/env/ — see vite.config.ts)"
  exit 1
fi

echo "check-frontend-bundle-env: GREEN — ${#JS_FILES[@]} js files scanned, no env dump, no VITE_ keys."
exit 0
