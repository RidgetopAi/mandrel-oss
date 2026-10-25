#!/usr/bin/env bash
#
# scripts/oss-gate.sh — the authoritative gate for this repository.
#
# Exit codes are the verdict (consumers read these, never the prose):
#   0  GREEN              every stage measured and passed
#   1  RED                at least one stage measured a failure
#   2  COULD-NOT-MEASURE  nothing failed, but at least one stage could not run
#                         (tool missing, package registry unreachable, scanner error)
#
# Usage:
#   bash scripts/oss-gate.sh                   # run every stage, print a one-line verdict last
#   bash scripts/oss-gate.sh --list-scanned    # print the files the internal-refs scan covers
#   bash scripts/oss-gate.sh --refs-only       # STAGE R alone (used by scripts/test/internal-refs-ban.test.sh)
#   bash scripts/oss-gate.sh --secrets-only      # STAGE S alone (used by scripts/test/gate-secret-stage.test.sh)
#   bash scripts/oss-gate.sh --shell-tests-only  # STAGE H alone (a SUBSET: used by scripts/test/ci-workflow.test.sh)
#
# Stages:
#   D  deps          npm ci in each npm root
#   T  type-check    every TypeScript package
#   L  lint          eslint, errors fail, warnings tolerated
#   U  unit tests    tests that need no database and no network
#   H  shell tests  every scripts/test/*.test.sh (no exclusions)
#   S  secret scan   gitleaks with the repo's .gitleaks.toml over the tracked tree AND the full
#                    history — the same rules and arguments as .github/workflows/secrets.yml
#   R  refs ban      no internal reference (scripts/oss-gate/internal-refs.patterns) in any tracked
#                    file, except hits covered by a reasoned entry in internal-refs.allow
#
# What gets scanned (S and R): the git INDEX, i.e. what is committed or staged. Untracked files and
# unstaged edits are not part of the tree this gate measures; `git add` a file to put it in scope.
# On a clean checkout the index equals HEAD.
#
# Lists (npm roots, packages, internal-refs files): scripts/oss-gate/config.sh.
#
# Every stage runs with an EMPTY inherited environment (PATH, HOME, LANG, TMPDIR only), so a
# credential in the caller's environment never reaches repository code. Tests additionally get a
# throwaway HOME and a placeholder database on a closed port.

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "OSS-GATE COULD-NOT-MEASURE — not inside a git work tree"
  exit 2
}
cd "$ROOT" || { echo "OSS-GATE COULD-NOT-MEASURE — cannot cd to $ROOT"; exit 2; }

CONFIG="scripts/oss-gate/config.sh"
# shellcheck source=scripts/oss-gate/config.sh
. "$CONFIG" || { echo "OSS-GATE RED — cannot load $CONFIG"; exit 1; }

MODE=gate
case "${1:-}" in
  "") ;;
  --refs-only) MODE=refs ;;
  --shell-tests-only) MODE=shell ;;
  --secrets-only) MODE=secrets ;;
  --list-scanned) MODE=list ;;
  *) echo "usage: bash scripts/oss-gate.sh [--refs-only|--shell-tests-only|--secrets-only|--list-scanned]" >&2; exit 2 ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oss-gate.XXXXXX")" || { echo "OSS-GATE COULD-NOT-MEASURE — mktemp failed"; exit 2; }
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/tmp"

# clean CMD… — run with only PATH/HOME/LANG/TMPDIR. HOME is kept for npm's download cache.
clean() { env -i PATH="$PATH" HOME="${HOME:-$WORK/home}" LANG="${LANG:-C.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" "$@"; }
# test_env CMD… — tests: empty env, throwaway HOME/TMPDIR, CI=true, placeholder database.
test_env() { env -i PATH="$PATH" HOME="$WORK/home" LANG=C.UTF-8 TMPDIR="$WORK/tmp" CI=true "${OSS_GATE_TEST_DB_ENV[@]}" "$@"; }

STAGES=()      # "X:status" in run order
FAILED=()      # stage letters that went RED
UNMEASURED=()  # stage letters that could not measure
REFS_NOTE=""

record() {  # <letter> <ok|RED|UNMEASURED|skipped> <detail>
  STAGES+=("$1:$2")
  case "$2" in
    RED) FAILED+=("$1") ;;
    UNMEASURED) UNMEASURED+=("$1") ;;
  esac
  printf '[oss-gate] %s %-10s %s\n' "$1" "$2" "$3"
}

tail_log() {  # <log> — the durable record is stdout; the work dir is deleted on exit
  tail -n 25 "$1" | sed 's/^/    | /'
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- H: shell tests -----------------------------------------------------------------------------
# Runs every file matching $OSS_GATE_SHELL_TEST_GLOB; a non-zero exit from any is RED.
stage_shell_tests() {
  local f base log ran=0 bad=() matched=()
  shopt -s nullglob
  for f in $OSS_GATE_SHELL_TEST_GLOB; do matched+=("$f"); done
  shopt -u nullglob
  if [[ ${#matched[@]} -eq 0 ]]; then
    record H RED "no file matches $OSS_GATE_SHELL_TEST_GLOB — a test stage with nothing to run is hollow"
    return
  fi
  for f in "${matched[@]}"; do
    base="${f##*/}"; reason=""
    log="$WORK/sh-${base}.log"
    # A fresh TMPDIR per test: several suites build fixtures under a fixed name inside it.
    mkdir -p "$WORK/tmp/$base"
    if ! test_env TMPDIR="$WORK/tmp/$base" timeout "$OSS_GATE_SHELL_TEST_TIMEOUT" bash "$f" >"$log" 2>&1; then
      echo "    | shell test FAILED: $f"; tail_log "$log"; bad+=("$base")
    fi
    ran=$((ran + 1))
  done
  if [[ ${#bad[@]} -eq 0 ]]; then
    record H ok "$ran shell tests passed"
  else
    record H RED "failing shell tests: ${bad[*]}"
  fi
}
# --- R: internal-refs ban ------------------------------------------------------------------------
# REFS_PATHSPEC: the ONE pathspec both the scan and --list-scanned use (scope minus exempt paths).
refs_pathspec() {
  local p
  REFS_PATHSPEC=("${OSS_GATE_REFS_SCOPE[@]}")
  for p in "${OSS_GATE_REFS_EXEMPT[@]}"; do REFS_PATHSPEC+=(":(exclude)$p"); done
}

# refs_load — parse the pattern list and the allow-list. A pattern line is either
#   <class><TAB><pcre><TAB><probe>        a regex class, with a synthetic hit as its probe, or
#   <class><TAB>word:<word>               a word, matched as a whole TOKEN (see below)
#   <class><TAB>sha256:<64 hex>           a token whose sha256 is listed. For names that must not
#                                         be spelled out in a public file; obscured, not secret.
# A TOKEN is a maximal [a-z0-9] run after percent-escapes are removed and camelCase is split,
# lowercased: `sessAlpha`, `P_ALPHA`, `x%2Falpha` and `Alpha's` all yield the token `alpha`.
# Fills REFS_CLS/REFS_RE (regex lines), $WORK/hash.tsv (<class><TAB><hex>), REFS_ALLCLS (every
# class) and $WORK/allow.tsv. Returns 0 ok · 3 hollow (no patterns) · 4 malformed (REFS_ERR).
refs_load() {
  local line cls re probe extra n=0
  REFS_CLS=(); REFS_RE=(); REFS_ALLCLS=(); REFS_ERR=""
  : > "$WORK/hash.tsv"
  [[ -f "$OSS_GATE_REFS_PATTERNS" ]] || return 3
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    n=$((n + 1))
    IFS=$'\t' read -r cls re probe extra <<<"$line"
    if [[ ! "$cls" =~ ^[a-z][a-z0-9-]*$ || -n "$extra" ]]; then
      REFS_ERR="$OSS_GATE_REFS_PATTERNS line $n is not <class><TAB><pcre><TAB><probe>, <class><TAB>word:<word> or <class><TAB>sha256:<hex>"; return 4
    elif [[ "$re" =~ ^sha256: ]]; then
      if [[ ! "$re" =~ ^sha256:[0-9a-f]{64}$ || -n "$probe" ]]; then
        REFS_ERR="$OSS_GATE_REFS_PATTERNS line $n: a hashed token is sha256:<64 lowercase hex> and nothing after it"; return 4
      fi
      printf '%s\t%s\n' "$cls" "${re#sha256:}" >> "$WORK/hash.tsv"
    elif [[ "$re" =~ ^word: ]]; then
      if [[ ! "$re" =~ ^word:[a-z0-9]+$ || -n "$probe" ]]; then
        REFS_ERR="$OSS_GATE_REFS_PATTERNS line $n: a word token is word:<lowercase [a-z0-9]+> and nothing after it"; return 4
      fi
      printf '%s\t%s\n' "$cls" "$re" >> "$WORK/hash.tsv"
    elif [[ -z "$re" || -z "$probe" ]]; then
      REFS_ERR="$OSS_GATE_REFS_PATTERNS line $n is not <class><TAB><pcre><TAB><probe> or <class><TAB>sha256:<hex>"; return 4
    else
      REFS_CLS+=("$cls"); REFS_RE+=("$re")
    fi
    [[ " ${REFS_ALLCLS[*]} " == *" $cls "* ]] || REFS_ALLCLS+=("$cls")
  done < "$OSS_GATE_REFS_PATTERNS"
  [[ ${#REFS_ALLCLS[@]} -gt 0 ]] || return 3
  [[ -f "$OSS_GATE_REFS_ALLOW" ]] || { REFS_ERR="allow-list $OSS_GATE_REFS_ALLOW is missing"; return 4; }
  # allow.tsv: <entry-no> <class|*> <path-glob> <literal|*> — every entry must carry a reason.
  awk -F'\t' -v F="$OSS_GATE_REFS_ALLOW" -v CLS=" ${REFS_ALLCLS[*]} " '
    { sub(/\r$/, "") }
    /^[ \t]*(#|$)/ { next }
    { n++
      if (NF != 4 || $1 == "" || $2 == "" || $3 == "" || $4 !~ /[A-Za-z]/) { print "BAD\t" n "\tnot <class><TAB><path-glob><TAB><literal-or-*><TAB><reason>"; next }
      if ($1 != "*" && index(CLS, " " $1 " ") == 0) { print "BAD\t" n "\tunknown class \"" $1 "\""; next }
      print n "\t" $1 "\t" $2 "\t" $3 }' "$OSS_GATE_REFS_ALLOW" > "$WORK/allow.tsv"
  if grep -q '^BAD' "$WORK/allow.tsv"; then
    REFS_ERR="$(awk -F'\t' '$1 == "BAD" { printf "%sallow-list entry %s: %s", sep, $2, $3; sep = "; " }' "$WORK/allow.tsv")"
    return 4
  fi
  return 0
}

# The line-aware matcher: stdin is `git grep -z -n -e ''` (every line), argv[1] hash.tsv (word: and
# sha256 lines), argv[2] regex.tsv. Emits <class><TAB><path><TAB><line><TAB><text> for (a) a line
# holding a listed word or hashed token and
# (b) a regex class matching ACROSS two consecutive lines of the same kind (both comment lines, or
# neither; the continuation's comment marker stripped)
# that neither line matches alone — "decision" at a line end, its id on the next line. A regex that
# JavaScript cannot compile exits 3 (the stage reports could-not-measure, never a pass).
REFS_LINESCAN_JS="$(cat <<'JS'
const crypto = require('crypto');
const fs = require('fs');
const want = new Map();   // sha256 -> class
const words = new Map();  // plain token -> class
for (const l of fs.readFileSync(process.argv[1], 'utf8').split('\n')) {
  const [c, h] = l.split('\t');
  if (c && h) (h.startsWith('word:') ? words.set(h.slice(5), c) : want.set(h, c));
}
const tokens = (s) => s.replace(/%[0-9A-Fa-f]{2}/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase().match(/[a-z0-9]+/g) || [];
const rx = [];
for (const l of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  const i = l.indexOf('\t'); if (i < 0) continue;
  let src = l.slice(i + 1), flags = '';
  if (src.startsWith('(?i)')) { src = src.slice(4); flags = 'i'; }
  try { rx.push([l.slice(0, i), new RegExp(src, flags)]); } catch (e) { process.stderr.write(`cannot compile ${l.slice(0, i)}: ${e.message}\n`); process.exit(3); }
}
const memo = new Map();
const sha = (t) => {
  let h = memo.get(t);
  if (h === undefined) { h = crypto.createHash('sha256').update(t).digest('hex'); memo.set(t, h); }
  return h;
};
const out = [];
const emit = (c, path, ln, txt) => out.push(`${c}\t${path}\t${ln}\t${txt.replace(/\t/g, ' ')}\n`);
const LEAD = /^[ \t]*(?:\/\/|\*|#|--|<!--)?[ \t]*/;
// A wrap continues prose of the SAME kind: comment onto comment, or text onto text (a heredoc, a
// paragraph). A comment line followed by a code line is not one sentence, and joining them would
// read the code's fixture values as if the comment had said them.
const MARK = /^[ \t]*(?:\/\/|\/?\*|#|--|<!--)/;
let pPath = null, pLn = -1, pTxt = '';
const handle = (rec) => {
  const a = rec.indexOf('\0'); const b = a < 0 ? -1 : rec.indexOf('\0', a + 1);
  if (b < 0) return;
  const path = rec.slice(0, a), ln = Number(rec.slice(a + 1, b)), txt = rec.slice(b + 1);
  if (want.size || words.size) {
    const hit = new Set();
    for (const t of tokens(txt)) {
      const w = words.get(t); if (w) hit.add(w);
      if (want.size) { const c = want.get(sha(t)); if (c) hit.add(c); }
    }
    for (const c of hit) emit(c, path, ln, txt);
  }
  if (path === pPath && ln === pLn + 1 && pTxt.trim() && txt.trim() && MARK.test(pTxt) === MARK.test(txt)) {
    const joined = pTxt.replace(/\s+$/, '') + ' ' + txt.replace(LEAD, '');
    for (const [c, r] of rx) if (r.test(joined) && !r.test(pTxt) && !r.test(txt)) emit(c, path, ln, `${pTxt.trim()} ⏎ ${txt.trim()}`);
  }
  pPath = path; pLn = ln; pTxt = txt;
};
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
});
process.stdin.on('end', () => { if (buf) handle(buf); process.stdout.write(out.join('')); });
JS
)"

# refs_scan <out> — every match of every class in the indexed tree, as <class>\t<path>\t<line>\t<text>.
# Returns 0 measured · 2 scanner error.
refs_scan() {
  local out="$1" i rc
  : > "$out"
  refs_pathspec
  for i in "${!REFS_CLS[@]}"; do
    git grep --cached -I -n -z -P -e "${REFS_RE[$i]}" -- "${REFS_PATHSPEC[@]}" > "$WORK/refs.raw"
    rc=$?
    case "$rc" in
      # -z: <path>NUL<line>NUL<text>. A path holds no tab, a line number holds no tab, so after
      # NUL->TAB the first two fields are exact and the remainder (tabs folded) is the text.
      0) tr '\0' '\t' < "$WORK/refs.raw" | awk -F'\t' -v c="${REFS_CLS[$i]}" '{
           txt = $0; sub(/^[^\t]*\t[^\t]*\t/, "", txt); gsub(/\t/, " ", txt)
           print c "\t" $1 "\t" $2 "\t" txt }' >> "$out" ;;
      1) ;;  # git grep: 1 = no match anywhere, a valid measurement
      *) return 2 ;;
    esac
  done
  # Hashed tokens and cross-line matches need every line in order: one pass in node.
  have node || return 2
  : > "$WORK/regex.tsv"
  for i in "${!REFS_CLS[@]}"; do printf '%s\t%s\n' "${REFS_CLS[$i]}" "${REFS_RE[$i]}" >> "$WORK/regex.tsv"; done
  git grep --cached -I -n -z -e '' -- "${REFS_PATHSPEC[@]}" \
    | node -e "$REFS_LINESCAN_JS" "$WORK/hash.tsv" "$WORK/regex.tsv" >> "$out"
  local st=("${PIPESTATUS[@]}")
  [[ "${st[0]}" -le 1 && "${st[1]}" -eq 0 ]] || return 2
  return 0
}

# refs_judge <hits> — splits hits into $WORK/refs.bad (not covered) and $WORK/refs.unused (allow
# entries that cover nothing). A glob's `**` crosses directories, `*` and `?` do not.
refs_judge() {
  awk -F'\t' -v ALLOW="$WORK/allow.tsv" -v BAD="$WORK/refs.bad" -v UNUSED="$WORK/refs.unused" '
    function glob2re(g,   r, i, c) {
      r = "^"
      for (i = 1; i <= length(g); i++) {
        c = substr(g, i, 1)
        if (c == "*" && substr(g, i + 1, 1) == "*") { r = r ".*"; i++ }
        else if (c == "*") r = r "[^/]*"
        else if (c == "?") r = r "[^/]"
        else if (index("\\^$.[]|()+{}", c)) r = r "\\" c
        else r = r c
      }
      return r "$"
    }
    BEGIN { while ((getline l < ALLOW) > 0) { split(l, f, "\t"); n++; id[n] = f[1]; ac[n] = f[2]; ap[n] = glob2re(f[3]); al[n] = f[4] } }
    {
      ok = 0
      for (k = 1; k <= n; k++)
        if ((ac[k] == "*" || ac[k] == $1) && $2 ~ ap[k] && (al[k] == "*" || index($4, al[k]) > 0)) { used[k] = 1; ok = 1 }
      if (!ok) print > BAD
    }
    END { for (k = 1; k <= n; k++) if (!(k in used)) print id[k] > UNUSED; close(BAD); close(UNUSED) }' "$1"
}

stage_refs() {
  local rc hits="$WORK/refs.hits" bad unused allowed
  refs_load; rc=$?
  if [[ "$rc" -eq 3 ]]; then
    record R RED "no patterns in $OSS_GATE_REFS_PATTERNS (absent or only comments) — a ban with nothing to look for is hollow"; return
  elif [[ "$rc" -ne 0 ]]; then
    record R RED "$REFS_ERR"; return
  fi
  refs_scan "$hits" || { record R UNMEASURED "git grep failed while scanning the index"; return; }
  : > "$WORK/refs.bad"; : > "$WORK/refs.unused"
  refs_judge "$hits"
  bad=$(wc -l < "$WORK/refs.bad" | tr -d ' ')
  unused=$(wc -l < "$WORK/refs.unused" | tr -d ' ')
  allowed=$(( $(wc -l < "$hits" | tr -d ' ') - bad ))
  REFS_NOTE="refs ${bad} banned, ${allowed} allowed"
  if [[ "$bad" -gt 0 ]]; then
    awk -F'\t' '{ printf "    | [%s] %s:%s: %s\n", $1, $2, $3, substr($4, 1, 160) }' "$WORK/refs.bad" | head -n "$OSS_GATE_REFS_SHOW"
    [[ "$bad" -le "$OSS_GATE_REFS_SHOW" ]] || echo "    | … $((bad - OSS_GATE_REFS_SHOW)) more"
    record R RED "$bad internal reference(s) by class: $(cut -f1 "$WORK/refs.bad" | sort | uniq -c | awk '{ printf "%s%s=%s", s, $2, $1; s = " " }') — remove them, or add a reasoned entry to $OSS_GATE_REFS_ALLOW"
    return
  fi
  if [[ "$unused" -gt 0 ]]; then
    record R RED "allow-list entr$( [[ "$unused" -eq 1 ]] && echo y || echo ies) $(tr '\n' ' ' < "$WORK/refs.unused")cover no hit — delete them ($OSS_GATE_REFS_ALLOW)"
    return
  fi
  record R ok "${#REFS_ALLCLS[@]} classes, 0 banned, $allowed allowed by $(wc -l < "$WORK/allow.tsv" | tr -d ' ') reasoned entr$( [[ $(wc -l < "$WORK/allow.tsv") -eq 1 ]] && echo y || echo ies)"
}

# --- S: secret scan (gitleaks, the repo's config — the same rules as the Secret Scan workflow) ----
# Two scans, one config: the indexed tree (staged work no commit holds yet) and the full history
# (exactly the workflow's `gitleaks detect --redact --config .gitleaks.toml --log-opts=--all`).
stage_secrets() {
  gitleaks_findings() {  # <report.json> — file, line and rule only; never the match
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const f of r) console.log(`    | ${f.File}:${f.StartLine} ${f.RuleID}`);
    ' "$1" 2>/dev/null | sed "s#$WORK/tree/##"
  }
  if ! have gitleaks; then
    record S UNMEASURED "gitleaks not on PATH"
  elif [[ ! -f "$OSS_GATE_GITLEAKS_CONFIG" ]]; then
    record S UNMEASURED "$OSS_GATE_GITLEAKS_CONFIG missing — the scan would silently use other rules"
  else
    mkdir -p "$WORK/tree"
    if ! git checkout-index -a --prefix="$WORK/tree/" 2>"$WORK/checkout-index.log"; then
      tail_log "$WORK/checkout-index.log"
      record S UNMEASURED "could not materialise the indexed tree"
    elif [[ -z "$(find "$WORK/tree" -type f -print -quit)" ]]; then
      record S UNMEASURED "indexed tree is empty — nothing to scan"
    else
      clean gitleaks detect --no-git --source "$WORK/tree" --config "$ROOT/$OSS_GATE_GITLEAKS_CONFIG" \
        --redact --no-banner --exit-code 42 --report-format json --report-path "$WORK/gitleaks-tree.json" \
        >"$WORK/gitleaks-tree.log" 2>&1
      rc_tree=$?
      clean gitleaks detect --redact --no-banner --config "$OSS_GATE_GITLEAKS_CONFIG" \
        --log-opts="$OSS_GATE_GITLEAKS_LOG_OPTS" --exit-code 42 \
        --report-format json --report-path "$WORK/gitleaks-history.json" \
        >"$WORK/gitleaks-history.log" 2>&1
      rc_hist=$?
      if [[ "$rc_tree" -eq 0 && "$rc_hist" -eq 0 ]]; then
        record S ok "gitleaks $(gitleaks version 2>/dev/null) $OSS_GATE_GITLEAKS_CONFIG, tree + history: no leaks"
      elif [[ "$rc_tree" -eq 42 || "$rc_hist" -eq 42 ]]; then
        [[ "$rc_tree" -ne 42 ]] || gitleaks_findings "$WORK/gitleaks-tree.json"
        [[ "$rc_hist" -ne 42 ]] || gitleaks_findings "$WORK/gitleaks-history.json"
        record S RED "gitleaks ($OSS_GATE_GITLEAKS_CONFIG) found leak(s)"
      else
        tail_log "$WORK/gitleaks-tree.log"
        tail_log "$WORK/gitleaks-history.log"
        record S UNMEASURED "gitleaks exited tree=$rc_tree history=$rc_hist"
      fi
    fi
  fi
}

# --- verdict --------------------------------------------------------------------------------------
print_verdict() {
  SUMMARY="${STAGES[*]}${REFS_NOTE:+ | $REFS_NOTE}"
  if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "OSS-GATE RED — failed: ${FAILED[*]} | $SUMMARY"
    exit 1
  elif [[ ${#UNMEASURED[@]} -gt 0 ]]; then
    echo "OSS-GATE COULD-NOT-MEASURE — unmeasured: ${UNMEASURED[*]} | $SUMMARY"
    exit 2
  fi
  echo "OSS-GATE GREEN — $SUMMARY"
  exit 0
}

if [[ "$MODE" == "list" ]]; then  # the files the internal-refs scan covers, one per line
  refs_pathspec
  git ls-files --cached -- "${REFS_PATHSPEC[@]}" | LC_ALL=C sort
  exit 0
fi

if [[ "$MODE" == "refs" ]]; then
  stage_refs
  print_verdict
fi

if [[ "$MODE" == "shell" ]]; then
  stage_shell_tests
  print_verdict
fi

if [[ "$MODE" == "secrets" ]]; then
  stage_secrets
  print_verdict
fi

# --- header ---------------------------------------------------------------------------------------
echo "[oss-gate] repo $ROOT @ $(git rev-parse --short=12 HEAD 2>/dev/null || echo '?')"
if have node; then
  NODE_V="$(node -v 2>/dev/null)"
  WANT="$(tr -d ' \nv' < .nvmrc 2>/dev/null)"
  echo "[oss-gate] node $NODE_V (.nvmrc: ${WANT:-none})"
  [[ -n "$WANT" && "${NODE_V#v}" != "$WANT"* ]] && echo "[oss-gate] note: node major differs from .nvmrc"
fi

# --- D: deps --------------------------------------------------------------------------------------
DEPS_OK=0
if ! have npm || ! have node; then
  record D UNMEASURED "node/npm not on PATH"
elif ! clean npm ping >"$WORK/npm-ping.log" 2>&1; then
  tail_log "$WORK/npm-ping.log"
  record D UNMEASURED "package registry unreachable (npm ping failed)"
else
  DEPS_OK=1
  for d in "${OSS_GATE_NPM_ROOTS[@]}"; do
    log="$WORK/npm-ci-${d//\//_}.log"
    if ! ( cd "$d" && clean npm ci --include=dev --no-audit --no-fund ) >"$log" 2>&1; then
      tail_log "$log"
      record D RED "npm ci failed in $d (registry answered npm ping, so this is the lockfile or a lifecycle script)"
      DEPS_OK=0
      break
    fi
  done
  [[ "$DEPS_OK" -eq 1 ]] && record D ok "npm ci: ${OSS_GATE_NPM_ROOTS[*]}"
fi

if [[ "$DEPS_OK" -eq 1 ]]; then
  # --- T: type-check ------------------------------------------------------------------------------
  bad=()
  for spec in "${OSS_GATE_TYPECHECK[@]}"; do
    d="${spec%%|*}"; cmd="${spec#*|}"
    log="$WORK/tc-${d//\//_}.log"
    if ! ( cd "$d" && clean bash -c "$cmd" ) >"$log" 2>&1; then
      echo "    | type-check FAILED in $d ($cmd):"; tail_log "$log"; bad+=("$d")
    fi
  done
  if [[ ${#bad[@]} -eq 0 ]]; then record T ok "${#OSS_GATE_TYPECHECK[@]} packages"; else record T RED "type errors in: ${bad[*]}"; fi

  # --- L: lint ------------------------------------------------------------------------------------
  bad=()
  for d in "${OSS_GATE_LINT_DIRS[@]}"; do
    log="$WORK/lint-${d//\//_}.log"
    if ! ( cd "$d" && clean npm run -s lint -- --max-warnings=-1 ) >"$log" 2>&1; then
      echo "    | lint FAILED in $d:"; tail_log "$log"; bad+=("$d")
    fi
  done
  if [[ ${#bad[@]} -eq 0 ]]; then record L ok "${#OSS_GATE_LINT_DIRS[@]} packages, 0 errors"; else record L RED "eslint errors in: ${bad[*]}"; fi

  # --- U: unit tests ------------------------------------------------------------------------------
  bad=()
  excl=(); for g in "${OSS_GATE_MCP_TEST_EXCLUDE[@]}"; do excl+=(--exclude "$g"); done
  log="$WORK/test-mcp.log"
  if ! ( cd mcp-server && test_env npx --no-install vitest run --reporter=dot "$OSS_GATE_MCP_TEST_FILTER" "${excl[@]}" ) >"$log" 2>&1; then
    echo "    | mcp-server unit tests FAILED:"; tail_log "$log"; bad+=(mcp-server)
  fi
  log="$WORK/test-frontend.log"
  if ! ( cd mandrel-command/frontend && test_env npx --no-install vitest run --reporter=dot ) >"$log" 2>&1; then
    echo "    | frontend tests FAILED:"; tail_log "$log"; bad+=(frontend)
  fi
  log="$WORK/test-backend.log"
  if ! ( cd mandrel-command/backend && test_env NODE_ENV=test MANDREL_SKIP_DB_TESTS=true \
        npx --no-install jest --runInBand --ci --testPathIgnorePatterns '/node_modules/' "${OSS_GATE_BACKEND_TEST_IGNORE[@]}" ) >"$log" 2>&1; then
    echo "    | backend tests FAILED:"; tail_log "$log"; bad+=(backend)
  fi
  # The runners' own summary lines, as a witness of what ran. Display only: the verdict above is
  # each runner's exit code, never this text.
  for t in mcp frontend backend; do
    awk -v t="$t" '{ gsub(/\033\[[0-9;]*m/, "") } /^ *(Test Files|Tests|Test Suites):? / { sub(/^ +/, ""); print "    | " t ": " $0 }' "$WORK/test-$t.log"
  done
  if [[ ${#bad[@]} -eq 0 ]]; then record U ok "mcp-server unit, frontend, backend (no-DB populations)"; else record U RED "failing tests in: ${bad[*]}"; fi
else
  record T skipped "deps did not install"
  record L skipped "deps did not install"
  record U skipped "deps did not install"
fi

# --- H: shell tests (stage_shell_tests, defined above)
stage_shell_tests

# --- S: secret scan (stage_secrets, defined above)
stage_secrets

# --- R: internal-refs ban (stage_refs, defined above)
stage_refs

print_verdict
