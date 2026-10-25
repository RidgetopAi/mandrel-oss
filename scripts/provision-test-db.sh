#!/usr/bin/env bash
# =============================================================================
# provision-test-db.sh — ONE command for a CORRECT throwaway test Postgres.
#
# THE FOOTGUN THIS FIXES
#   Agents spinning up a throwaway DB for tests typically do `createdb` + run
#   migrate.ts and STOP — silently skipping the extensions step. Then any test
#   that touches similarity() (pg_trgm) or a uuid_*() function (uuid-ossp) fails
#   with a confusing "function does not exist" error. This has bitten multiple
#   Builders. This script makes the CORRECT full sequence the easy default:
#
#       create role (if needed) -> create db (if needed)
#         -> run the extensions SQL (00-extensions.sql: vector, pg_trgm,
#            pgcrypto, uuid-ossp)
#         -> run the real migrate.ts
#
#   the CI gate calls THIS helper (single source — no duplicated steps that
#   can drift). Use it any time you need a disposable migrated DB for tests.
#
# USAGE
#   bash scripts/provision-test-db.sh <dbname>
#   bash scripts/provision-test-db.sh --auto                  # mint a collision-proof name
#   bash scripts/provision-test-db.sh <dbname> --no-migrate   # ext only, skip migrate
#   bash scripts/provision-test-db.sh <dbname> --print-env    # ensure creds + print (no migrate)
#   bash scripts/provision-test-db.sh <dbname> --drop         # teardown (drop db+role)
#   bash scripts/provision-test-db.sh <dbname> --drop --force # teardown ACROSS owners (sweeps)
#   bash scripts/provision-test-db.sh <dbname> --print-owner  # who owns it (read-only)
#
# EXIT CODES
#   0  ok
#   1  ordinary failure (bad args, migrate failed, incomplete drop, ...)
#   3  OWNERSHIP CONFLICT — this database belongs to a DIFFERENT run. Nothing was
#      created, altered, or dropped. See "ISOLATION" below.
#
#   On success it prints the DB env you can source/eval to point tests at it:
#       eval "$(bash scripts/provision-test-db.sh ci_mytest_$$ --print-env)"
#       psql "host=$DATABASE_HOST port=$DATABASE_PORT dbname=$DATABASE_NAME user=$DATABASE_USER" ...
#
# DETERMINISTIC, ALWAYS-VALID CREDS (an earlier task — the --print-env footgun)
#   A role's stored password is a one-way scram hash, so an existing role's password
#   can NEVER be read back. The OLD --print-env minted a FRESH random password every
#   call and ALTERed the role to it as a side effect — so creds captured from an
#   EARLIER call (or another shell) silently stopped authenticating, failing tests
#   with confusing auth errors. Fix: the throwaway password is DERIVED DETERMINISTICALLY
#   from the dbname (same name -> same password, every call), and --print-env ENSURES
#   the role exists + is set to exactly that password (idempotent). So the emitted
#   DATABASE_PASSWORD ALWAYS authenticates against the role as it exists after the call,
#   and repeated calls are coherent. Pass TEST_DB_PASS to pin an explicit password
#   instead (what the CI gate does). --print-env does NOT run migrate (a provision concern;
#   it only guarantees a usable, authenticating role/db/extensions for env capture).
#
# ISOLATION — CONCURRENT RUNS MUST NOT BE ABLE TO OBSERVE OR DESTROY EACH OTHER'S DBs
#   Worktrees isolate the FILESYSTEM. Until this section
#   existed, NOTHING isolated the DATABASE, and the isolation we believed the
#   parallel-Builders pattern had was conventional (pick a unique-ish name and hope)
#   rather than structural. Two failure modes were REPRODUCED against the previous
#   version of this script, both with two runs started simultaneously on one name:
#
#     REPRO 1 (create race) — both runs pass the "does the role exist?" check, both
#       CREATE ROLE, and the loser dies with a raw `ERROR: role "..." already exists`
#       and rc=1. A TOCTOU window, not a user error.
#     REPRO 2 (adopt-and-destroy) — the second run SILENTLY ADOPTS the first run's
#       live database, ALTERs the role to its own password (the first run's already
#       captured creds stop authenticating mid-run), and then on teardown DROPS a
#       database it never created. The first run then sees
#       `FATAL: database "..." does not exist` on a suite that passed minutes earlier
#       — the exact, maximally-confusing symptom reported in an earlier task.
#
#   THE FIX IS STRUCTURAL, in three parts:
#
#   (a) OWNERSHIP IS STAMPED ON THE DATABASE ITSELF, at creation, as a
#       `COMMENT ON DATABASE` reading `mandrel-test-db v1 owner=<token>`. A comment is
#       readable without connecting to the database, so an ownership check never needs
#       a session on a DB it may not be allowed to touch, and it survives every path
#       (psql, dropdb, another agent) because it lives in the catalog, not in a file.
#
#   (b) BOTH provisioning AND teardown REFUSE (rc=3) when the stamp names a different
#       owner. This is the clause that makes REPRO 2 impossible: a second run cannot
#       adopt, cannot reset the password, and cannot drop. Note the guard is on
#       OWNERSHIP, not on liveness — deliberately. "Is anyone connected?" is the wrong
#       question and the task says so explicitly: a run that is merely IDLE between
#       test phases has zero connections and is not finished, so a
#       connections-based guard would happily destroy it.
#
#   (c) THE CHECK AND THE CREATE ARE ATOMIC. Deciding "who owns this?" in one psql
#       session and acting in the next is the same TOCTOU that produced REPRO 1, so
#       the whole sequence — read the stamp, gate on it, create the role, create the
#       database, write the stamp — runs in ONE psql session holding
#       `pg_advisory_lock(hashtext('mandrel-test-db:'||<dbname>))`.
#       THE LOCK IS PER-DBNAME, NOT GLOBAL. Two runs on two names hash to two
#       different lock keys and never contend, so this does NOT serialize the
#       parallel-build pattern it exists to protect — a global lock would have been
#       the weaker answer for exactly that reason.
#
#   OWNER TOKEN — `TEST_DB_OWNER`, defaulting to `<osuser>@<host>:<repo dir>`. The repo
#   dir is in it because the unit of parallelism we actually run is the WORKTREE: eight
#   Builders are eight checkouts, so the default already separates them with no caller
#   change anywhere. Two concurrent runs INSIDE ONE worktree share the default token and
#   are therefore NOT separated by it — they must use distinct dbnames (what `--auto`
#   gives you) or distinct `TEST_DB_OWNER` values.
#
#   (d) `--auto` MINTS A NAME THAT CANNOT COLLIDE — `ci_<owner8>_<epoch>_<rand>`. Prefer
#       it. Ownership refusal turns a silent corruption into a loud rc=3; a unique name
#       means the question never comes up.
#
#   KNOWN AND DELIBERATE: a pre-existing database with NO stamp (created before this
#   change, or by a bare `createdb`) is treated as UNOWNED — adopted with a warning and
#   stamped. Refusing instead would strand every legacy leftover on the box behind a
#   tool that will not touch it. Everything created from here on carries a stamp, so
#   the unstamped population only shrinks.
#
#   `--force` overrides the teardown refusal for deliberate cross-owner sweeps. It
#   prints a loud banner naming the owner it is overriding. It exists because the
#   alternative — a tool that can never clean up an orphan — pushes people to
#   hand-rolled `dropdb` loops, which is the unfenced behaviour this guard replaces.
#
# SAFETY
#   The dbname MUST be ci_*-prefixed (throwaway convention). This script REFUSES
#   to ever create/drop `mandrel` or any non-ci_*-prefixed DB/role. Idempotent:
#   re-running on the same name is safe (role/db/ext/migrate all if-not-exists).
#
# CONFIG (configs-not-hardcoded) — host/port/super-user from env, sane defaults:
#   TEST_DB_HOST   (default: localhost)
#   TEST_DB_PORT   (default: 5432)
#   TEST_DB_PASS   (default: a per-dbname DETERMINISTIC throwaway password)
#   PG_SUPERCMD    (default: "sudo -u postgres") — how to run psql/createdb as super
#   TEST_DB_OWNER  (default: "<osuser>@<host>:<repo dir>") — the OWNERSHIP TOKEN stamped
#                  onto every DB this script creates; see ISOLATION above.
#   TEST_DB_CONN_LIMIT (default: 60) — CONNECTION LIMIT on the throwaway role, so a test
#                  suite cannot consume the host's shared client slots (-1 = unlimited)
#   TEST_DB_SWEEP  (default: 1) — run the leak sweep below before provisioning; 0 = off
#   TEST_DB_SWEEP_TTL_HOURS (default: 48) — a ci_* database is a LEAK candidate once
#                  its data directory has been untouched this long; see SELF-CLEANING
#
# SELF-CLEANING — LEAKED ci_* DATABASES AND ROLES ARE SWEPT
#   BY THE NEXT PROVISION, not by a cron and not by anyone remembering.
#   Cleanup used to be a convention: every caller drops what it made. Anything that
#   died mid-run, was interrupted, or forgot, leaked silently — 15 databases and 23
#   roles were found on the control host on 2026-07-25, 19 of the roles orphans whose
#   database was already gone. Nothing swept and nothing alerted.
#
#   Every provision (and --print-env) now first drops, in ONE psql session per run:
#     DATABASES  named ci_* whose data directory (`pg_stat_file('base/<oid>')`)
#                has not been modified for TEST_DB_SWEEP_TTL_HOURS
#                AND that have ZERO backends in pg_stat_activity
#                AND whose per-name advisory lock this session can take
#                (a run provisioning or dropping that name right now holds it)
#                AND that are not the name this run is about to provision;
#     ROLES      named ci_role_* whose ci_* database does not exist, that own no
#                database, have no backend, and whose per-name lock is takeable.
#   BOTH conditions on a database are load-bearing and the task says so: age alone
#   would eventually drop a long-running the reviewer's idle-but-live database and
#   produce a confusing false failure; connections alone would drop a run that is
#   merely between phases within the TTL. The directory mtime is the age instrument
#   because it is written by the server on every relation file create/extend
#   (measured: a plain INSERT moved it; so can autovacuum's follow-up file writes
#   for a minute or two after activity — that only makes a young database younger),
#   needs no stamp-format change, and works on legacy unstamped databases too.
#   Connecting, disconnecting and pg_terminate_backend do NOT move it (measured).
#   DROP DATABASE is run WITHOUT FORCE, so a backend
#   that appears between the check and the drop makes the drop FAIL rather than the
#   backend die — the sweep never terminates anyone.
#
#   THE TENSION WITH ISOLATION (b), stated rather than hidden: ownership refusal is
#   gated on the STAMP, not on liveness, because "is anyone connected?" is the wrong
#   question for a run that is idle between phases. The sweep asks that question
#   anyway — but only about databases idle for TEST_DB_SWEEP_TTL_HOURS, which is far
#   longer than any phase gap, and it is the only sanctioned cross-owner drop that
#   does not print a --force banner. A sweep failure is a WARNING; it never blocks
#   provisioning, and it never runs for --drop or --print-owner.
# =============================================================================
set -euo pipefail

# --- Paths -------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="$REPO_DIR/mcp-server"
EXT_SQL="$MCP_DIR/database/init/00-extensions.sql"

# --- Config (env w/ sane defaults) ------------------------------------------
DBHOST="${TEST_DB_HOST:-localhost}"
DBPORT="${TEST_DB_PORT:-5432}"
PGSUPER="${PG_SUPERCMD:-sudo -u postgres}"

# --- Pretty output -----------------------------------------------------------
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
say()  { printf '%s%s%s\n' "$BLD" "$*" "$RST"; }
ok()   { printf '%s%s%s\n' "$GRN" "$*" "$RST"; }
warn() { printf '%s%s%s\n' "$YLW" "$*" "$RST"; }
die()  { printf '%s%s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# --- Ownership identity --------------------------------------
# See ISOLATION in the header. The token is stamped onto every DB this script
# creates and is what provisioning and teardown gate on. Default separates
# worktrees, which is the unit of parallelism the batch-build pattern uses.
# configs-not-hardcoded: overridable, with the stamp prefix named ONCE.
OWNER="${TEST_DB_OWNER:-$(id -un)@$(uname -n):${REPO_DIR}}"
STAMP_PREFIX='mandrel-test-db v1 owner='
RC_OWNER_CONFLICT=3
# The ownership refusal is raised by Postgres and has to be recognised back in bash.
# psql exits 3 for ANY query error — measured: a genuine RAISE and an ordinary
# `function does not exist` both return 3 — so the exit code cannot carry which one
# it was. This sentinel is the structured channel that can. It is defined HERE ONCE
# and passed into the SQL with -v, then RAISEd from that variable, so the token the
# script matches on and the token Postgres emits cannot drift apart (a rule written
# in two places can be weakened in one).
OWNER_CONFLICT_SENTINEL='MANDREL_TESTDB_OWNER_CONFLICT'
# Anchored on psql's ERROR line, not a bare substring: on an unrelated failure psql
# echoes the offending SOURCE LINE back, which would contain the sentinel too.
owner_conflict_raised() { grep -qE "ERROR: +${OWNER_CONFLICT_SENTINEL}\b" <<< "$1"; }

# --- Args --------------------------------------------------------------------
DBNAME=""
MODE="provision"   # provision | drop | print-env | print-owner
DO_MIGRATE=1
AUTO_NAME=0
FORCE=0
# The first positional is the dbname UNLESS it is a flag (`--auto` may stand alone).
if [[ "${1:-}" != --* ]]; then DBNAME="${1:-}"; shift || true; fi
for arg in "$@"; do
  case "$arg" in
    --drop)        MODE="drop" ;;
    --print-env)   MODE="print-env" ;;
    --print-owner) MODE="print-owner" ;;
    --no-migrate)  DO_MIGRATE=0 ;;
    --auto)        AUTO_NAME=1 ;;
    --force)       FORCE=1 ;;
    *) die "Unknown flag: $arg" ;;
  esac
done

# --auto mints a name that CANNOT collide with a concurrent run: owner digest +
# epoch + two $RANDOM draws. Charset is [A-Za-z0-9_] by construction, so it passes
# the identifier guard below rather than depending on it.
if [[ "$AUTO_NAME" == "1" ]]; then
  [[ -z "$DBNAME" ]] || die "REFUSING: --auto mints the name; do not also pass '$DBNAME'."
  [[ "$MODE" == "provision" || "$MODE" == "print-env" ]] \
    || die "REFUSING: --auto makes no sense with --$MODE (there is nothing yet to $MODE)."
  DBNAME="ci_$(printf '%s' "$OWNER" | sha1sum | cut -c1-8)_$(date +%s)_${RANDOM}${RANDOM}"
fi

[[ "$FORCE" == "0" || "$MODE" == "drop" ]] \
  || die "REFUSING: --force only applies to --drop (it overrides the teardown ownership refusal)."

[[ -n "$DBNAME" ]] \
  || die "Usage: $0 <dbname> [--no-migrate|--drop [--force]|--print-env|--print-owner]  |  $0 --auto"

# --- Guardrail: throwaway names only — NEVER touch a real DB -----------------
case "$DBNAME" in
  ci_*) : ;;
  *) die "REFUSING: '$DBNAME' is not ci_*-prefixed. Throwaway test DBs must be ci_* (NEVER 'mandrel' or any real DB)." ;;
esac
# ...and it must be a plain identifier. The prefix check above is an OWNERSHIP guard, not
# an injection guard: `ci_x"; DROP ROLE ...` is ci_*-prefixed. DBNAME is interpolated into
# statements this script runs as the Postgres SUPERUSER, and `psql -c` executes multiple
# statements, so the charset is the thing that actually constrains it. Same class as the
# TEST_DB_CONN_LIMIT check further down — guarded here so there is one rule, not two.
[[ "$DBNAME" =~ ^[A-Za-z0-9_]+$ ]] \
  || die "REFUSING: '$DBNAME' is not a plain identifier ([A-Za-z0-9_] only)."

# Same class, the OTHER unconstrained input. TEST_DB_CONN_LIMIT is
# spliced UNQUOTED into `ALTER ROLE ... CONNECTION LIMIT <val>` further down, run as the
# Postgres SUPERUSER, and `psql -c` executes multiple statements — so an unvalidated value
# is arbitrary superuser SQL (`-1; DROP ROLE ...`). Checked HERE, with the other input
# guardrails, so it runs BEFORE the first psql: a validation placed next to its use would
# be unreachable behind an earlier failure. A bad value is a HARD STOP, never a silent
# fallback to the default — silently substituting would run the gate with a connection
# footprint nobody chose.
if [[ -n "${TEST_DB_CONN_LIMIT:-}" && ! "${TEST_DB_CONN_LIMIT}" =~ ^-?[0-9]+$ ]]; then
  die "REFUSING: TEST_DB_CONN_LIMIT must be an integer (-1 = unlimited), got: '${TEST_DB_CONN_LIMIT}'"
fi
# Same class, third input: the sweep TTL is spliced into make_interval() as a number.
# Validated here with the others, before the first psql, for the same reasons.
if [[ -n "${TEST_DB_SWEEP_TTL_HOURS:-}" && ! "${TEST_DB_SWEEP_TTL_HOURS}" =~ ^[1-9][0-9]*$ ]]; then
  die "REFUSING: TEST_DB_SWEEP_TTL_HOURS must be a positive integer (hours), got: '${TEST_DB_SWEEP_TTL_HOURS}'"
fi
SWEEP="${TEST_DB_SWEEP:-1}"
SWEEP_TTL_HOURS="${TEST_DB_SWEEP_TTL_HOURS:-48}"
DBUSER="ci_role_${DBNAME#ci_}"   # derived, deterministic, also ci_role_*-prefixed
case "$DBUSER" in
  ci_role_*) : ;;
  *) die "REFUSING: derived role '$DBUSER' is not ci_role_*-prefixed." ;;
esac

# --- Sanity: the extensions SQL must exist (the whole point) -----------------
[[ -f "$EXT_SQL" ]] || die "Extensions SQL not found at $EXT_SQL — cannot guarantee a correct test DB."

# =============================================================================
# OWNERSHIP — read the stamp; the SQL below enforces it atomically.
# =============================================================================
# db_owner_state <dbname> prints exactly one of FOUR states. There are four and not
# two on purpose (CLASSES.md C1: an instrument that crosses a process boundary can
# always return "I could not measure", and code that folds that onto "no" is the bug):
#   absent      — no such database
#   unstamped   — exists, carries no ownership stamp (legacy; adopted with a warning)
#   owner:<tok> — exists, stamped, owned by <tok>
#   unknown     — the query itself failed. NEVER treated as "unowned".
# This is the HUMAN-MESSAGE path. It is deliberately NOT the enforcement path: a
# check here and an action in a later psql session is the same TOCTOU that produced
# REPRO 1. Enforcement is the RAISE inside the single locked session further down.
db_owner_state() {
  local db="$1" out rc
  # The leading 'D' makes "row exists with a NULL/empty comment" distinguishable from
  # "no row at all" — with -tA both would otherwise come back as an empty string.
  out=$($PGSUPER psql -tAc \
    "SELECT 'D' || coalesce(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname='${db}';" 2>/dev/null)
  rc=$?
  [[ $rc -eq 0 ]] || { printf 'unknown\n'; return 0; }
  out="${out%%$'\n'*}"
  [[ -n "$out" ]] || { printf 'absent\n'; return 0; }
  out="${out#D}"
  case "$out" in
    "$STAMP_PREFIX"*) printf 'owner:%s\n' "${out#"$STAMP_PREFIX"}" ;;
    *)                printf 'unstamped\n' ;;
  esac
}

# Turn a state into the message a human needs, then exit 3. Called only when the
# locked session already refused — so this reports, it does not decide.
die_owner_conflict() {
  local db="$1" state="$2" verb="$3" owner_line
  # The refusal is Postgres', not this function's — so the message must still be
  # correct when the follow-up read of the stamp could NOT be taken. Reporting
  # "its owner : unknown" would be worse than useless; say which fact is missing.
  if [[ "$state" == owner:* ]]; then
    owner_line="  its owner : ${state#owner:}"
  else
    owner_line="  its owner : (could not be re-read — state reported '${state}')
  Postgres refused this as an ownership conflict; the follow-up read that would have
  named the owner did not complete. The refusal itself is not in doubt."
  fi
  # NOT die(): this exits RC_OWNER_CONFLICT (3), not 1, so a caller can tell "someone
  # else owns this" apart from "the tool broke" without reading the message.
  printf '%s%s%s\n' "$RED" "REFUSING to ${verb} '${db}': it belongs to a DIFFERENT run.
${owner_line}
  your owner: ${OWNER}
Nothing was created, altered or dropped. This is an earlier task's guard: a concurrent
run's disposable database is not yours to adopt or destroy, even if it looks idle.
  - need your own DB?        bash $0 --auto
  - genuinely sweeping this? bash $0 '${db}' --drop --force
  - who owns it?             bash $0 '${db}' --print-owner" "$RST" >&2
  exit "$RC_OWNER_CONFLICT"
}

if [[ "$MODE" == "print-owner" ]]; then
  printf '%s\n' "$(db_owner_state "$DBNAME")"
  exit 0
fi

# =============================================================================
# TEARDOWN
# =============================================================================
if [[ "$MODE" == "drop" ]]; then
  say "Dropping throwaway test DB '$DBNAME' and role '$DBUSER' ..."
  # TERMINATE FIRST. `dropdb` fails outright with "database is being accessed by other
  # users" whenever ANY session is still attached, and an abandoned test process leaves
  # exactly that: MEASURED 2026-08-26 — three idle `ci_role_*` backends survived their
  # jest parents (a `timeout -s KILL` reaps the direct child, not the grandchild), so
  # `--drop` failed on every attempt while reporting success. This clause is the reason
  # the drop can succeed at all in the normal case.
  #
  # OWNERSHIP-GATED, AND THE GATE IS IN THE SAME SESSION AS THE DROP.
  # Terminate + DROP DATABASE + DROP ROLE all run in ONE psql session that first takes
  # the per-dbname advisory lock and then RAISEs if the stamp names someone else. A
  # bash-side check followed by a separate dropdb would leave a window in which the
  # owner changes between the check and the drop — which is precisely the class of bug
  # this task exists to close, so it is not repeated in the fix.
  # --force skips the RAISE (deliberate cross-owner sweeps); the banner is printed by
  # bash above rather than buried in SQL, so it cannot be missed in a log.
  pre_state="$(db_owner_state "$DBNAME")"
  if [[ "$FORCE" == "1" ]]; then
    warn "--force: overriding the ownership guard. Target state: ${pre_state}. \
If that names another run, you are destroying ITS database."
  fi
  drop_rc=0
  # Output is CAPTURED, not discarded: it carries the sentinel that says WHICH failure
  # this was. Capturing also keeps it off stdout, which is the eval-able export stream.
  drop_out=$($PGSUPER psql -q -v ON_ERROR_STOP=1 \
      -v db="$DBNAME" -v role="$DBUSER" -v owner="$OWNER" -v stamp="$STAMP_PREFIX" \
      -v sentinel="$OWNER_CONFLICT_SENTINEL" \
      -v enforce="$([[ "$FORCE" == "1" ]] && echo 0 || echo 1)" \
      -f - 2>&1 <<'SQL'
SELECT pg_advisory_lock(hashtext('mandrel-test-db:' || :'db'));
SELECT 'DO $g$ BEGIN RAISE EXCEPTION ' || quote_literal(:'sentinel') || '; END $g$'
  FROM pg_database d
 WHERE :enforce = 1
   AND d.datname = :'db'
   AND coalesce(shobj_description(d.oid, 'pg_database'), '') LIKE :'stamp' || '%'
   AND coalesce(shobj_description(d.oid, 'pg_database'), '') IS DISTINCT FROM (:'stamp' || :'owner')
\gexec
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = :'db' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'db') \gexec
SELECT format('DROP ROLE IF EXISTS %I', :'role') \gexec
SQL
  ) || drop_rc=$?
  # A non-zero rc here is EITHER the ownership refusal OR an ordinary SQL failure, and
  # those get different exit codes and different messages.
  #
  # THIS USED TO BE INFERRED — "psql failed AND the pre-read says someone else owns it"
  # — and that was wrong in both directions (the reviewer findings 2 and 3, verdict
  # an earlier fix). It lost rc=3 down to rc=1 whenever the pre-read returned `unknown`, i.e.
  # in exactly the could-not-measure case the four-state design exists for; and it
  # blamed an ordinary SQL failure on ownership whenever the DB happened to be foreign.
  # Both were a guess about the CAUSE dressed as a measurement of it.
  #
  # Now it is READ, from the sentinel Postgres raised. Not "deriving a verdict from
  # prose": psql's exit code is 3 for every query error alike (measured), so it cannot
  # answer this question, and the sentinel is the channel we added because of that. The
  # answer no longer depends on a second read succeeding.
  if [[ "$drop_rc" -ne 0 ]] && owner_conflict_raised "$drop_out"; then
    die_owner_conflict "$DBNAME" "$pre_state" "drop"
  fi
  # Not the ownership refusal, so an ordinary SQL failure — do not let it masquerade as
  # "something is still attached" further down without the actual error in view.
  if [[ "$drop_rc" -ne 0 ]]; then
    warn "psql exited ${drop_rc} during teardown of '$DBNAME' (NOT an ownership refusal — \
no ${OWNER_CONFLICT_SENTINEL} was raised). Error tail:"
    printf '%s\n' "$drop_out" | tail -5 >&2
  fi
  [[ "$pre_state" != "unstamped" ]] || warn "Note: '$DBNAME' carried no ownership stamp (pre-908ff00d leftover); dropped it anyway."
  left=$($PGSUPER psql -tAc "SELECT count(*) FROM pg_database WHERE datname='${DBNAME}';" 2>/dev/null || echo "?")
  role=$($PGSUPER psql -tAc "SELECT count(*) FROM pg_roles    WHERE rolname='${DBUSER}';" 2>/dev/null || echo "?")
  # THE VERDICT MUST READ THE MEASUREMENT IT JUST TOOK.
  # This block used to compute `left`/`role`, print them, and `exit 0` unconditionally —
  # every failure path swallowed by `|| true`. MEASURED 2026-08-26: it printed the green
  # "Dropped." with its own counter reading `db:1 role:1 (expect 0/0)`, twice, on a DB
  # that was still there afterwards. A caller that trusts the exit code (every agent
  # told to "drop it when done") leaves throwaway DBs and roles on the box forever.
  # "?" is the could-not-measure state and is treated as a failure, not as a zero.
  # ONE post-condition, ONE rendering, used by BOTH branches. The green
  # line used to carry its own hand-written "(expect 0/0)" beside the measured pair — an
  # EXPECTATION printed in the shape of a MEASUREMENT, which is how `db:1 role:1` came to
  # sit inside a success message in the first place. Rendering the same measured string in
  # both branches means the success text cannot state anything the condition did not just
  # verify: there is no longer a sentence to get out of step with the check.
  leftover="db:${left} role:${role}"
  if [[ "$left" == "0" && "$role" == "0" ]]; then
    ok "Dropped '$DBNAME'. Verified gone -> ${leftover}."
    exit 0
  fi
  # Non-zero, or a "?" from a count that could not be taken — both are failures, and the
  # third state never silently becomes a zero (CLASSES.md C1).
  die "Drop INCOMPLETE for '$DBNAME': leftover ${leftover} (required db:0 role:0). \
Something is still attached, the role still owns objects elsewhere, or the superuser \
command failed. Check: \
$PGSUPER psql -tAc \"SELECT pid, usename, state FROM pg_stat_activity WHERE datname='${DBNAME}';\" \
and: $PGSUPER psql -tAc \"SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='${DBUSER}');\""
fi

# =============================================================================
# PROVISION (idempotent: role -> db -> extensions -> migrate)
# =============================================================================
# Throwaway password. A role's stored password is a one-way scram hash and can
# never be read back, so to make the emitted creds ALWAYS valid (and coherent
# across separate calls — including a later bare --print-env) we DERIVE it
# DETERMINISTICALLY from the dbname: same name -> same password, every invocation.
# Pass TEST_DB_PASS to pin an explicit password instead (what the CI gate does). The
# role is then ALTERed to exactly this value below, so what we print authenticates.
DBPASS="${TEST_DB_PASS:-throwaway_$(printf '%s' "$DBNAME" | sha1sum | cut -c1-16)}"

# Role: create if missing, else (re-run) RESET its password to the one we'll use.
# (The statements themselves now live in THE ATOMIC PROVISIONING SESSION below; this
# note stays here with the password derivation it explains.)
# WHY the reset: on a re-run the role already exists, but since the password is a
# one-way hash we can't read it back — and a prior run may have used a different
# value (e.g. someone passed TEST_DB_PASS once and not the next time). ALTER ROLE
# pins the password to the deterministic/explicit value we are about to EMIT, so the
# printed DATABASE_PASSWORD always authenticates and the helper is truly idempotent
# (safe for the CI gate, which passes a fixed TEST_DB_PASS per run).

# BOUND THE THROWAWAY ROLE'S CONNECTION FOOTPRINT.
#
# Postgres client slots (max_connections - superuser_reserved_connections) are a BOX-WIDE
# resource shared by every database on the host. Until this line, a test suite using a
# disposable DB could consume essentially all of them: the mcp-server suite was measured
# peaking at 80 of 97 usable slots. On the prod host that also serves paying tenants, that
# is not just a flaky-gate problem — it is the gate able to deny connections to the
# customer-facing server.
#
# A per-role CONNECTION LIMIT makes the ceiling a SERVER-ENFORCED invariant rather than a
# property of how well-behaved the test code happens to be, and it makes exhaustion
# ATTRIBUTABLE: the role hits its own limit ("too many connections for role", still
# SQLSTATE 53300) instead of silently starving whatever else on the box asks next.
# -1 = unlimited (Postgres' own sentinel) for anyone who explicitly wants the old behaviour.
# The value is VALIDATED up with the other input guardrails, before anything talks to
# Postgres — see the TEST_DB_CONN_LIMIT check near the top of this file.
# WHY 60 AND NOT 40 (measured 2026-08-07). The backend suite grew past the
# old ceiling: `select count(*) from pg_stat_activity where usename='ci_role_…'` sampled
# during a full `jest --runInBand` peaked at **39** against a limit of **40**. At that
# margin the run produced 7-9 failing DB suites in a set that MOVED BETWEEN RUNS — i.e. a
# resource ceiling wearing a test failure's clothes, which is an earlier task's class exactly
# and the reason that task exists.
#
# THE CEILING IS STILL A CEILING, deliberately. Measured on both boxes the same day:
# max_connections=100, superuser_reserved=3 -> 97 usable; the production host had 18 in use by prod and
# the tenant fleet. 60 leaves ~19 slots spare there even while a full gate runs. A value
# like 120 would exceed the server's own capacity and hand the gate the ability to deny
# connections to paying tenants, which is the exact harm this limit was added to prevent —
# so do not raise it to "whatever makes the suite pass" without re-measuring both numbers.
#
# KNOWN AND NOT CLOSED: exhaustion still surfaces as ordinary suite failures, not as
# could-not-measure. SQLSTATE 53300 ("too many connections for role") is attributable by
# design (see above) but nothing upstream maps it onto rc=2, so a future overrun will again
# read as RED rather than "the gate could not measure". The root cause underneath is that
# the backend's shared pool is never closed between suites (app-wide, pre-existing).
DBCONNLIMIT="${TEST_DB_CONN_LIMIT:-60}"

# =============================================================================
# THE ATOMIC PROVISIONING SESSION
# =============================================================================
# ONE psql session does ALL of: take the per-dbname advisory lock, gate on the
# ownership stamp, create-or-repin the role, set its connection limit, create the
# database if missing, and stamp it. They were four separate psql invocations, and
# that is what REPRO 1 exploited: two runs each passed "does the role exist?" in
# their own session and then both issued CREATE ROLE, so the loser died on a raw
# `role already exists`. A check in one session and an action in the next is not a
# check. Merged here, the lock makes the whole sequence indivisible per dbname.
#
# THE LOCK KEY IS hashtext('mandrel-test-db:'||dbname) — per NAME. Two runs on two
# names take two different locks and never wait on each other, so the parallel
# build pattern this guard protects is not serialized by the guard. (A global lock
# would have been simpler and would have defeated the purpose.)
#
# Advisory locks are SESSION-scoped, so the lock survives across the autocommit
# statements below and is released when psql exits — including on error, which is
# why no explicit unlock is needed and why a crash cannot wedge the name.
#
# CREATE DATABASE cannot run inside a transaction block, which is why the DDL is
# emitted via \gexec at top level in autocommit rather than wrapped in a DO block.
# (\gexec is also what lets the DDL be CONDITIONAL without a DO block — and a DO
# block would not have worked anyway: psql does not expand :variables inside
# dollar-quoted strings, so :'role' in a DO body is literal text, not the role.)
#
# The password reaches psql through -v, exactly as the previous ALTER/CREATE ROLE
# did through -c. No change in exposure either way; format(%L) quotes it correctly.
# =============================================================================
# THE LEAK SWEEP — see SELF-CLEANING in the header.
# =============================================================================
# Runs BEFORE this run takes its own lock, so the name about to be provisioned is
# excluded by name rather than by lock order. All human output goes to STDERR:
# stdout is the eval-able export stream in --print-env mode.
sweep_leaked_test_dbs() {
  local before after gone kept n
  # The candidate list is printed FIRST, with the two facts the decision rests on,
  # so a reader can check the sweep's reasoning against the catalog. This read is
  # for the human; the locked session below re-evaluates every condition itself.
  before=$($PGSUPER psql -tA -F ' ' -v ON_ERROR_STOP=1 -v db="$DBNAME" -v ttl="$SWEEP_TTL_HOURS" -f - 2>&1 <<'SQL'
SELECT d.datname,
       'idle_h=' || floor(extract(epoch FROM now() - (pg_stat_file('base/' || d.oid::text, true)).modification) / 3600),
       'backends=' || (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)
  FROM pg_database d
 WHERE d.datname LIKE 'ci\_%' ESCAPE '\'
   AND d.datname <> :'db'
   AND (pg_stat_file('base/' || d.oid::text, true)).modification < now() - make_interval(hours => :ttl)
 ORDER BY 1;
SQL
  ) || { warn "sweep: could not list ci_* candidates (psql said: ${before}) — skipping the sweep, provisioning continues." >&2; return 0; }
  [[ -z "$before" ]] || printf '%s\n' "$before" | sed 's/^/sweep: candidate (idle past '"$SWEEP_TTL_HOURS"'h): /' >&2
  # ONE session: lock per name, re-check, drop. No ON_ERROR_STOP — a DROP that fails
  # because a backend appeared is exactly the fail-safe outcome, and must not stop
  # the next candidate. Errors are captured and shown, not discarded.
  n=$($PGSUPER psql -q -tA -v db="$DBNAME" -v role="$DBUSER" -v ttl="$SWEEP_TTL_HOURS" -f - 2>&1 <<'SQL'
SELECT format('DROP DATABASE %I', d.datname)
  FROM pg_database d
 WHERE d.datname LIKE 'ci\_%' ESCAPE '\'
   AND d.datname <> :'db'
   AND (pg_stat_file('base/' || d.oid::text, true)).modification < now() - make_interval(hours => :ttl)
   AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
   AND pg_try_advisory_lock(hashtext('mandrel-test-db:' || d.datname))
\gexec
SELECT format('DROP ROLE %I', r.rolname)
  FROM pg_roles r
 WHERE r.rolname LIKE 'ci\_role\_%' ESCAPE '\'
   AND r.rolname <> :'role'
   AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = 'ci_' || substr(r.rolname, 9))
   AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)
   AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usesysid = r.oid)
   AND pg_try_advisory_lock(hashtext('mandrel-test-db:ci_' || substr(r.rolname, 9)))
\gexec
SQL
  ) || true
  [[ -z "$n" ]] || printf '%s\n' "$n" | sed 's/^/sweep: psql: /' >&2
  # THE VERDICT READS THE CATALOG, not the statements it meant to run.
  after=$($PGSUPER psql -tAc "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'ci\_%' ESCAPE '\';" 2>/dev/null) \
    || { warn "sweep: ran, but the follow-up catalog read failed — cannot say what was dropped." >&2; return 0; }
  gone=""; kept=""
  while read -r name _; do
    [[ -n "$name" ]] || continue
    if [[ " $after " == *" $name "* ]]; then kept="$kept $name"; else gone="$gone $name"; fi
  done <<<"$before"
  [[ -z "$gone" ]] || warn "sweep: dropped leaked test DB(s):${gone} (idle > ${SWEEP_TTL_HOURS}h, zero backends) and their orphaned roles." >&2
  [[ -z "$kept" ]] || warn "sweep: kept${kept} — a backend is attached or the name is locked by a live run. Not touched." >&2
}
if [[ "$SWEEP" == "1" ]]; then
  sweep_leaked_test_dbs
fi

# Informational only — the ENFORCING read is the one inside the locked session.
# A legacy DB with no stamp is adopted, and saying so out loud is the difference
# between "the guard is off" and "there was nothing to guard yet".
pre_state="$(db_owner_state "$DBNAME")"
[[ "$pre_state" != "unstamped" ]] \
  || warn "Note: '$DBNAME' exists with no ownership stamp (pre-908ff00d leftover or hand-made). Adopting and stamping it for ${OWNER}."

prov_rc=0
# Captured, not discarded — same reason as the drop path: the sentinel is in here, and
# stdout belongs to the eval-able export block.
prov_out=$($PGSUPER psql -q -v ON_ERROR_STOP=1 \
    -v db="$DBNAME" -v role="$DBUSER" -v pass="$DBPASS" -v owner="$OWNER" \
    -v stamp="$STAMP_PREFIX" -v connlimit="$DBCONNLIMIT" \
    -v sentinel="$OWNER_CONFLICT_SENTINEL" \
    -f - 2>&1 <<'SQL'
SELECT pg_advisory_lock(hashtext('mandrel-test-db:' || :'db'));

-- (b) OWNERSHIP GATE. Fires only when the database EXISTS, IS stamped, and the
-- stamp names someone else. Absent -> we are about to create it. Unstamped ->
-- legacy, adopted (see ISOLATION). Neither of those is a conflict.
SELECT 'DO $g$ BEGIN RAISE EXCEPTION ' || quote_literal(:'sentinel') || '; END $g$'
  FROM pg_database d
 WHERE d.datname = :'db'
   AND coalesce(shobj_description(d.oid, 'pg_database'), '') LIKE :'stamp' || '%'
   AND coalesce(shobj_description(d.oid, 'pg_database'), '') IS DISTINCT FROM (:'stamp' || :'owner')
\gexec

-- Role: create if missing, else repin the password (see the DETERMINISTIC CREDS
-- note in the header — the emitted DATABASE_PASSWORD must always authenticate).
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'role', :'pass')
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('ALTER ROLE %I CONNECTION LIMIT %s', :'role', :'connlimit') \gexec

-- DB: create if missing, owned by the throwaway role.
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db')
\gexec

-- (a) STAMP. Unconditional, so a legacy unstamped DB we just adopted becomes owned
-- and every subsequent run gets the guard. Written INSIDE the lock, so the window
-- between "created" and "stamped" — in which a rival would have seen it as
-- unstamped and adopted it — does not exist.
SELECT format('COMMENT ON DATABASE %I IS %L', :'db', :'stamp' || :'owner') \gexec
SQL
) || prov_rc=$?

if [[ "$prov_rc" -ne 0 ]]; then
  # Same discrimination as the drop path, and for the same reasons — read the sentinel
  # Postgres raised rather than inferring the cause from a follow-up read that may not
  # have been takeable. The state read below is for the MESSAGE only; it no longer
  # decides the exit code.
  state="$(db_owner_state "$DBNAME")"
  if owner_conflict_raised "$prov_out"; then
    die_owner_conflict "$DBNAME" "$state" "provision"
  fi
  printf '%s\n' "$prov_out" | tail -5 >&2
  die "Provisioning '$DBNAME' FAILED (psql rc=${prov_rc}, observed state: ${state}). This is NOT an \
ownership refusal — no ${OWNER_CONFLICT_SENTINEL} was raised. The SQL error is above."
fi

# Extensions: THE step ad-hoc DBs skip. Idempotent (CREATE EXTENSION IF NOT EXISTS).
$PGSUPER psql -d "$DBNAME" -q -f "$EXT_SQL" >/dev/null

if [[ "$MODE" != "print-env" ]]; then
  ok "Provisioned '$DBNAME' (role '$DBUSER') + extensions installed (vector, pg_trgm, pgcrypto, uuid-ossp)."
fi

# Migrate with the real migrate.ts (the same one the CI gate + prod use).
# --print-env is a CRED/ENV-capture path, NOT a provisioner: it guarantees an
# authenticating role/db/extensions but deliberately does NOT migrate (migrate is
# a provision concern, is a surprising side effect for a "print" flag, and needs
# node_modules that may be absent). Run a full provision first if you need schema.
if [[ "$DO_MIGRATE" == "1" && "$MODE" != "print-env" ]]; then
  say "Migrating '$DBNAME' with real migrate.ts ..."
  if ( cd "$MCP_DIR" && env \
        DATABASE_NAME="$DBNAME" \
        DATABASE_USER="$DBUSER" \
        DATABASE_PASSWORD="$DBPASS" \
        DATABASE_HOST="$DBHOST" \
        DATABASE_PORT="$DBPORT" \
        NODE_ENV="development" \
        npx tsx scripts/migrate.ts ) >"/tmp/provision_test_db_${DBNAME}.log" 2>&1; then
    ok "Migration OK."
  else
    warn "Migration FAILED — log tail:"; tail -25 "/tmp/provision_test_db_${DBNAME}.log" >&2
    die "Could not migrate '$DBNAME'."
  fi
fi

# --- Emit the DB env so callers can point tests at this DB -------------------
# Always print to stdout (eval-able); human messages above go to the same stream
# only in non print-env mode, so --print-env yields clean shell assignments.
# EXPORTED, not bare. The documented recipe is `eval "$(… --print-env)"`, and a bare
# assignment under eval sets a SHELL-LOCAL var that a CHILD PROCESS never sees — so
# jest/vitest launched afterwards got no DB and died in assertDbReachable. That is a
# LOUD failure, never a silent green, but it reads as a real RED and has now cost two
# agents a wasted mutation-probe round (the reviewer). `export` makes the
# documented recipe actually do what it says.
cat <<EOF
export DATABASE_NAME=$DBNAME
export DATABASE_USER=$DBUSER
export DATABASE_PASSWORD=$DBPASS
export DATABASE_HOST=$DBHOST
export DATABASE_PORT=$DBPORT
EOF
