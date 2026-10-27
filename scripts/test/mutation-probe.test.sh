#!/usr/bin/env bash
# =============================================================================
# mutation-probe.test.sh — acceptance test for scripts/mutation-probe.sh
#
# GUARDS-CLASS: guard-not-fail-closed
#
# WHAT THIS EXISTS TO PREVENT RECURRING
#   A mutation probe reports a verdict that people then quote in commit bodies and
#   incident write-ups. Two independent defects have already turned that verdict into
#   a lie, in opposite directions, and both are pinned here.
#
#   an earlier change — THE PROBE THAT DID NOT RUN. The ad-hoc probe used for a real
#   measurement was clobbered, crashed on its own arguments, mutated NOTHING, and the
#   subsequent run reported `exit 0, 514 passed`. Indistinguishable from "the guard is
#   fine" — a perfect result produced by a probe that did not exist.
#
#   an earlier change — THE PROBE THAT MEASURED THE WRONG FAILURE. `--expect-red` read ANY
#   non-zero exit as "the guard noticed", so a suite that died at a missing fixture,
#   a branch guard or a syntax error scored as teeth WITHOUT REACHING THE MUTATED
#   CODE. It did exactly that twice on an earlier task. Same task: `awk -v` expanded
#   backslash escapes in the anchor, so any line containing a literal \n, \t or a
#   trailing backslash was silently unprobeable (that one failed CLOSED), and awk's
#   strnum comparison matched a numerically-equal but DIFFERENT line (that one failed
#   OPEN, mutating the wrong line).
#
#   So the properties under test are:
#
#     1. WHEN THE MUTATION DOES NOT LAND, THE COMMAND MUST NOT RUN AND NO PASS MAY BE
#        REPORTED.
#     2. WHEN THE RUN DID NOT DEMONSTRABLY REACH THE MUTATED CODE, NO TEETH VERDICT
#        MAY BE REPORTED — CANNOT MEASURE IS A THIRD OUTCOME, NOT A ROUNDING OF
#        EITHER ANSWER.
#     3. WHAT IS ON DISK IS WHAT IS MATCHED — no escape processing, no numeric
#        coercion — while a genuinely absent anchor STILL fails closed.
#
#   The observable for (1) is a SIDE EFFECT, not an exit code: the
#   command under test creates a CANARY file and appends to a RUN LOG. If the canary
#   exists after a probe that should have aborted, the command ran when it must not
#   have — and no return value can be right by luck about that.
#
# RUN: bash scripts/test/mutation-probe.test.sh
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/../mutation-probe.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0 FAIL=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ [[ "$2" == "$3" ]] && ok "$1 ($2)" || bad "$1: expected '$3', got '$2'"; }

CANARY="$WORK/canary"
RUNLOG="$WORK/runs"
TARGET="$WORK/target.txt"

# The "command under test": drops a canary and appends to a run log so we can SEE
# whether — and how often — it ran, prints a reachability marker, then exits with
# whatever code the caller asked for.
WITNESS_STR="REACHED-THE-MUTANT"
cat > "$WORK/cmd.sh" <<'EOF'
#!/usr/bin/env bash
touch "$CANARY_PATH"
echo run >> "$RUNLOG_PATH"
# ALWAYS emit a line of non-witness noise. "the command printed nothing" and "the
# command printed things but not the witness" are two DIFFERENT harness errors with
# two different remedies, and a fixture that conflates them cannot
# tell which check fired. Case 24 drives the blank case on purpose, via EMIT_NOISE=0.
[[ "${EMIT_NOISE:-1}" == "1" ]] && echo "command under test: starting"
[[ "${EMIT_WITNESS:-1}" == "1" ]] && echo "REACHED-THE-MUTANT"
exit "${CMD_EXIT:-0}"
EOF
chmod +x "$WORK/cmd.sh"
export CANARY_PATH="$CANARY" RUNLOG_PATH="$RUNLOG" WITNESS_STR_ENV="$WITNESS_STR"

fresh() { printf 'alpha\nTARGET LINE\nomega\n' > "$TARGET"; rm -f "$CANARY" "$RUNLOG"; }
sha()   { sha256sum "$TARGET" | cut -d' ' -f1; }
runs()  { [[ -f "$RUNLOG" ]] && wc -l < "$RUNLOG" | tr -d ' ' || echo 0; }
# Every --expect-red case below must carry attribution evidence, because that is now
# the tool's rule; W is the shorthand for the minimum a caller must supply.
W=(--witness "$WITNESS_STR")

# THE VERDICT SENTENCE, not the bare phrase. A harness ERROR message may legitimately
# quote "guard has teeth" while explaining why it refused to produce one, and a test
# that greps the phrase then fails on the tool's own explanation. Match what the tool
# actually PRINTS as a verdict.
TEETH_VERDICT="guard has teeth: the mutation was caught"

echo "== 1. anchor ABSENT -> abort (exit 2), command must NOT run =="
fresh; BEFORE="$(sha)"
CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "NO SUCH LINE" --replace "x" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "2"
[[ -f "$CANARY" ]] && bad "command RAN despite the mutation not landing (the clobber incident)" || ok "command did not run"
check "file untouched" "$(sha)" "$BEFORE"

echo "== 2. anchor AMBIGUOUS (2 matches) -> abort, command must NOT run =="
printf 'dup\nTARGET LINE\nTARGET LINE\n' > "$TARGET"; rm -f "$CANARY" "$RUNLOG"; BEFORE="$(sha)"
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "x" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "2"
[[ -f "$CANARY" ]] && bad "command RAN on an ambiguous anchor" || ok "command did not run"
check "file untouched" "$(sha)" "$BEFORE"

echo "== 3. replacement IDENTICAL to anchor (a mutation that changes nothing) -> abort =="
fresh; BEFORE="$(sha)"
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "TARGET LINE" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "2"
[[ -f "$CANARY" ]] && bad "command RAN on a no-op mutation" || ok "command did not run"
check "file untouched" "$(sha)" "$BEFORE"

echo "== 4. mutation lands + command FAILS + witness seen -> exit 0 (the guard has teeth) =="
fresh; BEFORE="$(sha)"
CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "0"
[[ -f "$CANARY" ]] && ok "command ran" || bad "command did NOT run when it should have"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 5. mutation lands + command PASSES -> exit 1 (BLIND guard reported) =="
fresh; BEFORE="$(sha)"
CMD_EXIT=0 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "1"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 6. --expect-green baseline: passes green, fails red =="
fresh
CMD_EXIT=0 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --expect-green -- "$WORK/cmd.sh" >/dev/null 2>&1
check "green baseline accepted" "$?" "0"
fresh; BEFORE="$(sha)"
CMD_EXIT=3 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --expect-green -- "$WORK/cmd.sh" >/dev/null 2>&1
check "red under --expect-green rejected" "$?" "1"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 7. the file is restored even when the command CRASHES hard =="
fresh; BEFORE="$(sha)"
CMD_EXIT=137 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code (red expected, crash counts)" "$?" "0"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 8. command DOES NOT EXIST (127) -> exit 2, never a RED =="
fresh; BEFORE="$(sha)"
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/no-such-command-$$" >/dev/null 2>&1
check "exit code" "$?" "2"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 9. command NOT EXECUTABLE (126) -> exit 2, never a RED =="
fresh; BEFORE="$(sha)"
printf '#!/usr/bin/env bash\ntrue\n' > "$WORK/noexec.sh"; chmod -x "$WORK/noexec.sh"
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/noexec.sh" >/dev/null 2>&1
check "exit code" "$?" "2"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 10. a typo'd command can never report 'the guard has teeth' =="
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd-with-a-typo.sh" 2>&1)"
if grep -q "$TEETH_VERDICT" <<<"$OUT"; then bad "a nonexistent command reported a PASS verdict"; else ok "no pass verdict for a command that never ran"; fi

# =============================================================================
# DEFECT 1 — FAILS OPEN. A non-zero exit is not a detection.
# =============================================================================
echo "== 11. --expect-red with NO attribution evidence -> refused (2), nothing run =="
# The safe path must be the DEFAULT path, not the remembered one: a caller that
# supplies neither a witness nor a control cannot obtain a teeth verdict at all.
fresh; BEFORE="$(sha)"
OUT="$(CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" -- "$WORK/cmd.sh" 2>&1)"
check "exit code" "$?" "2"
[[ -f "$CANARY" ]] && bad "command RAN despite no attribution evidence" || ok "command did not run"
check "file untouched" "$(sha)" "$BEFORE"
grep -q "CANNOT MEASURE" <<<"$OUT" && ok "says CANNOT MEASURE" || bad "did not name the outcome CANNOT MEASURE"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "reported teeth with no evidence" || ok "no teeth verdict"

echo "== 12. THE LANE'S POINT: the suite fails for a reason UNRELATED to the mutation =="
# This is the exact shape that produced two false greens on the run
# dies before reaching the mutated code, exits non-zero, and the old tool called it
# teeth. The witness is what separates "the guard caught it" from "something broke".
fresh; BEFORE="$(sha)"
OUT="$(CMD_EXIT=1 EMIT_WITNESS=0 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd.sh" 2>&1)"
RC=$?
check "exit code is CANNOT MEASURE, not PASS" "$RC" "2"
if grep -q "$TEETH_VERDICT" <<<"$OUT"; then
  bad "A FALSE RED WAS ACCEPTED: a suite that never reached the mutation was scored as teeth"
else
  ok "a non-zero exit with no reachability witness is NOT scored as teeth"
fi
grep -q "witness never appeared" <<<"$OUT" && ok "names the missing witness as the reason" || bad "did not name the missing witness"
check "file restored byte-identical" "$(sha)" "$BEFORE"

echo "== 13. witness absent + command PASSED -> CANNOT MEASURE, not 'BLIND guard' =="
# The witness outranks the verdict in BOTH directions. Without evidence the run
# reached the mutated code, exit 0 does not prove the guard is blind either.
fresh
OUT="$(CMD_EXIT=0 EMIT_WITNESS=0 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" "${W[@]}" -- "$WORK/cmd.sh" 2>&1)"
check "exit code" "$?" "2"
grep -q "BLIND GUARD" <<<"$OUT" && bad "declared a guard BLIND from a run that never reached it" || ok "no BLIND verdict without reachability"

echo "== 14. --control: command already RED unmutated -> CANNOT MEASURE, mutation never run =="
fresh
OUT="$(CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --control -- "$WORK/cmd.sh" 2>&1)"
check "exit code" "$?" "2"
check "command ran ONCE (the control) and the mutated leg was never reached" "$(runs)" "1"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "scored teeth off a command that was already failing" || ok "no teeth verdict from a red control"

echo "== 15. --control green + mutated red -> teeth, and BOTH legs ran =="
# The `echo checked` is load-bearing, not decoration. `grep -q` prints NOTHING, and a
# command that produces no output at all is now a HARNESS ERROR in its own right
# (an earlier task — "I found no output" must never be read as a result). The property
# under test here is the CONTROL DIFFERENTIAL, not silence, so the fixture emits a
# line the way any real command would. Case 24 probes the blank case deliberately.
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --control \
        -- bash -c 'echo run >> "$RUNLOG_PATH"; echo checked; grep -q "TARGET LINE" "$1" && exit 0 || exit 1' _ "$TARGET" 2>&1)"
check "exit code" "$?" "0"
check "both legs ran" "$(runs)" "2"
grep -q "CONTROL GREEN" <<<"$OUT" && ok "reports the control leg green" || bad "did not report a green control"

echo "== 16. --control alone satisfies the attribution rule (no witness needed) =="
fresh
CMD_EXIT_UNUSED=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --control \
  -- bash -c 'echo checked; grep -q "TARGET LINE" "$1" && exit 0 || exit 1' _ "$TARGET" >/dev/null 2>&1
check "exit code" "$?" "0"

echo "== 17. --reachability-witness is the same flag as --witness (both spellings live) =="
fresh
CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
  --reachability-witness "$WITNESS_STR" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "0"

# =============================================================================
# DEFECT 2 — FAILS CLOSED. What is on disk is what must be matched.
# =============================================================================
ESC="$WORK/escapes.txt"
# Literal two-character sequences on disk: `\n`, `\t`, and a trailing backslash.
esc_fresh() { printf 'alpha\nprintf %%s\\n foo\nbeta\tb\\tb\ngamma trailing\\\nomega\n' > "$ESC"; }
esc_sha()   { sha256sum "$ESC" | cut -d' ' -f1; }

probe_esc() { # <anchor> -> rc
  bash "$PROBE" --file "$ESC" --anchor "$1" --replace "MUTATED-$2" --witness ran \
    -- bash -c 'echo ran; exit 1' >/dev/null 2>&1
}

echo "== 18. a line containing a literal \\n is PROBEABLE (awk -v ate it before) =="
esc_fresh; BEFORE="$(esc_sha)"
probe_esc 'printf %s\n foo' n
check "exit code" "$?" "0"
check "file restored byte-identical" "$(esc_sha)" "$BEFORE"

echo "== 19. a line containing a literal \\t is PROBEABLE =="
esc_fresh
probe_esc "$(printf 'beta\tb\\tb')" t
check "exit code" "$?" "0"

echo "== 20. a line with a TRAILING BACKSLASH is PROBEABLE =="
esc_fresh
probe_esc 'gamma trailing\' b
check "exit code" "$?" "0"

echo "== 21. a genuinely ABSENT anchor STILL fails closed (the match was not loosened) =="
# 18-20 must not have been bought by making the comparison fuzzy. These three anchors
# are each ONE character away from a real line and must all match ZERO lines.
esc_fresh
for A in 'printf %s\nfoo' 'printf %sn foo' 'gamma trailing'; do
  probe_esc "$A" x
  RC=$?
  check "absent anchor $(printf '%q' "$A") -> 2" "$RC" "2"
done

echo "== 22. NUMERIC anchors compare as BYTES, not as numbers (awk strnum, fails OPEN) =="
# awk: printf '1.0\n' | awk -v a='1.00' '$0==a{n++} END{print n+0}'  ->  1
# That silently mutates a DIFFERENT line than the one you named, and the landing
# assertions agree because they used the same comparison.
printf 'alpha\n1.0\nomega\n' > "$ESC"
probe_esc '1.00' num
check "'1.00' does not match the line '1.0'" "$?" "2"
printf 'alpha\n1.0\nomega\n' > "$ESC"
probe_esc '1.0' num
check "'1.0' DOES match the line '1.0' (the match still works)" "$?" "0"

# =============================================================================
# DEFECT 3 / DEFECT 4 — THE WITNESS ITSELF COULD BE FORGED OR SWALLOWED
# =============================================================================
# The witness is the pre-condition every other assertion in this file rests on, and it
# had a hole in each direction:
#
#   FORGED (failed OPEN, a false green). The witness was matched ANYWHERE in the output.
#   A mutant that does not COMPILE makes the runner print a source listing of the
#   offending file — which reproduces the mutated line, witness string included, behind
#   a gutter — and exit non-zero. Non-zero + witness "seen" = "guard has teeth", from a
#   mutant that executed nothing. Measured against real vitest in section E below.
#
#   SWALLOWED (failed CLOSED, and it cost a real lane two rounds). mcp-server's
#   vitest.setup.ts no-ops console.* for every test, so a console witness emits nothing
#   even when the mutation landed perfectly. The tool must refuse to judge AND say why,
#   because the tempting next move is to weaken the probe until something prints.
#
# These cases are hermetic (no npm, no vitest). Section E drives the real runner.
# =============================================================================

echo "== 23. an INDENTED witness is NOT evidence the code ran (the forged witness) =="
# This is the column-0 rule on its own, isolated from the no-tests backstop: the command
# exits non-zero and the witness string IS in the output — but indented, exactly as a
# syntax-error source listing reproduces the mutated line. Scoring this is the false
# green. No runner involved, so this case holds even if every runner rewords its output.
fresh
OUT="$(CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
        --witness "$WITNESS_STR" \
        -- bash -c 'echo "  2  |    line containing REACHED-THE-MUTANT here"; exit 1' 2>&1)"
check "exit code is CANNOT MEASURE, not teeth" "$?" "2"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "scored teeth off an INDENTED witness (the forged-witness false green)" \
  || ok "an indented witness is refused"
grep -q "NOT AT COLUMN 0" <<<"$OUT" && ok "names indentation as the reason and shows where it matched" \
  || bad "did not explain that the witness was present but indented"

echo "== 24. THE ABSENT CASE: no output at all is a HARNESS ERROR, never a result =="
# "I found nothing" must not be read as either answer. Probed in BOTH directions, because
# a harness that reports success off an empty read is the exact bug this task removes.
fresh
EMIT_NOISE=0 EMIT_WITNESS=0 CMD_EXIT=1 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" \
  --replace "MUTATED" --witness "$WITNESS_STR" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "blank output + non-zero exit -> 2 (not scored as RED/teeth)" "$?" "2"
fresh
OUT="$(EMIT_NOISE=0 EMIT_WITNESS=0 CMD_EXIT=0 bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" \
  --replace "MUTATED" --witness "$WITNESS_STR" -- "$WORK/cmd.sh" 2>&1)"
check "blank output + zero exit -> 2 (not scored as GREEN/blind)" "$?" "2"
grep -q "NO output at all" <<<"$OUT" && ok "names the absent output as the reason" || bad "did not name the absent output"
grep -qE "guard has teeth|BLIND GUARD" <<<"$OUT" && bad "produced a verdict from an empty read" || ok "no verdict from an empty read"

echo "== 24b. THE ABSENT CASE where NOTHING ELSE CATCHES IT: --control, no witness =="
# Found by mutation-probing this file's own guard. Case 24 above requests
# a witness, so disabling the blank-output check entirely still leaves the WITNESS check
# to refuse the run — case 24 kept passing on exit code and only its message assertion
# went red. The blank rule is only load-bearing on the path where no witness is required:
# attribution by --control alone. There, a control that printed nothing and a mutant that
# printed nothing are a "teeth" verdict drawn from ZERO observed evidence, which is the
# exact shape this task exists to make impossible. `grep -q` prints nothing by design.
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --control \
        -- bash -c 'grep -q "TARGET LINE" "$1" && exit 0 || exit 1' _ "$TARGET" 2>&1)"
check "control-only attribution with NO output at all -> 2, not teeth" "$?" "2"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "scored teeth from two runs that produced no output at all" \
  || ok "no teeth from a differential with nothing observed behind it"

echo "== 25. ZERO TESTS EXECUTED is a HARNESS ERROR even with a column-0 witness =="
# The backstop for the stream channel. A runner that compiled nothing exits non-zero
# exactly like a runner whose guard fired; the exit code cannot separate them.
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
        --witness "$WITNESS_STR" \
        -- bash -c 'echo "REACHED-THE-MUTANT"; echo "      Tests  no tests"; exit 1' 2>&1)"
check "exit code is CANNOT MEASURE, not teeth" "$?" "2"
grep -q "ZERO TESTS EXECUTED" <<<"$OUT" && ok "names zero-tests as the reason" || bad "did not name zero-tests"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "scored teeth from a run that executed no tests" || ok "no teeth from a run with no tests"

echo "== 26. a CONTROL leg that executed no tests is not a green baseline =="
# Checked on the control too, deliberately: every later RED would be attributed to the
# mutation on the strength of this leg, so an unmeasured control must not pass as green.
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" --control \
        -- bash -c 'echo "      Tests  no tests"; exit 0' 2>&1)"
check "exit code is CANNOT MEASURE" "$?" "2"
grep -q "CONTROL" <<<"$OUT" && ok "attributes the harness error to the control leg" || bad "did not name the control leg"
grep -q "CONTROL GREEN" <<<"$OUT" && bad "called an unmeasured control GREEN" || ok "did not call an unmeasured control green"

echo "== 27. --witness-file: the channel no console spy can silence and no output can forge =="
WFILE="$WORK/witness.txt"
fresh
# The command writes the marker to the path the harness handed it in the environment.
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
        --witness "$WITNESS_STR" --witness-file "$WFILE" \
        -- bash -c 'echo noise; printf "%s\n" "$WITNESS_STR_ENV" >> "$MUTATION_PROBE_WITNESS"; exit 1' 2>&1)"
check "witness written to the file -> teeth" "$?" "0"
grep -q "witness file" <<<"$OUT" && ok "reports the file channel was used" || bad "did not report the file channel"

echo "== 28. a witness in the OUTPUT cannot satisfy --witness-file (no forging) =="
# The whole value of the file channel: reporter output is not admissible evidence for it.
fresh
OUT="$(bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
        --witness "$WITNESS_STR" --witness-file "$WFILE" \
        -- bash -c 'echo "REACHED-THE-MUTANT"; exit 1' 2>&1)"
check "column-0 witness in stdout does NOT satisfy the file channel" "$?" "2"
grep -q "$TEETH_VERDICT" <<<"$OUT" && bad "forged a file witness from stream output" || ok "stream output cannot forge a file witness"

echo "== 29. the witness file is TRUNCATED per run (a stale marker cannot vouch) =="
# Without this, one landed run vouches for every later run that never reached the code.
printf '%s\n' "$WITNESS_STR" > "$WFILE"
fresh
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
  --witness "$WITNESS_STR" --witness-file "$WFILE" \
  -- bash -c 'echo noise; exit 1' >/dev/null 2>&1
check "a pre-existing marker does not count as this run's witness" "$?" "2"

echo "== 30. --witness-file without --witness is refused (a check that always passes) =="
fresh
bash "$PROBE" --file "$TARGET" --anchor "TARGET LINE" --replace "MUTATED" \
  --witness-file "$WFILE" -- "$WORK/cmd.sh" >/dev/null 2>&1
check "exit code" "$?" "2"

echo
if [[ $FAIL -eq 0 ]]; then
  printf '\033[32mmutation-probe.test.sh: %d passed, 0 failed\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[31mmutation-probe.test.sh: %d passed, %d FAILED\033[0m\n' "$PASS" "$FAIL"
exit 1
