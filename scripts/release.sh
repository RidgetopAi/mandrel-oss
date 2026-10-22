#!/usr/bin/env bash
# =============================================================================
# release.sh — version bump + tag for mandrel, in lockstep, safely
# =============================================================================
# WHY THIS EXISTS
#   Mandrel's runtime version is customer-visible (a connecting agent reads it in
#   the MCP `initialize` handshake) and is derived from ONE source:
#   mcp-server/package.json's `version` (see mcp-server/src/version.ts). For that
#   to stay honest, the FOUR package.json files (root, mcp-server,
#   mandrel-command/backend, mandrel-command/frontend) must move TOGETHER, in a
#   single `chore(release): vX.Y.Z` commit, with a matching annotated `vX.Y.Z`
#   tag. Doing that by hand is exactly how versions drift. This script makes the
#   release act ONE atomic, idempotent, reviewable operation.
#
# WHAT IT DOES
#   release.sh <new-version|major|minor|patch> [--message "..."] [--yes]
#     1. Asserts a CLEAN git working tree (no uncommitted/staged changes).
#     2. Resolves the new version (explicit X.Y.Z, or bump major/minor/patch off
#        the current root package.json version) and asserts NEW > CURRENT.
#     3. Asserts all four package.json currently AGREE (refuse to release from a
#        already-drifted state — fix the drift first).
#     4. Bumps all four package.json `version` fields in lockstep.
#     5. Creates a `chore(release): vX.Y.Z — <message>` commit of exactly those
#        four files.
#     6. Creates an annotated tag `vX.Y.Z`.
#
# SAFETY MODEL
#   * DRY-RUN BY DEFAULT: prints the full plan and mutates NOTHING unless --yes.
#   * Idempotent guards: refuses if the tag already exists, if the tree is dirty,
#     if the four files disagree, or if NEW is not strictly greater than CURRENT.
#   * It does NOT push. Pushing the commit + tag (the public release act) is a
#     deliberate, separate human step.
#
# USAGE
#   bash scripts/release.sh minor                       # dry-run: 0.3.0 -> 0.4.0
#   bash scripts/release.sh 0.4.0 --message "..." --yes # actually bump + tag
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
die() { echo "${RED}ERROR: $*${RST}" >&2; exit 1; }

# The branch a release MUST be cut from. Config-overridable (e.g. for a hotfix
# branch) but defaults to main. See assert_expected_branch below.
EXPECTED_BRANCH="${EXPECTED_BRANCH:-main}"

# Refuse to release off a stray branch. Near-miss 2026-06-20: subagents share ONE
# working tree, so a leftover feature checkout made `release.sh 0.5.9` commit+tag
# on the un-Inspected branch. Runs BEFORE any mutation (and before the dry-run
# plan), so a wrong-branch invocation aborts up front with an actionable message.
assert_expected_branch() {
  local cur
  cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  if [[ -z "$cur" || "$cur" == "HEAD" ]]; then
    die "cannot determine git branch (detached HEAD or not a repo). Releases must be cut from '$EXPECTED_BRANCH'. Run: git checkout $EXPECTED_BRANCH"
  fi
  if [[ "$cur" != "$EXPECTED_BRANCH" ]]; then
    die "on branch '$cur' but releases must be cut from '$EXPECTED_BRANCH'. The working tree may carry a subagent's leftover checkout. Run: git checkout $EXPECTED_BRANCH   (or set EXPECTED_BRANCH=$cur if this is intentional)."
  fi
  echo "${GRN}✓ on expected release branch '$cur'${RST}"
}

# The package.json that MUST move in lockstep — defined ONCE in build-config.sh as
# RELEASE_VERSION_FILES and shared with scripts/lib/release-tag-gate.sh, which
# refuses to DEPLOY a ref whose tag and manifests disagree. This list used to live
# here privately while the deploy gate carried none; that is how v0.48.0-v0.51.1
# were hand-cut outside this script and shipped advertising a stale version
# (2026-08-30). Two lists of "the files a release bumps" WILL drift.
# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/build-config.sh"
mapfile -t PKGS <<< "$RELEASE_VERSION_FILES"
[[ ${#PKGS[@]} -ge 1 && -n "${PKGS[0]}" ]] || die "RELEASE_VERSION_FILES is empty — refusing to cut a release that bumps nothing"

# --- Args --------------------------------------------------------------------
[[ $# -ge 1 ]] || die "usage: release.sh <new-version|major|minor|patch> [--message \"...\"] [--yes]"
BUMP_ARG="$1"; shift
APPLY=0
MESSAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) APPLY=1; shift ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    --message=*) MESSAGE="${1#--message=}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# --- Branch guard (runs FIRST, before any read/plan/mutation) ----------------
assert_expected_branch

# --- Read current version (root is canonical) --------------------------------
read_version() { # read_version <package.json path>
  node -e 'process.stdout.write(String(require("./"+process.argv[1]).version||""))' "$1"
}
CURRENT="$(read_version "package.json")"
[[ -n "$CURRENT" ]] || die "could not read current version from root package.json"
[[ "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "current version '$CURRENT' is not X.Y.Z"

# --- Resolve target version --------------------------------------------------
IFS='.' read -r CMAJ CMIN CPAT <<<"$CURRENT"
case "$BUMP_ARG" in
  major) NEW="$((CMAJ + 1)).0.0" ;;
  minor) NEW="${CMAJ}.$((CMIN + 1)).0" ;;
  patch) NEW="${CMAJ}.${CMIN}.$((CPAT + 1))" ;;
  *)
    [[ "$BUMP_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || die "version '$BUMP_ARG' is not X.Y.Z (or one of: major|minor|patch)"
    NEW="$BUMP_ARG"
    ;;
esac
TAG="v${NEW}"

# --- Strict greater-than check (semver-ordered numeric compare) --------------
IFS='.' read -r NMAJ NMIN NPAT <<<"$NEW"
greater=0
if   (( NMAJ > CMAJ )); then greater=1
elif (( NMAJ == CMAJ && NMIN > CMIN )); then greater=1
elif (( NMAJ == CMAJ && NMIN == CMIN && NPAT > CPAT )); then greater=1
fi
[[ "$greater" -eq 1 ]] || die "new version $NEW is not strictly greater than current $CURRENT"

# --- Preflight assertions ----------------------------------------------------
echo "${BLD}===== release.sh plan =====${RST}"
echo "Current version : $CURRENT"
echo "New version     : ${GRN}$NEW${RST}   (tag: $TAG)"
echo "Message         : ${MESSAGE:-<none>}"
echo ""

PREFLIGHT_OK=1

# (a) clean tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "${RED}✗ working tree is DIRTY — commit/stash first (release must be atomic).${RST}"
  git status --short | sed 's/^/    /'
  PREFLIGHT_OK=0
else
  echo "${GRN}✓ working tree clean${RST}"
fi

# (b) tag must not already exist
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "${RED}✗ tag $TAG already exists${RST}"
  PREFLIGHT_OK=0
else
  echo "${GRN}✓ tag $TAG is free${RST}"
fi

# (c) all four package.json currently agree
echo "Current package.json versions:"
AGREE=1
for p in "${PKGS[@]}"; do
  v="$(read_version "$p")"
  printf '    %-40s %s\n' "$p" "$v"
  [[ "$v" == "$CURRENT" ]] || AGREE=0
done
if [[ "$AGREE" -eq 1 ]]; then
  echo "${GRN}✓ all four package.json agree at $CURRENT${RST}"
else
  echo "${RED}✗ package.json versions DISAGREE — fix the drift before releasing.${RST}"
  PREFLIGHT_OK=0
fi

echo ""
echo "Planned actions:"
echo "  1. set version -> $NEW in: ${PKGS[*]}"
echo "  2. git commit (only those 4 files): chore(release): $TAG${MESSAGE:+ — $MESSAGE}"
echo "  3. git tag -a $TAG"
echo "  (does NOT push — pushing is a separate, deliberate step)"
echo ""

[[ "$PREFLIGHT_OK" -eq 1 ]] || die "preflight failed — see ✗ above. Nothing changed."

if [[ "$APPLY" -ne 1 ]]; then
  echo "${YLW}DRY-RUN — no changes made. Re-run with --yes to apply.${RST}"
  exit 0
fi

# --- Apply (idempotent, lockstep) -------------------------------------------
echo "${BLD}===== applying =====${RST}"
for p in "${PKGS[@]}"; do
  # Edit ONLY the top-level "version" field, preserving file formatting, via a
  # precise node rewrite that re-serializes from the parsed object's first
  # version occurrence. We keep 2-space indent + trailing newline (npm default).
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const want = process.argv[2];
    const txt = fs.readFileSync(f, "utf8");
    // Replace only the FIRST top-level "version": "..." occurrence to avoid
    // touching any nested dependency version pins.
    const out = txt.replace(/("version"\s*:\s*")[^"]*(")/, `$1${want}$2`);
    if (out === txt) { console.error("no version field replaced in " + f); process.exit(1); }
    fs.writeFileSync(f, out);
  ' "$p" "$NEW"
  echo "  set $p -> $NEW"
done

git add -- "${PKGS[@]}"
COMMIT_MSG="chore(release): $TAG"
[[ -n "$MESSAGE" ]] && COMMIT_MSG="$COMMIT_MSG — $MESSAGE"
git commit -m "$COMMIT_MSG"
git tag -a "$TAG" -m "$COMMIT_MSG"

echo ""
echo "${GRN}Done.${RST} Created commit + annotated tag $TAG."
echo "Tag NOT pushed. To publish:  git push origin main && git push origin $TAG"
