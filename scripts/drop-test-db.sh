#!/usr/bin/env bash
# =============================================================================
# drop-test-db.sh — teardown a throwaway test Postgres created by
#                   scripts/provision-test-db.sh.
#
# Thin, discoverable wrapper around `provision-test-db.sh <dbname> --drop` so the
# teardown is easy to find next to its provisioner. Drops the ci_*-prefixed DB
# and its derived ci_role_* role. REFUSES anything not ci_*-prefixed (the guard
# lives in provision-test-db.sh — single source).
#
# USAGE
#   bash scripts/drop-test-db.sh <dbname>
# =============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -n "${1:-}" ]] || { echo "Usage: $0 <dbname>" >&2; exit 1; }
exec bash "$DIR/provision-test-db.sh" "$1" --drop
