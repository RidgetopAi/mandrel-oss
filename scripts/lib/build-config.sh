#!/usr/bin/env bash
#
# build-config.sh — single source of truth for ON-HOST frontend build tunables.
#
# WHY THIS EXISTS
#   The mandrel-command/frontend app builds with Vite (migrated from Create-React-
#   App / react-scripts / webpack, 2026-07-15). The V8 heap headroom below was
#   originally added for the CRA/webpack build: a production `npm run build` ran
#   webpack in a single Node process which hit V8's DEFAULT old-space cap (~2GB).
#   Our bundle grew past that: on 2026-07-09 the CI frontend-build stage died with
#   `FATAL ERROR: Ineffective mark-compacts near heap limit / JavaScript heap out of
#   memory` at ~2078MB — even though the host had ~10G free. That OOM aborted the
#   deploy CI gate and blocked EVERY deploy (staging + tenant roll). Vite/
#   esbuild+rollup is far more memory-frugal and is not expected to hit this, but we
#   RETAIN the raised NODE_OPTIONS=--max-old-space-size as a harmless safety margin
#   so a future heavy build can't silently re-trip the same OOM class.
#
# ONE VAR, EVERY ON-HOST FRONTEND BUILD SITE (a past incident — fix the class, not one line)
#   Every place we build the frontend ON THE HOST sources THIS file and runs the
#   build as `NODE_OPTIONS="$FRONTEND_BUILD_NODE_OPTIONS" npm run build`:
#     * the CI gate                          (STAGE 5 — CI compile gate)
#   (The on-host prod builds were RETIRED at T3.5, an earlier task — containerized
#   prod runs the release images and builds nothing on the host; the CI gate STAGE 5 is
#   the remaining host build.)
#   Defining it once here (not N drifting copies) is the whole point — change the
#   headroom in ONE place and every host build site moves together.
#
#   The docker/tenant frontend build is a SEPARATE memory context (built inside the
#   image, not on the host) and carries its own heap setting in
#   mandrel-command/frontend/Dockerfile — this file governs HOST builds only.
#
# THE DEFAULT (4096 MiB) — justification
#   The build needs a hair over ~2GB (it died at ~2078MB). 4096 gives ~2x headroom
#   so normal bundle growth won't re-trip it, while staying well under host RAM
#   (CI/prod hosts have ~15G). Env-overridable so a smaller box can dial it down or
#   a future heavier build can raise it without a code change (configs-not-hardcoded).

# Guard against double-sourcing (the CI gate + a transitively-sourced lib, etc.).
if [[ -z "${_MANDREL_BUILD_CONFIG_SOURCED:-}" ]]; then
  _MANDREL_BUILD_CONFIG_SOURCED=1

  # NODE_OPTIONS applied to on-host frontend (Vite) builds. Raises V8's old-space
  # cap so a large production build does not OOM (retained safety margin from the
  # historical CRA/webpack OOM — see the WHY block above).
  FRONTEND_BUILD_NODE_OPTIONS="${FRONTEND_BUILD_NODE_OPTIONS:---max-old-space-size=4096}"
  export FRONTEND_BUILD_NODE_OPTIONS

  # Name of the frontend build-tool binary/package (Vite, migrated from CRA's
  # react-scripts on 2026-07-15). SINGLE SOURCE (configs-not-hardcoded)
  # for any consumer that needs the tool's NAME rather than its invocation.
  # (Its original consumer, the prod-install toolchain guard, was retired at T3.5
  # with the on-box prod build; kept because the name is config, not a literal.)
  FRONTEND_BUILD_TOOL="${FRONTEND_BUILD_TOOL:-vite}"
  export FRONTEND_BUILD_TOOL

  # === VERSION-DRIFT GATE THRESHOLDS =======================================
  # Tagging a release is a MANUAL step (scripts/release.sh, dry-run by default,
  # never auto-pushed) — so untagged commits accrue on main and the runtime keeps
  # reporting a stale version. A CI version-drift check counts
  # commits since the latest `vX.Y.Z` tag and surfaces the backlog instead of
  # letting it silently grow. These two thresholds define its bands:
  #
  #     drift <= WARN            -> PASS  (quiet, exit 0)
  #     WARN  <  drift <= FAIL   -> WARN  (GitHub ::warning:: annotation, exit 0)
  #     drift >  FAIL            -> FAIL  (GitHub ::error:: annotation, exit 1 — blocks CI)
  #
  # DEFAULTS (30 / 100) — justification. A healthy release cadence tags well before
  # 30 untagged commits pile up, so 30 is the "nudge" line (warn, don't block). 100
  # is the "this is clearly out of hand, cut a release now" hard stop that fails the
  # run. Deliberately NON-BLOCKING for the CURRENT backlog (76 untagged commits at
  # v0.6.0 on 2026-07-10): 76 lands in the WARN band, so wiring this gate surfaces
  # the debt LOUDLY on every main run without instantly bricking main CI (a gate
  # that turns main red on merge just gets `--no-verify`'d or reverted, defeating
  # the purpose). Tighten by lowering VERSION_DRIFT_FAIL_THRESHOLD once the backlog
  # is tagged down. Both are env-overridable (configs-not-hardcoded).
  VERSION_DRIFT_WARN_THRESHOLD="${VERSION_DRIFT_WARN_THRESHOLD:-30}"
  VERSION_DRIFT_FAIL_THRESHOLD="${VERSION_DRIFT_FAIL_THRESHOLD:-100}"
  export VERSION_DRIFT_WARN_THRESHOLD VERSION_DRIFT_FAIL_THRESHOLD

  # === THE RELEASE VERSION MANIFEST =========================================
  # The files whose `version` field MUST equal the vX.Y.Z release tag, and must
  # equal EACH OTHER. Mandrel's version is customer-visible: an agent reads it in
  # the MCP `initialize` handshake, sourced from mcp-server/package.json.
  #
  # ONE DEFINITION, TWO CONSUMERS (the same rule RELEASE_TAG_REGEX follows in
  # scripts/lib/release-tag-gate.sh, and for the same reason — two lists of "the
  # files a release bumps" WILL drift apart, and the one that drifts is the one
  # nobody is looking at). Consumers:
  #     * scripts/release.sh              — bumps them in lockstep, refuses to cut
  #                                         a release from a disagreeing tree
  #     * scripts/lib/release-tag-gate.sh — refuses to DEPLOY a ref whose tag and
  #                                         manifest disagree
  # Before this was shared, release.sh carried the list privately and the deploy
  # gate carried no list at all, which is exactly how v0.51.0 and v0.51.1 were
  # tagged by hand with no bump and shipped advertising 0.50.0 (2026-08-30).
  #
  # Newline-delimited rather than a bash array because arrays cannot be exported,
  # and these must survive into a sourced-lib consumer either way (configs-not-
  # hardcoded: env-overridable, so a repo layout change needs no code edit).
  RELEASE_VERSION_FILES="${RELEASE_VERSION_FILES:-package.json
mcp-server/package.json
mandrel-command/backend/package.json
mandrel-command/frontend/package.json}"
  export RELEASE_VERSION_FILES
fi
