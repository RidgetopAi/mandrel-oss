#!/usr/bin/env bash
# =============================================================================
# mutation-probe.sh — prove a guard actually catches the defect it claims to catch.
#
# WHY THIS EXISTS
#   The only way to know a test guards anything is to BREAK the product and watch it
#   go RED. That procedure is itself a program, and it can silently do nothing — at
#   which point it reports a flawless pass and you publish a claim that is false.
#
#   That is not hypothetical here. While proving the revoke-sessions guard, the ad-hoc
#   mutation script used for the measurement was clobbered between runs. It crashed on
#   its own arguments, mutated NOTHING, and the suite was then run against unmutated
#   source and reported `exit 0, 514 passed`. Read carelessly, that is the sentence
#   "the guard catches the defect" — produced by a probe that did not exist.
#
#   The lesson is not "be careful". It is that the landing of a mutation must be an
#   ASSERTED PRE-CONDITION of reading its result, enforced by the tool, every time.
#
# WHY IT WAS REWRITTEN — two independent defects, opposite
# directions. Both were found by people using this tool correctly. The tool we reach
# for to prove other guards have teeth had no teeth of its own.
#
#   DEFECT 1 (failed OPEN — the false-green generator). `--expect-red` read ANY
#   non-zero exit as "the guard noticed". A suite that dies at a missing fixture, a
#   syntax error, a branch guard, a crashed dependency — every one of those exits
#   non-zero WITHOUT EVER REACHING THE MUTATED CODE, and every one was scored as
#   teeth. It produced two false greens on an earlier task, where the probes died at
#   the deploy script's branch guard before reaching the CN1 code and this script printed
#   "guard has teeth". The defence existed, but it lived in ONE CALLER's
#   --probe-bypass-blocked helper, so the next author to
#   reach for --expect-red got the unsafe behaviour by default.
#
#   DEFECT 2 (failed CLOSED — silently unprobeable lines). The anchor and replacement
#   were handed to `awk -v`, and awk INTERPRETS BACKSLASH ESCAPES in a -v assignment:
#     $ awk -v a='printf %s\n foo' 'BEGIN{print a}'   # prints TWO lines
#   so any source line containing a literal \n, \t or a trailing backslash could never
#   equal its own on-disk text and was unprobeable — exit 2, command never run. Shell
#   and printf-heavy files are exactly where guards live.
#
#   DEFECT 2b, found while fixing 2b and NOT in the original report: awk compares a
#   -v/ENVIRON value against $0 using STRNUM rules, so a numeric-looking anchor
#   matches a DIFFERENT line that is numerically equal:
#     $ printf '1.0\n' | awk -v a='1.00' '$0==a{n++} END{print n+0}'   # prints 1
#   That fails OPEN in a nastier way than defect 1: the wrong line gets mutated and
#   the landing assertions, using the same broken comparison, agree that it landed.
#
#   The fix for 2 and 2b is one deletion, not two escapes: awk is gone from the line
#   matching entirely. Bash's own `[[ "$line" == "$anchor" ]]` is a byte comparison
#   with no escape processing and no numeric coercion. (CLASSES.md C3: never enumerate
#   with a foreign recognizer what the language you are already in will do exactly.)
#
# WHY IT WAS HARDENED AGAIN — the witness
# itself, which is the pre-condition every other assertion rests on, could be forged
# in one direction and swallowed in the other. Both were measured, not theorized.
#
#   DEFECT 3 (failed OPEN — a false green from a mutant that never ran a line). The
#   witness was matched with `grep -qF` ANYWHERE in the command's output. When a
#   mutant does not COMPILE, vitest prints a source listing of the offending file —
#   which reproduces the mutated line, witness string and all, behind a gutter:
#       16:  2  |    process.stderr.write('PROBEWITNESS-STDERR-XYZ\n'); return ((( 2;
#   and summarises `Tests  no tests`. It exits 1. So: exit non-zero (scored RED),
#   witness "observed" (scored reachable) => this script printed
#       [mutation-probe] guard has teeth: the mutation was caught (exit 1).
#   and returned 0. Measured 2026-09-04 against vitest 2.1.9 in mcp-server; the
#   harness certified a guard using a mutant that executed NOTHING. That is the worst
#   verdict this tool can produce, because it is the reassuring one.
#
#   DEFECT 4 (failed CLOSED, and it burned two rounds of a real lane). mcp-server's
#   vitest.setup.ts installs a `beforeEach` that replaces console.log/error/warn/
#   info/debug with no-op spies for EVERY test. A probe that prints its witness with
#   console.error from inside test-run code therefore emits NOTHING. Measured on the
#   same scratch subject: the identical landed mutation produced 1 witness line via
#   process.stderr.write and 0 via console.error. The harness correctly refused to
#   judge — but "the witness never appeared" reads to the author as "my mutation did
#   not land", and the documented next move is to weaken the probe until something
#   prints. It is a false negative that costs rounds and invites a bad fix.
#
#   THE FIX IS A CHANNEL, NOT A SENTENCE. A comment telling authors to avoid console
#   already existed at the silencer and did not prevent defect 4, because prose in a
#   file nobody opens is the weak version of a rule. So the tool now OWNS the channel:
#   see WITNESS CHANNELS below.
#
# WITNESS CHANNELS — two, and they are not equally strong.
#
#   --witness STRING              (stream witness)
#       The string must appear AT COLUMN 0 of some line of the command's combined
#       output. Column 0 is the whole point: every runner that echoes your source
#       back at you does so behind a gutter (`  2  |  `, `>`, line numbers), so an
#       indented match is a REPRODUCTION of your mutation, not evidence it RAN.
#       This closes defect 3 for the general case and costs existing callers nothing
#       — a witness is normally emitted with a bare `echo`, which lands at column 0.
#
#   --witness STRING --witness-file PATH      (file witness — PREFER THIS)
#       The harness truncates PATH, exports it to the command as
#       MUTATION_PROBE_WITNESS, and requires STRING to appear IN THAT FILE. The
#       mutated code writes it itself, e.g. in TypeScript:
#           require('fs').appendFileSync(process.env.MUTATION_PROBE_WITNESS, 'MARK\n')
#       This is the only channel that is STRUCTURALLY safe rather than textually
#       safe. No console spy can silence a file write (defect 4), and no reporter
#       output can forge one — a mutant that fails to compile cannot write anything,
#       so defect 3 becomes impossible rather than merely detected. Use it whenever
#       the command is a test runner.
#
# HARNESS ERROR IS NOT A RESULT (requirement (c)). Three conditions
# are now checked on EVERY leg, control included, before any verdict is formed. Each
# exits 2, never 0 and never 1:
#     * the command produced NO output at all (or only whitespace). Nothing was
#       observed, so nothing was measured — and a harness that treats "I found no
#       output" as success is the exact bug this task exists to remove.
#     * the output says zero tests executed (MUTATION_PROBE_NO_TESTS_PATTERNS).
#     * the witness did not appear on its declared channel.
#   The control leg is checked too, deliberately: a control that ran no tests is not
#   a green baseline, it is an unmeasured one, and every later RED would be attributed
#   to a mutation on the strength of it.
#
# THE CONTRACT
#   mutation-probe.sh --file F --anchor LINE --replace TEXT
#                     [--expect-red|--expect-green]
#                     [--witness STRING] [--witness-file PATH] [--control]
#                     -- <command...>
#
#   1. Back up F (sha256 recorded).
#   2. The anchor must match EXACTLY ONE WHOLE LINE of F, compared as bytes. Zero or
#      two matches => the edit is a no-op or ambiguous => ABORT (2), command NEVER RUN.
#   3. --replace must differ from --anchor, or the "mutation" changes nothing => ABORT.
#   4. --control (optional but recommended): run the command against the UNMUTATED
#      file first. It must exit 0. If it does not, any later RED is not attributable
#      to the mutation => CANNOT MEASURE (2), not "teeth".
#   5. Apply, then re-read from disk and assert the anchor line is GONE and the
#      replacement is PRESENT and the sha changed. Not asserted => ABORT.
#   6. Run the command, capturing combined stdout+stderr.
#   6b. HARNESS ERROR CHECKS (every leg): blank output, or a "zero tests executed"
#      pattern, is CANNOT MEASURE (2) — not a pass and not a fail.
#   7. --witness STRING (optional but see ATTRIBUTION below): the string MUST appear
#      AT COLUMN 0 of that output — or, with --witness-file, inside that file — or
#      the mutated code path is not shown to have been reached => CANNOT MEASURE (2).
#      Absence of the witness is never a verdict either way. See WITNESS CHANNELS.
#   8. --expect-red (default) means the command MUST fail: that is the guard noticing.
#      --expect-green means it must pass: use it for the baseline control, because a
#      guard that is RED for everything proves nothing either.
#   9. Restore from the backup and verify the file is byte-identical, ALWAYS, including
#      when the command fails or the script is interrupted.
#
#   ATTRIBUTION IS MANDATORY UNDER --expect-red.
#     A "the guard has teeth" verdict now REQUIRES at least one of --witness or
#     --control. With neither, the tool exits 2 and refuses to judge, because with
#     neither it genuinely cannot tell a detection from an accident — which is the
#     defect above, and the reason it must be the TOOL's rule and not a rule each
#     caller is trusted to remember. The safe path is the default path.
#
#   HONEST LIMITS — what a `guard has teeth` still does NOT prove:
#     * --witness proves the witness string was EMITTED at column 0 (or written to
#       the witness file). If you choose a witness that a run prints before reaching
#       the guard, it proves only that much. Choose the guard's own message, or a
#       marker the caller emits at the decision point.
#     * the NO-TESTS check is prose matching against a third party's summary line and
#       is the weakest of the three defences — if a runner rewords that line it fails
#       OPEN. It is a backstop for the stream channel. --witness-file does not depend
#       on it at all, which is why --witness-file is the recommendation.
#     * the column-0 rule is a heuristic about REPORTER LAYOUT, not a proof. A runner
#       that echoed source back at column 0 would defeat it. None of the runners in
#       this repo do; --witness-file is immune to the question.
#     * --control proves the command is green unmutated and RED mutated, so the
#       difference IS attributable to the mutation. It does NOT prove the GUARD is
#       what noticed: a mutation that makes the file a syntax error also flips the
#       verdict. Use a mutation that keeps the subject loadable, and prefer a witness
#       that names the guard.
#     * Neither distinguishes a RED from a TIMEOUT that happened to occur after the
#       witness was printed. A timeout is scored as RED.
#     * `--expect-green` requires no attribution: a green verdict is not the
#       reassuring-false direction here, and 126/127 already abort. A --witness passed
#       with --expect-green IS still checked.
#     * NUL bytes: the line matcher reads with `read -r`, which stops at NUL, so a
#       binary file fails the landing assertions. That fails CLOSED (exit 2).
#     * A file with no trailing newline gets one when mutated. The restore is a
#       byte-exact copy of the backup, so the tree is unaffected.
#
#   EXIT CODES — CANNOT MEASURE IS ITS OWN OUTCOME, never folded into pass or fail.
#     0  verdict as expected (guard has teeth / baseline healthy)
#     1  verdict NOT as expected — e.g. the product was broken and the suite still
#        passed: the guard is BLIND. This is the finding, not an error.
#     2  CANNOT MEASURE — the mutation could not be applied, the command never ran,
#        the control was not green, or the reachability witness never appeared.
#        Nothing was measured; do not read this as either answer.
#     3  restore failed — the working tree is dirty, fix before trusting anything
#
#   Its own behaviour is exercised by scripts/test/mutation-probe.test.sh (the CI gate
#   STAGE 0a8c), including the two cases that motivated it: a probe that mutates
#   nothing must be incapable of reporting a pass, and a suite that fails for a reason
#   unrelated to the mutation must be incapable of reporting teeth.
# =============================================================================
set -euo pipefail

FILE="" ANCHOR="" REPLACE="" EXPECT="red" WITNESS="" WITNESS_FILE="" CONTROL=0
declare -a CMD=()

# --- tunables live in a named config, never inline (house rule) ----------------------
# The values that depend on a THIRD PARTY's output wording are the ones that rot, so
# they are not buried in this script. A missing config is a HARNESS ERROR: silently
# falling back to an empty pattern list would disable the no-tests check and leave the
# tool reporting confident verdicts with one defence quietly gone.
PROBE_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config/mutation-probe.conf"
if [[ ! -f "$PROBE_CONF" ]]; then
  printf '\033[31m[mutation-probe] HARNESS ERROR: config not found: %s\033[0m\n' "$PROBE_CONF" >&2
  exit 2
fi
# shellcheck source=config/mutation-probe.conf
. "$PROBE_CONF"
if [[ ${#MUTATION_PROBE_NO_TESTS_PATTERNS[@]} -eq 0 ]]; then
  printf '\033[31m[mutation-probe] HARNESS ERROR: MUTATION_PROBE_NO_TESTS_PATTERNS is empty\033[0m\n' >&2
  exit 2
fi

die() { printf '\033[31m[mutation-probe] %s\033[0m\n' "$1" >&2; exit "${2:-2}"; }
cannot() {
  printf '\033[33m[mutation-probe] CANNOT MEASURE: %s\033[0m\n' "$1" >&2
  printf '\033[33m[mutation-probe] this is NOT a red and NOT a green — nothing was measured.\033[0m\n' >&2
  exit 2
}
say() { printf '[mutation-probe] %s\n' "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)    FILE="${2:-}"; shift 2 ;;
    --anchor)  ANCHOR="${2:-}"; shift 2 ;;
    --replace) REPLACE="${2:-}"; shift 2 ;;
    --expect-red)   EXPECT="red"; shift ;;
    --expect-green) EXPECT="green"; shift ;;
    # --reachability-witness is the name the defect report proposed; --witness is the
    # short form. Both are the same flag, so neither spelling silently does nothing.
    --witness|--reachability-witness) WITNESS="${2:-}"; shift 2 ;;
    # The unsilenceable channel. See WITNESS CHANNELS in the header: a console spy
    # can swallow a stream witness and a syntax-error listing can forge one; neither
    # can touch a file only the mutated code writes.
    --witness-file) WITNESS_FILE="${2:-}"; shift 2 ;;
    --control) CONTROL=1; shift ;;
    --) shift; CMD=("$@"); break ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$FILE"   ]] || die "--file is required"
[[ -f "$FILE"   ]] || die "no such file: $FILE"
[[ -n "$ANCHOR" ]] || die "--anchor is required"
[[ ${#CMD[@]} -gt 0 ]] || die "a command is required after --"
[[ "$ANCHOR" != "$REPLACE" ]] || die "--replace is identical to --anchor: the mutation would change nothing"
# --witness-file names WHERE to look; --witness is still WHAT to look for. Accepting a
# path with nothing to find in it would be a check that always passes.
if [[ -n "$WITNESS_FILE" && -z "$WITNESS" ]]; then
  die "--witness-file needs --witness: the file is where to look, the string is what to look for"
fi

# --- THE ATTRIBUTION RULE (defect 1). Refuse to judge what cannot be attributed. ----
# Checked BEFORE the file is touched, so a caller that cannot produce a teeth verdict
# is told so without anything being mutated or run.
if [[ "$EXPECT" == "red" && -z "$WITNESS" && $CONTROL -eq 0 ]]; then
  cannot "--expect-red needs attribution evidence, and none was given.
  A non-zero exit is not a detection: a missing fixture, a syntax error, a branch
  guard, a crashed dependency and an OOM all exit non-zero without ever reaching the
  code you mutated. That produced two false greens on an earlier task.
  Give at least one of:
    --witness STRING   a string the MUTATED run must print, proving it reached the
                       guard (the guard's own message is the best choice), or
    --control          run the command UNMUTATED first and require it to exit 0, so
                       the RED is attributable to the mutation."
fi

# --- byte-exact whole-line matching, in bash (defect 2 / 2b: no awk, no escapes) ----
# `read -r` does no backslash processing and `[[ == ]]` with a QUOTED right-hand side
# is a byte comparison with no numeric coercion. The `|| [[ -n "$line" ]]` keeps a
# final line that has no trailing newline.
count_matches() { # <file> <target> -> count on stdout
  local f="$1" target="$2" line n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$target" ]] && n=$((n+1))
  done < "$f"
  printf '%s\n' "$n"
}
substitute() { # <in> <target> <replacement> -> mutated text on stdout
  local f="$1" target="$2" repl="$3" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$target" ]]; then printf '%s\n' "$repl"; else printf '%s\n' "$line"; fi
  done < "$f"
}

MATCHES=$(count_matches "$FILE" "$ANCHOR")
[[ "$MATCHES" == "1" ]] || die "anchor matched $MATCHES lines (need exactly 1) — the mutation would be a NO-OP or ambiguous, so NOTHING was run"

BACKUP="$(mktemp)"; cp "$FILE" "$BACKUP"
BEFORE_SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
RUNLOG="$(mktemp)"

restore() {
  rm -f "$RUNLOG"
  cp "$BACKUP" "$FILE"
  local now; now="$(sha256sum "$FILE" | cut -d' ' -f1)"
  if [[ "$now" != "$BEFORE_SHA" ]]; then
    printf '\033[31m[mutation-probe] RESTORE FAILED — %s is not byte-identical to its backup (%s)\033[0m\n' "$FILE" "$BACKUP" >&2
    exit 3
  fi
  rm -f "$BACKUP"
  say "restored $FILE (byte-identical, sha256=${BEFORE_SHA:0:16})"
}
trap restore EXIT

# run_cmd <label> -> sets RC, fills $RUNLOG with combined output.
# PIPESTATUS[0] is read explicitly rather than the pipeline's own status, so `tee`
# and pipefail cannot author the verdict (the pipefail-boolean class).
run_cmd() {
  say "running the command ($1)…"
  set +e
  "${CMD[@]}" 2>&1 | tee "$RUNLOG"
  RC=${PIPESTATUS[0]}
  set -e
}

# 126/127 mean the command never RAN. Under --expect-red the old script scored those
# as teeth, so A TYPO IN THE COMMAND produced a confident green. They are CANNOT
# MEASURE in both legs. The stated cost: a command that genuinely exits 126/127 itself
# cannot be probed — the right trade, because that is indistinguishable from the
# runner being missing. A runner that merely CRASHES is a different animal and still
# counts as RED (self-test case 7).
never_ran_check() {
  if [[ $RC -eq 127 || $RC -eq 126 ]]; then
    cannot "command exited $RC ($([[ $RC -eq 127 ]] && echo 'not found' || echo 'not executable')) — it never RAN. This is not a RED."
  fi
}

# --- HARNESS ERROR CHECKS (an earlier task requirement (c)) ----------------------------
# Run on EVERY leg, control included, BEFORE any verdict is formed. Each is a state in
# which nothing was measured, so each exits 2 — never 0, never 1, in either direction.

# THE ABSENT CASE. A harness that concludes anything from having found no output at all
# is the bug this task exists to remove: "I saw nothing" is not "I saw a pass" and it is
# not "I saw a failure" either. `grep .` is true only if some line has ≥1 character.
blank_output_check() { # <leg>
  if ! grep -q '[^[:space:]]' "$RUNLOG"; then
    cannot "the command ($1) produced NO output at all (exit $RC).
  Nothing was observed, so nothing was measured. An exit code with no output behind it
  is not a verdict — a crashed runner, a wrong path and a silent pass are the same
  three bytes from here.
  This refuses to judge rather than guessing, which is the safe direction. If the
  command is legitimately silent, give the probe something to observe: echo a marker
  at the decision point and pass it as --witness, or use --witness-file."
  fi
}

# ZERO TESTS EXECUTED. A runner that failed to compile the mutant exits non-zero exactly
# like a runner whose guard fired, and the exit code cannot separate them. This is the
# weakest of the three defences (prose matching — see the config), which is why it is a
# backstop and --witness-file is the recommendation.
no_tests_check() { # <leg>
  local pat
  for pat in "${MUTATION_PROBE_NO_TESTS_PATTERNS[@]}"; do
    if grep -qF -- "$pat" "$RUNLOG"; then
      cannot "the command ($1) reported that ZERO TESTS EXECUTED: $(printf '%q' "$pat")
  A run that executed no tests measured nothing about the guard. Its exit code ($RC)
  is not a RED and not a GREEN — most likely the mutant did not COMPILE, in which case
  the guard was never given the chance to notice anything.
  If you meant to probe a test suite, make the mutation one the file can still parse."
    fi
  done
}

measurability_checks() { # <leg>
  blank_output_check "$1"
  no_tests_check "$1"
}

# --- WITNESS MATCHING ----------------------------------------------------------------
# Stream witness: COLUMN 0 only. A runner echoing your source back at you always does it
# behind a gutter, so an indented match is a REPRODUCTION of the mutated line, not proof
# it ran. Compared as bytes in bash for the same reason awk was deleted from the line
# matcher: no escape processing, no numeric coercion, no foreign grammar.
witness_at_column_zero() { # <file> <witness> -> rc 0 if found at column 0
  local f="$1" w="$2" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$w"* ]] && return 0
  done < "$f"
  return 1
}

# Only used to make the FAILURE MESSAGE say the useful thing. It changes no verdict, so
# a wrapper script that hides the runner costs nothing but a less specific message.
looks_like_a_test_runner() {
  local fp
  for fp in "${MUTATION_PROBE_TEST_RUNNER_FINGERPRINTS[@]}"; do
    grep -qF -- "$fp" "$RUNLOG" && return 0
  done
  return 1
}

# --- CONTROL LEG: the command must be GREEN before the mutation ----------------------
if [[ $CONTROL -eq 1 ]]; then
  run_cmd "CONTROL — file UNMUTATED"
  never_ran_check
  # The control is checked for measurability too, and this is deliberate: a control
  # that executed zero tests is not a green baseline, it is an unmeasured one, and
  # every later RED would be attributed to the mutation on the strength of it.
  measurability_checks "CONTROL"
  if [[ $RC -ne 0 ]]; then
    cannot "the UNMUTATED control exited $RC. The command is already failing without
  the mutation, so a RED after mutating proves nothing about the guard. Fix the
  command or the environment first."
  fi
  say "CONTROL GREEN: the command passes against the unmutated file (exit 0)"
fi

# --- apply, then PROVE it landed -----------------------------------------------------
substitute "$BACKUP" "$ANCHOR" "$REPLACE" > "$FILE"

STILL=$(count_matches "$FILE" "$ANCHOR")
[[ "$STILL" == "0" ]] || die "the anchor line SURVIVED the edit — mutation did not land, nothing was run"
if [[ -n "$REPLACE" ]]; then
  GOT=$(count_matches "$FILE" "$REPLACE")
  [[ "$GOT" == "1" ]] || die "the replacement line is not present after the edit — mutation did not land, nothing was run"
fi
AFTER_SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
[[ "$AFTER_SHA" != "$BEFORE_SHA" ]] || die "file is unchanged after the edit — mutation did not land, nothing was run"
say "MUTATION LANDED in $FILE (sha256 ${BEFORE_SHA:0:12} -> ${AFTER_SHA:0:12})"

# --- run the command and JUDGE the verdict -------------------------------------------
if [[ -n "$WITNESS_FILE" ]]; then
  : > "$WITNESS_FILE" || die "cannot write the witness file: $WITNESS_FILE"
  export MUTATION_PROBE_WITNESS="$WITNESS_FILE"
  say "witness file armed (truncated): $WITNESS_FILE — the command sees it as \$MUTATION_PROBE_WITNESS"
fi

run_cmd "MUTATED"
say "command exited $RC (expected ${EXPECT})"
never_ran_check
measurability_checks "MUTATED"

# --- REACHABILITY WITNESS: was the mutated code path even reached? -------------------
# Checked BEFORE the verdict, and it outranks it. Without the witness we cannot call
# a non-zero exit a detection, and we cannot call a zero exit a blind guard either —
# both readings assume the run got there. So it is CANNOT MEASURE, in either direction.
if [[ -n "$WITNESS" ]]; then
  if [[ -n "$WITNESS_FILE" ]]; then
    # FILE CHANNEL — structural. Only the mutated code can write here, so a reporter
    # cannot forge the witness and a console spy cannot swallow it.
    if [[ -s "$WITNESS_FILE" ]] && grep -qF -- "$WITNESS" "$WITNESS_FILE"; then
      say "REACHABILITY WITNESS observed in the witness file: $(printf '%q' "$WITNESS")"
    else
      cannot "the reachability witness was never written to the witness file:
    witness: $(printf '%q' "$WITNESS")
    file:    $WITNESS_FILE
  The mutated code did not run. A file witness cannot be silenced by a console spy and
  cannot be forged by reporter output, so its absence means the mutated path was not
  executed — most often because the mutant failed to COMPILE.
  The mutated code must write the marker itself, e.g. in TypeScript:
    require('fs').appendFileSync(process.env.MUTATION_PROBE_WITNESS, '$WITNESS\\n')
  Its exit code ($RC) says nothing about the guard, in EITHER direction."
    fi
  elif witness_at_column_zero "$RUNLOG" "$WITNESS"; then
    say "REACHABILITY WITNESS observed at column 0: $(printf '%q' "$WITNESS")"
  else
    # Two different situations, and the author needs to be told which. If the string is
    # in the output but INDENTED, it is almost certainly a source listing echoing the
    # mutation back — that is the false green this check exists to refuse.
    INDENTED_ONLY=""
    grep -qF -- "$WITNESS" "$RUNLOG" && INDENTED_ONLY=1
    HINT=""
    if [[ -n "$INDENTED_ONLY" ]]; then
      HINT="  THE STRING IS PRESENT BUT NOT AT COLUMN 0 — here is where it appeared:
$(grep -nF -- "$WITNESS" "$RUNLOG" | head -3 | sed 's/^/    /')
  Indented text is how a runner REPRINTS YOUR SOURCE in a syntax-error listing. That is
  a copy of the mutation, not evidence it executed, and scoring it certified a guard
  using a mutant that never ran a line. If the mutant really did run,
  emit the witness at column 0 or use --witness-file."
    elif looks_like_a_test_runner; then
      HINT="  THE COMMAND LOOKS LIKE A TEST RUNNER, so check the channel before the mutation.
  mcp-server's vitest.setup.ts replaces console.log/error/warn/info/debug with no-op
  spies in a beforeEach for EVERY test, so a witness printed with console.* from inside
  test-run code emits NOTHING even though the mutation landed perfectly (an earlier defect
  — it cost two probe rounds). Do NOT weaken the probe until something prints.
  Use --witness-file, which no spy can reach:
    --witness $(printf '%q' "$WITNESS") --witness-file \"\$SOME_TMP/witness.txt\"
  and have the mutated code write it:
    require('fs').appendFileSync(process.env.MUTATION_PROBE_WITNESS, '$WITNESS\\n')"
    fi
    cannot "the reachability witness never appeared at column 0 of the command's output:
    $(printf '%q' "$WITNESS")
${HINT}
  The run did not demonstrably reach the code that was mutated, so its exit code
  ($RC) says nothing about the guard — in EITHER direction."
  fi
fi

if [[ "$EXPECT" == "red" ]]; then
  if [[ $RC -eq 0 ]]; then
    printf '\033[31m[mutation-probe] BLIND GUARD: the product was mutated and the command still PASSED.\033[0m\n' >&2
    exit 1
  fi
  printf '\033[32m[mutation-probe] guard has teeth: the mutation was caught (exit %s).\033[0m\n' "$RC"
else
  if [[ $RC -ne 0 ]]; then
    printf '\033[31m[mutation-probe] baseline expectation failed: expected the command to PASS, got exit %s.\033[0m\n' "$RC" >&2
    exit 1
  fi
  printf '\033[32m[mutation-probe] baseline healthy (exit 0).\033[0m\n'
fi
