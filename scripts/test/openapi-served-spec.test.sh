#!/usr/bin/env bash
# =============================================================================
# openapi-served-spec.test.sh — does the SHIPPED IMAGE serve a populated OpenAPI spec?
# -----------------------------------------------------------------------------
# THE DEFECT THIS EXISTS FOR
#   config/openapi used to call swaggerJSDoc({apis:['./src/routes/*.ts']}) at module
#   load. swagger-jsdoc resolves that glob against the PROCESS CWD, and the backend
#   runner image runs from /app/backend having copied dist/ and no src/. The glob
#   matched nothing. It did not error: swagger-jsdoc returns a well-formed document
#   with `paths: {}` and exits 0.
#
#   MEASURED 2026-08-31 on the live fleet, image 5fe35c4e5a47 — all 7 running
#   command-backend containers, prod included: GET /api/openapi/openapi.json returned
#   HTTP 200, 33229 bytes, 70 schemas, 11 tags, and `paths: []`. A customer reading our
#   API spec got a document describing nothing, and it was indistinguishable from an
#   API that genuinely had no routes. The vacuous success in its quietest form.
#
# WHY STAGE 5o DID NOT CATCH IT, AND THIS DOES
#   5o measures the spec AS GENERATED IN A SOURCE TREE. It was green throughout,
#   correctly — it named this exact gap as its own known bound. Its population is the
#   CI checkout; the defect lives in the RUNTIME IMAGE, one layer over.
#
#   THIS GUARD'S POPULATION IS THE IMAGE'S CONDITION: a sourceless dist/, required from
#   a CWD that cannot see src/. That is the whole population, not a sample of it — the
#   runner stage of mandrel-command/backend/Dockerfile copies dist/ and no source, so
#   there is no other arrangement a container can be in. If the spec resolves here it
#   resolves there.
#
# HOW IT MEASURES (the choke point, not a remembered shape)
#   1. DELETES dist/ and then runs the SHIPPED build (`npm run build`), and asserts the
#      emitter's own witness line is in the build output. Both halves are load-bearing
#      and both were missing until Reviewer produced a false green (round 1, verdict
#      an earlier change): the guard used to just run the build, and with the emission step
#      removed from package.json it still passed — because a LEFTOVER artifact from an
#      earlier build was sitting in the warm tree's dist/ and tsc does not remove it.
#      Deleting dist/ makes this the Docker builder's actual condition (a fresh
#      container has no dist/), and the witness line proves the emission step RAN rather
#      than that a file happens to exist. Sensitivity to a mutation is not sensitivity
#      to a stage's ABSENCE; the witness is what tells those apart.
#   2. Copies ONLY dist/ into a throwaway directory — no src/, no node_modules, no
#      package.json — and ASSERTS that sandbox contains no src/routes/*.ts. That
#      assertion is the witness that the condition under test is real: without it a
#      sandbox that accidentally carried sources would pass for the wrong reason, which
#      is precisely the "decoy that looks healthier than the truth" this class turns on.
#   3. Loads the serving module from that sandbox FROM A CWD THAT IS NOT THE SANDBOX
#      (`/`), and asserts it resolved from the ARTIFACT, is not degraded, and clears the
#      floor the PRODUCT applies (read back out of the product's own config — never
#      restated here). The foreign CWD is the whole point and was the second false green
#      Reviewer produced: the fix is "anchor on __dirname, not process.cwd()", and when
#      CWD *is* the dist-containing root those two are INDISTINGUISHABLE. Re-anchoring
#      the loader on process.cwd() left the guard green while it printed "resolved from
#      the BUILD ARTIFACT (not a runtime glob)". The smallest input where fixed and
#      broken diverge is a CWD that is not the dist root, so that is where this runs.
#   4. NEGATIVE CONTROL: deletes the artifact from the sandbox and asserts the module
#      goes degraded AND emits a loud [openapi][FINDING]. This is the empty population,
#      and it proves the guard's subject really is the artifact rather than something
#      that would pass no matter what. A guard whose RED cannot be produced is not a
#      guard.
#   5. Asserts the SHIPPED ROUTE refuses a degraded spec with 503 rather than serving a
#      200 that carries an empty contract — driving the real handler out of the real
#      compiled router, with the floor raised so the resolution is genuinely degraded.
#
# WHAT THIS DOES NOT PROVE (the honest bounds)
#   1. It does not run a container. It reproduces the container's directory arrangement
#      from the same dist/ the Dockerfile copies. A change to WHICH files the runner
#      stage copies is outside this guard's reach.
#   2. It does not prove the ANNOTATIONS are right — only that what they produce is
#      what the image serves. That is 5o's job and mutatingRouteAuthzCoverage's.
#   3. It DELETES and rebuilds dist/ in the working tree. dist/ is gitignored box state
#      and `npm run build` is the sanctioned way to refresh it.
#
# Usage: bash scripts/test/openapi-served-spec.test.sh
# Exit:  0 all assertions pass · 1 a real failure · 2 could not measure
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE_RC_HARNESS_ERR=2

RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'

# shellcheck source=../lib/openapi-served.config.sh
source "$REPO_DIR/scripts/lib/openapi-served.config.sh"

BACKEND_DIR="$REPO_DIR/$OPENAPI_SERVED_BACKEND_DIR"
PROBE="$REPO_DIR/$OPENAPI_SERVED_PROBE"

FAILURES=0
pass() { printf '  %sPASS%s %s\n' "$GRN" "$RST" "$1"; }
fail() { printf '  %sFAIL%s %s\n' "$RED" "$RST" "$1"; FAILURES=$((FAILURES + 1)); }
nomeasure() { printf '%sCOULD NOT MEASURE:%s %s\n' "$RED" "$RST" "$1"; exit "$GATE_RC_HARNESS_ERR"; }

SANDBOX=""
cleanup() { [[ -n "$SANDBOX" && -d "$SANDBOX" ]] && rm -rf "$SANDBOX"; }
trap cleanup EXIT

printf '%sOpenAPI served-spec guard — does the shipped image serve a populated spec?%s\n' "$BLD" "$RST"

# --- preflight: toolchain facts are rc 2, never a verdict ---------------------
command -v node >/dev/null 2>&1 || nomeasure "node is not on PATH."
[[ -d "$BACKEND_DIR" ]] || nomeasure "backend dir not found at $BACKEND_DIR"
[[ -f "$PROBE" ]] || nomeasure "probe not found at $PROBE"
[[ -d "$BACKEND_DIR/node_modules" || -d "$BACKEND_DIR/../node_modules" ]] \
  || nomeasure "mandrel-command workspace deps are not installed — cannot build the backend."

# --- 1. the shipped build ------------------------------------------------------
printf '\n%s1. shipped build (npm run %s)%s\n' "$BLD" "$OPENAPI_SERVED_BUILD_SCRIPT" "$RST"

# Build from NO dist/, which is the Docker builder stage's actual condition. Without
# this a leftover artifact from an earlier build satisfies every assertion below even
# when the emission step has been removed from the build entirely (Reviewer, round 1).
# ${VAR:?} refuses to expand an empty BACKEND_DIR, so this cannot become `rm -rf /dist`.
rm -rf "${BACKEND_DIR:?}/dist"

BUILD_LOG="$(mktemp)"
if ( cd "$BACKEND_DIR" && npm run "$OPENAPI_SERVED_BUILD_SCRIPT" ) >"$BUILD_LOG" 2>&1; then
  pass "backend build succeeded"
  # THE WITNESS THAT THE EMISSION STEP RAN. A file existing afterwards is not evidence
  # the step executed; this line is emitted from inside the emitter itself. Matched on
  # the emitter's stable prefix rather than a restated filename, so it cannot drift out
  # of agreement with the basename the product config defines.
  if grep -q '\[emit-openapi-artifact\] wrote dist/' "$BUILD_LOG"; then
    pass "the shipped build RAN the artifact emitter: $(grep -m1 '\[emit-openapi-artifact\] wrote' "$BUILD_LOG" | sed 's/^\[emit-openapi-artifact\] //')"
  else
    fail "the shipped build emitted NO [emit-openapi-artifact] witness — artifact emission is"
    fail "  not part of \`npm run $OPENAPI_SERVED_BUILD_SCRIPT\` any more. A fresh Docker builder would ship"
    fail "  no artifact and every container would degrade to 503 across /api/openapi."
  fi
else
  # The emitter exits 1 when the spec it generated is below the floor — that is a REAL
  # failure and must not be laundered into could-not-measure. Anything else from the
  # build is a toolchain fact.
  if grep -q 'VACUOUS SPEC' "$BUILD_LOG"; then
    fail "the build refused to emit a spec below the path floor (this is the fail-closed firing):"
    sed 's/^/      /' "$BUILD_LOG" | tail -20
    rm -f "$BUILD_LOG"
    printf '\n%sRESULT: %d assertion(s) failed.%s\n' "$RED" "$FAILURES" "$RST"
    exit 1
  fi
  sed 's/^/      /' "$BUILD_LOG" | tail -30
  rm -f "$BUILD_LOG"
  nomeasure "backend build failed for a reason other than the spec floor (see above)."
fi
rm -f "$BUILD_LOG"

# --- 2. the sourceless sandbox — the image's condition -------------------------
printf '\n%s2. sourceless sandbox (dist/ only — the runner image ships nothing else)%s\n' "$BLD" "$RST"
SANDBOX="$(mktemp -d)" || nomeasure "could not create a sandbox directory."
cp -a "$BACKEND_DIR/dist" "$SANDBOX/dist" || nomeasure "could not copy dist/ into the sandbox."

# THE WITNESS. Without this the whole measurement can pass for the wrong reason.
STRAY_SOURCES="$(find "$SANDBOX" -path '*src/routes/*.ts' -print 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$STRAY_SOURCES" == "0" ]]; then
  pass "sandbox contains 0 src/routes/*.ts — the cwd-relative glob genuinely cannot resolve here"
else
  fail "sandbox contains $STRAY_SOURCES src/routes/*.ts — this is NOT the image's condition, so the"
  fail "  measurement below would prove nothing. Refusing to report a verdict from a decoy."
fi
if [[ -d "$SANDBOX/node_modules" ]]; then
  fail "sandbox has node_modules — the serving path is supposed to need no deps when the artifact exists"
else
  pass "sandbox has no node_modules — the artifact path pulls in no swagger-jsdoc"
fi

# --- 3. resolve the spec as the image would ------------------------------------
printf '\n%s3. load the serving module from the sandbox, with CWD at /%s\n' "$BLD" "$RST"
# FROM `/`, NOT FROM THE SANDBOX. $SANDBOX is absolute, so the probe still finds the
# module; but a cwd-anchored loader now resolves somewhere that does not exist, which
# is exactly the divergence the fix is about. Running this from the sandbox made the
# guard blind to the headline property (Reviewer, round 1).
PROBE_OUT="$(cd / && node "$PROBE" "$SANDBOX" 2>/dev/null)"
PROBE_RC=$?
[[ $PROBE_RC -eq 0 ]] || nomeasure "the probe could not load the serving module (rc=$PROBE_RC)."

get() { printf '%s\n' "$PROBE_OUT" | grep "^$1=" | head -1 | cut -d= -f2-; }
SOURCE="$(get SOURCE)"; PATH_COUNT="$(get PATH_COUNT)"
DEGRADED="$(get DEGRADED)"; FLOOR="$(get FLOOR)"
printf '      source=%s pathCount=%s degraded=%s floor=%s\n' "$SOURCE" "$PATH_COUNT" "$DEGRADED" "$FLOOR"

[[ "$SOURCE" == "artifact" ]] \
  && pass "resolved from the BUILD ARTIFACT (not a runtime glob)" \
  || fail "resolved from '$SOURCE', expected 'artifact' — the serving path did not load the build
artifact. Either it was never emitted, or the loader is anchored on process.cwd() instead of
__dirname (this probe runs from / precisely so those two are distinguishable)"

[[ "$DEGRADED" == "false" ]] \
  && pass "spec is not degraded" \
  || fail "spec is DEGRADED in the image's condition — this is the shipped defect"

if [[ -z "$FLOOR" ]]; then
  fail "could not read OPENAPI_MIN_PATHS from the product's own config — guard has no floor to apply"
elif [[ "$PATH_COUNT" -ge "$FLOOR" ]]; then
  pass "$PATH_COUNT documented paths, at or above the product's floor of $FLOOR"
else
  fail "$PATH_COUNT documented paths, below the product's floor of $FLOOR"
fi

# --- 4. NEGATIVE CONTROL: the empty population must be LOUD --------------------
printf '\n%s4. negative control — delete the artifact, the vacuous case must be loud%s\n' "$BLD" "$RST"
ARTIFACT_IN_SANDBOX="$(printf '%s\n' "$PROBE_OUT" | grep '^ARTIFACT=' | head -1 | cut -d= -f2-)"
if [[ -z "$ARTIFACT_IN_SANDBOX" || ! -f "$ARTIFACT_IN_SANDBOX" ]]; then
  fail "no artifact file to remove — cannot run the negative control, so section 3's PASS is unproven"
else
  rm -f "$ARTIFACT_IN_SANDBOX"
  NEG_OUT="$(cd / && node "$PROBE" "$SANDBOX" 2>/dev/null)"
  if [[ $? -ne 0 ]]; then
    fail "probe could not measure the artifact-absent case"
  else
    NEG_DEGRADED="$(printf '%s\n' "$NEG_OUT" | grep '^DEGRADED=' | cut -d= -f2-)"
    NEG_FINDING="$(printf '%s\n' "$NEG_OUT" | grep '^FINDING_EMITTED=' | cut -d= -f2-)"
    NEG_COUNT="$(printf '%s\n' "$NEG_OUT" | grep '^PATH_COUNT=' | cut -d= -f2-)"
    printf '      pathCount=%s degraded=%s findingEmitted=%s\n' "$NEG_COUNT" "$NEG_DEGRADED" "$NEG_FINDING"
    [[ "$NEG_DEGRADED" == "true" ]] \
      && pass "artifact-absent resolves DEGRADED (zero is not a valid population)" \
      || fail "artifact-absent did NOT go degraded — the fail-closed is not wired"
    [[ "$NEG_FINDING" == "true" ]] \
      && pass "a startup [openapi][FINDING] was emitted — the vacuous case is not silent" \
      || fail "no [openapi][FINDING] on the vacuous case — this is the silence the task exists to kill"
  fi
fi

# --- 5. the shipped route refuses to serve a degraded spec ---------------------
printf '\n%s5. the shipped route returns 503 (not a 200 carrying an empty contract)%s\n' "$BLD" "$RST"
ROUTE_OUT="$( cd "$BACKEND_DIR" && OPENAPI_MIN_PATHS=999999 node -e '
const router = require("./dist/routes/openapi").default;
const layer = router.stack.find(l => l.route && l.route.path === "/openapi.json");
if (!layer) { console.log("STATUS=NO_ROUTE"); process.exit(0); }
let status = 0, body = null;
const res = { status(c){ status=c; return this; }, json(b){ body=b; return this; },
              setHeader(){ return this; } };
layer.route.stack[0].handle({ correlationId:"guard", get(){ return "guard"; },
                              protocol:"http", baseUrl:"/api/openapi" }, res, () => {});
console.log("STATUS=" + status);
console.log("HAS_PATHS_KEY=" + (body && Object.prototype.hasOwnProperty.call(body, "paths")));
' 2>/dev/null )"
ROUTE_STATUS="$(printf '%s\n' "$ROUTE_OUT" | grep '^STATUS=' | cut -d= -f2-)"
printf '      forced floor=999999 -> %s\n' "${ROUTE_STATUS:-<no output>}"
if [[ "$ROUTE_STATUS" == "503" ]]; then
  pass "degraded spec is refused with 503"
elif [[ -z "$ROUTE_STATUS" || "$ROUTE_STATUS" == "NO_ROUTE" ]]; then
  fail "could not drive the compiled /openapi.json handler (got '${ROUTE_STATUS:-nothing}')"
else
  fail "degraded spec was served with status $ROUTE_STATUS — an empty contract reaching a customer"
fi

# --- verdict -------------------------------------------------------------------
printf '\n'
if [[ $FAILURES -eq 0 ]]; then
  printf '%sRESULT: the shipped image serves a populated OpenAPI spec (%s paths, from the build artifact).%s\n' \
    "$GRN" "$PATH_COUNT" "$RST"
  exit 0
fi
printf '%sRESULT: %d assertion(s) failed.%s\n' "$RED" "$FAILURES" "$RST"
exit 1
