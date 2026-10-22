#!/usr/bin/env bash
# =============================================================================
# pre-push-release-tag.test.sh — acceptance test for hooks/pre-push
# =============================================================================
# The hook refuses to PUSH a vX.Y.Z tag whose commit's version manifests disagree
# with the tag. It is the front half of the pair whose back half is the deploy-time
# release-tag gate: the gate stops a bad tag from SHIPPING, this stops one from
# LEAVING THE MACHINE.
#
# WHAT MAKES A PUSH HOOK WORTH HAVING IS THAT IT CAN GO RED *AND* THAT IT LETS
# EVERYTHING ELSE THROUGH. A hook that blocks pushes people did not sign up for
# gets disabled, and a disabled hook protects nothing — so the SKIP lanes below
# (branch pushes, non-release tags, deletions) are load-bearing assertions, not
# politeness. Both directions are tested against a REAL `git push` into a real bare
# repo with core.hooksPath set, not by calling the hook's functions directly: the
# wiring (does git actually invoke it, does it read stdin correctly) is exactly
# what a direct call cannot measure.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$REPO_DIR/hooks/pre-push"
[[ -f "$HOOK" ]] || { echo "FATAL: hook not found: $HOOK" >&2; exit 2; }

RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# mkclone <name> -> a repo wired exactly like a dev checkout: the tracked hooks/
# and the scripts/lib the hook sources, core.hooksPath set, and a real bare origin.
mkclone() {
  local d="$TMPROOT/$1"
  mkdir -p "$d/hooks" "$d/scripts/lib"
  git init -q -b main "$d"
  git -C "$d" config user.email t@t; git -C "$d" config user.name t
  cp "$HOOK" "$d/hooks/pre-push"; chmod +x "$d/hooks/pre-push"
  cp "$REPO_DIR/scripts/lib/release-tag-gate.sh" "$REPO_DIR/scripts/lib/build-config.sh" "$d/scripts/lib/"
  git -C "$d" config core.hooksPath hooks
  git init -q --bare -b main "$TMPROOT/$1-origin.git"
  git -C "$d" remote add origin "$TMPROOT/$1-origin.git"
  echo "$d"
}

# commit_release <repo> <version> — the four manifests at <version>, committed.
commit_release() {
  local d="$1" v="$2" f
  for f in package.json mcp-server/package.json \
           mandrel-command/backend/package.json mandrel-command/frontend/package.json; do
    mkdir -p "$d/$(dirname "$f")"
    printf '{\n  "version": "%s"\n}\n' "$v" > "$d/$f"
  done
  git -C "$d" add -A >/dev/null 2>&1
  git -C "$d" commit -qm "chore(release): v$v"
}

# try_push <repo> <refspec> [env...] -> sets OUT / RC
try_push() {
  local d="$1" ref="$2"; shift 2
  OUT="$(cd "$d" && env "$@" git push origin "$ref" 2>&1)"; RC=$?
}

# -----------------------------------------------------------------------------
hdr "0. THE HOOK UNDER TEST IS THE TRACKED HOOK"
# Without this the suite can pass against a stale copy and prove nothing about
# what actually ships.
R0="$(mkclone h0)"
if cmp -s "$HOOK" "$R0/hooks/pre-push"; then
  pass "the fixture's hook is byte-identical to the tracked hooks/pre-push"
else fail "FIXTURE BROKEN: the fixture hook differs from hooks/pre-push"; fi

# -----------------------------------------------------------------------------
hdr "1. CONTROL — a correctly cut release pushes"
# The unmutated control. If this is not GREEN every refusal below is meaningless:
# a hook that refuses everything is not a gate, it is an outage.
R1="$(mkclone h1)"
commit_release "$R1" 1.4.0
git -C "$R1" tag -a v1.4.0 -m v1.4.0
try_push "$R1" main
[[ $RC -eq 0 ]] && pass "a branch push is not this hook's business (rc=0)" \
                || fail "the hook blocked a plain branch push: $OUT"
try_push "$R1" v1.4.0
if [[ $RC -eq 0 ]]; then pass "CONTROL: tag agreeing with its manifests PUSHES (rc=0)"
else fail "CONTROL RED: a correct release tag was refused — $OUT"; fi
grep -qa "all 4 manifest(s) at 1.4.0" <<<"$OUT" \
  && pass "CONTROL: the hook SAYS what it verified (names the version + count)" \
  || fail "CONTROL: the hook passed silently — a guard that never speaks cannot be trusted to have run: $OUT"

# -----------------------------------------------------------------------------
hdr "2. GUARD RED — the exact 2026-08-30 shape: a hand-cut tag"
# v0.51.1 was tagged onto a commit whose manifests still read 0.50.0/0.47.0. This
# is that push, and it must not leave the machine.
R2="$(mkclone h2)"
commit_release "$R2" 0.50.0
# ...then hand-cut a tag naming a version nothing was bumped to.
git -C "$R2" tag -a v0.51.1 -m "hand-cut, no bump"
try_push "$R2" main
[[ $RC -eq 0 ]] || fail "setup: the branch push should still succeed ($OUT)"
try_push "$R2" v0.51.1
if [[ $RC -ne 0 ]]; then pass "GUARD RED: the hand-cut tag v0.51.1 is REFUSED (rc=$RC)"
else fail "FALSE GREEN: the hand-cut tag pushed — this is the whole defect: $OUT"; fi
# MUTATION LANDED, asserted rather than assumed: prove the tag really is absent
# from origin. A refusal that still leaves the ref on the remote is not a refusal.
if [[ -z "$(git -C "$TMPROOT/h2-origin.git" tag -l v0.51.1)" ]]; then
  pass "MUTATION LANDED: v0.51.1 is ABSENT from origin — the refusal actually withheld the ref"
else fail "the hook printed a refusal but the tag reached origin anyway"; fi
for want in "0.50.0" "release.sh" "git tag -d v0.51.1"; do
  grep -qa -- "$want" <<<"$OUT" \
    && pass "the refusal is actionable — names '$want'" \
    || fail "the refusal does not name '$want': $OUT"
done

# -----------------------------------------------------------------------------
hdr "3. SENSITIVITY — one stale manifest out of four still refuses"
# The v0.48.0-v0.50.0 shape: three files right, one frozen. A hook that only reads
# the root manifest passes this.
R3="$(mkclone h3)"
commit_release "$R3" 1.5.0
printf '{\n  "version": "1.4.0"\n}\n' > "$R3/mandrel-command/frontend/package.json"
git -C "$R3" add -A >/dev/null 2>&1; git -C "$R3" commit -qm "one frozen"
git -C "$R3" tag -a v1.5.0 -m v1.5.0
try_push "$R3" main >/dev/null 2>&1
try_push "$R3" v1.5.0
[[ $RC -ne 0 ]] && pass "SENSITIVITY: ONE frozen manifest of four is still refused (rc=$RC)" \
                || fail "FALSE GREEN: three-right-one-frozen pushed: $OUT"
grep -qa "frontend/package.json=1.4.0" <<<"$OUT" \
  && pass "SENSITIVITY: the refusal names the ONE file that is wrong" \
  || fail "the refusal does not name the frozen file: $OUT"

# -----------------------------------------------------------------------------
hdr "4. THE SKIP LANES — everything that is NOT a release tag passes untouched"
# Load-bearing. A hook that blocks these gets turned off, and then lane 2 protects
# nothing. Each of these is pushed from a repo whose manifests DISAGREE, so any
# pass here is the hook correctly declining to judge, not the manifests being fine.
R4="$(mkclone h4)"
commit_release "$R4" 2.0.0
printf '{\n  "version": "9.9.9"\n}\n' > "$R4/package.json"
git -C "$R4" add -A >/dev/null 2>&1; git -C "$R4" commit -qm "deliberately disagreeing"
try_push "$R4" main
[[ $RC -eq 0 ]] && pass "SKIP: a branch push is never judged, even with disagreeing manifests" \
                || fail "the hook blocked a branch push: $OUT"
for t in "archive/feat-something" "release-1.2.3" "v1.2" "v1.2.3-rc1"; do
  git -C "$R4" tag -a "$t" -m x 2>/dev/null
  try_push "$R4" "$t"
  [[ $RC -eq 0 ]] && pass "SKIP: '$t' is not a vX.Y.Z release tag — pushed untouched" \
                  || fail "the hook judged '$t', which is not a release tag: $OUT"
done
# A DELETION is not a ship. The all-zero sha must not be treated as a subject.
git -C "$R4" tag -a v2.0.0 -m v2.0.0 2>/dev/null
SKIP_RELEASE_TAG_CHECK=1 git -C "$R4" push -q origin v2.0.0 2>/dev/null
try_push "$R4" ":refs/tags/v2.0.0"
[[ $RC -eq 0 ]] && pass "SKIP: deleting a tag is not shipping one — deletion pushed" \
                || fail "the hook blocked a tag DELETION: $OUT"

# -----------------------------------------------------------------------------
hdr "5. FAIL CLOSED — what cannot be measured is refused, never waved through"
R5="$(mkclone h5)"
commit_release "$R5" 3.0.0
git -C "$R5" rm -q mandrel-command/frontend/package.json
git -C "$R5" commit -qm "drop a manifest"
git -C "$R5" tag -a v3.0.0 -m v3.0.0
try_push "$R5" main >/dev/null 2>&1
try_push "$R5" v3.0.0
[[ $RC -ne 0 ]] && pass "FAIL CLOSED: an ABSENT manifest is unmeasurable, not agreement (rc=$RC)" \
                || fail "FALSE GREEN: a missing manifest pushed: $OUT"
grep -qa "UNREADABLE" <<<"$OUT" && pass "FAIL CLOSED: the refusal says the manifest was UNREADABLE" \
                                || fail "the refusal does not distinguish unreadable from disagreeing: $OUT"

# The lib the hook depends on is GONE — an old checkout genuinely cannot answer.
R6="$(mkclone h6)"
commit_release "$R6" 4.0.0
git -C "$R6" tag -a v4.0.0 -m v4.0.0
try_push "$R6" main >/dev/null 2>&1
rm -f "$R6/scripts/lib/release-tag-gate.sh"
try_push "$R6" v4.0.0
[[ $RC -ne 0 ]] && pass "FAIL CLOSED: a missing release-tag-gate.sh refuses (cannot-measure is never permission)" \
                || fail "FALSE GREEN: the hook no-opped when its own lib was absent: $OUT"

# -----------------------------------------------------------------------------
hdr "6. THE ESCAPE HATCH works, and is the ONLY thing that opens the gate"
R7="$(mkclone h7)"
commit_release "$R7" 0.50.0
git -C "$R7" tag -a v0.51.1 -m "hand-cut"
try_push "$R7" main >/dev/null 2>&1
try_push "$R7" v0.51.1
[[ $RC -ne 0 ]] || fail "setup: this tag should be refused without the bypass"
try_push "$R7" v0.51.1 SKIP_RELEASE_TAG_CHECK=1
[[ $RC -eq 0 ]] && pass "the documented bypass SKIP_RELEASE_TAG_CHECK=1 pushes the same refused tag" \
                || fail "the documented bypass does not work — an undocumented workaround will be invented: $OUT"
# ...and it announces itself. A silent bypass is how a gate becomes decorative.
grep -qa "SKIP_RELEASE_TAG_CHECK=1" <<<"$OUT" \
  && pass "the bypass ANNOUNCES itself on stderr — it cannot be used invisibly" \
  || fail "the bypass is silent: $OUT"

# ANTI-VACUITY. MEASURED 2026-08-31 with a `git` shim that
# refuses to create tags and refuses to add an origin remote — i.e. the fixture
# stops answering the ref/tag resolver, which is exactly what a correctness fix
# to that resolver does to it. Healthy run: 22 assertions. Vacuumed run: 6. The
# floor sits between the two, which is the only way to choose one honestly — a
# loose floor would not have caught either 2026-08 incident (the 2026-08-29
# vacuum still made 32 assertions).
# shellcheck source=scripts/test/lib/anti-vacuity.sh
# shellcheck disable=SC1091
. "$(dirname "${BASH_SOURCE[0]}")/lib/anti-vacuity.sh"
av_floor "$PASS" 14 \
  "the pre-push hook lanes that need a real vX.Y.Z tag on the fixture repo" \
  || FAIL=$((FAIL+1))

# -----------------------------------------------------------------------------
hdr "SUMMARY"
printf '  %sPASS=%d%s  %sFAIL=%d%s\n' "$GRN" "$PASS" "$RST" "$RED" "$FAIL" "$RST"
if [[ "$FAIL" -gt 0 ]]; then
  printf '%s########## pre-push-release-tag: RED ##########%s\n' "$RED" "$RST"; exit 1
fi
printf '%s########## pre-push-release-tag: GREEN ##########%s\n' "$GRN" "$RST"; exit 0
