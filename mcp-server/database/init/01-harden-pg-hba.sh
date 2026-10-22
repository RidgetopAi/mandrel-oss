#!/bin/sh
# =============================================================================
# 01-harden-pg-hba.sh — tighten a FRESH tenant's pg_hba loopback-TCP trust to scram.
# =============================================================================
# WHY (exposure an earlier note)
#   The postgres image ships pg_hba with `host all all 127.0.0.1/32 trust` (+ ::1/128),
#   so any process that can reach the mapped loopback port authenticates PASSWORDLESSLY
#   — a cross-tenant local-isolation gap on a shared box. This runs on FIRST init of a
#   fresh data volume (mounted into /docker-entrypoint-initdb.d/, after 00-extensions.sql)
#   and rewrites the auth METHOD to scram-sha-256 on every `host*` rule whose method is
#   `trust`. `local` (unix-socket) lines are LEFT as trust so in-container admin tooling
#   (provisioner admin upsert, reset-tenant-password script, rotation socket-exec) keeps
#   working. The app connects over the docker network WITH a password (scram) → unaffected.
#
#   This is the NEW-TENANT path. EXISTING tenants are tightened at runtime by
#   rotate-tenant-db-password script (rotate_apply_pg_hba_hardening) using the
#   IDENTICAL transform in the hosted rotation tooling — a drift
#   test (scripts/test/db-rotate.test.sh) asserts the two produce byte-identical output.
#
#   Init scripts run while postgres is up on the UNIX SOCKET (local/trust), so tightening
#   the TCP host lines here does NOT break the entrypoint's own socket connection.
#
# TEST/DRIFT MODE: `01-harden-pg-hba.sh --filter` reads pg_hba text on STDIN and writes
#   the transformed text on STDOUT (no DB, no I/O) — so the transform is unit-testable
#   and diffable against the lib. Without --filter it edits "$PGDATA/pg_hba.conf" live.
#
# CONFIG (env-overridable; matches the hosted rotation tooling defaults):
#   HARDEN_HBA_METHOD            method to replace trust with (default scram-sha-256)
#   HARDEN_HBA_KEEP_LOCAL_TRUST  1 = keep `local` trust (default 1)
set -eu

METHOD="${HARDEN_HBA_METHOD:-scram-sha-256}"
KEEP_LOCAL="${HARDEN_HBA_KEEP_LOCAL_TRUST:-1}"

# The transform — MUST stay byte-identical in behaviour to
# the hosted rotation tooling (guarded by a drift test).
_harden_filter() {
  awk -v method="$METHOD" -v keeplocal="$KEEP_LOCAL" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      type = $1
      if (type == "local") {
        if (keeplocal == "1") { print; next }
        mf = 4
      } else if (type == "host" || type == "hostssl" || type == "hostnossl") {
        mf = 5
      } else { print; next }

      if (NF >= mf && $mf == "trust") {
        $mf = method
        line = $1
        for (i = 2; i <= NF; i++) line = line " " $i
        print line
        next
      }
      print
    }
  '
}

if [ "${1:-}" = "--filter" ]; then
  _harden_filter
  exit 0
fi

HBA="${PGDATA:?PGDATA must be set}/pg_hba.conf"
[ -f "$HBA" ] || { echo "01-harden-pg-hba: $HBA not found; skipping" >&2; exit 0; }

tmp="${HBA}.harden.$$"
_harden_filter < "$HBA" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$HBA"
echo "01-harden-pg-hba: loopback-TCP trust tightened to ${METHOD} in ${HBA}"

# Reload if a server is already accepting connections (belt-and-suspenders; the
# entrypoint also restarts after init scripts, which re-reads pg_hba regardless).
if command -v psql >/dev/null 2>&1; then
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" \
    -tAqc "SELECT pg_reload_conf();" >/dev/null 2>&1 || true
fi
