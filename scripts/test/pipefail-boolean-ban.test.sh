#!/usr/bin/env bash
# =============================================================================
# pipefail-boolean-ban.test.sh — THE REPO-WIDE BAN on pipeline-derived booleans
# (batch 11 lane B2)
# -----------------------------------------------------------------------------
# WHAT WENT WRONG (what this guard exists to stop recurring)
#   Under `set -o pipefail`, a boolean derived from `producer | <early-exit
#   consumer>` INVERTS once the producer outgrows the 64KB pipe buffer before the
#   consumer quits. `grep -q` exits on the FIRST match, the producer is then killed
#   by SIGPIPE (141), pipefail promotes 141 to the pipeline's status — so a
#   condition that IS TRUE reads FALSE.
#
#   IT IS NOT A FLAKE. Measured in isolation with pipefail on, 200 iterations:
#     seq 1 100000 | grep -q .          ->   0/200   (100% inverted)
#     grep -q . < <(seq 1 100000)       -> 200/200   (correct)
#   The rate is a function of PRODUCER OUTPUT SIZE and MATCH POSITION, not luck.
#   Four measurements of the same defect came back 0%, 2.75%, 94% and 100%, each
#   true of its own environment (in one ~402KB environment a
#   match at byte 402,451 was caught 20/20 and a match at byte 221,324 was caught
#   0/20). So a small producer is LATENT, not safe, and "N green runs" is not
#   evidence a site is fixed. That is exactly why every one of these reviewed clean.
#
#   It reached a DEPLOY PRE-FLIGHT GATE: fleet-deploy script's origin-ref check asked
#   `git branch -r --contains "$PROD_REF" | grep -q .` — a gate that would refuse to
#   ship perfectly pushed code, confidently and wrongly, the day the remote branch
#   list got large.
#
# WHY A BAN AND NOT A FIX LIST
#   A list of fixed sites has no floor; a ban does. The predecessor assertion
#   (S10d in fleet-drift-seam-report.test script) was the right shape and
#   the wrong scope: one file, one spelling (`env | grep`). This is that same
#   assertion widened to the whole tree.
#
# THE CONTRACT
#   The FILESYSTEM is the population: every shell file in the repo (*.sh plus any
#   file whose first line is a sh/bash shebang), excluding node_modules and .git.
#   Every pipeline-derived boolean over an early-exit consumer is either
#     FIXED    — the pipeline is gone (process substitution, a herestring, or a
#                bounded primitive), or
#     EXCEPTED — carrying a CO-LOCATED `# PIPEFAIL-BOOLEAN-OK: <reason>` marker
#                within PIPEFAIL_BAN_MARKER_WINDOW lines above the finding.
#   Anything else is RED. A file the scanner cannot read or parse is a FINDING,
#   never a silent pass — the population is not allowed to shrink quietly
#   (a coverage test is an allow-list unless it fails closed).
#
#   The marker is CO-LOCATED, not a central registry — the same call
#   test-wiring-coverage.test.sh made, for the same reason: a registry drifts, a
#   co-located marker means deleting the fix without adding the marker is a visible
#   RED in the same review as the deletion. An empty/whitespace reason does NOT
#   satisfy it ("absent/zero/empty are the values that slip through").
#
# IT SCANS FILES THAT DO NOT SET pipefail, DELIBERATELY
#   Measured on this tree: 17 of the 69 findings at the time this guard was written
#   were in files that never say `set -o pipefail` — and six of those are LIBRARIES
#   under scripts/lib/ that are SOURCED into scripts which do (gate-cannot-measure.sh,
#   gate-harness-crash.sh, env-caller-restore.sh, canary-registry.sh,
#   preflight-db-password script, test/lib/fixture-harness.sh). pipefail is a property of
#   the SHELL, inherited by everything sourced into it, and a file gains
#   `set -o pipefail` in a one-line diff that nobody reviews for pipelines. Scoping
#   the ban to files that declare pipefail today would have left that whole class
#   dark, and would have added a classification step that can itself be wrong.
#
# TWO INSTRUMENTS, AND THE DIFFERENCE IS THE FINDING (the round-2 deliverable)
#   INSTRUMENT A — scripts/lib/pipefail-boolean-scan.awk, a precise character-level
#     parser. It is the only thing here that can judge BOOLEAN POSITION, and it is
#     stateful: it carries a context stack across lines because shell constructs do.
#   INSTRUMENT B — a deliberately dumb, stateless, LINE-LOCAL grep for any line
#     piping into an early-exit consumer. It over-matches enormously (422 candidate
#     lines against 5 real findings on this tree). It has no state, so it has
#     nothing to lose, so it cannot go dark.
#   INSTRUMENT C — A again, run on ONE line with no history. The adjudicator.
#   THE ASSERTION: every line B sees must be accounted for by A — either FLAGGED, or
#     not-a-finding when C re-reads that same line alone. A line B sees, A did not
#     flag, and C calls a finding is a place A WENT DARK, and that is RED.
#
#   WHY, MEASURED. Instrument A has now been caught losing its parse state SIX
#   distinct ways: `<<<` read as a heredoc (silently hid 20 of 69 findings),
#   `$(( a << b ))` read as a heredoc, a heredoc body skipped when it was generated
#   code, a `then`/`do` at end of line poisoning the next segment (hid the FIRST
#   boolean inside EVERY then/do block — the most common shape in the repo, and the
#   round-1 REJECT), a line ending inside an ordinary multi-line string, and an
#   unbalanced `$(` inside a heredoc body. Three were found by the author during
#   development, three by Reviewer after the suite reported 25/25 GREEN over them.
#
#   Every one of those was fixed by making the parser smarter, and a seventh is
#   coming, because "the parser reads clean" is the same reasoning that let the
#   original 69 sites survive review. So the guarantee does not rest on the parser
#   being right. It rests on two instruments disagreeing where one of them is blind.
#   Probe 4j is the proof: it puts the round-1 bug BACK into a copy of the detector
#   and asserts the reconciliation still turns the hidden site RED.
#
# IT OVER-MATCHES ON PURPOSE
#   There is no shfmt and no shell AST tool pinned in this gate. Both instruments
#   call safe lines. That is the correct direction of error: a false positive in a
#   ban is visible and cheap; a false negative is the bug shipping again. Resolve a
#   collision with a marker and a written reason, NEVER by narrowing either pattern.
#   DO NOT SHARPEN INSTRUMENT B. Its dumbness is load-bearing.
#
# THE ANCHOR IS WHERE THIS REPO'S GUARDS HAVE FAILED TWICE
#   db-capacity-gate.test.sh (cb2d5b5) was satisfied by a COMMENTED-OUT copy of the
#   line it checked for. Then the first version of test-wiring-coverage.test.sh
#   (ebeef7f) stripped comments with a rule requiring WHITESPACE before the `#` —
#   but bash starts a comment at the start of any WORD, and metacharacters delimit
#   words, so `:;#`, `x &#` and `y |#` all parse as comments and slipped through.
#   scripts/lib/pipefail-boolean-scan.awk therefore strips comments with that same
#   word-boundary rule, and additionally QUOTE-AWARE (so `grep -q '# tag'` survives
#   as code instead of being truncated into a miss — the false-NEGATIVE direction
#   that a sed-based strip has). Section 4 probes all five comment prefixes and the
#   quoted-hash case.
#
#   The detector is defined ONCE, in scripts/lib/pipefail-boolean-scan.awk. There are
#   exactly two call sites, both in the anchor block (pfb_unresolved for the whole
#   file, pfb_isolate_flags for one line); every assertion and every probe reaches it
#   through those, so nothing can drift away from it. Section 1 checks
#   that by POSITION rather than by count, so adding a probe cannot satisfy it.
#
# WHAT THIS DOES *NOT* PROVE — the honest scope
#   * It is a parser, not bash. It does not expand aliases and does not follow
#     `eval`. Instrument A still loses its state on multi-line strings — 25 files
#     end the parse unbalanced today, reported as !STATE-LOST and ceilinged in 3c.
#     That is TOLERATED, not fixed, and it is tolerable only because every one of
#     those files goes through the stateless reconciliation in 3b — unconditionally,
#     because pfb_unresolved runs the dumb pass on EVERY file outside the parser's
#     result block. That is the encoding; there is deliberately no separate
#     assertion restating it. One was tried and it was a tautology (both branches
#     of its `&&`/`||` incremented the same counter), so it certified coverage even
#     with instrument B disabled entirely. the reviewer caught it by deleting
#     the feature and watching the assertion still pass. Deleted rather than
#     rewritten: restating a structural property as a runtime check is what created
#     the false green in the first place.
#   * It knows four early-exit consumer families: grep with a -q/--quiet/-m flag,
#     `head`, `read`, and `sed` scripts containing a `q` command. An early-exiting
#     awk (`{... exit}`) as a CONSUMER stage is NOT recognised. That is a named
#     hole, not a claim of completeness.
#   * HEREDOC bodies ARE scanned. A script that writes out another script and runs
#     it is generating code, and the two heredoc-body hits on this tree at an earlier revision
#     were exactly that (fixture-harness.sh's SHIM block, executed as
#     $FH_DIR/bin/.fh-shim). The cost is that a fixture which deliberately carries
#     the banned shape must be built with printf or carry a marker.
#   * Contents of `<(...)` are exempt because nobody can read that status — which
#     is precisely why process substitution is the fix. A pipeline hidden inside a
#     process substitution is genuinely safe, not merely unreported.
#
# NO NETWORK, NO DB, NO DOCKER, NO PROD. Pure text analysis of tracked files plus
# throwaway copies under a mktemp dir.
#
# USAGE:  bash scripts/test/pipefail-boolean-ban.test.sh
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG (configs-not-hardcoded: every knob named, defaulted, env-overridable) ---
# The single detector implementation. Assertions AND probes both go through it.
PIPEFAIL_BAN_SCANNER="${PIPEFAIL_BAN_SCANNER:-scripts/lib/pipefail-boolean-scan.awk}"
# Directory names pruned from the population walk.
PIPEFAIL_BAN_PRUNE_DIRS="${PIPEFAIL_BAN_PRUNE_DIRS:-node_modules .git}"
# The co-located escape-hatch marker LABEL. Written as `# PIPEFAIL-BOOLEAN-OK: <why>`.
PIPEFAIL_BAN_MARKER_LABEL="${PIPEFAIL_BAN_MARKER_LABEL:-PIPEFAIL-BOOLEAN-OK}"
# How far ABOVE a finding the marker may sit and still count as co-located.
PIPEFAIL_BAN_MARKER_WINDOW="${PIPEFAIL_BAN_MARKER_WINDOW:-6}"
# ...and the PIN for it. Section 4c builds its out-of-window fixture from THIS
# literal, so widening the window is a deliberate TWO-LINE diff rather than a
# one-line drift that the guard would follow in lockstep (a past incident rule 8; the
# measured precedent is test-wiring-coverage.test.sh, where reading the constant
# let 50 -> 100000 pass with 48/48 green). Not env-overridable, on purpose.
PIPEFAIL_BAN_MARKER_WINDOW_PIN=6
# INSTRUMENT B — the DUMB, STATELESS, LINE-LOCAL pass. See "TWO INSTRUMENTS" above.
# It is a single grep with no cross-line state, so there is nothing it can lose. It
# over-matches enormously (419 candidate lines on this tree against 5 real findings)
# and that is what makes it a usable second opinion. DO NOT SHARPEN THIS: its job is
# to be wrong in the safe direction.
PIPEFAIL_BAN_DUMB_RE="${PIPEFAIL_BAN_DUMB_RE:-\|[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(sudo[[:space:]]+|command[[:space:]]+|env[[:space:]]+[^|]*)?(grep|egrep|fgrep|zgrep|rg|head|read)([[:space:]]|$)}"
# CEILING on files whose parse ends unbalanced. This is a DRIFT DETECTOR, not the
# guarantee — the reconciliation is the guarantee, and it covers state-lost files
# exactly as it covers every other file. Measured 25 at the time of writing (the
# cause is a quoted string spanning lines: instrument A resets quote state at each
# line boundary, so parens inside a multi-line SQL/JSON/curl body count as nesting).
# A jump here means a new construct instrument A cannot follow; go look.
PIPEFAIL_BAN_STATE_LOST_CEILING="${PIPEFAIL_BAN_STATE_LOST_CEILING:-30}"
# Sanity FLOOR on the discovered population — a broken-discovery detector (wrong
# dir, empty checkout, a find that silently returned nothing), NOT an anti-shrink
# guarantee. Measured 77 shell files after the hosted-fleet scripts were removed from this
# repository; the floor sits below that so it catches broken discovery, not a deletion.
PIPEFAIL_BAN_MIN_POPULATION="${PIPEFAIL_BAN_MIN_POPULATION:-60}"

# Resolve the scanner ONCE. Absolute paths are accepted so a probe can point the
# anchor at a mutated copy under its own mktemp dir instead of writing a file into
# the shared repo tree (the shared-namespace hazard STAGE 0a22b exists for).
pfb_scanner() {
  case "$PIPEFAIL_BAN_SCANNER" in /*) printf '%s' "$PIPEFAIL_BAN_SCANNER" ;;
                                   *) printf '%s' "$REPO_DIR/$PIPEFAIL_BAN_SCANNER" ;; esac
}

PASS=0; FAIL=0
hdr()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pass() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[31m×\033[0m %s\n' "$*"; }

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pipefail-ban.XXXXXX")"
cleanup() { rm -rf "$TMPD"; }
trap cleanup EXIT

# =============================================================================
# THE ANCHOR — three functions. Everything below calls these, nothing re-inlines.
# =============================================================================

# pfb_population <root> -> repo-relative paths of every shell file, one per line.
# Two arms, because a shell script is not always named *.sh: hooks/pre-commit and
# hooks/pre-push carry no extension. Extension arm and shebang arm are disjoint by
# construction (the shebang arm excludes *.sh).
pfb_population() {
  local root="$1" prune=() d f
  for d in $PIPEFAIL_BAN_PRUNE_DIRS; do prune+=( -name "$d" -o ); done
  unset 'prune[${#prune[@]}-1]'
  find "$root" -type d \( "${prune[@]}" \) -prune -o -type f -name '*.sh' -print \
    | sed "s|^${root}/||"
  while IFS= read -r f; do
    [[ -r "$root/$f" ]] || { printf '%s\n' "$f"; continue; }   # unreadable -> keep it, so it fails closed
    if grep -qE '^#!.*(bash|/bin/sh|env +sh|zsh|ksh)' < <(head -1 -- "$root/$f" 2>/dev/null); then
      printf '%s\n' "$f"
    fi
  done < <(find "$root" -type d \( "${prune[@]}" \) -prune -o -type f ! -name '*.sh' -print | sed "s|^${root}/||")
}

# pfb_marker_ok <abs-file> <lineno> -> 0 if a co-located marker with a NON-EMPTY
# reason sits on the finding line or within the window above it.
pfb_marker_ok() {
  local file="$1" ln="$2" from to seg
  from=$(( ln - PIPEFAIL_BAN_MARKER_WINDOW )); (( from < 1 )) && from=1
  to="$ln"
  seg="$(sed -n "${from},${to}p" -- "$file" 2>/dev/null)"
  # The reason must contain at least one non-whitespace character AFTER the colon.
  grep -qE "#[[:space:]]*${PIPEFAIL_BAN_MARKER_LABEL}:[[:space:]]*[^[:space:]]" <<<"$seg"
}

# pfb_dumb_lines <abs-file> -> line numbers seen by INSTRUMENT B.
# Deliberately dumb: no comment stripping, no context, no state. A commented-out
# banned line lands here and is then discharged by instrument C, which does strip
# comments — so the dumbness costs noise, never a false RED.
pfb_dumb_lines() {
  grep -nE "$PIPEFAIL_BAN_DUMB_RE" -- "$1" 2>/dev/null | cut -d: -f1
}

# pfb_isolate_flags <abs-file> <lineno> -> 0 if INSTRUMENT C (the SAME parser, run on
# that ONE line, with no history to lose) calls it a finding.
#
# THIS IS THE WHOLE IDEA. Instrument A is precise and stateful, and state is the
# thing it has now demonstrably lost six different ways. Running the identical
# parser statelessly over a single line cannot lose state, because there is none.
# The DIFFERENCE between the two is the finding — and it catches mechanisms nobody
# predicted, which is the only kind that has ever bitten us here.
pfb_isolate_flags() {
  local one="$TMPD/.isolate-one-line.sh"
  sed -n "${2}p" -- "$1" > "$one" 2>/dev/null || return 1
  [[ -n "$(awk -v FNAME=iso -f "$(pfb_scanner)" -- "$one" 2>/dev/null \
            | awk -F'\t' '$3 != "STATE-LOST"')" ]]
}

# pfb_unresolved <root> -> one line per UNRESOLVED finding. Four record shapes:
#     <relpath>:<lineno>:<kind>:<consumer stage>   instrument A flagged it, no marker
#     !UNRECONCILED:<relpath>:<lineno>:<text>      B saw it, A did not flag it, C does
#     !SCAN-FAILED:<relpath>                       unreadable, or awk itself failed
#     !STATE-LOST:<relpath>:<detail>               A ended the file unbalanced
# Exit status is NOT the verdict (that would be the very bug this bans); callers
# test the OUTPUT. !STATE-LOST is reported for section 3c's ceiling and is not a
# RED on its own — see the ceiling's comment for why the reconciliation, not the
# balance check, is what makes it safe.
pfb_unresolved() {
  local root="$1" f raw rc rel ln kind stage flagged
  while IFS= read -r f; do
    if [[ ! -r "$root/$f" ]]; then printf '!SCAN-FAILED:%s\n' "$f"; continue; fi
    raw="$(awk -v FNAME="$f" -f "$(pfb_scanner)" -- "$root/$f" 2>&1)"; rc=$?
    if [[ $rc -ne 0 ]]; then printf '!SCAN-FAILED:%s\n' "$f"; continue; fi

    flagged=""
    if [[ -n "$raw" ]]; then
      while IFS=$'\t' read -r rel ln kind stage _; do
        [[ -n "${ln:-}" ]] || { printf '!SCAN-FAILED:%s\n' "$f"; continue; }
        if [[ "$kind" == "STATE-LOST" ]]; then
          printf '!STATE-LOST:%s:%s\n' "$f" "$stage"
          continue
        fi
        flagged+="$ln"$'\n'
        pfb_marker_ok "$root/$f" "$ln" && continue
        printf '%s:%s:%s:%s\n' "$rel" "$ln" "$kind" "$stage"
      done <<<"$raw"
    fi

    # --- THE RECONCILIATION (instrument B vs A, adjudicated by C) ---
    while IFS= read -r ln; do
      [[ -n "$ln" ]] || continue
      grep -qxF "$ln" <<<"$flagged" && continue          # A already flagged it
      pfb_isolate_flags "$root/$f" "$ln" || continue     # C says it is not one either
      pfb_marker_ok "$root/$f" "$ln" && continue
      printf '!UNRECONCILED:%s:%s:%s\n' "$f" "$ln" \
        "$(sed -n "${ln}p" -- "$root/$f" | sed 's/^[[:space:]]*//' | cut -c1-120)"
    done < <(pfb_dumb_lines "$root/$f")
  done < <(pfb_population "$root")
}

# =============================================================================
hdr "1. THE DETECTOR EXISTS AND IS THE SINGLE DEFINITION"
# =============================================================================
if [[ -r "$(pfb_scanner)" ]]; then
  pass "detector present: $PIPEFAIL_BAN_SCANNER"
else
  fail "detector MISSING: $PIPEFAIL_BAN_SCANNER — this suite has nothing to assert with"
  printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; exit 1
fi

# The teeth must call the detector, not a copy of its logic. There are exactly two
# legitimate call sites — instrument A (whole-file, in pfb_unresolved) and instrument
# C (one line, in pfb_isolate_flags) — and BOTH live in the anchor block above the
# first section header. No assertion and no probe may invoke the detector directly;
# they all go through the anchor, so the teeth cannot drift from the detector
#. Checked by POSITION, not by count, so adding a probe cannot quietly
# satisfy it.
_ANCHOR_END="$(grep -n '^hdr "1\.' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1)"
_AWK_SITES="$(grep -nE '(awk|gawk)[[:space:]]+-v[[:space:]]+FNAME' "${BASH_SOURCE[0]}" | cut -d: -f1)"
_AWK_N="$(grep -c . <<<"$_AWK_SITES")"
_AWK_OUTSIDE="$(awk -v e="$_ANCHOR_END" '$1 > e' <<<"$_AWK_SITES" | grep -c . || true)"
if [[ "$_AWK_N" -ge 2 && "${_AWK_OUTSIDE:-0}" -eq 0 ]]; then
  pass "all $_AWK_N detector invocations sit inside the anchor block (above line $_ANCHOR_END) — every assertion and probe reaches it through pfb_unresolved / pfb_isolate_flags"
else
  fail "$_AWK_OUTSIDE detector invocation(s) sit OUTSIDE the anchor block; a probe that calls the detector directly can drift from what the assertions use"
fi

if [[ "$PIPEFAIL_BAN_MARKER_WINDOW" -eq "$PIPEFAIL_BAN_MARKER_WINDOW_PIN" ]]; then
  pass "co-location window is $PIPEFAIL_BAN_MARKER_WINDOW and still equals its pin — widening it is a two-line, deliberate diff"
else
  fail "co-location window ($PIPEFAIL_BAN_MARKER_WINDOW) has drifted from its pin ($PIPEFAIL_BAN_MARKER_WINDOW_PIN); change both lines in one commit or leave it alone"
fi

# =============================================================================
hdr "2. THE POPULATION COMES FROM THE FILESYSTEM, AND IS NOT VACUOUS"
# =============================================================================
mapfile -t POP < <(pfb_population "$REPO_DIR")
NPOP="${#POP[@]}"
if [[ "$NPOP" -ge "$PIPEFAIL_BAN_MIN_POPULATION" ]]; then
  pass "discovered $NPOP shell files (floor $PIPEFAIL_BAN_MIN_POPULATION) — discovery is not silently empty"
else
  fail "discovered only $NPOP shell files, below the floor of $PIPEFAIL_BAN_MIN_POPULATION — discovery is broken, and a broken population reports a perfect result"
fi

# Cross-check the SMART walk against a DUMB one. The dumb pass takes NO shortcuts:
# it finds every *.sh in the tree and then subtracts, textually, the ones under a
# pruned directory. If the smart walk's prune is doing anything other than what it
# says, the two numbers part company (a-count-carries-its-command: a too-SMALL count
# reads as clean and is the dangerous direction, so the cross-check has to exist).
#
# BOTH numbers come from ONE find snapshot, deliberately. The first version ran find
# TWICE and compared the results, and it fabricated a RED: node_modules is a moving
# target, another suite churned it between the two passes, and the guard reported
# "the walk is losing files" about a tree that was fine. Two measurements of a
# changing subject are not a reconciliation of a method.
DUMB_SNAPSHOT="$TMPD/dumb-population.txt"
find "$REPO_DIR" -type f -name '*.sh' > "$DUMB_SNAPSHOT" 2>/dev/null
DUMB_ALL="$(wc -l < "$DUMB_SNAPSHOT")"
_PRUNE_RE="(^|/)($(tr ' ' '|' <<<"$PIPEFAIL_BAN_PRUNE_DIRS"))/"
DUMB_PRUNED="$(grep -cE "$_PRUNE_RE" "$DUMB_SNAPSHOT")"
SMART_EXT="$(printf '%s\n' "${POP[@]}" | grep -c '\.sh$')"
if [[ $(( DUMB_ALL - DUMB_PRUNED )) -eq "$SMART_EXT" ]]; then
  pass "smart walk reconciles with the dumb one: $DUMB_ALL *.sh found - $DUMB_PRUNED under [$PIPEFAIL_BAN_PRUNE_DIRS] = $SMART_EXT scanned"
else
  fail "population reconciliation FAILED: dumb $DUMB_ALL - pruned $DUMB_PRUNED != smart $SMART_EXT — the walk is losing files. Only in the dumb list:"
  comm -23 <(grep -vE "$_PRUNE_RE" "$DUMB_SNAPSHOT" | sed "s|^${REPO_DIR}/||" | sort) \
           <(printf '%s\n' "${POP[@]}" | grep '\.sh$' | sort) | sed 's/^/      /'
fi

# Size instrument B's population too, and assert it is not vacuous — a dumb pass
# that sees nothing reconciles perfectly with anything.
DUMB_CANDIDATES=0
for _f in "${POP[@]}"; do
  _n="$(pfb_dumb_lines "$REPO_DIR/$_f" | grep -c . || true)"
  DUMB_CANDIDATES=$(( DUMB_CANDIDATES + _n ))
done
if [[ "$DUMB_CANDIDATES" -ge "$NPOP" ]]; then
  pass "instrument B (stateless) sees $DUMB_CANDIDATES candidate lines across $NPOP files — it is over-matching, which is its job"
else
  fail "instrument B saw only $DUMB_CANDIDATES candidate lines; a second opinion that sees almost nothing cannot contradict the first one"
fi

_SHEBANG_ONLY="$(printf '%s\n' "${POP[@]}" | grep -cv '\.sh$')"
if [[ "$_SHEBANG_ONLY" -ge 1 ]]; then
  pass "the shebang arm is live — $_SHEBANG_ONLY extensionless shell file(s) are in the population, not just *.sh"
else
  fail "the shebang arm found NOTHING; a shell script without a .sh name would escape this ban entirely"
fi

# =============================================================================
hdr "3. THE LIVE CONTRACT — parser, dumb pass, and the difference between them"
# =============================================================================
UNRESOLVED="$(pfb_unresolved "$REPO_DIR")"
FLAGS="$(grep -v '^!' <<<"$UNRESOLVED" || true)"
UNRECON="$(grep '^!UNRECONCILED:' <<<"$UNRESOLVED" || true)"
SCANFAIL="$(grep '^!SCAN-FAILED:' <<<"$UNRESOLVED" || true)"
STATELOST="$(grep '^!STATE-LOST:' <<<"$UNRESOLVED" || true)"

# --- 3a. INSTRUMENT A: no flagged site is unresolved. ---
if [[ -z "${FLAGS//[[:space:]]/}" ]]; then
  pass "[3a parser] no unresolved pipeline-derived boolean over an early-exit consumer in $NPOP shell files"
else
  fail "$(grep -c . <<<"$FLAGS") unresolved site(s). FIX (delete the pipeline: \`grep -q P < <(cmd)\`, \`grep -q P <<<\"\$var\"\`, or a bounded primitive) or add a co-located '# ${PIPEFAIL_BAN_MARKER_LABEL}: <reason>'."
  sed 's/^/      /' <<<"$FLAGS"
fi

# --- 3b. THE RECONCILIATION. The assertion that catches what nobody predicted. ---
# Every line instrument B can see must be accounted for by instrument A — flagged,
# or classified-not-a-finding when re-read statelessly by instrument C. A line B
# sees, A never flagged, and C calls a finding is a place where A WENT DARK. That
# is a RED, not a pass: this repo has now measured SIX distinct ways for A to lose
# its state, and every one of them was found after the fact.
if [[ -z "${UNRECON//[[:space:]]/}" ]]; then
  pass "[3b reconciliation] all $DUMB_CANDIDATES lines the stateless pass can see are accounted for by the parser — no site is hidden by lost parse state"
else
  fail "$(grep -c . <<<"$UNRECON") UNRECONCILED line(s): the dumb pass sees them, the parser did not flag them, and the parser flags them when the SAME line is read alone. The parser went dark here."
  sed 's/^/      /' <<<"$UNRECON"
fi

# --- 3c. Parse failures and lost state. ---
if [[ -z "${SCANFAIL//[[:space:]]/}" ]]; then
  pass "[3c parse] every file in the population was successfully parsed — nothing skipped for being unreadable"
else
  fail "$(grep -c . <<<"$SCANFAIL") file(s) could not be parsed; unresolvable is a FINDING, not a pass"
  sed 's/^/      /' <<<"$SCANFAIL"
fi

N_STATELOST="$(grep -c . <<<"${STATELOST:-}" || true)"; [[ -n "$STATELOST" ]] || N_STATELOST=0
if [[ "$N_STATELOST" -le "$PIPEFAIL_BAN_STATE_LOST_CEILING" ]]; then
  pass "[3c state] $N_STATELOST file(s) end the parse unbalanced (ceiling $PIPEFAIL_BAN_STATE_LOST_CEILING) — each one's candidate lines still went through 3b, which is what makes that survivable"
else
  fail "[3c state] $N_STATELOST file(s) end the parse unbalanced, over the ceiling of $PIPEFAIL_BAN_STATE_LOST_CEILING. Something new defeats the parser; confirm 3b still covers those files before raising it."
  sed 's/^/      /' <<<"$STATELOST" | head -40
fi

# An EXCEPTED site must still be a real, live exception.
_MARKED="$(grep -rlE "#[[:space:]]*${PIPEFAIL_BAN_MARKER_LABEL}:" "$REPO_DIR/scripts" "$REPO_DIR/reports" 2>/dev/null | wc -l)"
if [[ "$_MARKED" -ge 1 ]]; then
  pass "the exception hatch is in live use ($_MARKED file(s) carry a marker) — section 4c proves it is not a rubber stamp"
else
  fail "no file in the tree carries a marker; the hatch below is being probed but never exercised for real"
fi

# =============================================================================
hdr "4. MUTATION PROBES — the guard is only worth its sensitivity"
# =============================================================================
# Every probe asserts THREE things, in this order: the mutation LANDED (a witness
# read back out of the mutated file), the guard went RED on it, and the UNMUTATED
# control stayed GREEN. A probe that mutates nothing reports a perfect result.

FIX="$TMPD/fix"; mkdir -p "$FIX"

# --- 4a. A REAL, PREVIOUSLY-DEFECTIVE SITE, PUT BACK. -------------------------
# A log-management setup script once carried this exact line three times. `crontab -l`
# is small, which is why it survived review for years — latent, not safe. The subject is
# written here (it is no longer in the tree), so the probe does not depend on that script.
SUBJ_REL="scripts/example-log-cron.sh"
SUBJ_FIXED='if grep -q "aidis.*log" < <(crontab -l 2>/dev/null); then'
SUBJ_BANNED='if crontab -l 2>/dev/null | grep -q "aidis.*log"; then'

rm -rf "$FIX"; mkdir -p "$FIX/$(dirname "$SUBJ_REL")"
printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n  echo "log cron present"\nfi\n' "$SUBJ_FIXED" > "$FIX/$SUBJ_REL"
CTRL_OUT="$(pfb_unresolved "$FIX")"
if [[ -z "$CTRL_OUT" ]]; then
  pass "[4a control] the UNMUTATED copy of $SUBJ_REL is GREEN — the RED below is the mutation, not a stuck fail"
else
  fail "[4a control] the unmutated copy is already RED; every result in 4a is uninterpretable"$'\n'"$(sed 's/^/      /' <<<"$CTRL_OUT")"
fi

if grep -qF "$SUBJ_FIXED" "$FIX/$SUBJ_REL"; then
  pass "[4a premise] the fixed form is present in $SUBJ_REL, so there is something to mutate back"
else
  fail "[4a premise] the fixed form is NOT in $SUBJ_REL — this probe is mutating nothing and would report a perfect result"
fi

python3 - "$FIX/$SUBJ_REL" "$SUBJ_FIXED" "$SUBJ_BANNED" <<'PYEOF'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
open(p, 'w').write(s.replace(old, new, 1))
PYEOF

if grep -qF "$SUBJ_BANNED" "$FIX/$SUBJ_REL"; then
  pass "[4a LANDED] the banned pipeline is back in the mutated copy (witness read from the file, not assumed)"
else
  fail "[4a LANDED] the mutation did NOT land; the RED/GREEN below would mean nothing"
fi

MUT_OUT="$(pfb_unresolved "$FIX")"
if grep -qE "^${SUBJ_REL}:[0-9]+:TOPLEVEL:" <<<"$MUT_OUT"; then
  pass "[4a RED] the guard names the reintroduced site: $(grep -m1 -E "^${SUBJ_REL}:" <<<"$MUT_OUT")"
else
  fail "[4a RED] the guard did NOT notice the reintroduced banned pipeline — it is hollow"
fi

# --- 4b. THE COMMENT-PREFIX CLASS, BOTH DIRECTIONS. ---------------------------
# Direction 1 (false RED): a banned line that is COMMENTED OUT is not code and must
# not be flagged — including behind the metacharacter prefixes `;#`, `&#`, `|#`,
# which bash treats as comments and a whitespace-only strip does not.
rm -rf "$FIX"; mkdir -p "$FIX"
cat > "$FIX/comments.sh" <<'CEOF'
#!/usr/bin/env bash
set -euo pipefail
# if seq 1 100000 | grep -q .; then :; fi
  # if seq 1 100000 | grep -q .; then :; fi
true ;# if seq 1 100000 | grep -q .; then :; fi
true &# if seq 1 100000 | grep -q .; then :; fi
true |# if seq 1 100000 | grep -q .; then :; fi
true  # if seq 1 100000 | grep -q .; then :; fi
CEOF
C_OUT="$(pfb_unresolved "$FIX")"
if [[ -z "$C_OUT" ]]; then
  pass "[4b comments] all five comment prefixes (full-line, indented, ';#', '&#', '|#', ' #') are stripped — no false RED on commented-out code"
else
  fail "[4b comments] a COMMENT was flagged as code; the strip is wrong"$'\n'"$(sed 's/^/      /' <<<"$C_OUT")"
fi

# Direction 2 (false GREEN — the dangerous one): a `#` INSIDE QUOTES is data, not a
# comment. A sed-based strip truncates the line there and goes blind to the rest.
# Built with printf, not a heredoc: heredoc bodies ARE scanned now (they can be
# generated-and-executed code), and a fixture that deliberately carries the banned
# shape would otherwise flag the suite that owns it. Inside these quotes the `|` is
# data to this file and code to the fixture — which is the whole point.
_HASH_ARG="'# tag'"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  "if seq 1 100000 | grep -q $_HASH_ARG; then :; fi" > "$FIX/quoted.sh"
Q_OUT="$(pfb_unresolved "$FIX")"
if grep -qE '^quoted\.sh:3:TOPLEVEL:' <<<"$Q_OUT"; then
  pass "[4b quoted-hash] a banned line containing a QUOTED '#' is still seen as code — the strip does not blind the detector"
else
  fail "[4b quoted-hash] a quoted '#' truncated the line and the banned pipeline was MISSED — this is the false-GREEN direction"
fi
rm -f "$FIX/quoted.sh" "$FIX/comments.sh"

# --- 4c. THE EXCEPTION MARKER: real reason, empty reason, out of window. ------
mk_marked() { # <file> <marker-line-or-empty> <blank-lines-before-code>
  local f="$1" marker="$2" gap="$3" i
  { printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    [[ -n "$marker" ]] && printf '%s\n' "$marker"
    for ((i=0;i<gap;i++)); do printf ':\n'; done
    printf 'if seq 1 100000 | grep -q .; then :; fi\n'
  } > "$f"
}

rm -rf "$FIX"; mkdir -p "$FIX"
mk_marked "$FIX/m_none.sh" "" 0
if grep -qE '^m_none\.sh:[0-9]+:TOPLEVEL:' <<<"$(pfb_unresolved "$FIX")"; then
  pass "[4c baseline] the fixture IS flagged with no marker at all — the three results below are about the marker"
else
  fail "[4c baseline] the unmarked fixture is not even flagged; nothing below is interpretable"
fi
rm -f "$FIX/m_none.sh"

mk_marked "$FIX/m_real.sh" "# ${PIPEFAIL_BAN_MARKER_LABEL}: status is not consumed here, this is display-only output" 0
if [[ -z "$(pfb_unresolved "$FIX")" ]]; then
  pass "[4c real reason] a marker with a written reason DOES exempt the site — the hatch works"
else
  fail "[4c real reason] a valid marker failed to exempt; the hatch is unusable and people will route around the gate"
fi
rm -f "$FIX/m_real.sh"

for empty in "# ${PIPEFAIL_BAN_MARKER_LABEL}:" "# ${PIPEFAIL_BAN_MARKER_LABEL}:   " "# ${PIPEFAIL_BAN_MARKER_LABEL}:"$'\t'; do
  mk_marked "$FIX/m_empty.sh" "$empty" 0
  if grep -qE '^m_empty\.sh:[0-9]+:TOPLEVEL:' <<<"$(pfb_unresolved "$FIX")"; then
    pass "[4c empty reason] a marker with an EMPTY/whitespace reason does NOT satisfy the gate ($(printf '%q' "$empty"))"
  else
    fail "[4c empty reason] an empty reason exempted the site ($(printf '%q' "$empty")) — absent/zero/empty are the values that slip through"
  fi
  rm -f "$FIX/m_empty.sh"
done

# Out of window: the marker sits PIN+2 lines above the finding. Sized from the
# PINNED literal, never from the live constant — a fixture that reads the constant
# widens in lockstep with it and cannot detect a change to it.
mk_marked "$FIX/m_far.sh" "# ${PIPEFAIL_BAN_MARKER_LABEL}: buried far above the site it claims to excuse" \
          "$(( PIPEFAIL_BAN_MARKER_WINDOW_PIN + 2 ))"
if grep -qE '^m_far\.sh:[0-9]+:TOPLEVEL:' <<<"$(pfb_unresolved "$FIX")"; then
  pass "[4c co-location] a marker $(( PIPEFAIL_BAN_MARKER_WINDOW_PIN + 2 )) lines above the finding does NOT excuse it — co-location is enforced, not decorative"
else
  fail "[4c co-location] a marker far from the site still exempted it; the window is not being applied"
fi
rm -f "$FIX/m_far.sh"

# --- 4d. THE FIX ITSELF MUST READ AS GREEN, or the ban is unsatisfiable. ------
rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if grep -q . < <(seq 1 100000); then :; fi' \
  'if grep -q x <<<"$VAR"; then :; fi' \
  'mapfile -t names < <(compgen -e)' \
  'X="$(a | head -1)"' \
  '[[ "$RC" -ne 0 ]] && printf "%s\\n" "$OUT" | head -8' \
  'if [[ -n "$(a | head -1)" ]]; then :; fi' > "$FIX/fixed.sh"
F_OUT="$(pfb_unresolved "$FIX")"
if [[ -z "$F_OUT" ]]; then
  pass "[4d remedies] all four sanctioned fixes and the two genuine non-booleans read GREEN — the ban is satisfiable without an exception"
else
  fail "[4d remedies] the guard flags its own remedy; every fix would need a marker and the ban would be routed around"$'\n'"$(sed 's/^/      /' <<<"$F_OUT")"
fi

# --- 4e. A NEW FILE IS CONSCRIPTED AUTOMATICALLY. ----------------------------
# The population is the filesystem, so a brand-new script must be covered without
# anyone adding it to a list.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if docker ps --format "{{.Names}}" | grep -qx "$c"; then :; fi' > "$FIX/brand-new-script.sh"
if grep -qE '^brand-new-script\.sh:3:TOPLEVEL:' <<<"$(pfb_unresolved "$FIX")"; then
  pass "[4e conscription] a brand-new shell file is covered the moment it exists — no list to remember to update"
else
  fail "[4e conscription] a new file escaped the population; this ban is an allow-list"
fi

# An extensionless script must be conscripted too (the shebang arm, under mutation).
printf '%s\n' '#!/bin/bash' 'set -euo pipefail' \
  'if git ls-files | grep -q sneaky; then :; fi' > "$FIX/hookish"
if grep -qE '^hookish:3:TOPLEVEL:' <<<"$(pfb_unresolved "$FIX")"; then
  pass "[4e shebang] an extensionless shell file is covered too — the escape hatch of 'just do not name it .sh' is closed"
else
  fail "[4e shebang] an extensionless shell script escaped the population entirely"
fi

# --- 4g. THE POISONING CLASS ITSELF — the one that got past round 1. ---------
# `if X; then` on one line, a banned pipeline on the next. The shipped detector at
# carried " then" into the next segment, so seg_is_bool() stopped seeing
# the leading `if` and THE FIRST PIPELINE-BOOLEAN INSIDE ANY then/do BLOCK WAS
# INVISIBLE. Bisected on a schema-audit script: dark from the `; then` at
# one line, hiding the next — while the suite reported 25/25 GREEN over it. Three shapes,
# because `do` and a bare `then` on its own line are the same construct.
rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if [[ "$m" == "container" ]]; then' \
  '  if ! docker ps | grep -qx "$c"; then' '    :' '  fi' 'fi' > "$FIX/then_block.sh"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'for x in a b; do' '  if seq 1 100000 | grep -q .; then :; fi' 'done' > "$FIX/do_block.sh"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if true' 'then' '  if seq 1 100000 | grep -q .; then :; fi' 'fi' > "$FIX/then_own_line.sh"
P_OUT="$(pfb_unresolved "$FIX")"
for probe in "then_block.sh:4" "do_block.sh:4" "then_own_line.sh:5"; do
  if grep -qE "(^|:)${probe%%:*}:${probe##*:}:" <<<"$P_OUT"; then
    pass "[4g poisoning] a banned pipeline on the line after a \`then\`/\`do\` is RED (${probe})"
  else
    fail "[4g poisoning] ${probe} was NOT reported — the round-1 blocker has returned; the first boolean inside every then/do block is invisible again"
  fi
done

# --- 4h. A LINE ENDING INSIDE AN OPEN QUOTE. ---------------------------------
# Any ordinary multi-line string. Instrument A resets quote state at each line
# boundary and cannot follow this; it does not even raise STATE-LOST. Caught by the
# reconciliation, which is the point of having one.
rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'MSG="hello' 'world"' \
  'if seq 1 100000 | grep -q .; then :; fi' > "$FIX/openquote.sh"
if grep -qE '(^|:)openquote\.sh:5:' <<<"$(pfb_unresolved "$FIX")"; then
  pass "[4h open quote] a banned pipeline after a multi-line string is still reported"
else
  fail "[4h open quote] a multi-line string hid the banned pipeline that follows it"
fi

# --- 4i. A HEREDOC BODY WITH AN UNBALANCED \$(. --------------------------------
# Heredoc bodies are scanned by design (they can be generated-and-executed code), so
# an unbalanced `$(` inside one corrupts depth for the whole rest of the file.
rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' "cat > /dev/null <<'EOF'" \
  '$( unbalanced' 'EOF' 'if seq 1 100000 | grep -q .; then :; fi' > "$FIX/badheredoc.sh"
H_OUT="$(pfb_unresolved "$FIX")"
if grep -qE '(^|:)badheredoc\.sh:6:' <<<"$H_OUT"; then
  pass "[4i heredoc] a banned pipeline after an unbalanced \$( in a heredoc body is still reported"
else
  fail "[4i heredoc] depth corruption from a heredoc body hid the banned pipeline that follows it"
fi
if grep -q '^!STATE-LOST:badheredoc.sh:' <<<"$H_OUT"; then
  pass "[4i state] and the parse is ALSO reported as ending unbalanced, so the cause is visible and not just the symptom"
else
  fail "[4i state] the parser ended this file unbalanced and did not say so"
fi

# --- 4j. THE PROBE THAT GUARDS THE NEW GUARD: blind instrument A, keep C. -----
# Reintroduce the ROUND-1 BUG into a copy of the detector — `then`/`do` back in the
# end-of-line continuation set — and point the suite at that copy. Instrument A goes
# dark exactly as it did at the earlier pipefail scan; instrument C, reading the same line alone, does
# not. The reconciliation must turn that difference into a RED. If this probe ever
# passes for the wrong reason the whole cross-check is decorative.
MUT_SCANNER_ABS="$TMPD/pipefail-boolean-scan.MUTANT.awk"
sed 's@L !~ /(\\\\|\\||&&|\\|\\|)\[\[:space:\]\]\*\$/@L !~ /(\\\\|\\||\&\&|\\|\\||[[:space:]]then|[[:space:]]do)[[:space:]]*$/@' \
  "$(pfb_scanner)" > "$MUT_SCANNER_ABS"

# A WITNESS FROM INSIDE, not merely "the files differ": read the round-1 text back
# out of the mutant. `diff` alone would be satisfied by a sed that changed anything.
if grep -qF '[[:space:]]then|[[:space:]]do' "$MUT_SCANNER_ABS" \
   && ! grep -qF '[[:space:]]then|[[:space:]]do' "$(pfb_scanner)"; then
  pass "[4j LANDED] the round-1 poisoning text is present in the mutant and absent from the real detector (witness read from both files)"
else
  fail "[4j LANDED] the detector mutation did NOT land — every result below is vacuous"
fi

rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if [[ "$m" == "container" ]]; then' \
  '  if ! docker ps | grep -qx "$c"; then' '    :' '  fi' 'fi' > "$FIX/reconciled.sh"

J_CTRL="$(pfb_unresolved "$FIX")"
if grep -qE '^reconciled\.sh:4:' <<<"$J_CTRL"; then
  pass "[4j control] with the REAL detector the site is reported by instrument A directly"
else
  fail "[4j control] the real detector does not flag the fixture; the mutant comparison below means nothing"
fi

J_MUT="$(PIPEFAIL_BAN_SCANNER="$MUT_SCANNER_ABS" pfb_unresolved "$FIX")"
if grep -q '^!UNRECONCILED:reconciled.sh:4:' <<<"$J_MUT"; then
  pass "[4j RED via reconciliation] with instrument A blinded, the DIFFERENCE against the stateless pass is what turns it RED — this is the assertion that would have caught round 1"
else
  fail "[4j RED via reconciliation] instrument A went dark and the reconciliation did not notice. The cross-check is decorative."$'\n'"      got: $(sed 's/^/        /' <<<"${J_MUT:-<empty>}")"
fi

# ...and the reconciliation must not fire on a CLEAN tree just because A is blind:
# a fixture with no banned shape must stay GREEN under the mutant too, or 4j is
# only measuring "the mutant reports everything".
rm -rf "$FIX"; mkdir -p "$FIX"
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if [[ "$m" == "container" ]]; then' \
  '  if grep -qx "$c" < <(docker ps); then' '    :' '  fi' 'fi' > "$FIX/reconciled_ok.sh"
if [[ -z "$(PIPEFAIL_BAN_SCANNER="$MUT_SCANNER_ABS" pfb_unresolved "$FIX")" ]]; then
  pass "[4j control GREEN] the same blinded detector reports NOTHING on the fixed form — 4j measures the difference, not a stuck RED"
else
  fail "[4j control GREEN] the blinded run reports a finding on already-fixed code; the reconciliation over-fires"
fi

# --- 4f. EMPTY / BROKEN POPULATION IS RED, NOT VACUOUSLY GREEN. --------------
rm -rf "$FIX"; mkdir -p "$FIX"
if [[ -z "$(pfb_unresolved "$FIX")" ]] && [[ "$(pfb_population "$FIX" | wc -l)" -eq 0 ]]; then
  pass "[4f empty population] an empty tree yields an empty population — and section 2's FLOOR is what turns that into a RED rather than a perfect score"
else
  fail "[4f empty population] the empty-tree case did not behave as modelled; section 2's floor assertion cannot be reasoned about"
fi

# =============================================================================
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
