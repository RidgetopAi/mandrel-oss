#!/usr/bin/env bash
# =============================================================================
# command-backend-dev-start.test.sh — does the dashboard backend's dev entry LOAD from a source checkout?
# -----------------------------------------------------------------------------
# THE DEFECT THIS EXISTS FOR (install-proof finding 14)
#   `npm run dev:command` runs mandrel-command/backend's `npm run dev` (nodemon -> ts-node).
#   EmbeddingService.ts re-exported './embedding/index.js'; ts-node resolves a literal .js
#   specifier on disk, finds only index.ts, and the backend died with
#   "Cannot find module './embedding/index.js'" before listening. Port 5000 never answered.
#   Every other test imports through ts-jest, which maps .js->.ts, so nothing noticed.
#
# HOW IT MEASURES (no database, no PostgreSQL binaries, any invoking user)
#   Starts the SAME command `dev:command` uses for the backend (`npm run dev` in
#   mandrel-command/backend) with DATABASE_PORT pointed at a closed loopback port. server.ts
#   imports every module first and only then calls initializeDatabase(). Its console output
#   ("Database connection failed", or "...established" if a database is there) therefore proves
#   the whole module graph resolved. PASS when that marker appears (or /api/health answers, if a
#   database happens to be there) with no module-resolution error in the output before it.
#   FAIL on: MODULE_NOT_FOUND / "Cannot find module" anywhere in the output, or the process we
#   started exiting before the marker. We do not rely on nodemon's "app crashed" wording; the
#   liveness check is kill -0 on the PID this test started, plus the output scan.
#   The process group is always torn down.
#
# NODE_ENV=development is set only so the backend's logger writes to the console (otherwise it
#   logs to files and the output carries no marker); LOG_DIR keeps those files in the temp dir.
#
# Tunables (env): CBDS_PORT (default 5000), CBDS_DEADLINE_SEC (default 90),
#   CBDS_DEAD_DB_PORT (default 1: a closed port), CBDS_MARKER (the database-connect log line).
# Exit: 0 passed, 1 failed, 2 could not measure (deps not installed, port taken).
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/mandrel-command/backend"
PORT="${CBDS_PORT:-5000}"
DEADLINE="${CBDS_DEADLINE_SEC:-90}"
DEAD_DB_PORT="${CBDS_DEAD_DB_PORT:-1}"
MARKER="${CBDS_MARKER:-Database connection (failed|established)}"
MODULE_ERR='Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND'

[[ -x "$BACKEND/node_modules/.bin/nodemon" || -x "$ROOT/mandrel-command/node_modules/.bin/nodemon" ]] || { echo "CANNOT MEASURE: backend deps not installed (run npm run setup)"; exit 2; }
command -v curl >/dev/null || { echo "CANNOT MEASURE: curl missing"; exit 2; }
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "CANNOT MEASURE: something already answers on port $PORT"; exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cbds.XXXXXX")"
LOG="$WORK/backend.log"
PID=""
cleanup() {
  if [[ -n "$PID" ]]; then
    kill -TERM -- "-$PID" 2>/dev/null
    sleep 1
    kill -KILL -- "-$PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# setsid as a background job of a non-interactive shell execs in place, so $! IS the session/group
# leader of everything the backend spawns; we address only that group, never the host's processes.
( cd "$BACKEND" && exec env NODE_ENV=development LOG_DIR="$WORK/logs" DATABASE_HOST=127.0.0.1 DATABASE_PORT="$DEAD_DB_PORT" \
    MANDREL_HTTP_PORT="$PORT" MANDREL_RUN_DIR="$WORK/run" setsid npm run dev >"$LOG" 2>&1 ) &
PID=$!

fail() { echo "FAIL: $1"; echo "---- backend output (tail) ----"; tail -n 30 "$LOG"; exit 1; }

end=$((SECONDS + DEADLINE))
reached=""
while (( SECONDS < end )); do
  grep -Eq "$MODULE_ERR" "$LOG" && fail "backend output contains a module-resolution error"
  if grep -Eq "$MARKER" "$LOG"; then reached="database-connect step ('$MARKER')"; break; fi
  body="$(curl -s -m 2 "http://127.0.0.1:$PORT/api/health" || true)"
  [[ "$body" == *'"status":"healthy"'* ]] && { reached="/api/health: $body"; break; }
  kill -0 "$PID" 2>/dev/null || fail "the backend process we started (pid $PID) exited before reaching the database-connect step"
  sleep 1
done
[[ -n "$reached" ]] || fail "neither the database-connect step nor /api/health reached within ${DEADLINE}s"
# Give any late module error a moment to surface (nodemon may restart/crash right after).
sleep 2
grep -Eq "$MODULE_ERR" "$LOG" && fail "backend output contains a module-resolution error"
echo "PASS: backend dev entry loaded all modules and reached the $reached"
