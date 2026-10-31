#!/usr/bin/env bash
#
# schema-contract-static.config.sh — single source of truth for STAGE 0c's
# static-mode trigger (refile (c) of an earlier change).
#
# WHY THIS EXISTS
#   STAGE 0c (the CI gate) needs the ONE path prefix that, when touched by a
#   ref's diff, can plausibly move the committed schema fingerprint
#   (scripts/schema-reference.sql.txt): the migrations directory
#   mcp-server/scripts/migrate.ts actually walks. Named config, not a literal
#   inlined at the call site (configs-not-hardcoded) — and not duplicated between
#   the CI gate and its test suite,
#   which would drift the same way schema-fingerprint.sql and this reference
#   already warn about drifting (scripts/schema-contract.sh's own header).
#
# EVERY PATH IS REPO-RELATIVE. The consumer joins it onto its own resolved
# REPO_DIR; a guard that carries an absolute path only measures one checkout.

if [[ -z "${_MANDREL_SCHEMA_CONTRACT_STATIC_CONFIG_SOURCED:-}" ]]; then
  _MANDREL_SCHEMA_CONTRACT_STATIC_CONFIG_SOURCED=1

  # The path mcp-server/scripts/migrate.ts walks (this.migrationsPath =
  # path.join(__dirname, '..', 'database', 'migrations')). Trailing slash so a
  # prefix match (gate_diff_touches_prefix) cannot false-positive on a sibling
  # like mcp-server/database/migrations-archive/.
  SCHEMA_CONTRACT_STATIC_TRIGGER_PREFIX="${SCHEMA_CONTRACT_STATIC_TRIGGER_PREFIX:-mcp-server/database/migrations/}"

  # the install STAGE 0c's static branch runs when mcp-server's
  # dependencies do not resolve in the (clean, node_modules-less) workspace.
  # Lockfile-exact (`npm ci`), offline-preferred; the probe package is the one
  # migrate.ts's first import needs, whose absence is the 2026-10-28 failure.
  SCHEMA_CONTRACT_STATIC_NPM_BIN="${SCHEMA_CONTRACT_STATIC_NPM_BIN:-npm}"
  SCHEMA_CONTRACT_STATIC_NPM_ARGS="${SCHEMA_CONTRACT_STATIC_NPM_ARGS:---include=dev --prefer-offline}"
  SCHEMA_CONTRACT_STATIC_PROBE_PKG="${SCHEMA_CONTRACT_STATIC_PROBE_PKG:-pg}"
fi
