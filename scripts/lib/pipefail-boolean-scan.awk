# =============================================================================
# pipefail-boolean-scan.awk — THE DETECTOR for the pipefail/SIGPIPE boolean class
# -----------------------------------------------------------------------------
# Defined ONCE, here, as the single implementation. scripts/test/pipefail-boolean-ban.test.sh
# and every one of its mutation probes call THIS file — never a re-inlined regex
# that could drift away from it (the same rule test-wiring-coverage.test.sh
# follows for invokes_test()).
#
# WHAT IT LOOKS FOR
#   A pipeline whose EXIT STATUS is consumed as a BOOLEAN, where some stage of the
#   pipeline can exit BEFORE draining its stdin. Under `set -o pipefail` that shape
#   INVERTS: the consumer quits on first match, the producer takes SIGPIPE (141),
#   pipefail promotes 141 to the pipeline's status, and a condition that IS TRUE
#   reads FALSE. It is a function of producer output size and match position (the
#   64KB pipe buffer), not of luck, so it reviews clean in every small fixture.
#
# HOW IT PARSES (character-level, not a line regex)
#   Quote-aware and nesting-aware. It maintains a context stack so it can tell
#   apart the three cases that a line regex cannot:
#     TOP / SUBSHELL  — the pipeline's status IS the segment's status.
#     SUBST  `$(...)` — the status flows into a command substitution. That still
#                       matters when the enclosing segment is itself a boolean
#                       (`if v="$(a | head -1)"`), and does not when it is not.
#     DTEST  `[[ ... ]]` — the test's own status is the boolean; a substitution
#                       inside it is a value, so its status is discarded.
#   HEREDOC bodies are NOT skipped. They read as data to THIS shell, so skipping
#   them is defensible — and it was wrong here. MEASURED on this tree: the only two
#   heredoc-body hits at 38ee428a were inside scripts/test/lib/fixture-harness.sh's
#   `<<'"'"'SHIM'"'"'` block, which is WRITTEN OUT to $FH_DIR/bin/.fh-shim and then EXECUTED.
#   A generated script is code; the fact that it is quoted at rest does not make its
#   pipefail boolean safe. Scanning heredoc bodies costs a small amount of
#   over-match (fixtures that deliberately contain the banned shape) and that is
#   what the exception marker is for.
#   Comments are stripped with WORD-BOUNDARY correctness: bash starts a comment at
#   the start of any WORD, and metacharacters delimit words, so `:;#`, `x &#` and
#   `y |#` are all comments. That exact hole produced a false GREEN in this repo
#   once already (test-wiring-coverage.test.sh, commit ebeef7f). Unlike the sed
#   strip used there, this one is also QUOTE-AWARE, so `grep -q '# x'` survives
#   intact instead of being truncated into a miss.
#
# IT OVER-MATCHES ON PURPOSE
#   There is no shfmt and no shell AST tool pinned in this gate. A ban implemented
#   as a parser will call some lines that are actually safe. That is the correct
#   direction of error: a false positive in a ban is visible and cheap, a false
#   negative is the bug shipping again. Resolve a collision with a CO-LOCATED
#   exception marker carrying a written reason — NEVER by narrowing the pattern
#   until it stops noticing things.
#
# OUTPUT: one finding per line, TAB-separated:
#   <file>\t<lineno>\t<kind>\t<consumer-stage>\t<source line, comment-stripped>
# KINDs: TOPLEVEL (pipeline status is the boolean) · SUBST_BOOL (substitution
# inside a boolean segment).
#
# INPUT: awk -v FNAME=<path> -f this <file>
# =============================================================================
BEGIN {
  SQ = sprintf("%c", 39); DQ = sprintf("%c", 34); BS = sprintf("%c", 92)
  SEP = sprintf("%c", 2)          # stage separator, cannot occur in shell source
  d = 0
  ctype[0] = "TOP"; boolin[0] = 0
  reset_seg(0, 0)
}

function reset_seg(dd, inheritbool) {
  segbuf[dd] = ""; stagebuf[dd] = ""; pipes[dd] = 0; stages[dd] = ""
  boolpre[dd] = inheritbool
}

# Is this segment in boolean position? Either a preceding &&/|| (or an inherited
# boolean context from the enclosing segment), or a leading if/elif/while/until/!.
function seg_is_bool(dd,   b) {
  if (force_bool) return 1
  b = segbuf[dd]
  sub(/^[ \t]*/, "", b)
  sub(/^[({][ \t]*/, "", b)
  if (b ~ /^(if|elif|while|until)[ \t]/) return 1
  if (b ~ /^![ \t(]/) return 1
  return boolpre[dd]
}

# Does any post-pipe stage START with a command that can exit before draining stdin?
# Returns the offending stage text, or "".
function early_exit_stage(dd,   i, n, arr, s) {
  n = split(stages[dd], arr, SEP)
  for (i = 1; i <= n; i++) {
    s = arr[i]
    sub(/^[ \t]*/, "", s)
    # step over leading env-assignments and simple prefixes
    while (s ~ /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/) sub(/^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/, "", s)
    sub(/^(sudo|command|builtin|exec|timeout[ \t]+[^ \t]+|nice|stdbuf[ \t]+[^ \t]+)[ \t]+/, "", s)
    if (s ~ /^(head|read)([ \t]|$)/) return s
    if (s ~ /^(grep|egrep|fgrep|zgrep|rg|ug)([ \t]|$)/) {
      if (s ~ /(^|[ \t])-[A-Za-z]*q[A-Za-z]*([ \t]|$)/) return s          # -q, -qE, -qxF, -iq ...
      if (s ~ /(^|[ \t])(--quiet|--silent)([ \t]|$)/) return s
      if (s ~ /(^|[ \t])(-m[ \t]*[0-9]+|--max-count[= \t][0-9]+)/) return s
    }
    if (s ~ /^sed[ \t].*(^|[;\/])q([ \t;\/}]|$)/) return s                 # sed '...q' quits early
  }
  return ""
}

function close_pipe_stage(dd) {
  if (pipes[dd] > 0) stages[dd] = stages[dd] SEP stagebuf[dd]
  stagebuf[dd] = ""
}

function eval_seg(dd,   isb, st, k) {
  close_pipe_stage(dd)
  if (pipes[dd] == 0) return
  st = early_exit_stage(dd)
  if (st == "") return
  if (indtest > 0) return                     # value inside [[ ]] — status discarded
  for (k = dd; k >= 0; k--) if (ctype[k] == "PROCSUB") return   # inside <(...) — nobody reads that status
  isb = seg_is_bool(dd)
  if (ctype[dd] == "TOP" || ctype[dd] == "SUBSHELL") {
    if (isb) emit(dd, "TOPLEVEL", st)
  } else if (ctype[dd] == "SUBST") {
    if (boolin[dd]) emit(dd, "SUBST_BOOL", st)
  }
}

function emit(dd, kind, st,   l) {
  l = stripped
  gsub(/^[ \t]+/, "", l)
  printf "%s\t%d\t%s\t%s\t%s\n", FNAME, NR, kind, st, l
}

function push(newtype, inheritbool) {
  close_pipe_stage(d)
  sqs[d] = sq; dqs[d] = dq; sq = 0; dq = 0
  d++
  ctype[d] = newtype
  boolin[d] = inheritbool
  reset_seg(d, 0)
}

function pop(   dd) {
  eval_seg(d)
  if (d > 0) { d--; sq = sqs[d]; dq = dqs[d] }
}

{
  # ---- pass 1: strip comments, quote-aware + word-boundary-correct ----
  line = $0; stripped = ""; sq = 0; dq = 0; n = length(line)
  for (i = 1; i <= n; i++) {
    c = substr(line, i, 1)
    if (!sq && c == BS) { stripped = stripped c; i++; if (i <= n) stripped = stripped substr(line, i, 1); continue }
    if (!dq && c == SQ) { sq = !sq; stripped = stripped c; continue }
    if (!sq && c == DQ) { dq = !dq; stripped = stripped c; continue }
    if (!sq && !dq && c == "#") {
      p = (i == 1) ? "" : substr(line, i-1, 1)
      if (i == 1 || p ~ /[ \t;&|()<>]/) break
    }
    stripped = stripped c
  }

  # ---- pass 2: walk the stripped line, maintaining the context stack ----
  # State (d, ctype, indtest, ...) deliberately PERSISTS across lines: a shell
  # `if` or `$( ` routinely spans lines, and resetting per line would lose the
  # boolean context of a multi-line condition.
  L = stripped; n = length(L); sq = 0; dq = 0
  for (i = 1; i <= n; i++) {
    c = substr(L, i, 1)
    nx = (i < n) ? substr(L, i+1, 1) : ""
    if (!sq && c == BS) { segbuf[d] = segbuf[d] c; stagebuf[d] = stagebuf[d] c; i++; if (i<=n) { segbuf[d]=segbuf[d] substr(L,i,1); stagebuf[d]=stagebuf[d] substr(L,i,1) } ; continue }
    if (!dq && c == SQ) { sq = !sq; segbuf[d] = segbuf[d] c; stagebuf[d] = stagebuf[d] c; continue }
    if (!sq && c == DQ) { dq = !dq; segbuf[d] = segbuf[d] c; stagebuf[d] = stagebuf[d] c; continue }
    if (sq || dq) {
      # inside quotes, only `$(` still opens a nesting level (double quotes only)
      if (dq && !sq && c == "$" && nx == "(") { push("SUBST", (indtest > 0) ? 0 : seg_is_bool(d)); i++; continue }
      segbuf[d] = segbuf[d] c; stagebuf[d] = stagebuf[d] c
      continue
    }

    if (c == "$" && nx == "(" && substr(L, i+2, 1) == "(") { ahd++; i += 2; continue }
    if (c == "$" && nx == "(") { push("SUBST", (indtest > 0) ? 0 : seg_is_bool(d)); i++; continue }
    if (c == "`") { if (ctype[d] == "SUBST_BT") { pop() } else { push("SUBST", (indtest > 0) ? 0 : seg_is_bool(d)); ctype[d] = "SUBST_BT" } ; continue }
    if (c == "[" && nx == "[") { indtest++; segbuf[d] = segbuf[d] "[["; stagebuf[d] = stagebuf[d] "[["; i++; continue }
    if (c == "]" && nx == "]") { if (indtest > 0) indtest--; segbuf[d] = segbuf[d] "]]"; stagebuf[d] = stagebuf[d] "]]"; i++; continue }
    if (c == "(") {
      # `< (` / `> (` is a PROCESS SUBSTITUTION, which is the fix for this very
      # class: the producer's status is never consulted by anybody. Its contents
      # are therefore exempt, and must be, or the guard would flag its own remedy.
      prev = (i == 1) ? "" : substr(L, i-1, 1)
      if (prev == "<" || prev == ">") { push("PROCSUB", 0); continue }
      pb = (indtest > 0) ? 0 : seg_is_bool(d); push("SUBSHELL", pb); boolpre[d] = pb; continue
    }
    if (c == ")" && nx == ")" && ahd > 0) { ahd--; i++; continue }
    if (c == ")") { if (d > 0) { pop(); reset_seg(d, 0) } ; continue }

    # `<<<` is a HERESTRING, not a heredoc. Consume all three or the third `<`
    # re-enters this branch and opens a heredoc named after the herestring's word
    # — which then swallows the rest of the file. MEASURED: that single missing
    # `i += 2` hid 20 of 69 real findings on this tree, silently.
    if (c == "<" && nx == "<" && substr(L, i+2, 1) == "<") {
      segbuf[d] = segbuf[d] "<<<"; stagebuf[d] = stagebuf[d] "<<<"; i += 2; continue
    }
    if (c == "|") {
      if (nx == "|") {          # || : consumes the LEFT status; the RIGHT inherits the LIST's context
        listbool[d] = seg_is_bool(d)
        force_bool = 1; eval_seg(d); force_bool = 0; reset_seg(d, listbool[d]); i++; continue
      }
      if (indtest > 0) { segbuf[d] = segbuf[d] c; continue }
      if (pipes[d] > 0) stages[d] = stages[d] SEP stagebuf[d]
      pipes[d]++
      stagebuf[d] = ""
      segbuf[d] = segbuf[d] c
      continue
    }
    if (c == "&") {
      if (nx == "&") { listbool[d] = seg_is_bool(d)
                       force_bool = 1; eval_seg(d); force_bool = 0; reset_seg(d, listbool[d]); i++; continue }
      if (indtest > 0) { segbuf[d] = segbuf[d] c; continue }
      eval_seg(d); reset_seg(d, 0); continue
    }
    if (c == ";") { if (indtest > 0) { segbuf[d] = segbuf[d] c; continue } ; eval_seg(d); reset_seg(d, 0); continue }
    if (c == "{" || c == "}") { eval_seg(d); reset_seg(d, 0); continue }

    segbuf[d] = segbuf[d] c; stagebuf[d] = stagebuf[d] c
  }
  # A newline terminates the current segment unless we are inside quotes or a
  # line-continuation; approximate with: terminate unless the line ends in `\`,
  # `|`, `&&`, `||`, or an unclosed quote.
  # A newline terminates the current segment unless the line is EXPLICITLY
  # continued: a trailing backslash, or a trailing `|` / `&&` / `||` that has no
  # right-hand side yet.
  #
  # `then` and `do` ARE NOT CONTINUATIONS — they TERMINATE a condition, and
  # suppressing the reset on them was the fourth false negative in this detector.
  # MEASURED: `if [[ $m == c ]]; then` on one line carried a literal " then" into
  # the next line's segbuf, so seg_is_bool() no longer saw the leading `if` and
  # THE FIRST PIPELINE-BOOLEAN INSIDE ANY then/do BLOCK WAS INVISIBLE — the most
  # common shape in the tree. Bisected on a per-instance schema audit: dark from
  # the `; then` at :117, hiding the banned pipeline at :118. Do not add them back.
  if (!sq && !dq && L !~ /(\\|\||&&|\|\|)[[:space:]]*$/) {
    eval_seg(d); reset_seg(d, 0)
  }
}

# =============================================================================
# FAIL CLOSED ON STATE LOSS — the defence the contract already promised.
# -----------------------------------------------------------------------------
# This parser carries state across lines, and three separate bugs have proved it
# can LOSE that state and go silently dark over the rest of a file (a herestring
# read as a heredoc, `$(( a << b ))` read as a heredoc, a heredoc body with an
# unbalanced `$(`). Measured by the reviewer at d9c42c81: 25 of 252 files ended the
# scan with an unclosed nesting level, up to d=34, and the ban reported GREEN.
#
# An unbalanced end-of-scan means the parse is not trustworthy for that file. Say
# so, loudly, as a finding. This is DEFENCE IN DEPTH and not the primary defence:
# the then/do bug above corrupted the answer without moving `d` at all, which is
# why the suite ALSO cross-checks every line against a stateless second opinion.
END {
  if (d > 0 || indtest > 0 || ahd > 0) {
    printf "%s\t%d\tSTATE-LOST\tdepth=%d dtest=%d arith=%d\tparser ended the file with an unclosed nesting level; its answers for this file are not trustworthy\n", FNAME, NR, d, indtest, ahd
  }
}
