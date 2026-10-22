#!/usr/bin/env bash
# =============================================================================
# bind-file-mount-ban.test.sh — a committed compose file may not bind-mount a
# SINGLE FILE out of this repo's own tree.
# =============================================================================
# an earlier Task. Sibling of scripts/check-bind-mount-drift.sh, one layer earlier:
# the detector finds the class on a live box, this stops the next one being
# WRITTEN. GUARDS-CLASS: stale-file-bind-mount
#
# THE CLASS
#   A bind mount whose source is a regular file binds the INODE. `git checkout`
#   and `git merge` replace a file rather than rewrite it, so the mount keeps
#   the pre-update inode and the container serves the old bytes until it is
#   recreated — with no signal anywhere: the commit is on the box, the host file
#   is correct, the deploy exits 0. Measured on prod 2026-08-23:
#   the deployed scripts/lib/notify.sh was inode 1564100 on the host and
#   1541506 inside mandrel-prod-mcp-server after a fast-forward.
#   A DIRECTORY bind mount does not have the property: lookup is per-open.
#
# THE POPULATION, AND WHY IT IS THIS ONE
#   Every committed compose file discovered by GLOB (never a hardcoded list), and
#   within each, every volume entry whose source is a PATH that resolves into
#   THIS repo — either relative to the compose file, or absolute under the
#   deployed checkout root (BIND_BAN_DEPLOY_ROOT). That is exactly the set a `git
#   checkout` of this repo can replace, which is the hazard. A source that does
#   not resolve into the repo is reported as UNRESOLVED and named, never counted
#   as clean.
#
# WHY THIS IS NOT A GREP (a past incident / C3)
#   The consumer of a compose file is a YAML interpreter, so the population is
#   enumerated by one (python3 + PyYAML, via yaml.compose so each entry keeps its
#   real line number). A deliberately dumb line-local grep runs alongside it over
#   the same files: any path-sourced volume line the dumb pass sees and the
#   parser did not report is a place the parser went dark, and that is RED rather
#   than a quiet zero.
#
# THE ESCAPE HATCH is a co-located marker, never a central allow-list:
#     # BIND-FILE-MOUNT-OK: <reason>
#   on the volume's own line or in the comment block immediately above it.
#
# HONEST SCOPE — what a GREEN here does NOT mean
#   * It says nothing about a mount created outside a committed compose file (a
#     hand-run `docker run -v`, a gitignored per-tenant overlay). Those are the
#     live detector's population, not this one.
#   * It does not prove any container is currently fresh. That is
#     scripts/check-bind-mount-drift.sh, and it needs a docker daemon.
#
# Run:  bash scripts/test/bind-file-mount-ban.test.sh
# Exit: 0 GREEN · 1 RED · 2 CANNOT MEASURE
# =============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_REAL="$(cd "$SELF_DIR/../.." && pwd)"

# --- CONFIG (configs-not-hardcoded) ------------------------------------------
# Where the repo is checked out on the deploy box. An absolute compose source
# under this prefix is the SAME file as the repo-relative path beneath it.
BIND_BAN_DEPLOY_ROOT="${BIND_BAN_DEPLOY_ROOT:-/srv/mandrel}"
# Filename globs that define a compose file.
BIND_BAN_COMPOSE_GLOB="${BIND_BAN_COMPOSE_GLOB:-docker-compose*.yml docker-compose*.yaml compose*.yml compose*.yaml}"
# Discovery FLOOR. A broken glob must read as CANNOT-MEASURE, never as clean.
BIND_BAN_MIN_COMPOSE_FILES="${BIND_BAN_MIN_COMPOSE_FILES:-3}"
# The co-located exception marker.
BIND_BAN_MARKER="${BIND_BAN_MARKER:-BIND-FILE-MOUNT-OK:}"

RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
cnm()  { printf 'CANNOT MEASURE: %s\n' "$*" >&2; exit 2; }

WORK="$(mktemp -d -t bind-file-ban-XXXXXX)" || cnm "mktemp failed"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- FIXTURE HARNESS: shadow the dangerous binaries ----------
# Nothing is opted in: this suite reads files and runs a YAML parser.
. "$SELF_DIR/lib/fixture-harness.sh"
fh_init "$WORK/fixture-harness"

command -v python3 >/dev/null 2>&1 || cnm "python3 absent — the compose parser cannot run"
python3 -c 'import yaml' 2>/dev/null || cnm "PyYAML absent — the compose parser cannot run"

# =============================================================================
# THE ENUMERATOR — python3 + PyYAML. It owns BOTH halves of discovery: which
# files are compose files, and which volume entries each declares. Emits
#   FILE<TAB><rel>
#   VOL<TAB><rel><TAB><line><TAB><source>
# `yaml.compose` is used rather than `safe_load` so every entry carries the line
# number the marker check needs. A file that does not parse emits a VOL row with
# line -1 carrying the parse error — a finding, never a silent skip.
# =============================================================================
enumerate_compose() {
  local root="$1"
  python3 - "$root" "$BIND_BAN_COMPOSE_GLOB" <<'PYEOF'
import os, sys, fnmatch, yaml

root, globs = sys.argv[1], sys.argv[2].split()
files = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git')]
    for fn in sorted(filenames):
        if any(fnmatch.fnmatch(fn, g) for g in globs):
            files.append(os.path.join(dirpath, fn))

def get(mapnode, key):
    if not isinstance(mapnode, yaml.MappingNode):
        return None
    for k, v in mapnode.value:
        if getattr(k, 'value', None) == key:
            return v
    return None

for f in sorted(files):
    rel = os.path.relpath(f, root)
    print("FILE\t%s" % rel)
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            node = yaml.compose(fh)
    except Exception as e:
        print("VOL\t%s\t-1\tPARSE-ERROR: %s" % (rel, e))
        continue
    services = get(node, 'services') if node is not None else None
    if not isinstance(services, yaml.MappingNode):
        continue
    for _svc, svcnode in services.value:
        vols = get(svcnode, 'volumes')
        if not isinstance(vols, yaml.SequenceNode):
            continue
        for item in vols.value:
            line = item.start_mark.line + 1
            if isinstance(item, yaml.ScalarNode):
                src = item.value.split(':', 1)[0]
            elif isinstance(item, yaml.MappingNode):
                s = get(item, 'source')
                src = getattr(s, 'value', '') if s is not None else ''
            else:
                src = ''
            print("VOL\t%s\t%d\t%s" % (rel, line, src))
PYEOF
}

# =============================================================================
# ONE POPULATION, TWO READINGS.
# Discovery of the compose FILES lives in the enumerator above and nowhere else.
# A second discovery pass written in a different tool is the a past incident shape,
# and it bit during authoring: a `find`-based copy silently missed
# a reverse-proxy compose file on this box (`find` here is bfs 4.1.1;
# the production host has GNU findutils), so the dumb pass was reading a SMALLER population
# than the parser and would have reported a confident clean zero for that file.
#
# The dumb cross-check is therefore about PARSING, not discovery: line-local,
# stateless, no YAML knowledge, run over the files the enumerator found.
# =============================================================================
enumerate_volumes_dumb() {
  local root="$1" rel ln _rest
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    while IFS=: read -r ln _rest; do
      [[ -n "$ln" ]] && printf '%s\t%s\n' "$rel" "$ln"
    done < <(grep -n -E '^[[:space:]]*-[[:space:]]+\.{0,2}/[^[:space:]]*:/' "$root/$rel" 2>/dev/null)
  done <<< "${SCAN_FILE_LIST:-}"
}

# marker_present <file> <line> — is the co-located exception marker on that
# line, or in the contiguous comment block immediately above it?
marker_present() {
  local file="$1" line="$2" n text
  text="$(sed -n "${line}p" "$file")"
  [[ "$text" == *"$BIND_BAN_MARKER"* ]] && return 0
  n=$((line - 1))
  while [[ "$n" -ge 1 ]]; do
    text="$(sed -n "${n}p" "$file")"
    [[ "$text" =~ ^[[:space:]]*# ]] || return 1
    [[ "$text" == *"$BIND_BAN_MARKER"* ]] && return 0
    n=$((n - 1))
  done
  return 1
}

# =============================================================================
# scan <root> — THE ANCHOR. One implementation, called by the live assertion and
# by every mutation probe, so the teeth cannot drift from the detector.
# Sets SCAN_RC (0 green / 1 red / 2 cannot-measure), SCAN_OUT, SCAN_HAZARD,
# SCAN_UNRESOLVED, SCAN_EXEMPT, SCAN_PATHVOLS, SCAN_FILES, SCAN_FILE_LIST.
# =============================================================================
scan() {
  local root="$1" kind rel line src abs repo_rel srckind
  SCAN_HAZARD=0; SCAN_UNRESOLVED=0; SCAN_EXEMPT=0; SCAN_PATHVOLS=0; SCAN_FILES=0
  SCAN_OUT=""; SCAN_FILE_LIST=""
  local seen_lines="" rows
  rows="$(enumerate_compose "$root")"

  while IFS=$'\t' read -r kind rel line src; do
    [[ "$kind" == "FILE" ]] || continue
    SCAN_FILES=$((SCAN_FILES + 1))
    SCAN_FILE_LIST+="${rel}"$'\n'
  done <<< "$rows"

  if [[ "$SCAN_FILES" -lt "$BIND_BAN_MIN_COMPOSE_FILES" ]]; then
    SCAN_OUT+="CANNOT MEASURE: discovered ${SCAN_FILES} compose file(s), below the floor of ${BIND_BAN_MIN_COMPOSE_FILES}"$'\n'
    SCAN_RC=2; return
  fi

  while IFS=$'\t' read -r kind rel line src; do
    [[ "$kind" == "VOL" ]] || continue
    if [[ "$line" == "-1" ]]; then
      SCAN_OUT+="RED  ${rel}: ${src}"$'\n'
      SCAN_HAZARD=$((SCAN_HAZARD + 1)); continue
    fi
    case "$src" in
      /*|./*|../*) ;;
      *) continue ;;   # a named volume: no host path, no inode to pin
    esac
    SCAN_PATHVOLS=$((SCAN_PATHVOLS + 1))
    seen_lines+="${rel}"$'\t'"${line}"$'\n'

    repo_rel=""; abs=""
    case "$src" in
      ./*|../*)
        abs="$(cd "$(dirname "$root/$rel")" 2>/dev/null && cd "$(dirname "$src")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$src")")" || abs=""
        repo_rel="${abs#"$root"/}" ;;
      "$BIND_BAN_DEPLOY_ROOT"/*)
        repo_rel="${src#"$BIND_BAN_DEPLOY_ROOT"/}"; abs="$root/$repo_rel" ;;
    esac

    if [[ -z "$repo_rel" || -z "$abs" || ! -e "$abs" ]]; then
      SCAN_UNRESOLVED=$((SCAN_UNRESOLVED + 1))
      SCAN_OUT+="UNRESOLVED  ${rel}:${line}  ${src}  (not a path inside this repo — outside this guard's population; the live detector is what covers it)"$'\n'
      continue
    fi

    if [[ -d "$abs" ]]; then srckind=DIR; elif [[ -f "$abs" ]]; then srckind=FILE; else srckind=OTHER; fi
    [[ "$srckind" == "FILE" ]] || continue

    if marker_present "$root/$rel" "$line"; then
      SCAN_EXEMPT=$((SCAN_EXEMPT + 1))
      SCAN_OUT+="EXEMPT  ${rel}:${line}  ${src}"$'\n'
    else
      SCAN_HAZARD=$((SCAN_HAZARD + 1))
      SCAN_OUT+="RED  ${rel}:${line}  single-FILE bind mount of a repo-tracked file: ${src}"$'\n'
    fi
  done <<< "$rows"

  # THE CROSS-CHECK: anything the dumb pass saw that the parser never reported.
  local dumb_rel dumb_line
  while IFS=$'\t' read -r dumb_rel dumb_line; do
    [[ -n "${dumb_rel:-}" ]] || continue
    if [[ "$seen_lines" != *"${dumb_rel}"$'\t'"${dumb_line}"$'\n'* ]]; then
      SCAN_HAZARD=$((SCAN_HAZARD + 1))
      SCAN_OUT+="RED  ${dumb_rel}:${dumb_line}  a path-sourced volume line the YAML parser did not report — the parser went dark here"$'\n'
    fi
  done < <(enumerate_volumes_dumb "$root")

  if [[ "$SCAN_HAZARD" -gt 0 ]]; then SCAN_RC=1; else SCAN_RC=0; fi
}

# mutate <name> — a fresh copy of the TRACKED tree to mutate.
mutate() {
  local dest="$WORK/$1"
  rm -rf "$dest"; mkdir -p "$dest"
  # Built ONCE, then unpacked per mutant. Not `cp -al`: a hardlink clone would
  # make an in-place truncating write in a probe edit the real repo.
  if [[ ! -s "$WORK/tracked.tar" ]]; then
    ( cd "$REPO_DIR_REAL" && git ls-files -z > "$WORK/tracked.z" ) || cnm "git ls-files failed"
    tar -C "$REPO_DIR_REAL" --null -T "$WORK/tracked.z" -cf "$WORK/tracked.tar" || cnm "tar failed"
  fi
  tar -C "$dest" -xf "$WORK/tracked.tar" || cnm "tar extract failed"
  printf '%s\n' "$dest"
}

# =============================================================================
# 1. THE LIVE ASSERTION
# =============================================================================
hdr "1. the committed compose surface carries no unmarked single-FILE bind mount"
scan "$REPO_DIR_REAL"
printf '%s' "$SCAN_OUT"
printf '  population: %s compose file(s), %s path-sourced volume(s), %s exempt, %s unresolved\n' \
  "$SCAN_FILES" "$SCAN_PATHVOLS" "$SCAN_EXEMPT" "$SCAN_UNRESOLVED"

[[ "$SCAN_RC" -eq 0 ]] && pass "no unmarked file-sourced bind mount in the committed compose files" \
  || fail "an unmarked single-FILE bind mount is present (see RED rows above)"
[[ "$SCAN_FILES" -ge "$BIND_BAN_MIN_COMPOSE_FILES" ]] && pass "discovery floor met (${SCAN_FILES} >= ${BIND_BAN_MIN_COMPOSE_FILES})" \
  || fail "discovery floor not met"
[[ "$SCAN_PATHVOLS" -ge 1 ]] && pass "the scan examined ${SCAN_PATHVOLS} path-sourced volume(s) — it is not green by looking at nothing" \
  || fail "the scan examined ZERO path-sourced volumes"

# THE TWO POPULATIONS AGREE. The dumb pass must see every compose file the
# parser saw; a smaller dumb population is how a cross-check reports a clean
# zero for a file it never opened.
DUMB_FILES="$(enumerate_volumes_dumb "$REPO_DIR_REAL" | cut -f1 | sort -u | grep -c . || true)"
[[ "$SCAN_FILES" -ge 1 ]] && pass "the dumb pass reads the SAME discovered file list as the parser (${DUMB_FILES} of ${SCAN_FILES} contain a path-sourced line)" \
  || fail "no files discovered"

# =============================================================================
# 2. MUTATION PROBES — every one asserts the mutation LANDED before its RED
# =============================================================================
hdr "2a. MUTATION: adding a single-FILE bind mount of a repo file goes RED"
M="$(mutate m2a)"
python3 - "$M/docker-compose.yml" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace("      - mcp_data:/app/data",
              "      - /srv/mandrel/scripts/lib/build-config.sh:/app/x.sh:ro\n      - mcp_data:/app/data", 1)
open(p, 'w').write(s)
PYEOF
grep -q 'build-config.sh:/app/x.sh' "$M/docker-compose.yml" \
  && pass "mutation LANDED: the file-sourced volume line is in the mutant" || fail "mutation did not land"
[[ -f "$M/scripts/lib/build-config.sh" ]] && pass "mutation LANDED: the referenced source is a regular file in the mutant tree" || fail "source is not a file in the mutant"
scan "$M"
[[ "$SCAN_RC" -eq 1 ]] && pass "scan goes RED" || fail "scan rc=${SCAN_RC}, expected 1"$'\n'"$SCAN_OUT"
[[ "$SCAN_OUT" == *"build-config.sh"* ]] && pass "the finding names the offending mount" || fail "finding does not name the mount"

hdr "2b. MUTATION: deleting a co-located marker goes RED (the hatch cannot be free)"
M="$(mutate m2b)"
if grep -q "$BIND_BAN_MARKER" "$M/docker-compose.yml" 2>/dev/null; then
  sed -i "/$BIND_BAN_MARKER/d" "$M/docker-compose.yml"
  if grep -q "$BIND_BAN_MARKER" "$M/docker-compose.yml"; then
    fail "mutation did not land — marker still present"
  else
    pass "mutation LANDED: the marker is gone from the mutant"
  fi
  scan "$M"
  [[ "$SCAN_RC" -eq 1 ]] && pass "scan goes RED once the marker is removed" || fail "scan rc=${SCAN_RC}, expected 1"$'\n'"$SCAN_OUT"
else
  fail "no marker found in the mutant's docker-compose.yml — this probe measured nothing"
fi

hdr "2c. MUTATION: a RELATIVE-path single-file bind mount goes RED"
M="$(mutate m2c)"
python3 - "$M/docker-compose.yml" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
assert "      - mcp_data:/app/data" in s, "the volume line this probe extends is not present"
s = s.replace("      - mcp_data:/app/data",
              "      - ./scripts/lib/build-config.sh:/app/notify/build-config.sh:ro\n      - mcp_data:/app/data", 1)
open(p, 'w').write(s)
PYEOF
if grep -q 'scripts/lib/build-config.sh:/app/notify/build-config.sh' "$M/docker-compose.yml"; then
  pass "mutation LANDED: the relative single-file mount is in the mutant"
  scan "$M"
  [[ "$SCAN_RC" -eq 1 ]] && pass "scan goes RED on a relative single-file mount" \
    || fail "scan rc=${SCAN_RC}, expected 1"$'\n'"$SCAN_OUT"
else
  fail "mutation did not land"
fi

hdr "2d. MUTATION: a path-sourced volume the PARSER cannot see is still caught by the dumb pass"
M="$(mutate m2d)"
# A volume list parked under a top-level key the enumerator does not walk. The
# YAML is valid, so the parser reports nothing at all for it.
cat >> "$M/docker-compose.yml" <<'YML'

x-not-a-service:
  volumes:
    - /srv/mandrel/scripts/lib/build-config.sh:/app/y.sh:ro
YML
scan "$M"
[[ "$SCAN_RC" -eq 1 ]] && pass "scan goes RED where the parser went dark (dumb cross-check)" \
  || fail "scan rc=${SCAN_RC}, expected 1 — the cross-check did not fire"$'\n'"$SCAN_OUT"
[[ "$SCAN_OUT" == *"parser went dark"* ]] && pass "the finding says the parser went dark rather than reporting a clean count" \
  || fail "the finding does not name the parser gap"

hdr "2e. CONTROL: the unmutated copy is GREEN (or every RED above is void)"
M="$(mutate m2e)"
scan "$M"
[[ "$SCAN_RC" -eq 0 ]] && pass "the unmutated copy is GREEN" || fail "the unmutated copy is rc=${SCAN_RC}"$'\n'"$SCAN_OUT"
[[ "$SCAN_PATHVOLS" -ge 1 ]] && pass "and it examined ${SCAN_PATHVOLS} path-sourced volume(s)" || fail "the control examined nothing"

# =============================================================================
# 3. THE EMPTY POPULATION — a broken glob must not read as clean
# =============================================================================
hdr "3. ABSENT POPULATION: a tree with no compose files is CANNOT-MEASURE, never GREEN"
mkdir -p "$WORK/empty"
scan "$WORK/empty"
[[ "$SCAN_RC" -eq 2 ]] && pass "rc=2 (cannot measure)" || fail "rc=${SCAN_RC}, expected 2"
[[ "$SCAN_OUT" == *"CANNOT MEASURE"* ]] && pass "says CANNOT MEASURE in words" || fail "did not say CANNOT MEASURE"

hdr "4. the suite never reached a real dangerous binary"
# CONTROL ON THE INSTRUMENT: an empty forbidden log is only a measurement if the
# shadow can record at all. Assert it moves before reading it as evidence.
if fh_assert_shim_control; then pass "the shadow records when invoked"; else fail "THE SHADOW IS DEAD — the assertion below is vacuous"; fi
if fh_assert_no_forbidden_calls; then pass "no forbidden call was made"; else fail "a forbidden call was made"; fi

printf '\n%s== SUMMARY ==%s  %s passed, %s failed\n' "$BLD" "$RST" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
