#!/usr/bin/env bash
# =============================================================================
# openapi-artifact-drift.test.sh — the OpenAPI contract-drift gate
# -----------------------------------------------------------------------------
# WHAT THIS EXISTS TO STOP
#   The Command-UI API contract has ONE source: the `@swagger` JSDoc annotations on
#   mandrel-command/backend/src/routes/*.ts. It has TWO checked-in derivations —
#   frontend/.openapi/openapi.json and frontend/src/api/generated/** — and until this
#   stage NOTHING regenerated or compared them. The only thing keeping the shipped
#   artifacts equal to the code was a human remembering to run a script, and measured
#   on an earlier change (v0.50.0) they were not equal: the spec was missing 4 whole paths,
#   disagreed on 9 more, and 5 generated service files differed. The drift had
#   accumulated across several unrelated tasks. The artifact a customer reads to
#   understand our API — including which routes require a credential — could, and did,
#   contradict the code.
#
# HOW IT MEASURES
#   It runs the SHIPPED regeneration command (`npm run generate:openapi`) in the real
#   tree and diffs both artifacts against a byte snapshot taken first, then restores
#   the snapshot. Driving the shipped entry point is deliberate: the codegen flags
#   live in frontend/package.json, and a guard that re-typed them would keep validating
#   a decoy the moment they changed (C3 — read the subject the product reads).
#
# THE THIRD REPRESENTATION
#   The spec served live at /api/openapi/openapi.json is NOT a third hand-maintained
#   copy: routes/openapi.ts imports the same swagger-jsdoc module the exporter imports,
#   so the exported bytes are the live bytes. Section 5 asserts that identity instead of
#   claiming it in prose — if the two ever fork, this stage goes RED and the coverage
#   argument stops being asserted along with it.
#
# FAIL-CLOSED, AND THE THIRD STATE
#   A regeneration that errors, an artifact that is missing, an unparseable spec, or a
#   spec below the path floor are all FAILURES (rc 1) — never a clean diff. A missing
#   TOOLCHAIN is a different answer: that is a fact about the box, and it exits 2
#   (could-not-measure), which this gate never reads as a pass.
#
# WHAT THIS DOES NOT PROVE (the honest bounds)
#   1. It does not prove the ANNOTATIONS are right. It proves the artifacts say what
#      the annotations say. A wrong `security:` in a route source is a defect this
#      stage cannot see; scripts/../mutatingRouteAuthzCoverage is the guard for that.
#   2. It does not prove the RUNNING backend serves a populated spec. Section 5 pins
#      the module identity and the floor in section 3 catches a collapsed glob HERE,
#      but this stage's population is the CI checkout. The runtime image is a different
#      population and it WAS broken while this stage was green: the runner ships no
#      src/, so the cwd-relative `apis` glob found nothing and all 7 containers served
#      `paths: []` (measured 2026-08-31). That is now STAGE 5p's
#      subject — scripts/test/openapi-served-spec.test.sh loads the serving module
#      from a sourceless dist/. This stage still does not measure it; 5p does.
#   3. It mutates the working tree for the duration of the regeneration and restores
#      it on EXIT. Two concurrent runs in one checkout would race; the clean gate
#      serializes on a flock and runs from a pristine checkout, so that is not a state
#      it can reach there.
#
# Usage: bash scripts/test/openapi-artifact-drift.test.sh
# Exit:  0 all assertions pass · 1 a real failure · 2 could not measure
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE_RC_HARNESS_ERR=2

RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
PASS=0; FAIL=0
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
pass() { PASS=$((PASS+1)); printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; }
fail() { FAIL=$((FAIL+1)); printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; }
die()  { printf '%sCOULD NOT MEASURE: %s%s\n' "$RED" "$*" "$RST" >&2; exit "$GATE_RC_HARNESS_ERR"; }

# shellcheck source=../lib/openapi-drift.config.sh
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/openapi-drift.config.sh" \
  || die "cannot source scripts/lib/openapi-drift.config.sh"

COMPARE="$REPO_DIR/scripts/lib/openapi-drift-compare.cjs"
REGEN_DIR="$REPO_DIR/$OPENAPI_DRIFT_REGEN_DIR"
SPEC="$REPO_DIR/$OPENAPI_DRIFT_SPEC_PATH"
CLIENT_DIR="$REPO_DIR/$OPENAPI_DRIFT_CLIENT_DIR"

[[ -r "$COMPARE" ]]     || die "comparator missing: $COMPARE"
[[ -d "$REGEN_DIR" ]]   || die "regeneration dir missing: $REGEN_DIR"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/openapi-drift-XXXXXX")" || die "mktemp failed"

# -----------------------------------------------------------------------------
# RESTORE ON EVERY EXIT PATH. The regeneration writes into the working tree; the
# snapshot taken in section 2 is put back here whether we pass, fail, or die. A
# guard that leaves the tree rewritten would hand the NEXT stage a green it did not
# earn (the artifacts would agree because this stage had just made them agree).
# -----------------------------------------------------------------------------
SNAP_TAKEN=0
restore() {
  if [[ "$SNAP_TAKEN" -eq 1 ]]; then
    rm -rf "$CLIENT_DIR"
    cp -a "$TMP/before/generated" "$CLIENT_DIR"
    cp -a "$TMP/before/openapi.json" "$SPEC"
  fi
  rm -rf "$TMP"
}
trap restore EXIT

# =============================================================================
hdr "1. toolchain preflight (a missing tool is a fact about the BOX, not the commit)"
# =============================================================================
command -v node >/dev/null 2>&1 || die "node not on PATH"
command -v npm  >/dev/null 2>&1 || die "npm not on PATH"

# Resolve the generators the shipped command needs, FROM the directories that will run
# them. Without this a sandboxed `npx` would try the network, fail, and the diff stage
# would report a RED that says nothing about the commit.
# Prints the name of the first tool that does not resolve; returns 0 when all do.
# `typescript` (tsc) is checked because ts-node and the stages after this one need it.
_openapi_drift_missing_tool() {
  local spec dir pkg
  for spec in \
    "$REGEN_DIR:openapi-typescript-codegen" \
    "$REPO_DIR/mandrel-command/backend:swagger-jsdoc" \
    "$REPO_DIR/mandrel-command/backend:ts-node" \
    "$REPO_DIR/mandrel-command/backend:typescript"; do
    dir="${spec%%:*}"; pkg="${spec#*:}"
    if ! ( cd "$dir" && node -e 'require.resolve(process.argv[1] + "/package.json")' "$pkg" ) >/dev/null 2>&1; then
      echo "$pkg"; return 1
    fi
  done
  # `require.resolve` can succeed from a package reachable OUTSIDE this checkout (a parent
  # node_modules / NODE_PATH) while the checkout has no linked `.bin/<tool>` — and the
  # shipped `npm run openapi:export` runs the BIN (`sh: ts-node: not found`, rc=127,
  # merged-ref gate 2026-10-23). Measure what the command will execute.
  _openapi_drift_bin_linked ts-node || { echo "ts-node (no linked .bin/ts-node)"; return 1; }
  return 0
}
_openapi_drift_bin_linked() {
  local tool="$1" d
  for d in "$REPO_DIR/mandrel-command/backend" "$REPO_DIR/mandrel-command"; do
    [[ -x "$d/node_modules/.bin/$tool" ]] && return 0
  done
  return 1
}

# NEVER INSTALL BY DEFAULT. Under mandrel-oss's scripts/oss-gate.sh this directory is the
# gate's OWN working tree; a reinstall that is interrupted leaves
# mandrel-command/node_modules half-empty and the next stage dies with `tsc: not found`.
# A missing tool is could-not-measure (exit 2), named. ONLY a caller that owns a
# single-use checkout opts in, with OPENAPI_DRIFT_SELF_PROVISION=1, and the install itself
# lives in scripts/lib/openapi-drift-self-provision.sh, so this file carries no install
# invocation.
if ! MISSING_TOOL="$(_openapi_drift_missing_tool)"; then
  if [[ "$OPENAPI_DRIFT_SELF_PROVISION" != 1 ]]; then
    die "toolchain package '$MISSING_TOOL' does not resolve from mandrel-command — run the gate's deps stage (the lockfile install in mandrel-command) first; this test never installs into the tree it measures unless OPENAPI_DRIFT_SELF_PROVISION=1"
  fi
  echo "  toolchain package '$MISSING_TOOL' does not resolve from mandrel-command"
  bash "$REPO_DIR/scripts/lib/openapi-drift-self-provision.sh" "$REPO_DIR" "$TMP/self_provision_npm_ci.log" \
    || die "self-provisioning failed (see above) — an environmental fact about this box, not a verdict on the commit"
  MISSING_TOOL="$(_openapi_drift_missing_tool)" \
    || die "toolchain package '$MISSING_TOOL' still does not resolve after self-provisioning — see mandrel-command/package.json"
fi
echo "  toolchain resolves: node $(node -v), openapi-typescript-codegen, swagger-jsdoc, ts-node, typescript"

# =============================================================================
hdr "2. the checked-in artifacts EXIST (an absent artifact is a FAILURE, not a clean diff)"
# =============================================================================
ARTIFACTS_OK=1
if [[ -f "$SPEC" ]]; then
  pass "checked-in specification present: $OPENAPI_DRIFT_SPEC_PATH"
else
  fail "checked-in specification MISSING: $OPENAPI_DRIFT_SPEC_PATH — the frontend generates its API client from this file; its absence is a broken contract, not an empty population"
  ARTIFACTS_OK=0
fi
if [[ -d "$CLIENT_DIR" ]]; then
  pass "checked-in generated client present: $OPENAPI_DRIFT_CLIENT_DIR"
else
  fail "checked-in generated client MISSING: $OPENAPI_DRIFT_CLIENT_DIR"
  ARTIFACTS_OK=0
fi

if [[ "$ARTIFACTS_OK" -eq 1 ]]; then
  mkdir -p "$TMP/before"
  cp -a "$SPEC" "$TMP/before/openapi.json"
  cp -a "$CLIENT_DIR" "$TMP/before/generated"
  SNAP_TAKEN=1

  # =============================================================================
  hdr "3. regenerate from the route sources with the SHIPPED command, and prove it produced something"
  # =============================================================================
  # DELETE THE ARTIFACTS FIRST. Without this the floor and the diff below both read
  # the files IN PLACE, so a regeneration that exits 0 without WRITING leaves the
  # stale checked-in copies sitting there — they diff byte-identical against their
  # own snapshot and trivially clear the floor. Measured: the mutated and unmutated
  # runs were byte-for-byte indistinguishable at 16/0 rc 0. The stage announced it
  # had measured a contract it never touched.
  # The path floor only covers the COLLAPSED-GLOB case (an export that writes an
  # EMPTY spec). The NO-WRITE case is the likelier one — an output path that moves,
  # a --output flag that changes, a wrapper swallowing a write error. Removing the
  # artifacts makes both fail on absence instead. The restore trap puts them back.
  rm -f "$SPEC"
  rm -rf "$CLIENT_DIR"

  REGEN_LOG="$TMP/regen.log"
  REGEN_RC=0
  ( cd "$REGEN_DIR" && npm run "$OPENAPI_DRIFT_REGEN_SCRIPT" ) >"$REGEN_LOG" 2>&1 || REGEN_RC=$?
  if [[ "$REGEN_RC" -eq 0 ]]; then
    pass "npm run $OPENAPI_DRIFT_REGEN_SCRIPT (in $OPENAPI_DRIFT_REGEN_DIR) exited 0"
  else
    fail "npm run $OPENAPI_DRIFT_REGEN_SCRIPT FAILED (rc=$REGEN_RC) — log tail:"
    # The ROOT CAUSE (a ts-node diagnostic, a missing module) prints BEFORE npm's
    # trailing "command failed" lines, so a bare tail hides it. Show the first
    # error-bearing lines as well as the tail.
    grep -n -m 20 -i -E 'error|TS[0-9]{4}|cannot find|ENOENT' "$REGEN_LOG" | sed 's/^/      first: /'
    tail -20 "$REGEN_LOG" | sed 's/^/      /'
  fi

  FLOOR_OUT=""; FLOOR_RC=0
  FLOOR_OUT="$(node "$COMPARE" floor "$SPEC" "$OPENAPI_DRIFT_MIN_PATHS" 2>&1)" || FLOOR_RC=$?
  if [[ "$FLOOR_RC" -eq 0 ]]; then
    pass "regenerated spec clears the path floor — $FLOOR_OUT"
  else
    fail "$FLOOR_OUT"
  fi

  CLIENT_FILES=0
  [[ -d "$CLIENT_DIR" ]] && CLIENT_FILES="$(find "$CLIENT_DIR" -type f | wc -l)"
  if [[ "$CLIENT_FILES" -ge "$OPENAPI_DRIFT_MIN_CLIENT_FILES" ]]; then
    pass "regenerated client clears the file floor — $CLIENT_FILES file(s) (floor $OPENAPI_DRIFT_MIN_CLIENT_FILES)"
  else
    fail "regenerated client emitted $CLIENT_FILES file(s), below the floor of $OPENAPI_DRIFT_MIN_CLIENT_FILES — a truncated codegen run, not a clean diff"
  fi

  # =============================================================================
  hdr "4. DIFF — the checked-in artifacts must be what the route annotations produce"
  # =============================================================================
  SPEC_OUT=""; SPEC_RC=0
  SPEC_OUT="$(node "$COMPARE" spec "$TMP/before/openapi.json" "$SPEC" 2>&1)" || SPEC_RC=$?
  if [[ "$SPEC_RC" -eq 0 ]]; then
    pass "$OPENAPI_DRIFT_SPEC_PATH is byte-identical to a fresh export"
  else
    fail "$SPEC_OUT"
    echo "      Fix: run \`npm run $OPENAPI_DRIFT_REGEN_SCRIPT\` in $OPENAPI_DRIFT_REGEN_DIR and commit the result."
  fi

  CLIENT_OUT=""; CLIENT_RC=0
  CLIENT_OUT="$(diff -rq "$TMP/before/generated" "$CLIENT_DIR" 2>&1)" || CLIENT_RC=$?
  if [[ "$CLIENT_RC" -eq 0 ]]; then
    pass "$OPENAPI_DRIFT_CLIENT_DIR is identical to a fresh codegen run ($CLIENT_FILES file(s))"
  else
    fail "generated client DRIFT — $OPENAPI_DRIFT_CLIENT_DIR is not what the specification produces:"
    echo "$CLIENT_OUT" | sed "s#$TMP/before/generated#<checked-in>#g; s#$CLIENT_DIR#<fresh>#g; s/^/      /"
    echo "      Fix: run \`npm run $OPENAPI_DRIFT_REGEN_SCRIPT\` in $OPENAPI_DRIFT_REGEN_DIR and commit the result."
  fi
fi

# =============================================================================
hdr "5. the LIVE-served spec is the same derivation (construction identity, not prose)"
# =============================================================================
ID_OUT=""; ID_RC=0
ID_OUT="$(node "$COMPARE" identity \
  "$REPO_DIR/$OPENAPI_DRIFT_EXPORTER_TS" \
  "$REPO_DIR/$OPENAPI_DRIFT_LIVE_ROUTE_TS" \
  config/openapi 2>&1)" || ID_RC=$?
if [[ "$ID_RC" -eq 0 ]]; then
  pass "exporter and live route read one module — $ID_OUT"
else
  fail "$ID_OUT"
fi

# =============================================================================
hdr "6. self-probes — this comparator must be able to go RED, and must not pass vacuously"
# =============================================================================
# The three C3 assertions against the detector itself, on throwaway fixtures. Section
# 4's green is only worth something if these are true; without them a comparator that
# had stopped comparing would look exactly the same in the log.
PROBE="$TMP/probe"; mkdir -p "$PROBE"
cat > "$PROBE/control.json" <<'JSON'
{"openapi":"3.0.0","paths":{"/a":{"get":{"summary":"a"}},"/b":{"get":{"summary":"b"}}},
 "components":{"schemas":{"S":{"type":"object"}}}}
JSON

# CONTROL — identical inputs must be GREEN, or every RED below means nothing.
if node "$COMPARE" spec "$PROBE/control.json" "$PROBE/control.json" >/dev/null 2>&1; then
  pass "control: identical specs compare clean"
else
  fail "control: identical specs did NOT compare clean — the comparator is broken, and every RED it produces is uninterpretable"
fi

# MUTATION 1 — the exact defect that opened this task: a `security: []` re-appearing
# on a route the source authenticates. The mutant must go RED and must NAME the path.
sed 's#"/b":{"get":{"summary":"b"}}#"/b":{"get":{"summary":"b","security":[]}}#' \
  "$PROBE/control.json" > "$PROBE/security.json"
if cmp -s "$PROBE/control.json" "$PROBE/security.json"; then
  fail "mutation 1 did NOT LAND — the fixture is unchanged, so the probe below proves nothing"
else
  M1_OUT="$(node "$COMPARE" spec "$PROBE/security.json" "$PROBE/control.json" 2>&1)"; M1_RC=$?
  if [[ "$M1_RC" -ne 0 ]] && [[ "$M1_OUT" == *"/b"* ]]; then
    pass "mutation 1 (a stale empty security block) -> RED, and the report names the drifting path"
  else
    fail "mutation 1 -> rc=$M1_RC, output did not name the drifting path: $M1_OUT"
  fi
fi

# MUTATION 2 — a whole path present in the source and absent from the artifact (the
# shape 4 real paths had at v0.50.0).
sed 's#,"/b":{"get":{"summary":"b"}}##' "$PROBE/control.json" > "$PROBE/missing.json"
if cmp -s "$PROBE/control.json" "$PROBE/missing.json"; then
  fail "mutation 2 did NOT LAND — the fixture is unchanged"
else
  M2_OUT="$(node "$COMPARE" spec "$PROBE/missing.json" "$PROBE/control.json" 2>&1)"; M2_RC=$?
  if [[ "$M2_RC" -ne 0 ]] && [[ "$M2_OUT" == *"ADDED BY REGENERATION"* ]]; then
    pass "mutation 2 (a path missing from the artifact) -> RED, reported as added by regeneration"
  else
    fail "mutation 2 -> rc=$M2_RC, unexpected report: $M2_OUT"
  fi
fi

# EMPTY POPULATION — a spec with zero paths is the collapsed-glob signature and must
# FAIL rather than sail through as a well-formed file.
printf '{"openapi":"3.0.0","paths":{}}\n' > "$PROBE/empty.json"
if node "$COMPARE" floor "$PROBE/empty.json" "$OPENAPI_DRIFT_MIN_PATHS" >/dev/null 2>&1; then
  fail "empty probe: a spec documenting ZERO paths passed the floor — the stage would announce it had measured a contract it had not"
else
  pass "empty probe: a spec documenting zero paths FAILS the floor"
fi

# ABSENT POPULATION — no file at all.
if node "$COMPARE" floor "$PROBE/does-not-exist.json" "$OPENAPI_DRIFT_MIN_PATHS" >/dev/null 2>&1; then
  fail "absent probe: a MISSING spec passed the floor"
else
  pass "absent probe: a missing spec FAILS the floor"
fi

# UNPARSEABLE — a truncated write is what a killed export leaves behind.
printf '{"openapi":"3.0.0","paths":{' > "$PROBE/truncated.json"
if node "$COMPARE" spec "$PROBE/control.json" "$PROBE/truncated.json" >/dev/null 2>&1; then
  fail "truncated probe: an unparseable spec compared clean"
else
  pass "truncated probe: an unparseable spec FAILS"
fi

# IDENTITY FORK — the section-5 assertion must be able to go RED.
mkdir -p "$PROBE/id"
printf 'export const a = 1;\n' > "$PROBE/id/cfg-one.ts"
printf 'export const b = 2;\n' > "$PROBE/id/cfg-two.ts"
printf "import s from './cfg-one';\n" > "$PROBE/id/exporter.ts"
printf "import s from './cfg-two';\n" > "$PROBE/id/route.ts"
# CONTROL FIRST: both files pointing at the same module must be GREEN, so the RED
# below is the FORK and not the probe simply failing to resolve anything.
if node "$COMPARE" identity "$PROBE/id/exporter.ts" "$PROBE/id/exporter.ts" cfg- >/dev/null 2>&1; then
  pass "identity control: a matched import pair is clean"
else
  fail "identity control: a matched import pair did NOT compare clean"
fi
ID_PROBE_OUT="$(node "$COMPARE" identity "$PROBE/id/exporter.ts" "$PROBE/id/route.ts" cfg- 2>&1)"; ID_PROBE_RC=$?
if [[ "$ID_PROBE_RC" -ne 0 ]] && [[ "$ID_PROBE_OUT" == *FORKED* ]]; then
  pass "identity probe: a forked import pair FAILS as FORKED (both sides resolved)"
else
  fail "identity probe: rc=$ID_PROBE_RC, unexpected report: $ID_PROBE_OUT"
fi

# =============================================================================
printf '\n%s%d passed, %d failed%s\n' "$BLD" "$PASS" "$FAIL" "$RST"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
