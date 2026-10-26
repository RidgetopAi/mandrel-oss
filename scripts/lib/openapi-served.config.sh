#!/usr/bin/env bash
#
# openapi-served.config.sh — tunables for the SERVED-spec guard.
#
# WHY THIS GUARD IS SEPARATE FROM STAGE 5o
#   5o (openapi-drift.config.sh) measures the spec AS GENERATED IN A SOURCE TREE and
#   compares it to the checked-in artifacts. It is correct at what it does, and it
#   named this defect as its own known bound: "It does not prove the RUNNING backend
#   serves a populated spec ... the backend runtime image ships no src/, so
#   swagger-jsdoc's cwd-relative `apis` glob finds nothing there."
#
#   That bound was real. MEASURED 2026-08-31 on image 5fe3f00df00d: all 7 running
#   command-backend containers, prod included, served GET /api/openapi/openapi.json as
#   HTTP 200 / 33229 bytes / `paths: []`. 5o was green the whole time, because the
#   population it enumerates is the CI tree and the defect lives in the runtime image.
#
#   This guard's population is THE SHIPPED IMAGE'S CONDITION: a sourceless dist/,
#   loaded from a CWD that cannot see src/. That is the whole population — the runner
#   image copies dist/ and nothing else (mandrel-command/backend/Dockerfile), so if the
#   spec resolves there it resolves in the container, and there is no third arrangement
#   the image can be in.
#
# EVERY PATH IS REPO-RELATIVE. The consumer joins them onto its own resolved REPO_DIR;
# a guard carrying absolute paths only measures one checkout.

if [[ -z "${_MANDREL_OPENAPI_SERVED_CONFIG_SOURCED:-}" ]]; then
  _MANDREL_OPENAPI_SERVED_CONFIG_SOURCED=1

  # The backend workspace member whose dist/ the runner image ships.
  OPENAPI_SERVED_BACKEND_DIR="${OPENAPI_SERVED_BACKEND_DIR:-mandrel-command/backend}"

  # The shipped build command. Driving the SHIPPED entry point is deliberate: the
  # artifact emission is a step inside `npm run build`, and a guard that re-typed the
  # steps would keep validating a decoy the moment the build script changed (C3).
  OPENAPI_SERVED_BUILD_SCRIPT="${OPENAPI_SERVED_BUILD_SCRIPT:-build}"

  # The probe that loads the serving module and reports its resolution.
  OPENAPI_SERVED_PROBE="${OPENAPI_SERVED_PROBE:-scripts/lib/openapi-served-probe.cjs}"

  # NO PATH FLOOR IS DEFINED HERE ON PURPOSE. The floor is OPENAPI_MIN_PATHS in
  # mandrel-command/backend/src/config/openapi/spec-source.config.ts — the same value
  # the PRODUCT reads to decide whether to serve. The probe reports the floor it
  # actually applied and this guard asserts against that, so the guard cannot drift
  # from the product's own definition of "too few" (C4: never hardcode a
  # config-derived value in a test; derive it from the source the product reads).

  export OPENAPI_SERVED_BACKEND_DIR OPENAPI_SERVED_BUILD_SCRIPT OPENAPI_SERVED_PROBE
fi
