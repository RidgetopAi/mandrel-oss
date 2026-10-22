#!/usr/bin/env bash
# =============================================================================
# schema-contract.sh — the schema-contract REFERENCE GENERATOR, and a standalone
#                      verifier (anti-drift)
# =============================================================================
# WHO ACTUALLY RUNS WHAT — read this before assuming. The name
# says "the CI gate" and that is NOT what CI runs. Nothing invokes this file
# during a gate:
#   * `regenerate` is THIS FILE'S REASON TO EXIST. It is the ONLY producer of
#     scripts/schema-reference.sql.txt — the committed artifact both gates diff
#     against — and it is the remedy named by the CI gate, by
#     .github/workflows/ci.yml, by a per-instance schema audit, by the reference
#     file's own header, and by ~20 migration headers. Deleting this script would
#     leave no way to update the contract it defines.
#   * `verify` is a standalone convenience you can run by hand. THE GATE IS
#     ELSEWHERE: the CI gate STAGE 0c performs the same comparison inline, and
#     .github/workflows/ci.yml has its own step. Deliberately, not by accident —
#     the CI gate reuses the disposable DB it already provisioned and migrated in Stage
#     0b, where this script provisions and migrates a second one from scratch.
#   * CAUTION: the fingerprint pipeline below and the CI gate STAGE 0c are
#     two copies of one rule that agree today. If you change the extraction here,
#     the reference you generate stops matching what the gate computes, and the
#     gate goes RED for a reason that has nothing to do with the migrations.
#     Change both together.
#
# Proves the committed migrations DETERMINISTICALLY reproduce the expected
# schema. Spins a throwaway Postgres DB, runs the REAL migrate.ts against it,
# extracts a canonical version-agnostic schema fingerprint, and compares it to
# the committed reference (scripts/schema-reference.sql.txt).
#
#   * verify    (default) — FAIL if the freshly-migrated schema differs from the
#                           committed reference; print the diff. Standalone: the
#                           gate CI runs is the CI gate STAGE 0c, not this.
#   * regenerate          — overwrite the committed reference from a fresh migrate
#                           (use this when a migration LEGITIMATELY changes schema).
#
# This catches the class of bug where committed migrations no longer reproduce
# the real/expected schema (e.g. golden-image drift: sessions 31 cols in-app vs
# 42 in prod; phantom user_sessions references) — at the gate, not in prod.
#
# Disposable infra: ONE throwaway DB + role per run, ci_*-prefixed, dropped on
# EXIT (always). NEVER touches the real `mandrel` DB or any tenant DB.
#
# Usage:
#   bash scripts/schema-contract.sh            # verify by hand
#   bash scripts/schema-contract.sh verify
#   bash scripts/schema-contract.sh regenerate # update the committed reference
#
# EXIT CODES (an earlier task — a gate must be able to tell a defect from a box
# fact; Lesson class C2). This is a CONTRACT: a caller maps 2 to could-not-
# measure and NEVER to RED.
#   0  IN SYNC          the fresh migrate reproduces the committed reference.
#   1  DRIFT             a real diff exists between reference and fresh migrate
#                        — printed. This, and only this, is a schema defect.
#   2  COULD NOT MEASURE a prerequisite is missing/refused (sudo, psql, createdb
#                        absent or refusing; the migration itself failed; the
#                        committed reference is missing) — named on stderr. NO
#                        diff is printed, because none was computed.
# =============================================================================
set -euo pipefail

MODE="${1:-verify}"

# --- Paths -------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$REPO_DIR/mcp-server"
EXT_SQL="$MCP_DIR/database/init/00-extensions.sql"
FINGERPRINT_SQL="$SCRIPT_DIR/schema-fingerprint.sql"
REFERENCE_FILE="$SCRIPT_DIR/schema-reference.sql.txt"
PGSUPER="sudo -u postgres"

# --- Disposable DB identity (unique per run; mirrors the CI gate) ------------------
SFX="$$_$(date +%s)"
DBNAME="ci_schema_${SFX}"
DBUSER="ci_role_schema_${SFX}"
DBPASS="throwaway_$(date +%s%N | sha1sum | cut -c1-16)"
DBHOST="${CI_DB_HOST:-localhost}"
DBPORT="${CI_DB_PORT:-5432}"

# --- Pretty output -----------------------------------------------------------
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
hdr() { printf '\n%s========== %s ==========%s\n' "$BLD" "$*" "$RST"; }

# cnm <message> — THE ONE EXIT for "I could not measure" (exit 2). Never used
# for a schema diff: a diff means the measurement SUCCEEDED and found drift,
# which is exit 1, printed by the verify branch below, not this function.
cnm() {
  echo "${RED}COULD-NOT-MEASURE: $*${RST}" >&2
  exit 2
}

# --- Cleanup (always; even on failure) --------------------------------------
cleanup() {
  $PGSUPER dropdb --if-exists "$DBNAME" >/dev/null 2>&1 || true
  $PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- Guardrail: refuse to ever operate on a real DB --------------------------
case "$DBNAME" in
  ci_*) : ;;
  *) cnm "disposable DB name '$DBNAME' is not ci_*-prefixed" ;;
esac

[[ -f "$FINGERPRINT_SQL" ]] || cnm "missing $FINGERPRINT_SQL"

# --- Preflight: the prerequisites this script cannot measure without --------
# Named individually (not just "postgres is unhappy") so a gate's could-not-
# measure message says exactly what a box is missing.
for _prereq in sudo psql createdb; do
  command -v "$_prereq" >/dev/null 2>&1 || cnm "prerequisite '$_prereq' not found on PATH"
done
unset _prereq
PREFLIGHT_ERR="/tmp/schema_contract_preflight_${SFX}.txt"
if ! $PGSUPER psql -q -c 'SELECT 1;' >/dev/null 2>"$PREFLIGHT_ERR"; then
  echo "${RED}Cannot run '$PGSUPER psql' — sudo/postgres access refused. Detail:${RST}" >&2
  cat "$PREFLIGHT_ERR" >&2
  cnm "sudo/postgres access refused (see detail above)"
fi
rm -f "$PREFLIGHT_ERR"

# --- Build a fresh, fully-migrated disposable DB -----------------------------
hdr "schema-contract: provision + migrate disposable DB ($MODE)"
echo "DB=$DBNAME  ROLE=$DBUSER  HOST=$DBHOST:$DBPORT"
$PGSUPER psql -q -c "DROP ROLE IF EXISTS \"$DBUSER\";" >/dev/null 2>&1 || true
PROV_ERR="/tmp/schema_contract_provision_${SFX}.txt"
# password via stdin, never on psql's argv (ps-visible). ON_ERROR_STOP is what makes the
# stdin form fail closed: without it psql exits 0 on a SQL error and `set -e` cannot see it
# (the reviewer F3 — measured: -c error exit 1, stdin error exit 0, stdin+flag exit 3).
if $PGSUPER psql -q -v ON_ERROR_STOP=1 >/dev/null 2>"$PROV_ERR" <<SQL
CREATE ROLE "$DBUSER" LOGIN PASSWORD '$DBPASS';
SQL
then
  [[ -s "$PROV_ERR" ]] && cat "$PROV_ERR" >&2
else
  cat "$PROV_ERR" >&2
  cnm "could not create disposable role '$DBUSER'"
fi
if $PGSUPER createdb -O "$DBUSER" "$DBNAME" >/dev/null 2>"$PROV_ERR"; then
  [[ -s "$PROV_ERR" ]] && cat "$PROV_ERR" >&2
else
  cat "$PROV_ERR" >&2
  cnm "could not create disposable database '$DBNAME'"
fi
if $PGSUPER psql -d "$DBNAME" -q -f "$EXT_SQL" >/dev/null 2>"$PROV_ERR"; then
  [[ -s "$PROV_ERR" ]] && cat "$PROV_ERR" >&2
else
  cat "$PROV_ERR" >&2
  cnm "could not install extensions ($EXT_SQL) into the disposable database"
fi
rm -f "$PROV_ERR"
echo "Provisioned + extensions installed."

MIG_LOG="/tmp/schema_contract_migrate_${SFX}.log"
if ( cd "$MCP_DIR" && env \
      DATABASE_NAME="$DBNAME" DATABASE_USER="$DBUSER" DATABASE_PASSWORD="$DBPASS" \
      DATABASE_HOST="$DBHOST" DATABASE_PORT="$DBPORT" NODE_ENV="development" \
      npx tsx scripts/migrate.ts ) >"$MIG_LOG" 2>&1; then
  echo "${GRN}Migration OK${RST}"
else
  echo "${RED}Migration FAILED — cannot establish schema contract. Log tail:${RST}" >&2
  tail -25 "$MIG_LOG" >&2
  cnm "migration failed (mcp-server/scripts/migrate.ts) — nothing to compare, not a drift"
fi

# --- Extract canonical fingerprint (sorted, version-agnostic) ----------------
FRESH="/tmp/schema_contract_fresh_${SFX}.txt"
# Keep ONLY real fingerprint rows (drop any psql \pset confirmation echoes / blanks).
$PGSUPER psql -d "$DBNAME" -f "$FINGERPRINT_SQL" 2>/dev/null \
  | grep -E '^(COLUMN|CONSTRAINT|INDEX|VIEW|SEQUENCE|ENUM) ' \
  | LC_ALL=C sort > "$FRESH"
LINES=$(wc -l < "$FRESH")
echo "Canonical fingerprint extracted: ${LINES} schema objects."
if [[ "$LINES" -lt 50 ]]; then
  cnm "fingerprint extraction produced only ${LINES} lines (expected >=50) — extraction broke, not a drift"
fi

# =============================================================================
# REGENERATE — overwrite the committed reference
# =============================================================================
if [[ "$MODE" == "regenerate" ]]; then
  {
    echo "# Mandrel CANONICAL SCHEMA REFERENCE — committed contract for the CI drift gate."
    echo "# DO NOT EDIT BY HAND. Regenerate with:  bash scripts/schema-contract.sh regenerate"
    echo "# Generated from a fresh disposable DB migrated by mcp-server/scripts/migrate.ts."
    echo "# Format: one sorted line per schema object (see scripts/schema-fingerprint.sql)."
    echo "# Version-agnostic (catalog-derived), so pg15 tenants compare clean vs a pg16 ref."
    echo "#"
    cat "$FRESH"
  } > "$REFERENCE_FILE"
  echo "${GRN}Reference regenerated:${RST} $REFERENCE_FILE (${LINES} objects)."
  echo "Review the diff (git diff) and commit it WITH the migration that caused it."
  exit 0
fi

# =============================================================================
# VERIFY — standalone (the CI gate STAGE 0c is the copy that gates merges/deploys)
# =============================================================================
hdr "schema-contract: VERIFY fresh schema == committed reference"
if [[ ! -f "$REFERENCE_FILE" ]]; then
  echo "${YLW}Generate it once with:  bash scripts/schema-contract.sh regenerate${RST}" >&2
  cnm "no committed reference at $REFERENCE_FILE"
fi

# Strip the leading comment header from the committed reference before diffing.
REF_BODY="/tmp/schema_contract_ref_${SFX}.txt"
grep -v '^#' "$REFERENCE_FILE" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort > "$REF_BODY"

if diff -u "$REF_BODY" "$FRESH" > "/tmp/schema_contract_diff_${SFX}.txt" 2>&1; then
  echo "${GRN}PASS: migrations reproduce the committed reference schema EXACTLY (${LINES} objects).${RST}"
  echo "${GRN}##########  SCHEMA CONTRACT GREEN  ##########${RST}"
  exit 0
else
  echo "${RED}FAIL: SCHEMA DRIFT — committed migrations do NOT reproduce the reference.${RST}"
  echo "${YLW}--- < reference (committed)   --- > fresh migrate (actual) ---${RST}"
  # Show only the meaningful +/- lines, not the whole file, for readability.
  grep -E '^[+-][^+-]' "/tmp/schema_contract_diff_${SFX}.txt" || cat "/tmp/schema_contract_diff_${SFX}.txt"
  echo ""
  echo "${YLW}If this change is INTENTIONAL (a migration legitimately changed the schema),${RST}"
  echo "${YLW}regenerate the reference and commit it with the migration:${RST}"
  echo "    bash scripts/schema-contract.sh regenerate"
  echo "${RED}##########   SCHEMA CONTRACT RED   ##########${RST}"
  exit 1
fi
