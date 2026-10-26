#!/usr/bin/env bash
# test-context-store-dangling-session.sh — proof harness for the P0
# contexts_session_id_fkey crash fix. Spins up a DISPOSABLE postgres DB, migrates
# it with the REAL migrate.ts, runs the dangling-session contract test against it
# via vitest, and drops everything on exit (even on failure). Never touches the
# production `mandrel` DB.
#
# Usage:  bash scripts/test-context-store-dangling-session.sh
set -uo pipefail

MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_SQL="$MCP_DIR/database/init/00-extensions.sql"
PGSUPER="sudo -u postgres"

SFX="$$_$(date +%s)"
DBNAME="th_ctxfk_${SFX}"
DBUSER="th_ctxfk_role_${SFX}"
DBPASS="throwaway_$(date +%s%N | sha1sum | cut -c1-16)"

cleanup() {
  $PGSUPER dropdb --if-exists "$DBNAME" >/dev/null 2>&1
  $PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
  echo "🧹 Dropped disposable DB $DBNAME and role $DBUSER"
}
trap cleanup EXIT

echo "🧱 Creating disposable DB: $DBNAME (role: $DBUSER)"
$PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1
# The throwaway password rides psql's STDIN, not its argv (class secret-on-child-argv):
# argv is world-readable in /proc for the life of the child. A stdin
# psql exits 0 on a SQL error unless told otherwise, hence -v ON_ERROR_STOP=1.
$PGSUPER psql -q -v ON_ERROR_STOP=1 <<<"CREATE ROLE \"$DBUSER\" LOGIN PASSWORD '$DBPASS';" >/dev/null
$PGSUPER createdb -O "$DBUSER" "$DBNAME" >/dev/null
$PGSUPER psql -d "$DBNAME" -q -f "$EXT_SQL" >/dev/null

echo "🔄 Migrating disposable DB with real migrate.ts ..."
( cd "$MCP_DIR" && \
  DATABASE_NAME="$DBNAME" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
  DATABASE_HOST="localhost" DATABASE_PORT="5432" NODE_ENV="development" \
  npx tsx scripts/migrate.ts ) >/tmp/ctxfk_migrate_${SFX}.log 2>&1
MRC=$?
if [ $MRC -ne 0 ]; then
  echo "❌ Migration failed (exit $MRC). Log tail:"
  tail -20 /tmp/ctxfk_migrate_${SFX}.log
  exit 1
fi
echo "✅ Migration complete"

echo "🧪 Running dangling-session contract test ..."
( cd "$MCP_DIR" && \
  DATABASE_NAME="$DBNAME" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
  DATABASE_HOST="localhost" DATABASE_PORT="5432" NODE_ENV="test" \
  EMBEDDING_PREFER_LOCAL="false" \
  npx vitest run src/tests/contextStoreDanglingSession.contract.test.ts )
TRC=$?

echo ""
if [ $TRC -eq 0 ]; then
  echo "✅ CONTRACT TEST PASSED"
else
  echo "❌ CONTRACT TEST FAILED (exit $TRC)"
fi
exit $TRC
