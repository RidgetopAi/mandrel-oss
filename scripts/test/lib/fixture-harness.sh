#!/usr/bin/env bash
# =============================================================================
# fixture-harness.sh — the SHARED fixture harness for scripts/test/*
# -----------------------------------------------------------------------------
# NOT A TEST. Sourced by suites under scripts/test/. Answers the two questions
# that produced it (an earlier task and an earlier change), which are the same
# question one layer apart:
#
#   (A) CAN THIS FIXTURE REACH A REAL DANGEROUS BINARY?
#       fh_init shadows every binary in FH_DANGEROUS_BINARIES at the FRONT of
#       PATH. A shadowed call is LOGGED and REFUSED. A suite must opt IN
#       (fh_allow / fh_allow_loopback / fh_allow_prefix) to reach a real one,
#       and then asserts fh_assert_no_forbidden_calls. Opt-in, never opt-out —
#       the incident was a suite that reached `docker compose -p <prod project>
#       ... up -d` because nobody had remembered to opt OUT.
#
#   (B) DID THE COPIED SUBJECT ACTUALLY LOAD?
#       fh_copy_subject mirrors the subject's whole sibling directory into the
#       copy dir, so the copy's `${SELF_DIR}/lib/...` sources cannot resolve to
#       a directory that does not exist. fh_run_subject then runs it and DECIDES
#       from bash's own diagnostic whether every source resolved. Under `set -uo
#       pipefail` WITHOUT `-e` a failed `.` does not abort, so a probe of a
#       partially-loaded subject reports PASS while measuring a strictly
#       smaller program than the one that ships.
#
# NEITHER HALF PARSES SHELL, DELIBERATELY. The shadow decides from calls that
# were MADE; the load check decides from bash's OWN report of what it could not
# open. A hand-rolled `source`-line recogniser was written first and deleted:
# measured on one real script it returned 20 directives of which
# 4 were real, the other 16 being prose and python heredoc assignments. A regex
# is a claim about a grammar you do not own.
#
# FAIL CLOSED. A subject that did not execute at all is FH_RC_CANNOT_MEASURE
# (2), never a pass — a mutant that cannot run masquerading as a passing control
# is this same bug in the control direction.
#
# HONEST SCOPE. The shadow governs binaries resolved through PATH by NAME. It
# does NOT govern an absolute path (`/usr/bin/docker`), a shell builtin, a
# library call from node/python, or a binary not named in FH_DANGEROUS_BINARIES.
# fh_assert_no_forbidden_calls is a statement about the calls that were MADE on
# the paths that RAN, not a proof that no such path exists.
# =============================================================================

# shellcheck disable=SC2034  # config values are consumed by the generated shim
FH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/test/lib/fixture-harness.config.sh
. "$FH_LIB_DIR/fixture-harness.config.sh"

fh_die() { printf 'CANNOT MEASURE (fixture-harness): %s\n' "$*" >&2; exit "$FH_RC_CANNOT_MEASURE"; }

# ---------------------------------------------------------------------------
# (A) THE SHADOW
# ---------------------------------------------------------------------------

# fh_init [dir] — install the shadow. Prepends the shim dir to PATH and EXPORTS
# it, so a subject invoked with `env -i PATH="$PATH"` inherits the shadow too.
fh_init() {
  FH_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/fh.XXXXXX")}" || fh_die "mktemp failed"
  mkdir -p "$FH_DIR/bin" "$FH_DIR/policy" "$FH_DIR/real" || fh_die "cannot create $FH_DIR"
  : > "$FH_DIR/forbidden.log"; : > "$FH_DIR/allowed.log"; : > "$FH_DIR/unavailable.log"

  # THE SHADOW IS FAITHFUL TO THE HOST: a binary that is NOT on this box is not
  # shimmed. There is nothing to reach, and shimming it would make `command -v
  # docker` succeed — flipping every capability probe in the tree. Measured: a
  # compose-render suite selects its INTERPRETER vs PARSER mode on exactly that check, so an unfaithful shadow silently changes what the
  # suite tests. FH_UNSHADOWED records the absent ones so "no docker call was
  # logged" can never be read as "docker was blocked" on a box with no docker.
  local b p
  FH_UNSHADOWED=()
  FH_SHADOWED=()
  for b in "${FH_DANGEROUS_BINARIES[@]}"; do
    # Resolve the REAL binary BEFORE the shim is on PATH, so an opt-in can exec it.
    p="$(command -v "$b" 2>/dev/null || true)"
    if [[ -n "$p" ]]; then
      printf '%s\n' "$p" > "$FH_DIR/real/$b"
      FH_SHADOWED+=("$b")
    else
      FH_UNSHADOWED+=("$b")
    fi
  done

  # THE SHIM'S STATE PATH, DENY CODE AND HOST LIST ARE BAKED IN AS LITERALS, not
  # read from the environment. Real suites invoke their subjects as
  # `env -i PATH="$PATH" …`, and a
  # shim that needed FH_DIR from the environment would die WITHOUT LOGGING under
  # that scrub — a shadow that fails open on the very invocation form it exists
  # to police.
  { printf '#!/usr/bin/env bash\n'
    printf '# One shadow. Which binary it stands for is $0'"'"'s basename.\n'
    printf 'bin="${0##*/}"\n'
    printf 'd=%q\n' "$FH_DIR"
    printf 'FH_DENY_RC=%q\n' "$FH_DENY_RC"
    printf 'FH_MAX_LOGGED_ARG_CHARS=%q\n' "$FH_MAX_LOGGED_ARG_CHARS"
    printf 'FH_LOOPBACK_HOSTS_STR=%q\n' "${FH_LOOPBACK_HOSTS[*]}"
    cat
  } > "$FH_DIR/bin/.fh-shim" <<'SHIM'
args="$(printf '%s ' "$@" | tr '\n\t' '  ')"
# REDACT THE ONE CREDENTIAL FORM WE ACTUALLY PASS, and do not claim more than that.
# This log is printed to stderr on a failure and lands in CI output; the suites that
# opt curl in pass `-H "Authorization: Bearer <token>"`. Fixture tokens today, and
# there is no version of "a real one leaked into a gate log" that is acceptable
#.
#
# ⚠️ SCOPE, MEASURED (Reviewer) — this covers `<keyword><SPACE><value>`
# and NOTHING ELSE. These leak VERBATIM and were checked, not assumed:
#     ?token=<value>            (no whitespace)
#     -H "X-Api-Key: <value>"   (the colon breaks the match)
#     a DSN carrying its password inline, before the @ (a URI credential — not
#       written out here, because the repo's own gitleaks rule
#       `mandrel-credential-in-uri` correctly refuses that shape even as a comment,
#       and teaching a scanner to ignore a real shape is worse than the example)
# So: this is not a general credential scrubber, and a suite that opts in `psql`,
# or any tool taking a secret in a URL or a colon-delimited header, WILL put that
# secret in CI output. Do not read the line above as protection you have not got.
# Widening the regex is the wrong instinct — a scrubber you trust and that misses
# a form is worse than one you know the shape of. Keep the secret out of the argv.
args="$(printf '%s' "$args" | sed -E 's/([Bb]earer|[Tt]oken|[Aa]pikey|[Aa]pi-[Kk]ey)[[:space:]]+[^[:space:]]+/\1 <redacted>/g')"
args="${args:0:$FH_MAX_LOGGED_ARG_CHARS}"
pol="$d/policy/$bin"
real="$(cat "$d/real/$bin" 2>/dev/null || true)"

fh_shim_deny() {
  printf '%s\t%s\t%s\n' "$bin" "$1" "$args" >> "$d/forbidden.log"
  exit "$FH_DENY_RC"
}
fh_shim_allow() {
  printf '%s\t%s\n' "$bin" "$args" >> "$d/allowed.log"
  if [[ -z "$real" || ! -x "$real" ]]; then
    # OPTED IN BUT THE BINARY IS NOT ON THIS BOX. That is a CANNOT-MEASURE, not a
    # safety violation, so it gets its own log and never turns an adopting suite
    # RED for running on a host that simply has no docker.
    printf '%s\t%s\n' "$bin" "$args" >> "$d/unavailable.log"
    exit "$FH_DENY_RC"
  fi
  exec "$real" "$@"
}

[[ -f "$pol" ]] || fh_shim_deny "shadowed-by-default (no opt-in)"

# READ THE POLICY ON FD 3, NOT STDIN. `exec "$real" "$@"` inherits whatever the
# shim is reading from, and a `while … done < "$pol"` hands the POLICY FILE to
# the real binary as its stdin. Measured: it broke 11 assertions in
# a probe suite whose subject uses `curl --data @-` and `curl -K -` —
# both of which read stdin, and both of which silently got the rule list.
# NEVER rules first, and they beat every allow rule. A suite that opts in to a
# read-only verb of a powerful binary must not be one argv away from a mutating
# one, and stating the forbidden set explicitly is cheaper than trusting an
# allow pattern to be airtight.
while IFS= read -r rule <&3; do
  case "$rule" in
    NEVER:*)
      want="${rule#NEVER:}"
      grep -qE "$want" <<<"$*" && fh_shim_deny "matched a NEVER rule: $want"
      ;;
  esac
done 3< "$pol"

while IFS= read -r rule <&3; do
  [[ -n "$rule" ]] || continue
  case "$rule" in
    ALL) fh_shim_allow "$@" ;;
    LOOPBACK)
      offender=""
      for a in "$@"; do
        case "$a" in
          *://*)
            hostport="${a#*://}"; hostport="${hostport%%/*}"
            hostport="${hostport##*@}"
            host="${hostport%%:*}"
            case "$hostport" in \[*) host="${hostport#\[}"; host="${host%%\]*}" ;; esac
            ok=0
            for h in $FH_LOOPBACK_HOSTS_STR; do [[ "$host" == "$h" ]] && ok=1; done
            [[ $ok -eq 1 ]] || offender="$host"
            ;;
        esac
      done
      [[ -z "$offender" ]] && fh_shim_allow "$@"
      fh_shim_deny "non-loopback-target:$offender"
      ;;
    PREFIX:*)
      want="${rule#PREFIX:}"
      got="$*"
      [[ "$got" == "$want" || "$got" == "$want "* ]] && fh_shim_allow "$@"
      ;;
    MATCH:*)
      want="${rule#MATCH:}"
      grep -qE "$want" <<<"$*" && fh_shim_allow "$@"
      ;;
    NEVER:*) ;;   # evaluated in the pre-pass above; it can only ever deny
  esac
done 3< "$pol"

fh_shim_deny "no-matching-opt-in-rule"
SHIM
  chmod +x "$FH_DIR/bin/.fh-shim"
  for b in ${FH_SHADOWED[@]+"${FH_SHADOWED[@]}"}; do
    ln -sf ".fh-shim" "$FH_DIR/bin/$b"
  done

  export FH_DIR
  PATH="$FH_DIR/bin:$PATH"
  export PATH
}

fh_require_init() { [[ -n "${FH_DIR:-}" && -d "${FH_DIR:-/nonexistent}" ]] || fh_die "fh_init was never called"; }

# fh_allow <bin>                — let a shadowed binary through unmodified (logged).
# fh_allow_loopback <bin>       — let it through ONLY while every URL argument
#                                 targets a host in FH_LOOPBACK_HOSTS. A request
#                                 that would LEAVE THE BOX is refused and logged.
# fh_allow_prefix <bin> <words> — let it through only for one exact argv prefix
#                                 (e.g. `docker compose version`).
fh_allow()          { fh_require_init; printf 'ALL\n'          >> "$FH_DIR/policy/$1"; }
fh_allow_loopback() { fh_require_init; printf 'LOOPBACK\n'     >> "$FH_DIR/policy/$1"; }
fh_allow_prefix()   { fh_require_init; local b="$1"; shift; printf 'PREFIX:%s\n' "$*" >> "$FH_DIR/policy/$b"; }
# fh_allow_matching <bin> <extended-regex> — opt in for any argv MATCHING the
# regex. Use when the permitted verb is not at a fixed argv position, e.g.
# `docker compose -f <file> --project-name x config --format json`, where the
# read-only verb `config` sits behind flags that vary per call.
fh_allow_matching() { fh_require_init; printf 'MATCH:%s\n' "$2" >> "$FH_DIR/policy/$1"; }
# fh_deny_matching <bin> <extended-regex> — argv matching this is REFUSED no
# matter what any allow rule says. Evaluated first, in its own pass.
fh_deny_matching()  { fh_require_init; printf 'NEVER:%s\n' "$2" >> "$FH_DIR/policy/$1"; }

# fh_shadow_report — one line naming what IS and IS NOT shadowed on this host.
# Print it in an adopting suite so a vacuous assertion is visible as vacuous.
fh_shadow_report() {
  fh_require_init
  printf 'shadowed: %s | not on this host (nothing to shadow): %s\n' \
    "${FH_SHADOWED[*]-none}" "${FH_UNSHADOWED[*]-none}"
}

# fh_expect_refused <extended-regex> <reason> — DECLARE that calls matching
# <regex> are expected to be attempted and MUST be refused. They stop counting
# as violations in fh_assert_no_forbidden_calls and are reported as
# "expected + refused" instead. The reason is MANDATORY and non-empty.
#
# This is the co-located exception with a written reason, not a central
# allow-list. It exists because one real suite
# drives real consumer scripts under a deliberately
# ALL-CLOBBERING config, so the consumers genuinely do call `rclone delete
# CONFIG_CLOBBERED` and `systemctl is-active`. Before the shadow those ran for
# real. The property that suite wants is not "no call was attempted" but "every
# attempt was REFUSED", and that is a different assertion.
fh_expect_refused() {
  fh_require_init
  local re="$1" why="${2:-}"
  [[ -n "$re" ]]  || fh_die "fh_expect_refused: empty pattern"
  [[ -n "${why//[[:space:]]/}" ]] || fh_die "fh_expect_refused: a reason is mandatory (pattern: $re)"
  printf '%s\n' "$re" >> "$FH_DIR/expect-refused"
  printf '%s\t%s\n' "$re" "$why" >> "$FH_DIR/expect-refused.why"
}

fh_forbidden_calls() { fh_require_init; cat "$FH_DIR/forbidden.log"; }
fh_allowed_calls()   { fh_require_init; cat "$FH_DIR/allowed.log"; }
# Opted-in calls whose real binary is absent on THIS host. Reported, never fatal.
fh_unavailable_calls() { fh_require_init; cat "$FH_DIR/unavailable.log"; }
fh_reset_calls()     { fh_require_init; : > "$FH_DIR/forbidden.log"; : > "$FH_DIR/allowed.log"; : > "$FH_DIR/unavailable.log"; }

# fh_assert_no_forbidden_calls — 0 when the forbidden log is EMPTY, else 1 with
# every offending call printed. THE POINT OF THE WHOLE HARNESS: a suite that
# happens not to reach docker is not protected; a suite that asserts its log is
# empty is. Callers wire the return into their own pass/fail.
fh_assert_no_forbidden_calls() {
  fh_require_init
  [[ -s "$FH_DIR/forbidden.log" ]] || return 0
  local undeclared expected re
  undeclared="$(cat "$FH_DIR/forbidden.log")"
  expected=""
  if [[ -s "$FH_DIR/expect-refused" ]]; then
    while IFS= read -r re; do
      [[ -n "$re" ]] || continue
      expected+="$(printf '%s\n' "$undeclared" | grep -E "$re" || true)"$'\n'
      undeclared="$(printf '%s\n' "$undeclared" | grep -vE "$re" || true)"
    done < "$FH_DIR/expect-refused"
  fi
  if [[ -n "${expected//[[:space:]]/}" ]]; then
    printf 'DECLARED + REFUSED (expected; the shadow stopped them):\n' >&2
    printf '%s' "$expected" | grep -v '^$' | sed 's/^/    /' >&2
  fi
  [[ -n "${undeclared//[[:space:]]/}" ]] || return 0
  printf 'UNDECLARED FORBIDDEN BINARY CALL(S) REACHED THE SHADOW:\n' >&2
  printf '%s' "$undeclared" | grep -v '^$' | sed 's/^/    /' >&2
  return 1
}

# fh_assert_shim_control — THE CONTROL ON THE INSTRUMENT, for adopting suites.
# An empty forbidden log means nothing unless the shim could have recorded. This
# proves at least one shadowed binary lands in the shadow when invoked, so
# "no shadowed binary was reached" is a MEASUREMENT and not a broken log.
# rc 0 = at least one shim demonstrably records
# rc 1 = binaries are shadowed but NONE records — every empty-log assertion in
#        this suite is vacuous, and that is a RED, not a pass
# rc 2 = nothing is shadowed on this host at all (CANNOT MEASURE, not a pass)
fh_assert_shim_control() {
  fh_require_init
  local b
  [[ "${#FH_SHADOWED[@]}" -gt 0 ]] || {
    printf 'CANNOT MEASURE: no binary in FH_DANGEROUS_BINARIES is present on this host\n' >&2
    return "$FH_RC_CANNOT_MEASURE"
  }
  for b in "${FH_SHADOWED[@]}"; do
    if fh_shim_is_live "$b"; then
      printf 'shim control: %s lands in the shadow when invoked\n' "$b"
      return 0
    fi
  done
  printf 'THE SHADOW IS DEAD: %s shadowed binaries and not one records a call.\n' "${#FH_SHADOWED[@]}" >&2
  printf 'Every empty-call-log assertion in this suite is vacuous.\n' >&2
  return 1
}

# fh_assert_allowed_calls_match <bin> <extended-regex> — every ALLOWED call to
# <bin> must match <regex>. This is the "does the fixture name a LIVE identifier?"
# question from a fixture should name fixtures. Opting in to a
# binary is not the end of the argument — assert WHAT you reached it with.
# An empty allowed log passes: nothing was reached, so nothing named anything.
fh_assert_allowed_calls_match() {
  fh_require_init
  local bin="$1" re="$2" bad rc=0
  bad="$(awk -F'\t' -v b="$bin" '$1 == b { print $2 }' "$FH_DIR/allowed.log" | grep -vE "$re" || true)"
  if [[ -n "$bad" ]]; then
    printf 'ALLOWED %s CALL(S) DO NOT MATCH THE FIXTURE PATTERN /%s/:\n' "$bin" "$re" >&2
    printf '%s\n' "$bad" | sed 's/^/    /' >&2
    rc=1
  fi
  return $rc
}

# fh_shim_is_live <bin> — CONTROL ON THE INSTRUMENT. An empty forbidden log
# proves nothing unless the shim can record. Returns 0 only if invoking <bin>
# through PATH actually lands in the shadow. Does not disturb the real logs.
fh_shim_is_live() {
  fh_require_init
  local b="$1" saved_f saved_a rc
  saved_f="$(cat "$FH_DIR/forbidden.log")"; saved_a="$(cat "$FH_DIR/allowed.log")"
  : > "$FH_DIR/forbidden.log"; : > "$FH_DIR/allowed.log"
  "$b" --fh-liveness-probe >/dev/null 2>&1
  rc=1
  # ONLY the two logs this function CLEARED above. unavailable.log was deliberately
  # dropped (Reviewer): it is never cleared here, so a single stale line
  # in it made a completely DEAD shadow report itself live — the control that exists
  # to catch a false green quietly becoming one.
  grep -q . "$FH_DIR/forbidden.log" "$FH_DIR/allowed.log" 2>/dev/null && rc=0
  printf '%s' "$saved_f" > "$FH_DIR/forbidden.log"
  printf '%s' "$saved_a" > "$FH_DIR/allowed.log"
  [[ -n "$saved_f" ]] && printf '\n' >> "$FH_DIR/forbidden.log"
  [[ -n "$saved_a" ]] && printf '\n' >> "$FH_DIR/allowed.log"
  return $rc
}

# ---------------------------------------------------------------------------
# (B) THE COPIED SUBJECT
# ---------------------------------------------------------------------------

# fh_mirror_siblings <subject> <destdir> — put the subject's whole sibling
# environment inside <destdir> so a copy of <subject> placed there cannot run
# partially loaded. Idempotent: safe to call once per temp dir, or before every
# copy. Prints nothing on success.
#
# IT COPIES, IT DOES NOT SYMLINK, AND THAT DISTINCTION IS LOAD-BEARING. The first
# version symlinked each sibling to the REAL directory, which made every write by
# the copied subject land in the SOURCE TREE. Measured by Reviewer: a subject
# doing `echo mutated > "$(dirname "$0")/lib/a.sh"` changed the original file.
# Isolation is the entire reason a subject is copied into a temp dir, and a
# symlink silently repeals it for writes — worst of all for THIS population,
# which is mutation probes that copy a subject and then mutate it. A disclosure
# comment was the cheaper option and was rejected: the trap fires on whoever
# reads the comment least carefully, and it costs 4.3M of `cp` to remove it
# outright (`du -sh --apparent-size scripts/` -> 4.3M).
#
# IT MIRRORS EVERYTHING RATHER THAN ENUMERATING THE SUBJECT'S SOURCES, also
# deliberately: enumerating means owning a claim about bash's grammar. Measured
# on one real script, a command-position regex returned 20
# "directives" of which 4 were real — the rest prose and PYTHON heredoc
# assignments (`source = "code default"`). Same reasoning as
# fixture_install_gate_libs, which copies wholesale for the same reason.
fh_mirror_siblings() {
  local subject="$1" destdir="$2" origdir base
  [[ -r "$subject" ]] || fh_die "subject not readable: $subject"
  origdir="$(cd "$(dirname "$subject")" && pwd)"
  mkdir -p "$destdir" || fh_die "cannot create $destdir"
  destdir="$(cd "$destdir" && pwd)"
  base="$(basename "$subject")"
  # A destdir inside the subject's own directory would make `cp -a` recurse into
  # its own output. Refuse rather than produce a mirror of unknown depth.
  case "$destdir/" in
    "$origdir"/*) fh_die "destdir is inside the subject's own directory: $destdir" ;;
  esac
  [[ -e "$destdir/.fh-mirrored" ]] && return 0
  cp -a "$origdir/." "$destdir/" || fh_die "cannot mirror $origdir into $destdir"
  rm -f "$destdir/$base"
  : > "$destdir/.fh-mirrored"
}

# fh_copy_subject <subject> <destdir> — mirror the siblings, then place a fresh
# copy of the subject in <destdir>. Prints the copy's path.
#
# HONEST SCOPE: this covers sources under the subject's OWN directory — the
# `${SELF_DIR}/lib/...` shape that produced the incident. A
# source that escapes upward (`../../other/x.sh`) is NOT mirrored. That case is
# caught at runtime by fh_run_subject, not here.
fh_copy_subject() {
  local subject="$1" destdir="$2" copy
  fh_mirror_siblings "$subject" "$destdir"
  copy="$destdir/$(basename "$subject")"
  cp "$subject" "$copy" || fh_die "cannot copy $subject"
  chmod +x "$copy" 2>/dev/null || true
  printf '%s\n' "$copy"
}

# fh_run_subject <copy> [args...] — run a copied subject and DECIDE, from
# evidence, whether it actually LOADED. Writes the subject's stdout+stderr to
# $FH_RUN_OUT and sets $FH_RUN_RC. Returns:
#   0  the subject ran and every source it attempted resolved
#   1  the subject ran but bash reported an UNRESOLVED source — the file and the
#      path are printed on stderr, and left in $FH_RUN_UNRESOLVED
#   2  CANNOT MEASURE — the subject did not execute at all
#
# THE DETECTOR IS BASH'S OWN DIAGNOSTIC, not our recogniser. Under `set -uo
# pipefail` WITHOUT `-e` a failed `.` does not abort, so the run continues and
# reports PASS while exercising a strictly smaller program than the one that
# ships. Bash still says so on stderr; nothing was reading it.
#
# HONEST SCOPE: a source whose own stderr the subject discards (`. x 2>/dev/null`)
# is invisible here, and so is a source on a branch this run did not take. This
# is a statement about the run, not a proof about the file.
fh_run_subject() {
  local copy="$1"; shift
  [[ -x "$copy" || -r "$copy" ]] || { printf 'CANNOT MEASURE: subject not runnable: %s\n' "$copy" >&2; return "$FH_RC_CANNOT_MEASURE"; }
  FH_RUN_OUT="$(mktemp "${TMPDIR:-/tmp}/fh-run.XXXXXX")" || fh_die "mktemp failed"
  bash "$copy" "$@" > "$FH_RUN_OUT" 2>&1
  FH_RUN_RC=$?
  # EXECUTION WITNESS. A subject that could not run at all must never read as a
  # clean load — that is the control-direction form of this very bug (a mutant
  # that cannot run masquerading as a passing control).
  if [[ "$FH_RUN_RC" -eq 126 || "$FH_RUN_RC" -eq 127 ]] && [[ ! -s "$FH_RUN_OUT" ]]; then
    printf 'CANNOT MEASURE: subject never executed (rc=%s, no output): %s\n' "$FH_RUN_RC" "$copy" >&2
    return "$FH_RC_CANNOT_MEASURE"
  fi
  FH_RUN_UNRESOLVED="$(grep -E ': (line [0-9]+: )?.*: No such file or directory' "$FH_RUN_OUT" || true)"
  if [[ -n "$FH_RUN_UNRESOLVED" ]]; then
    printf 'UNRESOLVED SOURCE in copied subject %s:\n' "$copy" >&2
    printf '%s\n' "$FH_RUN_UNRESOLVED" | sed 's/^/    /' >&2
    return 1
  fi
  return 0
}

# fh_assert_loaded <file-or-text> — THE ONE-LINE ADOPTION of the check
# for a suite that already captures its subject's combined output. rc 1, naming
# the file and the unresolved path, if bash reported it could not open something
# a `source`/`.` asked for. Under `set -uo pipefail` WITHOUT `-e` that failure
# does not abort, so the subject runs on as a strictly smaller program and the
# suite reports PASS. This reads the diagnostic nobody was reading.
#
# HONEST SCOPE: it can only see what the caller CAPTURED. A subject whose stderr
# was discarded, or a source on a branch this run did not take, is invisible.
fh_assert_loaded() {
  local subject="$1" text hits
  if [[ -f "$subject" ]]; then text="$(cat "$subject")"; else text="$subject"; fi
  hits="$(printf '%s\n' "$text" | grep -E ': line [0-9]+: [^:]*: No such file or directory' || true)"
  [[ -n "$hits" ]] || return 0
  printf 'SUBJECT RAN PARTIALLY LOADED — bash could not open a sourced file:\n' >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
  return 1
}
