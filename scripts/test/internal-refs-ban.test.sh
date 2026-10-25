#!/usr/bin/env bash
# =============================================================================
# internal-refs-ban.test.sh — STAGE R of scripts/oss-gate.sh bans every internal-reference class.
# =============================================================================
# The ban is scripts/oss-gate.sh STAGE R, driven through its shipped entry point
# (`bash scripts/oss-gate.sh --refs-only`), never re-implemented here.
#
# POPULATION. The classes are the lines of scripts/oss-gate/internal-refs.patterns. A regex line
# (<class><TAB><pcre><TAB><probe>) is probed with its own probe; a hashed-token class
# (<class><TAB>sha256:<hex>) is probed with a synthetic token whose hash this test appends under
# that class in the scratch copy (its real tokens are, by design, not spelled anywhere). Every
# class is probed, so a class added there is probed here with no edit to this file.
#
#   1. Real tree: the gate's STAGE R is GREEN on this repository's index.
#   2. Critic, in a scratch repo holding a copy of the gate, its config, its pattern list and a
#      scratch allow-list with ONE entry:
#        control       — clean files plus one allowed hit: GREEN;
#        per class     — that class's probe planted alone in a new file: RED, and the RED names
#                        the class and the file (mutation LANDED is checked in the index first);
#                        a hashed class is probed in lower, upper and camelCase; a word class
#                        as a plain word, camelCase, UPPER_SNAKE and percent-escaped;
#        split probes  — every regex probe split at its last space across two comment lines:
#                        still RED; the split id probe must be caught by the cross-line pass;
#        hexref shapes — a bare 8-hex id in each claimed context (comment, wrapped comment line,
#                        prose, keyword, parenthetical, test title, string label, heredoc wrap):
#                        RED; legitimate hex (colour, 0x constant, uuid, sha256, a quoted fixture,
#                        all-letter / all-digit runs, a comment followed by a fixture line),
#                        each confirmed in the scanned population: GREEN;
#        allow scope   — the allowed literal in a DIFFERENT path: RED (the path glob is enforced);
#                        the allowed path but a DIFFERENT class's probe: RED (the class is enforced);
#        allow hygiene — an entry with no reason: RED; an entry that covers no hit: RED;
#        hollow inputs — a pattern list of comments only, an absent pattern list, an absent
#                        allow-list, a pattern line without its probe, a malformed hash: each RED.
#
# USAGE:  bash scripts/test/internal-refs-ban.test.sh
# Exit: 0 green, 1 a check failed, 2 could not measure.
# =============================================================================
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- CONFIG ---------------------------------------------------------------------
GATE_SCRIPT="${GATE_SCRIPT:-scripts/oss-gate.sh}"
GATE_CONFIG="${GATE_CONFIG:-scripts/oss-gate/config.sh}"
PATTERNS_FILE="${PATTERNS_FILE:-scripts/oss-gate/internal-refs.patterns}"
ALLOW_FILE="${ALLOW_FILE:-scripts/oss-gate/internal-refs.allow}"
ALLOWED_PATH="${ALLOWED_PATH:-docs/allowed.md}"
ALLOWED_LITERAL="${ALLOWED_LITERAL:-SCRATCH-ALLOWED-LITERAL}"
ALLOWED_CLASS="${ALLOWED_CLASS:-brand}"
# A class whose probe, split at its last space, matches on neither line alone.
CROSS_LINE_CLASS="${CROSS_LINE_CLASS:-id}"

if [[ -t 1 ]]; then RED=$'\033[31m'; GRN=$'\033[32m'; BLD=$'\033[1m'; RST=$'\033[0m'
else RED=""; GRN=""; BLD=""; RST=""; fi
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }
cnm()  { printf '%sCANNOT MEASURE: %s%s\n' "$RED" "$*" "$RST" >&2; exit 2; }

command -v git >/dev/null 2>&1 || cnm "git is not installed"
git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || cnm "not a git work tree"
[[ -f "$REPO_DIR/$PATTERNS_FILE" ]] || cnm "$PATTERNS_FILE is missing"
WORK="$(mktemp -d)" || cnm "mktemp failed"
trap 'rm -rf "$WORK"' EXIT

# refs <repo> — run STAGE R alone; sets OUT (stdout+stderr) and RC.
refs() { OUT="$(cd "$1" && bash "$GATE_SCRIPT" --refs-only 2>&1)"; RC=$?; }

# The classes and their probes, from the pattern list the gate reads.
CLASSES=(); PROBES=(); HASHED=(); WORDCLS=(); WORDS=()
while IFS=$'\t' read -r cls re probe; do
  [[ "$cls" =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ "$re" == sha256:* ]]; then [[ " ${HASHED[*]} " == *" $cls "* ]] || HASHED+=("$cls"); continue; fi
  if [[ "$re" == word:* ]]; then [[ " ${WORDCLS[*]} " == *" $cls "* ]] || { WORDCLS+=("$cls"); WORDS+=("${re#word:}"); }; continue; fi
  CLASSES+=("$cls"); PROBES+=("$probe")
done < "$REPO_DIR/$PATTERNS_FILE"
[[ ${#CLASSES[@]} -gt 0 ]] || cnm "no regex classes in $PATTERNS_FILE"
sha256_of() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
command -v sha256sum >/dev/null 2>&1 || cnm "sha256sum is not installed"
probe_of() { local i; for i in "${!CLASSES[@]}"; do [[ "${CLASSES[$i]}" == "$1" ]] && { echo "${PROBES[$i]}"; return; }; done; }
ALLOWED_PROBE="$(probe_of "$ALLOWED_CLASS")"
[[ -n "$ALLOWED_PROBE" ]] || cnm "class $ALLOWED_CLASS is not in $PATTERNS_FILE"
OTHER_CLASS="${CLASSES[0]}"; [[ "$OTHER_CLASS" != "$ALLOWED_CLASS" ]] || OTHER_CLASS="${CLASSES[1]}"

hdr "1. Real tree"
refs "$REPO_DIR"
if [[ "$RC" -eq 0 && "$(tail -n1 <<<"$OUT")" == "OSS-GATE GREEN"* ]]; then pass "STAGE R is GREEN on the index: $(tail -n1 <<<"$OUT")"
else fail "STAGE R is not GREEN on the index (rc=$RC):"; sed 's/^/      /' <<<"$OUT" | head -40; fi

hdr "2. Critic (scratch repo with a copy of the gate)"
S="$WORK/scratch"
mkdir -p "$S/scripts/oss-gate" "$S/src" "$S/docs"
git -C "$S" init -q || cnm "git init failed"
git -C "$S" config user.email t@example.com; git -C "$S" config user.name t
cp "$REPO_DIR/$GATE_SCRIPT" "$S/$GATE_SCRIPT"
cp "$REPO_DIR/$GATE_CONFIG" "$S/$GATE_CONFIG"
cp "$REPO_DIR/$PATTERNS_FILE" "$S/$PATTERNS_FILE"
printf '%s\t%s\t%s\t%s\n' "$ALLOWED_CLASS" "$ALLOWED_PATH" "$ALLOWED_LITERAL" "scratch: the one allowed hit" > "$S/$ALLOW_FILE"
cp "$S/$ALLOW_FILE" "$WORK/allow.orig"; cp "$S/$PATTERNS_FILE" "$WORK/patterns.orig"
echo 'export const host = "localhost";' > "$S/src/a.ts"
printf '%s %s\n' "$ALLOWED_PROBE" "$ALLOWED_LITERAL" > "$S/$ALLOWED_PATH"
git -C "$S" add -A
reset_scratch() {
  cp "$WORK/allow.orig" "$S/$ALLOW_FILE"; cp "$WORK/patterns.orig" "$S/$PATTERNS_FILE"
  git -C "$S" rm -q -r --cached --ignore-unmatch probe >/dev/null 2>&1; rm -rf "$S/probe"
  git -C "$S" add -A
}

refs "$S"
if [[ "$RC" -eq 0 ]] && grep -q '1 allowed' <<<"$OUT"; then pass "control (unmutated) is GREEN and counts the one allowed hit"
else fail "control is not GREEN with one allowed hit (rc=$RC): $(tail -n2 <<<"$OUT" | tr '\n' ' ')"; fi

# Every class: its probe, planted alone, must turn the gate RED and be named.
for i in "${!CLASSES[@]}"; do
  cls="${CLASSES[$i]}"; probe="${PROBES[$i]}"; f="probe/$cls.txt"
  mkdir -p "$S/probe"; printf 'note: %s\n' "$probe" > "$S/$f"; git -C "$S" add -A
  if ! git -C "$S" grep --cached -q -F -e "$probe" -- "$f"; then fail "[$cls] mutation did not LAND in the index"; reset_scratch; continue; fi
  refs "$S"
  if [[ "$RC" -eq 1 ]] && grep -qF "[$cls] $f:" <<<"$OUT"; then pass "[$cls] probe LANDED in $f -> RED, named [$cls] $f"
  else fail "[$cls] probe in $f did not go RED naming the class (rc=$RC): $(tail -n1 <<<"$OUT")"; fi
  reset_scratch
done
# Every regex class again, its probe split across two comment lines at the last space.
for i in "${!CLASSES[@]}"; do
  cls="${CLASSES[$i]}"; probe="${PROBES[$i]}"; f="probe/split-$cls.ts"
  [[ "$probe" == *" "* ]] || continue
  mkdir -p "$S/probe"; printf '/**\n * %s\n * %s\n */\n' "${probe% *}" "${probe##* }" > "$S/$f"; git -C "$S" add -A
  refs "$S"
  if [[ "$RC" -eq 1 ]] && grep -qF "[$cls] $f:" <<<"$OUT"; then pass "[$cls] probe split across two comment lines -> RED"
  else fail "[$cls] probe split across two comment lines did not go RED (rc=$RC)"; fi
  if [[ "$cls" == "$CROSS_LINE_CLASS" ]]; then
    grep -qF '⏎' < <(grep -F "[$cls] $f:" <<<"$OUT") && pass "[$cls] the split probe was caught by the cross-line pass (neither line matches alone)" \
      || fail "[$cls] the split probe was not reported as a cross-line hit"
  fi
  reset_scratch
done

# Every word class: its first word, as a plain word and hidden in the shapes a \b regex misses.
for i in "${!WORDCLS[@]}"; do
  cls="${WORDCLS[$i]}"; w="${WORDS[$i]}"; W="${w^}"; f="probe/word-$cls.ts"
  for spelled in "note: $w here" "const sess${W} = 1;" "const P_${w^^}_ID = 1;" "id = 'x%2F${w}';"; do
    mkdir -p "$S/probe"; printf '%s\n' "$spelled" > "$S/$f"; git -C "$S" add -A
    if ! git -C "$S" grep --cached -q -F -e "$spelled" -- "$f"; then fail "[$cls] word mutation did not LAND"; continue; fi
    refs "$S"
    if [[ "$RC" -eq 1 ]] && grep -qF "[$cls] $f:" <<<"$OUT"; then pass "[$cls] '$spelled' -> RED, named [$cls]"
    else fail "[$cls] '$spelled' did not go RED naming the class (rc=$RC)"; fi
  done
  reset_scratch
done

# Every hashed class: a synthetic token, hashed under that class, must turn the gate RED in any case.
for cls in "${HASHED[@]}"; do
  tok="zzprobe${cls//-/}"; f="probe/$cls.txt"
  printf '%s\tsha256:%s\n' "$cls" "$(sha256_of "$tok")" >> "$S/$PATTERNS_FILE"
  for spelled in "$tok" "${tok^^}" "sess${tok^}"; do
    mkdir -p "$S/probe"; printf 'note: (%s) here\n' "$spelled" > "$S/$f"; git -C "$S" add -A
    if ! git -C "$S" grep --cached -q -F -e "$spelled" -- "$f"; then fail "[$cls] hashed mutation did not LAND"; continue; fi
    refs "$S"
    if [[ "$RC" -eq 1 ]] && grep -qF "[$cls] $f:" <<<"$OUT"; then pass "[$cls] hashed token '$spelled' LANDED in $f -> RED, named [$cls]"
    else fail "[$cls] hashed token '$spelled' did not go RED naming the class (rc=$RC): $(tail -n1 <<<"$OUT")"; fi
  done
  reset_scratch
done
refs "$S"; [[ "$RC" -eq 0 ]] && pass "control is GREEN again after the per-class probes" || fail "control did not return to GREEN (rc=$RC)"

# A bare 8-hex id in every context the hexref class claims, and the legitimate hex it must leave
# alone. The id is assembled at run time so this file never carries one.
HID="$(printf '9f8e%s' 7d6c)"
# shape_red <file> <class-alternation> <content…> — the content, planted alone, is RED naming a class.
shape_red() {
  local f="probe/$1" cls="$2"; shift 2
  mkdir -p "$S/probe"; printf '%s\n' "$@" > "$S/$f"; git -C "$S" add -A
  if ! git -C "$S" grep --cached -q -F -e "$HID" -- "$f"; then fail "[shape $f] mutation did not LAND in the index"; reset_scratch; return; fi
  refs "$S"
  if [[ "$RC" -eq 1 ]] && grep -qE "\[(${cls})\] $f:" <<<"$OUT"; then pass "[shape $f] LANDED -> RED, named [$(grep -oE "\[(${cls})\] $f:" <<<"$OUT" | head -1 | cut -d']' -f1 | tr -d '[')]"
  else fail "[shape $f] did not go RED naming ${cls} (rc=$RC): $(tail -n1 <<<"$OUT")"; fi
  reset_scratch
}
# shape_green <file> <content…> — legitimate hex, planted alone and SCANNED (it is in --list-scanned), is GREEN.
shape_green() {
  local f="probe/$1"; shift
  mkdir -p "$S/probe"; printf '%s\n' "$@" > "$S/$f"; git -C "$S" add -A
  if ! (cd "$S" && bash "$GATE_SCRIPT" --list-scanned) | grep -qxF "$f"; then fail "[decoy $f] is not in the scanned population"; reset_scratch; return; fi
  refs "$S"
  if [[ "$RC" -eq 0 ]]; then pass "[decoy $f] scanned and left GREEN"
  else fail "[decoy $f] went RED (rc=$RC): $(grep -F "$f" <<<"$OUT" | head -2 | tr '\n' ' ')"; fi
  reset_scratch
}
shape_red  comment.ts        hexref    "// $HID: the cause of the regression"
shape_red  wrapped.ts        hexref    "/**" " * this was fixed by the change" " * $HID" " */"
shape_red  prose.md          hexref    "Reverted in $HID after the review."
shape_red  keyword.ts        'id|hexref' "const m = \"see task $HID\";"
shape_red  paren.ts          hexref    "throw new Error('the export failed ($HID)');"
shape_red  title.test.ts     hexref    "it('$HID — keeps the order', () => {});"
shape_red  label.ts          hexref    "const d = '$HID fixture';"
shape_red  heredoc.sh        'id|hexref' "cat <<EOF" "the probe landed perfectly (defect" "$HID — it cost two rounds)" "EOF"
shape_green colour.css       "a { color: #$HID; }"
shape_green constant.ts      "const MASK = 0x$HID;"
shape_green uuid.ts          "const ID = '$HID-1111-4111-8111-111111111111';"
shape_green sha256.ts        "// pinned: sha256 ${HID}${HID}${HID}${HID}${HID}${HID}${HID}${HID}"
shape_green fixture.ts       "const ID = '$HID';"
shape_green words.ts         "// deadbeef is a word; released 20261024"
shape_green comment-code.ts  "// the next value is a fixture the test asserts on" "const ID = '$HID';"
refs "$S"; [[ "$RC" -eq 0 ]] && pass "control is GREEN again after the shape probes" || fail "control did not return to GREEN after the shape probes (rc=$RC)"

# Allow-list scope: the allowed literal elsewhere, and another class at the allowed path.
mkdir -p "$S/probe"; printf '%s %s\n' "$ALLOWED_PROBE" "$ALLOWED_LITERAL" > "$S/probe/elsewhere.md"; git -C "$S" add -A
refs "$S"
[[ "$RC" -eq 1 ]] && grep -qF "[$ALLOWED_CLASS] probe/elsewhere.md:" <<<"$OUT" \
  && pass "allowed literal at a different path -> RED (the path glob is enforced)" \
  || fail "allowed literal at a different path did not go RED (rc=$RC)"
reset_scratch
printf '%s %s\n' "$(probe_of "$OTHER_CLASS")" "$ALLOWED_LITERAL" >> "$S/$ALLOWED_PATH"; git -C "$S" add -A
refs "$S"
[[ "$RC" -eq 1 ]] && grep -qF "[$OTHER_CLASS] $ALLOWED_PATH:" <<<"$OUT" \
  && pass "a $OTHER_CLASS hit at the allowed path -> RED (the class is enforced)" \
  || fail "a $OTHER_CLASS hit at the allowed path did not go RED (rc=$RC)"
printf '%s %s\n' "$ALLOWED_PROBE" "$ALLOWED_LITERAL" > "$S/$ALLOWED_PATH"; reset_scratch

# Allow-list hygiene.
printf '%s\t%s\t%s\t\n' "$ALLOWED_CLASS" "docs/other.md" "x" >> "$S/$ALLOW_FILE"; git -C "$S" add -A
refs "$S"
[[ "$RC" -eq 1 ]] && grep -q 'allow-list entry 2' <<<"$OUT" && pass "an entry with no reason -> RED" || fail "an entry with no reason did not go RED (rc=$RC)"
reset_scratch
printf '%s\t%s\t%s\t%s\n' "$ALLOWED_CLASS" "docs/never.md" "x" "covers nothing" >> "$S/$ALLOW_FILE"; git -C "$S" add -A
refs "$S"
[[ "$RC" -eq 1 ]] && grep -q 'cover no hit' <<<"$OUT" && pass "an entry that covers no hit -> RED" || fail "a stale entry did not go RED (rc=$RC)"
reset_scratch

# Hollow and absent inputs: never GREEN.
grep '^#' "$WORK/patterns.orig" > "$S/$PATTERNS_FILE"; git -C "$S" add -A
refs "$S"; [[ "$RC" -eq 1 ]] && grep -q 'hollow' <<<"$OUT" && pass "comments-only pattern list -> RED (hollow)" || fail "comments-only pattern list did not go RED (rc=$RC)"
reset_scratch
git -C "$S" rm -q --cached "$PATTERNS_FILE"; rm -f "$S/$PATTERNS_FILE"
refs "$S"; [[ "$RC" -eq 1 ]] && pass "absent pattern list -> RED" || fail "absent pattern list did not go RED (rc=$RC)"
reset_scratch
git -C "$S" rm -q --cached "$ALLOW_FILE"; rm -f "$S/$ALLOW_FILE"
refs "$S"; [[ "$RC" -eq 1 ]] && grep -q 'missing' <<<"$OUT" && pass "absent allow-list -> RED" || fail "absent allow-list did not go RED (rc=$RC)"
reset_scratch
awk -F'\t' 'BEGIN { OFS = "\t" } /^#/ || NF < 3 { print; next } !done { print $1, $2; done = 1; next } { print }' "$WORK/patterns.orig" > "$S/$PATTERNS_FILE"; git -C "$S" add -A
refs "$S"; [[ "$RC" -eq 1 ]] && grep -q 'is not <class>' <<<"$OUT" && pass "a pattern line without its probe -> RED" || fail "a pattern line without its probe did not go RED (rc=$RC)"
reset_scratch
printf '%s\tsha256:%s\n' "${CLASSES[0]}" "NOT-HEX" >> "$S/$PATTERNS_FILE"; git -C "$S" add -A
refs "$S"; [[ "$RC" -eq 1 ]] && grep -q 'hashed token is sha256' <<<"$OUT" && pass "a malformed hash -> RED" || fail "a malformed hash did not go RED (rc=$RC)"
reset_scratch

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
