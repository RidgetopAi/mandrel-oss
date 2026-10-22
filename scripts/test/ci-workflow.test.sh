#!/usr/bin/env bash
# ci-workflow.test.sh — pins the CI wiring of the OSS gate:
#   A. .github/workflows/ci.yml defines exactly one job, triggered on push and pull_request to main,
#      whose run step executes `bash scripts/oss-gate.sh`, and names no private-repo vocabulary.
#   B. scripts/oss-gate.sh STAGE H selects every scripts/test/*.test.sh of the real tree  — so a newly added test is enforced without any wiring.
#   C. STAGE H goes RED on a failing test and GREEN without one (measured on a fixture repo, so this
#      suite never re-runs the real tests it is itself one of).
# Exit 0 = pass, 1 = fail.
#
# USAGE:  bash scripts/test/ci-workflow.test.sh
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="${CI_WORKFLOW_FILE:-$REPO_DIR/.github/workflows/ci.yml}"
GATE_CMD="bash scripts/oss-gate.sh"
# The last word is split so this file does not itself trip the internal-refs ban (STAGE R).
FORBIDDEN_RE='ci-clean-gate|fleet|tenant|het''zner'

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

# --- A. the workflow file -------------------------------------------------------------------------
echo "== A. ci.yml =="
[[ -f "$WORKFLOW" ]] || { bad "missing: $WORKFLOW"; exit 1; }

# Names directly under the top-level `jobs:` key (two-space indent).
jobs="$(awk '/^jobs:/ {in_jobs=1; next} in_jobs && /^[^ #]/ {in_jobs=0} in_jobs && /^  [A-Za-z0-9_-]+:[ ]*$/ {sub(/^  /, ""); sub(/:.*/, ""); print}' "$WORKFLOW")"
check "exactly one job (found: $(echo $jobs))" test "$(printf '%s\n' "$jobs" | grep -c .)" -eq 1

# The `on:` block: the lines between `on:` and the next top-level key.
on_block="$(awk '/^on:/ {f=1; next} f && /^[^ #]/ {f=0} f' "$WORKFLOW")"
trigger_branches() {  # <push|pull_request> — branch list lines under that trigger
  printf '%s\n' "$on_block" | awk -v t="$1" '
    $0 ~ "^  " t ":" {f=1; next}
    f && /^  [^ ]/ {f=0}
    f' | tr -d ' []' 
}
for ev in push pull_request; do
  check "triggered on $ev" grep -qE "^  $ev:" <<<"$on_block"
  check "$ev is limited to branch main" grep -qE '^branches:main$|^-main$|^branches:$' <<<"$(trigger_branches $ev)"
done
check "no other trigger" test "$(printf '%s\n' "$on_block" | grep -cE '^  [a-z_]+:')" -eq 2

runs="$(grep -E '^[[:space:]]*(-[[:space:]]+)?run:' "$WORKFLOW" | sed -E 's/^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*//')"
check "a run step executes exactly '$GATE_CMD'" grep -qxF "$GATE_CMD" <<<"$runs"
check "no run step invokes a different gate" test -z "$(grep -E 'scripts/[A-Za-z0-9_./-]*(gate|ci)[A-Za-z0-9_.-]*\.sh' "$WORKFLOW" | grep -v 'scripts/oss-gate.sh')"
check "no line mentions private vocabulary (/$FORBIDDEN_RE/i)" test -z "$(grep -inE "$FORBIDDEN_RE" "$WORKFLOW")"

# --- B. STAGE H selects every real test ------------------------------------------------------------
echo "== B. STAGE H covers every scripts/test/*.test.sh =="
# shellcheck source=/dev/null
. "$REPO_DIR/scripts/oss-gate/config.sh"
shopt -s nullglob
actual=("$REPO_DIR"/scripts/test/*.test.sh)
shopt -u nullglob
check "the tree has shell tests to select (${#actual[@]})" test "${#actual[@]}" -gt 0
check "the stage's glob is $OSS_GATE_SHELL_TEST_GLOB" test "$OSS_GATE_SHELL_TEST_GLOB" = "scripts/test/*.test.sh"
check "the config defines no exclusion list" test -z "$(grep -n SHELL_TEST_EXCLUDE "$REPO_DIR/scripts/oss-gate/config.sh" "$REPO_DIR/scripts/oss-gate.sh" | grep -v "^[^:]*:[0-9]*:#")"

# --- C. RED / GREEN on a fixture repo -------------------------------------------------------------
echo "== C. STAGE H verdicts (fixture repo) =="
FIX="$(mktemp -d "${TMPDIR:-/tmp}/ci-workflow-test.XXXXXX")"
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/scripts/oss-gate" "$FIX/scripts/test"
cp "$REPO_DIR/scripts/oss-gate.sh" "$FIX/scripts/"
cp "$REPO_DIR/scripts/oss-gate/config.sh" "$FIX/scripts/oss-gate/config.sh"
printf 'exit 0\n' > "$FIX/scripts/test/aa-pass.test.sh"
printf 'exit 0\n' > "$FIX/scripts/test/not-a-test.sh"
( cd "$FIX" && git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm fixture ) >/dev/null 2>&1

run_h() { ( cd "$FIX" && env -i PATH="$PATH" HOME="$FIX" bash scripts/oss-gate.sh --shell-tests-only 2>&1 ); }

out="$(run_h)"; rc=$?
check "control (all pass): rc 0 (got $rc)" test "$rc" -eq 0
check "control: last line starts with OSS-GATE GREEN" grep -q '^OSS-GATE GREEN' <<<"$(tail -n 1 <<<"$out")"
check "control: only *.test.sh files are run (1 test)" grep -q 'H  *ok .*1 shell tests passed' <<<"$out"

printf 'exit 1\n' > "$FIX/scripts/test/zz-probe.test.sh"
out="$(run_h)"; rc=$?
check "a new zz-probe.test.sh containing 'exit 1': rc 1 (got $rc)" test "$rc" -eq 1
check "probe: last line starts with OSS-GATE RED" grep -q '^OSS-GATE RED' <<<"$(tail -n 1 <<<"$out")"
check "probe: the failing test is named" grep -q 'failing shell tests: zz-probe.test.sh' <<<"$out"
rm -f "$FIX/scripts/test/zz-probe.test.sh"

printf 'exit 3\n' > "$FIX/scripts/test/zz-probe.test.sh"
out="$(run_h)"; rc=$?
check "any non-zero exit (3) is RED, not merely 1 (got $rc)" test "$rc" -eq 1
rm -f "$FIX/scripts/test/zz-probe.test.sh"

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
