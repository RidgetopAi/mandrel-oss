#!/usr/bin/env bash
#
# openapi-drift.config.sh — single source of truth for the OpenAPI artifact-drift
# gate.
#
# WHY THIS EXISTS
#   The Command-UI API contract has ONE source — the `@swagger` JSDoc annotations in
#   mandrel-command/backend/src/routes/*.ts, collected by swagger-jsdoc through
#   backend/src/config/openapi — and TWO checked-in derivations of it:
#
#     1. mandrel-command/frontend/.openapi/openapi.json      (backend `openapi:export`)
#     2. mandrel-command/frontend/src/api/generated/**        (frontend codegen)
#
#   Nothing regenerated or verified either one, so both drifted silently. Measured on
#   3626ea62 (v0.50.0), by regenerating and diffing: the checked-in spec was missing 4
#   whole paths and disagreed on 9 more, and 5 generated service files differed. The
#   drift had accumulated across several unrelated tasks, because the only thing
#   keeping the artifacts equal to the source was a human remembering to run a script.
#
#   scripts/test/openapi-artifact-drift.test.sh regenerates BOTH from the route
#   sources using the SHIPPED command (`npm run generate:openapi`) and fails on any
#   delta. This file holds its tunables so no path, floor or command literal is
#   duplicated into the guard (configs-not-hardcoded).
#
# EVERY PATH IS REPO-RELATIVE. The consumer joins them onto its own resolved
# REPO_DIR; a guard that carries absolute paths only measures one checkout.

if [[ -z "${_MANDREL_OPENAPI_DRIFT_CONFIG_SOURCED:-}" ]]; then
  _MANDREL_OPENAPI_DRIFT_CONFIG_SOURCED=1

  # --- the derivation's endpoints -------------------------------------------
  # Where the shipped regeneration command lives and what it is called. We invoke
  # the npm script rather than re-typing its steps: the codegen flags
  # (--client fetch --useOptions --useUnionTypes) live in frontend/package.json and
  # a guard that re-typed them would validate a decoy the moment they changed.
  OPENAPI_DRIFT_REGEN_DIR="${OPENAPI_DRIFT_REGEN_DIR:-mandrel-command/frontend}"
  OPENAPI_DRIFT_REGEN_SCRIPT="${OPENAPI_DRIFT_REGEN_SCRIPT:-generate:openapi}"

  # The two checked-in artifacts the regeneration writes.
  OPENAPI_DRIFT_SPEC_PATH="${OPENAPI_DRIFT_SPEC_PATH:-mandrel-command/frontend/.openapi/openapi.json}"
  OPENAPI_DRIFT_CLIENT_DIR="${OPENAPI_DRIFT_CLIENT_DIR:-mandrel-command/frontend/src/api/generated}"

  # --- the construction-identity pin ----------------------------------------
  # The spec served LIVE at /api/openapi/openapi.json is not a third copy: routes/
  # openapi.ts imports the same swagger-jsdoc module the exporter imports, so the
  # exported bytes ARE the live bytes for any process whose cwd sees the globbed
  # route sources. That is only true while both files import the SAME module, so the
  # guard resolves both import specifiers and compares the realpaths. These two are
  # the files it reads; a refactor that forks them turns the stage RED.
  OPENAPI_DRIFT_EXPORTER_TS="${OPENAPI_DRIFT_EXPORTER_TS:-mandrel-command/backend/scripts/export-openapi.ts}"
  OPENAPI_DRIFT_LIVE_ROUTE_TS="${OPENAPI_DRIFT_LIVE_ROUTE_TS:-mandrel-command/backend/src/routes/openapi.ts}"

  # --- anti-vacuous floors --------------------------------------------------
  # THE FAILURE THIS EXISTS FOR: swagger-jsdoc's `apis` glob ('./src/routes/*.ts') is
  # resolved against the process CWD. Run it where the route sources are not visible
  # and it returns a perfectly well-formed spec with ZERO paths — an empty contract
  # that diffs clean against an equally empty artifact. Measured 2026-08-29: a
  # swaggerJSDoc() call from a directory with no src/ yields `paths found: 0` and
  # exits 0. So the guard asserts a FLOOR, not merely "it produced a file".
  #
  # DEFAULTS. The spec carried 60 paths and the client 98 files at v0.50.0 (counts
  # produced by the guard's own report line). The floors sit well below that so
  # ordinary API churn never trips them, and far above zero so a collapsed glob or a
  # truncated codegen run cannot pass as a clean diff. Raise them, do not tighten to
  # the current count: an exact pin turns every legitimate new route RED.
  OPENAPI_DRIFT_MIN_PATHS="${OPENAPI_DRIFT_MIN_PATHS:-20}"
  OPENAPI_DRIFT_MIN_CLIENT_FILES="${OPENAPI_DRIFT_MIN_CLIENT_FILES:-20}"

  export OPENAPI_DRIFT_REGEN_DIR OPENAPI_DRIFT_REGEN_SCRIPT \
         OPENAPI_DRIFT_SPEC_PATH OPENAPI_DRIFT_CLIENT_DIR \
         OPENAPI_DRIFT_EXPORTER_TS OPENAPI_DRIFT_LIVE_ROUTE_TS \
         OPENAPI_DRIFT_MIN_PATHS OPENAPI_DRIFT_MIN_CLIENT_FILES
fi
