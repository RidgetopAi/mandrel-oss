#!/usr/bin/env bash
# =============================================================================
# release-tag-gate.sh — decide whether a ref is fit to ship as a NAMED release
# =============================================================================
# Sourced by fleet-deploy script (PRE-FLIGHT: RELEASE-TAG GATE) and exercised
# directly by its test suite. The decision lives here, apart
# from the deploy script, for the reason deploy-ref.test script's resolver does: a
# 2300-line script that runs a deploy top-to-bottom cannot be sourced by a test, so
# logic left inside it can only be tested by deploying. Logic in a lib can be
# driven against throwaway git repos in milliseconds.
#
# WHAT WAS WRONG (measured 2026-08-27). Mandrel's version is customer-visible — a
# connecting agent reads it in the MCP `initialize` handshake. Tagging was a pure
# HABIT: scripts/release.sh is manual, dry-run by default, never auto-pushes, and
# NOTHING invoked it. fleet-deploy script had no notion of whether the ref it was about
# to ship carried a version tag at all. The habit held for four days (ten tags
# across 2026-08-19..22), then lapsed, and 139 untagged commits shipped behind
# v0.44.2 while every instance advertised a stale version.
#
# The only thing that noticed was the CI drift backstop, at >100 commits — a
# BACKSTOP serving as the TRIGGER. It has now done so TWICE: 105 commits on
# 2026-07-16 (fixed by cutting v0.9.0) and 138 today. Two occurrences of one class
# means there is no trigger. This gate is the trigger.
#
# WHY A REFUSAL AND NOT AN AUTO-CUT. An auto-cut must pick a semver level, and
# nothing in a diff reveals whether a change is a patch or a minor. Guessing makes
# the handshake LIE about the shape of the change, which is worse than a stale
# number because it actively misleads. So the human keeps choosing the level and
# the machine removes the possibility of forgetting. The remedy is printed with the
# exact command, so complying is a copy-paste rather than a research task.
#
# WHY READ-ONLY. This creates no commit, no tag, and pushes nothing. Cutting a
# release inside the deploy would have to commit AND push before the origin-ref
# gate (which requires the shipped ref to be on origin) and therefore before the
# operator's `Proceed with LIVE deploy?` confirmation — i.e. mutate the public repo
# to satisfy a gate, ahead of human approval. Refusing needs no such trade.
# =============================================================================

# The shape of a release tag. ONE definition — deliberately the ONLY one. Both the
# "is HEAD tagged" question and the "what was the last one" question run through
# this regex, so they cannot disagree about what counts as a release. An earlier
# draft also carried a `v[0-9]*` GLOB for the second question; the test caught the
# two definitions disagreeing on `v1.2` (see release_tag_latest). Do not reintroduce
# a second one (configs-not-hardcoded).
RELEASE_TAG_REGEX="${RELEASE_TAG_REGEX:-^v[0-9]+\.[0-9]+\.[0-9]+$}"

# The release version manifest (RELEASE_VERSION_FILES) is defined ONCE, in
# build-config.sh, and shared with scripts/release.sh. Sourcing here rather than
# re-listing the files is the same discipline RELEASE_TAG_REGEX follows above: two
# definitions of one concept WILL drift, and a drifted list in a GATE fails OPEN —
# a file dropped from this copy simply stops being checked, silently.
_RTG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$_RTG_DIR/build-config.sh" ]] && source "$_RTG_DIR/build-config.sh"

# THE SUBJECT. Every function below takes the REF BEING SHIPPED as an explicit
# argument. It used to be implicit — the functions read HEAD — and that was the
# defect this file was rewritten to close (2026-08-29).
#
# WHAT WAS WRONG. fleet-deploy script deploys ${GIT_REMOTE}/${EXPECTED_BRANCH} (or an
# explicit PROD_REF pin), NOT the control tree's checkout. The control tree is
# routinely BEHIND that — the deploy prints its own WARN saying so. This gate read
# the control tree's HEAD, so on the v0.50.0 dry run it printed
#   [PASS] release-tag PRE-FLIGHT GATE: HEAD is tagged v0.49.0
# in the same run whose plan said PROD_REF = <the v0.50.0 commit>. Two refs, one
# PASS, and the PASS was about the ref that was NOT shipping. The admitted failure
# mode: push an UNTAGGED commit while the control tree sits on any older tagged
# commit and this gate reports PASS while the roll ships an untagged release.
#
# It was not hollow — it measured a real tag. It measured the WRONG SUBJECT, so a
# mutation probe that varies the tag VALUE can never catch it: the POINTER is what
# was wrong. That is why the subject is now a REQUIRED PARAMETER with no default:
# there is no HEAD fallback for a caller to silently inherit.

# release_tag_resolve_ref <repo_dir> <ref> -> echoes the full SHA of <ref>, or ''
#
# The three-state instrument (C1): a ref that does not resolve is CANNOT-MEASURE,
# and every caller below turns that into FAIL, never into a pass. An empty <ref> is
# the same case — fleet-deploy script substitutes the literal '<unresolved>' into
# PROD_REF on a dry-run whose ref resolution failed, and that must not pass either.
release_tag_resolve_ref() {
  local repo="$1" ref="$2"
  [[ -n "$ref" ]] || return 0
  git -C "$repo" rev-parse --verify --quiet "${ref}^{commit}" 2>/dev/null || true
}

# release_tag_at_ref <repo_dir> <ref> -> echoes the vX.Y.Z tag EXACTLY at <ref>, or ''
#
# `tag --points-at` is the precise question. `git describe --tags` is NOT a
# substitute: it happily reports a tag N commits back, which would report PASS for
# exactly the drifted state this gate exists to catch.
release_tag_at_ref() {
  local repo="$1" ref="$2"
  git -C "$repo" tag --points-at "$ref" 2>/dev/null \
    | grep -E "$RELEASE_TAG_REGEX" \
    | sort -V | tail -1
}

# release_tag_latest <repo_dir> <ref> -> echoes the NEAREST vX.Y.Z tag reachable
# from <ref>, or ''
#
# `describe --abbrev=0 --match <glob>` is NOT used here, and that is the point.
# A glob and a regex are two definitions of "release tag", and the test caught them
# disagreeing: the glob `v[0-9]*` matches `v1.2`, so a repo whose only tag was
# `v1.2` reported "0 commits since v1.2" — a message that reads as though the gate
# should have passed — while the strict regex had (correctly) refused it at the ref.
# Two definitions of the same concept WILL drift; this function and
# release_tag_at_ref now share exactly one, RELEASE_TAG_REGEX.
#
# NEAREST, not highest-numbered: drift is a commit distance, so the tag we measure
# from must be the closest ancestor, which is not always the largest version (a
# patch cut on a side branch and merged back can outrank a later ancestor).
release_tag_latest() {
  local repo="$1" ref="$2" t d best="" bestd=""
  while IFS= read -r t; do
    [[ -n "$t" ]] || continue
    d="$(git -C "$repo" rev-list "${t}..${ref}" --count 2>/dev/null)" || continue
    if [[ -z "$bestd" || "$d" -lt "$bestd" ]]; then bestd="$d"; best="$t"; fi
  done < <(git -C "$repo" tag --merged "$ref" 2>/dev/null | grep -E "$RELEASE_TAG_REGEX")
  printf '%s' "$best"
}

# release_tag_drift <repo_dir> <tag> <ref> -> commits from <tag> to <ref>
release_tag_drift() {
  local repo="$1" tag="$2" ref="$3"
  git -C "$repo" rev-list "${tag}..${ref}" --count 2>/dev/null || echo '?'
}

# release_tag_manifest_version <repo_dir> <ref> <path> -> echoes the `version`
# field of <path> AS IT EXISTS AT <ref>, or '' if it cannot be read.
#
# READ AT THE REF, NEVER FROM THE WORKING TREE. This is the same lesson "THE
# SUBJECT" records above, one layer over: the control tree is routinely behind the
# ref being shipped, so a worktree read would answer a question about a version
# that is not shipping. `git show <ref>:<path>` asks about the artifact that will
# actually be built into the image.
#
# Parsed with node, not a regex: package.json is JSON, a nested "version" key
# (every dependency block has one) is exactly the kind of thing a grep gets wrong,
# and this repo already requires node everywhere this runs. An unparseable file
# echoes '' and every caller turns that into FAIL — unresolvable is a FINDING.
release_tag_manifest_version() {
  local repo="$1" ref="$2" path="$3" blob
  blob="$(git -C "$repo" show "${ref}:${path}" 2>/dev/null)" || return 0
  [[ -n "$blob" ]] || return 0
  printf '%s' "$blob" | node -e '
    let s="";
    process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const v=JSON.parse(s).version; if(typeof v==="string") process.stdout.write(v); }
      catch(e) {}
    });' 2>/dev/null || true
}

# release_tag_manifest_agreement <repo_dir> <ref> <tag>
#
# Echoes ONE line: "<VERDICT>\t<detail>", 0 for OK / 1 for MISMATCH.
#
# WHAT THIS CLOSES (measured 2026-08-30). release_tag_at_ref answers "is the
# shipped ref tagged?" — and NOTHING asked whether the tag agrees with the version
# the build actually ships. v0.51.0 and v0.51.1 were tagged by hand, bypassing
# release.sh (which does check agreement), so no bump commit was ever made. Both
# shipped with all four manifests still reading 0.50.0 — and the two command
# manifests reading 0.47.0, four releases stale. Prod advertised
# "0.50.0+<older commit>" in the handshake for 18h.
#
# Three guards passed that state: the drift check counts commits since the latest
# TAG (a tag existed -> drift 0), this gate asked only whether a tag EXISTED at the
# ref, and fleet-deploy's post-roll assertion compares the container's manifest to
# itself. Each measured one side. None compared the two sides, which is the only
# comparison that separates the fixed case from the broken one.
release_tag_manifest_agreement() {
  local repo="$1" ref="$2" tag="$3"
  local want="${tag#v}" path v bad=() missing=()

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    v="$(release_tag_manifest_version "$repo" "$ref" "$path")"
    if [[ -z "$v" ]]; then
      missing+=("$path")
    elif [[ "$v" != "$want" ]]; then
      bad+=("${path}=${v}")
    fi
  done <<< "${RELEASE_VERSION_FILES:-}"

  # An empty manifest list is CANNOT-MEASURE, not agreement. Without this an
  # unset/blanked RELEASE_VERSION_FILES would make the loop check nothing and the
  # gate report OK — the fail-open shape this whole file is written against.
  if [[ ${#bad[@]} -eq 0 && ${#missing[@]} -eq 0 ]]; then
    local n; n="$(printf '%s\n' "${RELEASE_VERSION_FILES:-}" | grep -c '[^[:space:]]' || true)"
    if [[ "${n:-0}" -eq 0 ]]; then
      printf 'MISMATCH\tRELEASE_VERSION_FILES is empty — manifest agreement cannot be measured\n'; return 1
    fi
    printf 'OK\tall %s manifest(s) at %s\n' "$n" "$want"; return 0
  fi

  local detail="tag ${tag} but"
  [[ ${#bad[@]}     -gt 0 ]] && detail+=" $(IFS=', '; echo "${bad[*]}")"
  [[ ${#missing[@]} -gt 0 ]] && detail+=" UNREADABLE: $(IFS=', '; echo "${missing[*]}")"
  printf 'MISMATCH\t%s\n' "$detail"; return 1
}

# release_tag_gate_decide <repo_dir> <shipped_ref> <only> <require> <allow_untagged>
#
# <shipped_ref> is THE REF THIS DEPLOY WILL SHIP — resolved by
# deploy_shipped_ref_name() in deploy-ref script, which is the SAME
# resolution fleet_sync() moves every tree to. It is NOT the control tree's HEAD;
# see "THE SUBJECT" above for why that distinction is the whole point of this file.
#
# Echoes ONE line: "<VERDICT>\t<detail>" where VERDICT is
#   PASS  — the shipped ref carries a release tag (detail names the TAG *and* the
#           ref+sha it was read from, so a log can never show one version while
#           shipping another)
#   SKIP  — the gate does not apply here (detail = why)
#   FAIL  — the shipped ref carries no release tag, or could not be resolved at all
# Returns 0 for PASS/SKIP, 1 for FAIL. The CALLER owns all human-facing output and
# the abort; this function only decides, so a test can assert the decision without
# parsing colours or matching prose.
release_tag_gate_decide() {
  local repo="$1" ship_ref="$2" only="$3" require="$4" allow_untagged="$5"
  local sha tag latest drift where

  # --only <handle> replays the recorded release from the manifest: it ships an
  # already-tagged release and is not a new one.
  if [[ -n "$only" ]]; then
    printf 'SKIP\tonly=%s replays the recorded release\n' "$only"; return 0
  fi
  if [[ "$require" != "1" ]]; then
    printf 'SKIP\tDEPLOY_REQUIRE_RELEASE_TAG=%s\n' "$require"; return 0
  fi
  if [[ "$allow_untagged" == "1" ]]; then
    printf 'SKIP\t--allow-untagged\n'; return 0
  fi

  # Fail CLOSED on a subject we cannot resolve — an unreadable repo, an empty ref,
  # a ref that names nothing. An unresolvable question is a FINDING, never a silent
  # pass; the empty/absent value is the one that slips through.
  if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'FAIL\tcannot read the git repo at %s — the shipped ref cannot be measured\n' "$repo"; return 1
  fi
  sha="$(release_tag_resolve_ref "$repo" "$ship_ref")"
  if [[ -z "$sha" ]]; then
    printf "FAIL\tcannot resolve the shipped ref '%s' in %s — the ref this deploy would ship cannot be measured\n" "$ship_ref" "$repo"; return 1
  fi

  # Every verdict below NAMES THE SUBJECT. The v0.50.0 dry run was diagnosable only
  # because a human cross-read two lines; the message now carries the ref itself.
  where="$(printf '%s (%s)' "${sha:0:12}" "$ship_ref")"

  tag="$(release_tag_at_ref "$repo" "$sha")"
  if [[ -n "$tag" ]]; then
    # A tag at the ref is necessary and NOT sufficient. The version the customer
    # reads comes from the manifest, not from the tag, so a tag that disagrees with
    # the manifest ships a handshake that LIES — the exact state this gate was built
    # to prevent, arrived at by a different route (see release_tag_manifest_agreement).
    local agree averdict adetail
    agree="$(release_tag_manifest_agreement "$repo" "$sha" "$tag")"
    averdict="${agree%%$'\t'*}"; adetail="${agree#*$'\t'}"
    if [[ "$averdict" != "OK" ]]; then
      printf 'FAIL\tthe SHIPPED ref %s is tagged %s but its version manifest DISAGREES — %s. Cut the release through scripts/release.sh so the bump and the tag land together.\n' \
        "$where" "$tag" "$adetail"; return 1
    fi
    printf 'PASS\t%s at %s — %s\n' "$tag" "$where" "$adetail"; return 0
  fi

  latest="$(release_tag_latest "$repo" "$sha")"
  if [[ -n "$latest" ]]; then
    drift="$(release_tag_drift "$repo" "$latest" "$sha")"
    printf 'FAIL\tthe SHIPPED ref %s carries NO vX.Y.Z tag — %s commits since %s\n' "$where" "$drift" "$latest"
  else
    printf 'FAIL\tthe SHIPPED ref %s carries NO vX.Y.Z tag — no-tags reachable from it\n' "$where"
  fi
  return 1
}
