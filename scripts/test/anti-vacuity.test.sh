#!/usr/bin/env bash
# =============================================================================
# anti-vacuity.test.sh — the MUTATION PROBE for scripts/test/lib/anti-vacuity.sh
# and for the floors that adopt it.
# -----------------------------------------------------------------------------
# A floor is a guard, and a guard is a product that can be hollow. Section C does
# the three assertions on a REAL suite rather than on the helper alone: the
# mutation LANDED (the fixture really did stop satisfying the resolver, and the
# suite really did do less work), the floor went RED and SAID VACUOUS, and the
# unmutated control is GREEN with no banner.
#
# THE MUTATION IS THE INCIDENT, not a stand-in for it. A `git` shim refuses to
# CREATE tags and refuses to ADD an origin remote, and execs the real git for
# everything else — which is precisely what the fixture experiences when a
# product resolver's SUBJECT moves out from under it (2026-08-27 and 2026-08-29,
# defect record).
#
# NO NETWORK, NO DB, NO DOCKER, NO PROD.
#
# USAGE:  bash scripts/test/anti-vacuity.test.sh
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_DIR/scripts/test/lib/anti-vacuity.sh"
# The suite the end-to-end section drives. Named once (configs-not-hardcoded).
# It must ship wherever this probe ships, so it is a release-tooling suite, not a fleet one.
AV_PROBE_SUITE="${AV_PROBE_SUITE:-pre-push-release-tag.test.sh}"

if [[ -t 1 ]]; then RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
else RED=""; GRN=""; BLD=""; RST=""; fi
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
cnm()  { printf '%sCANNOT MEASURE: %s%s\n' "$RED" "$*" "$RST" >&2; exit 2; }

[[ -r "$LIB" ]] || cnm "the subject is missing: $LIB (an absent subject is not a pass)"
# shellcheck source=scripts/test/lib/anti-vacuity.sh
# shellcheck disable=SC1091
. "$LIB"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/av-probe.XXXXXX")" || cnm "mktemp failed"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
hdr "A. THE PREDICATE — both directions, and the boundary"
# ---------------------------------------------------------------------------
av_floor 20 16 "the lanes below the resolver" 2>/dev/null \
  && pass "CONTROL: a healthy count (20 >= 16) passes" \
  || fail "a healthy count did not pass"
av_floor 16 16 "the lanes below the resolver" 2>/dev/null \
  && pass "BOUNDARY: exactly at the floor passes (>=, not >)" \
  || fail "a count exactly at the floor was rejected"
OUT="$(av_floor 12 16 "the fleet-sync lanes below FLEET SYNC" 2>&1)"; RC=$?
[[ $RC -eq 1 ]] && pass "RED: a collapsed count (12 < 16) is rejected" \
                || fail "a collapsed count was not rejected (rc=$RC)"
grep -q 'VACUOUS RUN: 12 assertions, floor 16' <<<"$OUT" \
  && pass "...and says VACUOUS with both numbers, not a bare failure" \
  || fail "the banner does not carry the numbers: $OUT"
grep -q 'the fleet-sync lanes below FLEET SYNC' <<<"$OUT" \
  && pass "...and NAMES what had to be reached, so the reader meets the cause" \
  || fail "the banner does not name the dependency: $OUT"
grep -q 'Do NOT fix this by bypassing the gate' <<<"$OUT" \
  && pass "...and refuses the cheap fix that hides the interaction (--allow-untagged et al)" \
  || fail "the banner does not warn off the bypass: $OUT"

hdr "B. THE VALUES THAT SLIP THROUGH — empty, zero, absent"
OUT="$(av_floor 0 16 "anything" 2>&1)"; RC=$?
[[ $RC -eq 1 ]] && pass "ZERO assertions is a RED, not a vacuous pass" \
                || fail "an all-zero run passed the floor (rc=$RC)"
av_floor "" 16 "anything" >/dev/null 2>&1 \
  && fail "an EMPTY observed count passed — the harness failed open" \
  || pass "an EMPTY observed count is a harness error, not a pass"
av_floor "PASS=20" 16 "anything" >/dev/null 2>&1 \
  && fail "a NON-INTEGER observed count passed — the harness failed open" \
  || pass "a NON-INTEGER observed count is a harness error, not a pass"
av_floor 20 16 "   " >/dev/null 2>&1 \
  && fail "a WHITESPACE-ONLY description passed — the reason is not mandatory after all" \
  || pass "a WHITESPACE-ONLY description is a harness error (the reason is mandatory)"
av_floor 20 >/dev/null 2>&1 \
  && fail "a MISSING floor passed — absent is the third value that slips through" \
  || pass "a MISSING floor is a harness error, not a pass"

# ---------------------------------------------------------------------------
hdr "C. END TO END on a real suite: mutation LANDED, floor RED, control GREEN"
# ---------------------------------------------------------------------------
SUITE="$REPO_DIR/scripts/test/$AV_PROBE_SUITE"
[[ -r "$SUITE" ]] || cnm "the end-to-end probe subject is missing: $SUITE"
grep -q 'av_floor ' "$SUITE" \
  && pass "the probe subject ($AV_PROBE_SUITE) carries a floor — this probe knows what it is testing" \
  || cnm "$AV_PROBE_SUITE carries no av_floor call. This probe would measure nothing — CANNOT MEASURE, never a pass."

REALGIT="$(command -v git)" || cnm "git is not on PATH"
mkdir -p "$WORK/bin"
INTERCEPTS="$WORK/intercepts.log"; : > "$INTERCEPTS"
cat > "$WORK/bin/git" <<SHIM
#!/usr/bin/env bash
ct=0
[ "\${1:-}" = "tag" ] && case "\${2:-}" in ""|-l|--list|-n*) ct=0 ;; *) ct=1 ;; esac
[ "\${1:-}" = "-C" ] && [ "\${3:-}" = "tag" ] && case "\${4:-}" in ""|-l|--list|-n*) ct=0 ;; *) ct=1 ;; esac
if [ "\$ct" = 1 ]; then printf 'TAG_CREATE\t%s\n' "\$*" >> "$INTERCEPTS"; exit 0; fi
case " \$* " in *" remote add origin "*) printf 'REMOTE_ADD\t%s\n' "\$*" >> "$INTERCEPTS"; exit 0 ;; esac
exec "$REALGIT" "\$@"
SHIM
chmod +x "$WORK/bin/git"

# CONTROL ON THE INSTRUMENT, before it is used for anything. A shim that does not
# win PATH, does not record, or does not actually suppress, makes every assertion
# below vacuous — which would be this probe committing the bug it is probing for.
[[ "$(PATH="$WORK/bin:$PATH" command -v git)" == "$WORK/bin/git" ]] \
  || cnm "the git shim did not win on PATH"
T="$WORK/shimprobe"; mkdir -p "$T"; "$REALGIT" -C "$T" init -q 2>/dev/null
PATH="$WORK/bin:$PATH" git -C "$T" tag av-probe-tag >/dev/null 2>&1
grep -q TAG_CREATE "$INTERCEPTS" || cnm "the git shim does not record"
grep -q av-probe-tag < <("$REALGIT" -C "$T" tag -l 2>/dev/null) \
  && cnm "the git shim did not actually suppress tag creation — it would perturb nothing"
pass "shim control: it wins PATH, it records, and it really does suppress tag creation"
: > "$INTERCEPTS"

# --- the UNMUTATED CONTROL first, so a later RED is attributable --------------
bash "$SUITE" >"$WORK/control.log" 2>&1; c_rc=$?
c_n="$(sed -nE 's/.*PASS=([0-9]+).*/\1/p' "$WORK/control.log" | tail -1)"
[[ $c_rc -eq 0 ]] && pass "UNMUTATED CONTROL GREEN: $AV_PROBE_SUITE rc 0 with its floor in place (PASS=${c_n:-?})" \
                  || fail "the control is not green (rc=$c_rc) — every RED below would prove nothing"
grep -q 'VACUOUS RUN' "$WORK/control.log" \
  && fail "the floor fires on a HEALTHY run — it is set too high and will be deleted the first time it is inconvenient" \
  || pass "...and the floor is SILENT on it (no false positive)"

# --- now the mutation ---------------------------------------------------------
PATH="$WORK/bin:$PATH" bash "$SUITE" >"$WORK/mutant.log" 2>&1; m_rc=$?
m_n="$(sed -nE 's/.*PASS=([0-9]+).*/\1/p' "$WORK/mutant.log" | tail -1)"
ic="$(wc -l < "$INTERCEPTS")"

# MUTATION LANDED = the mutated path RAN. Two witnesses, because a diff proves
# nothing here: the shim was actually REACHED (intercepts > 0), and the suite
# demonstrably did LESS WORK than the control.
if [[ "$ic" -gt 0 ]]; then
  pass "MUTATION LANDED (witness 1): the fixture reached the shim $ic time(s) — it really did try to satisfy the resolver"
else
  fail "the shim was never reached, so the fixture does not depend on the resolver and nothing below is measuring the floor"
fi
if [[ -n "$m_n" && -n "$c_n" && "$m_n" -lt "$c_n" ]]; then
  pass "MUTATION LANDED (witness 2): the suite did LESS work — PASS ${c_n} -> ${m_n}"
else
  fail "the suite did not do less work (PASS ${c_n:-?} -> ${m_n:-?}); the vacuum did not occur and the floor was never asked"
fi
[[ $m_rc -ne 0 ]] && pass "GUARD RED: the vacuumed run exits non-zero (rc=$m_rc)" \
                  || fail "a vacuumed run exited 0 — this is the exact false green the floor exists to stop"
grep -q 'VACUOUS RUN' "$WORK/mutant.log" \
  && pass "...and it is the FLOOR that says so — 'VACUOUS RUN' is in the output, so the reader is told WHY, not just that something failed" \
  || fail "the run went red but the floor did not fire; the diagnosis is missing: $(tail -20 "$WORK/mutant.log")"

printf '\n%s== RESULT ==%s  %sPASS=%d%s  %sFAIL=%d%s\n' "$BLD" "$RST" "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
