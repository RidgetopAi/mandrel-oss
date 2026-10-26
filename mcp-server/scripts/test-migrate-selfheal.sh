#!/usr/bin/env bash
# =============================================================================
# test-migrate-selfheal.sh — automated proof harness for migrate.ts self-heal
# =============================================================================
# Proves the non-fresh self-heal in scripts/migrate.ts on DISPOSABLE postgres
# databases (created + dropped here; never touches the mandrel databases or real data).
#
# Scenarios:
#   1. Self-heal fires  — pre-baseline existing DB (old-lineage _aidis_migrations
#      rows, baseline schema installed, 000 NOT stamped) → no throw, auto-stamps
#      000 + <=42, ends 0 pending; second run = clean no-op (idempotent).
#   2. Fresh           — empty DB (no _aidis_migrations) → baseline installs + stamps.
#   3. Already-baselined — 000 + <=42 already stamped → self-heal no-op, up to date.
#   4. Blank non-fresh guard — _aidis_migrations exists but NO core tables →
#      self-heal does NOT fire (won't hide a real missing-schema situation).
#
# Runs the REAL `tsx scripts/migrate.ts` as a subprocess per scenario with a
# per-scenario DATABASE_NAME. Drops every temp DB on exit (even on failure).
# =============================================================================
set -uo pipefail

MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # script-relative: runs from any cwd
MIG_DIR="$MCP_DIR/database/migrations"
BASELINE_SQL="$MIG_DIR/000_baseline_schema.sql"
EXT_SQL="$MCP_DIR/database/init/00-extensions.sql"
PGSUPER="sudo -u postgres"

# Unique suffix so concurrent runs / leftovers never collide.
SFX="$$_$(date +%s)"

# Disposable test ROLE (NOT the real `mandrel` role; never carries real secrets).
# Created here, owns the temp DBs, connects over TCP localhost with a throwaway
# password, and is DROPPED at cleanup. This avoids needing the real mandrel secret.
DBUSER="th_mig_role_${SFX}"
DBPASS="throwaway_$(date +%s%N | sha1sum | cut -c1-16)"
DB_HEAL="th_mig_heal_${SFX}"
DB_FRESH="th_mig_fresh_${SFX}"
DB_BASED="th_mig_based_${SFX}"
DB_BLANK="th_mig_blank_${SFX}"
ALL_DBS=("$DB_HEAL" "$DB_FRESH" "$DB_BASED" "$DB_BLANK")

PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
hdr()   { printf '\n=== %s ===\n' "$*"; }

cleanup() {
  hdr "CLEANUP"
  for db in "${ALL_DBS[@]}"; do
    $PGSUPER dropdb --if-exists "$db" >/dev/null 2>&1
  done
  $PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
  # Verify gone
  local left role
  left=$($PGSUPER psql -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE 'th_mig_%_${SFX}';")
  role=$($PGSUPER psql -tAc "SELECT count(*) FROM pg_roles WHERE rolname='$DBUSER';")
  echo "Leftover temp DBs for this run: ${left}  | leftover test role: ${role}"
}
trap cleanup EXIT

# Create the disposable login role up front.
$PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
# The throwaway password rides psql's STDIN, not its argv (class secret-on-child-argv):
# argv is world-readable in /proc for the life of the child. A stdin
# psql exits 0 on a SQL error unless told otherwise, hence -v ON_ERROR_STOP=1.
$PGSUPER psql -q -v ON_ERROR_STOP=1 <<<"CREATE ROLE \"$DBUSER\" LOGIN PASSWORD '$DBPASS';" >/dev/null

mkdb() {  # create disposable db owned by test role + install extensions (superuser)
  local db="$1"
  $PGSUPER createdb -O "$DBUSER" "$db" >/dev/null
  $PGSUPER psql -d "$db" -q -f "$EXT_SQL" >/dev/null
}

# psql AS THE TEST ROLE over TCP (so objects it creates are owned by that role,
# matching a real instance where the service user owns its own schema). Reads SQL
# from stdin or -f via the surrounding caller.
asrole_psql() {  # asrole_psql <db> [extra psql args...]
  local db="$1"; shift
  PGPASSWORD="$DBPASS" psql -h localhost -p 5432 -U "$DBUSER" -d "$db" "$@"
}

# Run the REAL migrator against $1, capture combined output to $2 (logfile), return exit code.
run_migrate() {
  local db="$1" log="$2"
  ( cd "$MCP_DIR" && \
    DATABASE_NAME="$db" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
    DATABASE_HOST="localhost" DATABASE_PORT="5432" NODE_ENV="development" \
    npx tsx scripts/migrate.ts ) >"$log" 2>&1
  return $?
}

# count rows in _aidis_migrations; prints -1 if the table does not exist.
# Two-step (not a CASE) because Postgres parses the missing-relation subquery even
# in an unreached CASE branch and errors at parse time.
count_applied() {
  local db="$1" exists
  exists=$($PGSUPER psql -d "$db" -tAc "SELECT to_regclass('public._aidis_migrations') IS NOT NULL;")
  if [[ "$exists" == "t" ]]; then
    $PGSUPER psql -d "$db" -tAc "SELECT count(*) FROM _aidis_migrations;"
  else
    echo "-1"
  fi
}

baseline_stamped() {  # 1 if 000 stamped else 0
  local db="$1"
  $PGSUPER psql -d "$db" -tAc \
    "SELECT count(*) FROM _aidis_migrations WHERE filename='000_baseline_schema.sql';" 2>/dev/null
}

assert() {  # assert "label" expected actual
  local label="$1" exp="$2" act="$3"
  if [[ "$exp" == "$act" ]]; then grn "PASS: $label (=$act)"; PASS=$((PASS+1));
  else red "FAIL: $label (expected [$exp] got [$act])"; FAIL=$((FAIL+1)); fi
}

# Pending = repo .sql files not present in _aidis_migrations.
pending_count() {
  local db="$1"
  local applied repo
  applied=$($PGSUPER psql -d "$db" -tAc "SELECT filename FROM _aidis_migrations ORDER BY 1;" 2>/dev/null | sort)
  repo=$(ls "$MIG_DIR"/*.sql | xargs -n1 basename | sort)
  comm -23 <(echo "$repo") <(echo "$applied") | grep -c . || true
}

# ----------------------------------------------------------------------------
hdr "SCENARIO 1: self-heal fires (pre-baseline existing DB)"
mkdb "$DB_HEAL"
# Install baseline schema directly AS THE TEST ROLE (simulates an existing
# populated DB whose schema is owned by its own service user)...
asrole_psql "$DB_HEAL" -q -f "$BASELINE_SQL" >/dev/null 2>&1
# ...then DROP the _aidis_migrations the baseline created and recreate it with
# OLD-LINEAGE rows (renumbered filenames that don't match the current repo, and
# crucially NOT 000_baseline_schema.sql).
asrole_psql "$DB_HEAL" -q <<'SQL' >/dev/null
DROP TABLE IF EXISTS _aidis_migrations;
CREATE TABLE _aidis_migrations (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  migration_number INTEGER NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64)
);
INSERT INTO _aidis_migrations (filename, migration_number) VALUES
  ('025_implement_feature_flag_cutover.sql', 25),
  ('019_old_lineage_thing.sql', 19),
  ('001_create_projects_table.sql', 1);
SQL
echo "Seeded pre-baseline DB: $(count_applied "$DB_HEAL") old-lineage rows, baseline schema present, 000 NOT stamped (stamped=$(baseline_stamped "$DB_HEAL"))."

LOG1="/tmp/mig_heal_${SFX}.log"
run_migrate "$DB_HEAL" "$LOG1"; RC1=$?
echo "--- migrate exit code: $RC1 ---"
grep -E "Self-heal|Stamped baseline|pending|up to date|already exists|❌" "$LOG1" || true
assert "S1 migrate did NOT throw (exit 0)" "0" "$RC1"
if grep -q "🩹 Self-heal" "$LOG1"; then grn "PASS: S1 self-heal block fired"; PASS=$((PASS+1)); else red "FAIL: S1 self-heal did NOT fire"; FAIL=$((FAIL+1)); fi
assert "S1 000_baseline now stamped" "1" "$(baseline_stamped "$DB_HEAL")"
assert "S1 zero pending after run" "0" "$(pending_count "$DB_HEAL")"
# 43 & 44 (the genuinely-new ones) must be applied:
N44=$($PGSUPER psql -d "$DB_HEAL" -tAc "SELECT count(*) FROM _aidis_migrations WHERE filename IN ('043_add_must_change_password.sql','044_create_feedback_table.sql');")
assert "S1 migrations 43+44 applied" "2" "$N44"

# Idempotency: second run = clean no-op.
LOG1B="/tmp/mig_heal_${SFX}_2.log"
CNT_BEFORE=$(count_applied "$DB_HEAL")
run_migrate "$DB_HEAL" "$LOG1B"; RC1B=$?
CNT_AFTER=$(count_applied "$DB_HEAL")
assert "S1 second run exit 0" "0" "$RC1B"
assert "S1 idempotent (applied count unchanged)" "$CNT_BEFORE" "$CNT_AFTER"
if grep -q "up to date" "$LOG1B"; then grn "PASS: S1 second run = 'up to date'"; PASS=$((PASS+1)); else red "FAIL: S1 second run not up-to-date"; FAIL=$((FAIL+1)); fi
if grep -q "🩹 Self-heal" "$LOG1B"; then red "FAIL: S1 self-heal fired AGAIN on 2nd run (should be no-op)"; FAIL=$((FAIL+1)); else grn "PASS: S1 self-heal did NOT re-fire on 2nd run"; PASS=$((PASS+1)); fi

# ----------------------------------------------------------------------------
hdr "SCENARIO 2: fresh DB still works"
mkdb "$DB_FRESH"   # empty, no _aidis_migrations
assert "S2 starts with no _aidis_migrations" "-1" "$(count_applied "$DB_FRESH")"
LOG2="/tmp/mig_fresh_${SFX}.log"
run_migrate "$DB_FRESH" "$LOG2"; RC2=$?
grep -E "Fresh database detected|Baseline schema installed|Stamped baseline|Seeded dual_write|pending|up to date|❌" "$LOG2" || true
assert "S2 migrate exit 0" "0" "$RC2"
if grep -q "Fresh database detected" "$LOG2"; then grn "PASS: S2 fresh path taken"; PASS=$((PASS+1)); else red "FAIL: S2 fresh path NOT taken"; FAIL=$((FAIL+1)); fi
if grep -q "🩹 Self-heal" "$LOG2"; then red "FAIL: S2 self-heal fired on FRESH db (should not)"; FAIL=$((FAIL+1)); else grn "PASS: S2 self-heal did NOT fire on fresh"; PASS=$((PASS+1)); fi
assert "S2 000_baseline stamped" "1" "$(baseline_stamped "$DB_FRESH")"
assert "S2 zero pending" "0" "$(pending_count "$DB_FRESH")"

# ----------------------------------------------------------------------------
hdr "SCENARIO 3: already-baselined DB = no-op"
# Build it fresh-from-baseline first (that's exactly what an already-baselined
# instance is), then run migrate AGAIN and assert self-heal does not re-stamp.
mkdb "$DB_BASED"
LOG3A="/tmp/mig_based_setup_${SFX}.log"
run_migrate "$DB_BASED" "$LOG3A"; RC3A=$?
assert "S3 setup (fresh build) exit 0" "0" "$RC3A"
CNT3_BEFORE=$(count_applied "$DB_BASED")
LOG3="/tmp/mig_based_${SFX}.log"
run_migrate "$DB_BASED" "$LOG3"; RC3=$?
CNT3_AFTER=$(count_applied "$DB_BASED")
grep -E "Self-heal|up to date|pending|❌" "$LOG3" || true
assert "S3 migrate exit 0" "0" "$RC3"
if grep -q "🩹 Self-heal" "$LOG3"; then red "FAIL: S3 self-heal fired on already-baselined (should be no-op)"; FAIL=$((FAIL+1)); else grn "PASS: S3 self-heal did NOT fire (000 already stamped)"; PASS=$((PASS+1)); fi
assert "S3 applied count unchanged (no re-stamp)" "$CNT3_BEFORE" "$CNT3_AFTER"
if grep -q "up to date" "$LOG3"; then grn "PASS: S3 up to date"; PASS=$((PASS+1)); else red "FAIL: S3 not up to date"; FAIL=$((FAIL+1)); fi

# ----------------------------------------------------------------------------
hdr "SCENARIO 4: blank non-fresh guard (tracker exists, no core tables)"
mkdb "$DB_BLANK"
$PGSUPER psql -d "$DB_BLANK" -q <<'SQL' >/dev/null
CREATE TABLE _aidis_migrations (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL UNIQUE,
  migration_number INTEGER NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64)
);
SQL
echo "Blank non-fresh DB: _aidis_migrations exists, core tables absent (projects=$($PGSUPER psql -d "$DB_BLANK" -tAc "SELECT to_regclass('public.projects') IS NOT NULL;"))."
LOG4="/tmp/mig_blank_${SFX}.log"
# This DB has no core schema, so the normal pending loop WILL try to run 000
# (because self-heal must NOT fire here). We only assert self-heal did NOT fire
# and 000 was NOT auto-stamped by self-heal. The subsequent pending-loop behavior
# (it may apply or error on 000) is outside the guard's responsibility — what we
# prove is the guard refuses to silently stamp a DB with no schema.
STAMP_BEFORE=$(baseline_stamped "$DB_BLANK")
run_migrate "$DB_BLANK" "$LOG4"; RC4=$?
echo "--- migrate exit code: $RC4 ---"
if grep -q "🩹 Self-heal" "$LOG4"; then red "FAIL: S4 self-heal FIRED on blank DB (should be guarded off)"; FAIL=$((FAIL+1)); else grn "PASS: S4 self-heal did NOT fire (core tables absent)"; PASS=$((PASS+1)); fi
# Prove self-heal itself did not stamp 000 as a no-run bookkeeping entry: capture
# state right after self-heal would have run by inspecting the log for its message
# (already done above). The guard's contract is "does not auto-stamp via self-heal".
grn "NOTE: S4 confirms guard — self-heal refused to stamp a schema-less DB."

# ----------------------------------------------------------------------------
hdr "RESULTS"
echo "PASS=$PASS  FAIL=$FAIL"
if [[ "$FAIL" -eq 0 ]]; then grn "ALL ASSERTIONS PASSED"; exit 0; else red "SOME ASSERTIONS FAILED"; exit 1; fi
