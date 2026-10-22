#!/usr/bin/env bash
# test-session-counters.sh — proof harness for an earlier task (session counter columns are
# destroyed by finish()). Spins up a DISPOSABLE postgres DB, migrates it with the REAL
# migrate.ts, runs the counters contract test against it via vitest, and drops everything on
# exit (even on failure). Never touches the production `mandrel` DB.
#
# Usage:  bash scripts/test-session-counters.sh
#
# The env below is load-bearing, not decoration:
#   MANDREL_SESSION_RESOLVER_MODE=actor   — the CLOSER self-gates on this and returns 0
#                                           (inert) in legacy/shadow mode, so without it
#                                           TEST 2 would "pass" against a sweep that never
#                                           ran. The test asserts this value directly.
#   MANDREL_SESSION_ABSOLUTE_CAP_SEC=1    — makes an aged session eligible for the closer
#                                           immediately instead of after 7 days.
#   MANDREL_SESSION_FLUSH_SEC=3600        — the periodic flush must NOT fire on its own
#                                           during the test; the probe drives the flush
#                                           EXPLICITLY, because the flush-before-end
#                                           ordering is the bug under test.
set -uo pipefail

MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$MCP_DIR/database/migrations"
EXT_SQL="$MCP_DIR/database/init/00-extensions.sql"
PGSUPER="sudo -u postgres"

SFX="$$_$(date +%s)"
DBNAME="th_counters_${SFX}"
DBUSER="th_counters_role_${SFX}"
DBPASS="throwaway_$(date +%s%N | sha1sum | cut -c1-16)"

cleanup() {
  $PGSUPER dropdb --if-exists "$DBNAME" >/dev/null 2>&1
  $PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
  echo "🧹 Dropped disposable DB $DBNAME and role $DBUSER"
}
trap cleanup EXIT

echo "🧱 Creating disposable DB: $DBNAME (role: $DBUSER)"
$PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
# The throwaway password rides psql's STDIN, not its argv (class secret-on-child-argv,
# an earlier task): argv is world-readable in /proc for the life of the child. A stdin
# psql exits 0 on a SQL error unless told otherwise, hence -v ON_ERROR_STOP=1.
$PGSUPER psql -q -v ON_ERROR_STOP=1 <<<"CREATE ROLE \"$DBUSER\" LOGIN PASSWORD '$DBPASS';" >/dev/null
$PGSUPER createdb -O "$DBUSER" "$DBNAME" >/dev/null
$PGSUPER psql -d "$DBNAME" -q -f "$EXT_SQL" >/dev/null

echo "🔄 Migrating disposable DB with real migrate.ts (includes 069/070/071) ..."
( cd "$MCP_DIR" && \
  DATABASE_NAME="$DBNAME" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
  DATABASE_HOST="localhost" DATABASE_PORT="5432" NODE_ENV="development" \
  npx tsx scripts/migrate.ts ) >/tmp/counters_migrate_${SFX}.log 2>&1
MRC=$?
if [ $MRC -ne 0 ]; then
  echo "❌ Migration failed (exit $MRC). Log tail:"
  tail -30 /tmp/counters_migrate_${SFX}.log
  exit 1
fi
echo "✅ Migration complete"

echo "🧪 Running session-counters contract test ..."
( cd "$MCP_DIR" && \
  DATABASE_NAME="$DBNAME" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
  DATABASE_HOST="localhost" DATABASE_PORT="5432" NODE_ENV="test" \
  EMBEDDING_PREFER_LOCAL="false" \
  MANDREL_SESSION_RESOLVER_MODE="actor" \
  MANDREL_SESSION_ABSOLUTE_CAP_SEC="1" \
  MANDREL_SESSION_FLUSH_SEC="3600" \
  npx vitest run src/tests/sessionCountersSurviveFinalize.contract.test.ts )
TRC=$?

echo ""
if [ $TRC -eq 0 ]; then
  echo "✅ CONTRACT TEST PASSED"
else
  echo "❌ CONTRACT TEST FAILED (exit $TRC)"
fi
exit $TRC
