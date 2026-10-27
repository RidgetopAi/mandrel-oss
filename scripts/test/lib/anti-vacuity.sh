#!/usr/bin/env bash
# =============================================================================
# anti-vacuity.sh — "I REACHED MY SUBJECT", as an executable assertion.
# -----------------------------------------------------------------------------
# NOT A TEST. Sourced by suites under scripts/test/. One function.
#
# THE CLASS IT CLOSES (defect record)
#   A fixture that must clear a PRODUCT RESOLVER to reach the behaviour it tests
#   is encoding an IMPLICIT ANSWER to that resolver. When the resolver's subject
#   moves — which is exactly what a CORRECTNESS FIX to a resolver looks like —
#   the fixture stops satisfying it, the run aborts upstream of the assertions,
#   and the suite measures nothing.
#
#   A deploy-failure suite was vacuumed this way TWICE IN
#   THREE DAYS. 2026-08-27: a release-tag pre-flight landed, the fixture's HEAD
#   carried no vX.Y.Z tag, the deploy aborted before FLEET SYNC. 2026-08-29: an earlier task
#   moved that gate's SUBJECT from the control tree's HEAD to the ref the
#   deploy actually SHIPS; the fixture tagged HEAD, the shipped ref resolves
#   through origin, the fixture had no fetchable origin, the gate failed closed
#   exactly as designed. The product change was CORRECT both times. The cost
#   landed entirely on a fixture that had taken a dependency it never declared.
#
# WHY A FLOOR ON THE SUITE'S OWN ASSERTION COUNT
#   Because it is indifferent to WHICH resolver moved. A per-resolver check is a
#   claim about the gates that exist today; a floor notices any upstream abort,
#   including one from a gate nobody has written yet. And it is the one thing an
#   exit-code comparison cannot see: a suite that aborts early and still exits 0
#   is GREEN at every layer above it, and only the amount of work it did betrays
#   it (measured 2026-08-31: a lane suite under a broken
#   ref fixture goes 42 assertions -> 13, with ZERO failures).
#
# THE FLOOR IS A PINNED LITERAL, NOT A TUNABLE, and it is deliberately set just
#   BELOW the suite's current count rather than far below it. A loose floor is a
#   broken-discovery detector and would not have caught any of the runs above
#   (the 2026-08-29 vacuum still made 32 assertions). Choose it from a MEASURED
#   pair: above what a vacuumed run produces, below what a healthy one does, and
#   record both numbers next to it. A floor with no measurement behind it is a
#   guess wearing a number.
#
#   A floor is NOT an anti-shrink guarantee and is not claimed as one: deleting
#   assertions down to it still passes. It fires when a run does markedly LESS
#   work than the author measured, which is the vacuity signature and nothing
#   more.
#
# HONEST SCOPE, TWO PARTS, AND THE SECOND IS THE ONE THAT SURPRISES PEOPLE.
#   (1) This says the suite EXECUTED enough assertions. It does not say they were
#       the RIGHT ones, and it cannot: a suite that reaches its subject and asserts
#       the wrong thing is a different defect with a different fix.
#   (2) A CALL AT THE SUMMARY ONLY FIRES IF THE SUITE REACHES ITS SUMMARY. Measured
#       2026-08-31: the same suite, under the same perturbation,
#       aborts before printing any summary at all and exits 2 — so a floor placed
#       there could never run, and it deliberately does not carry one. That suite is
#       covered by its EXIT CODE instead, which is the correct instrument for a run
#       that dies. The floor is for the other shape: a run that survives, exits 0,
#       and quietly did a third of the work. Do not add a floor to a suite without
#       measuring which of the two shapes its vacuum takes.
# =============================================================================

# av_floor <observed> <floor> <what-had-to-be-reached>
#   rc 0 — the suite did at least <floor> assertions' worth of work.
#   rc 1 — VACUOUS. Prints a banner naming the dependency, so the reader meets
#          the cause rather than a bare number. The CALLER wires this into its
#          own FAIL counter; this function never exits, because a suite's
#          summary block is the only thing that owns its exit code.
#
# <observed> is the suite's OWN counter variable, never a count of its output.
# Text counting was measured wrong on 2026-08-31: a release-tag suite's captured
# SUBJECT output contains the product gate's own `[FAIL]`
# lines, so a grep over the log reports failures in a run whose FAIL counter is 0.
av_floor() {
  local observed="${1:-}" floor="${2:-}" what="${3:-}"
  if [[ ! "$observed" =~ ^[0-9]+$ || ! "$floor" =~ ^[0-9]+$ ]]; then
    printf 'ANTI-VACUITY HARNESS ERROR: av_floor needs two integers, got observed=%q floor=%q\n' \
      "$observed" "$floor" >&2
    return 1
  fi
  [[ -n "${what//[[:space:]]/}" ]] || {
    printf 'ANTI-VACUITY HARNESS ERROR: av_floor needs a non-empty description of what had to be reached\n' >&2
    return 1
  }
  # A floor of ZERO is satisfied by a run that asserted NOTHING, so it is not a weak
  # floor — it is an absent one wearing the syntax of a present one, which is worse
  # than no call at all (a reader greps for av_floor and finds this suite covered).
  # Absent/zero/empty are the values that slip through; this is the zero.
  if [[ "$floor" -eq 0 ]]; then
    printf 'ANTI-VACUITY HARNESS ERROR: av_floor floor of 0 can never fail — pick a floor between the suite'"'"'s measured healthy and vacuumed assertion counts\n' >&2
    return 1
  fi
  [[ "$observed" -ge "$floor" ]] && return 0
  printf '\n  ***** VACUOUS RUN: %d assertions, floor %d *****\n' "$observed" "$floor" >&2
  printf '  This suite did far less work than it was measured doing. The usual cause is\n' >&2
  printf '  that its FIXTURE stopped satisfying a product resolver and the run aborted\n' >&2
  printf '  UPSTREAM of the assertions, so what follows measured nothing.\n' >&2
  printf '  It had to reach: %s\n' "$what" >&2
  printf '  Do NOT fix this by bypassing the gate in the fixture (--allow-untagged,\n' >&2
  printf '  DEPLOY_REQUIRE_RELEASE_TAG=0, a seeded GIT_FETCHED). Those hit the gate SKIP\n' >&2
  printf '  branch, which short-circuits the fetch and hides the interaction entirely.\n' >&2
  printf '  Make the fixture satisfy the resolver for real.\n' >&2
  return 1
}
