# shellcheck shell=bash
# scripts/oss-gate/config.sh — the named configuration for scripts/oss-gate.sh.
#
# Sourced (never executed) by oss-gate.sh. Every list the gate enumerates lives here, so a change
# to WHAT the gate covers is a reviewable diff in one file, and every exclusion carries its reason
# next to it.

# --- Deps (STAGE D) ------------------------------------------------------------------------------
# Each dir gets `npm ci --include=dev` from its own package-lock.json. The repo root is NOT
# installed: its package.json only carries runtime deps for ops scripts, and no stage below
# resolves a module from the root node_modules.
OSS_GATE_NPM_ROOTS=(
  mcp-server
  mandrel-command   # npm workspaces root: installs frontend, backend, shared
  adapters
  loop              # reference Punch List loop (client of the public tool API)
)

# --- Type-check (STAGE T) ------------------------------------------------------------------------
# "<dir>|<command>" — run in <dir>. shared has no type-check script; tsc --noEmit is its equivalent.
OSS_GATE_TYPECHECK=(
  "mcp-server|npm run -s type-check"
  "mandrel-command/backend|npm run -s type-check"
  "mandrel-command/frontend|npm run -s type-check"
  "mandrel-command/shared|npx --no-install tsc --noEmit -p ."
  "adapters|npm run -s type-check"
  "loop|npm run -s type-check"
)

# --- Lint (STAGE L) ------------------------------------------------------------------------------
# ERRORS fail; warnings are the tolerated upstream baseline (eslint --max-warnings=-1).
# EXCLUDED: adapters — its `lint` script has no eslint config to load (eslint exits 2, "couldn't
# find a configuration file"), and the upstream gate never linted it either.
OSS_GATE_LINT_DIRS=(
  mcp-server
  mandrel-command/backend
  mandrel-command/frontend
  mandrel-command/shared
  loop
)

# --- Unit tests (STAGE U) ------------------------------------------------------------------------
# Only tests that need no database and no network. They run with an EMPTY inherited environment,
# a throwaway HOME, and a placeholder database that points at a closed port, so a test that does
# try to connect fails loudly instead of reaching whatever Postgres happens to be on the box.
# src/config/database.ts throws at IMPORT when DATABASE_NAME is unset, which is why a placeholder
# is set at all.
OSS_GATE_TEST_DB_ENV=(
  DATABASE_NAME=oss_gate_no_db
  DATABASE_USER=oss_gate_no_db
  DATABASE_HOST=127.0.0.1
  DATABASE_PORT=9
)

# mcp-server: the *.unit.test.ts population (contract/integration/e2e files need Postgres).
OSS_GATE_MCP_TEST_FILTER="unit.test"
# Files inside that population that are excluded, one glob each, with the reason:
OSS_GATE_MCP_TEST_EXCLUDE=(
  # Needs Postgres despite its name: freshProject() runs INSERTs through the real pool
  # (DATASTORE_ERROR / ECONNREFUSED against the placeholder).
  "src/tests/threadInference.unit.test.ts"
  # Its PROVENANCE case re-executes an upstream commit by sha (git cat-file <sha>); that commit
  # is not in this repository's history, so the case cannot pass here.
  "src/tests/actorRegistry.unit.test.ts"
)

# mandrel-command/backend (jest): regexes passed to --testPathIgnorePatterns, with the reason.
OSS_GATE_BACKEND_TEST_IGNORE=(
  # Every *.db.test.ts file opens a real Postgres connection.
  '\.db\.test\.ts$'
  # These contract suites query Postgres directly (ECONNREFUSED against the placeholder).
  '/analyticsSplitAndRhythm\.contract\.test\.ts$'
  '/analyticsWindows\.contract\.test\.ts$'
  '/contextsByActor\.contract\.test\.ts$'
  '/sessionActorReadModel\.contract\.test\.ts$'
  '/sessionAnalyticsContexts\.contract\.test\.ts$'
  '/sessionAnalyticsProjectIsolation\.contract\.test\.ts$'
  '/sessionCountRule\.contract\.test\.ts$'
  '/sessionScoreUnified\.contract\.test\.ts$'
  '/sessionSummaries\.contract\.test\.ts$'
  # Streams through a live database trigger.
  '/sse-db-integration\.test\.ts$'
)

# mandrel-command/frontend: the whole vitest suite (no database involved).

# --- Shell tests (STAGE H) -----------------------------------------------------------------------
# Every file matching OSS_GATE_SHELL_TEST_GLOB runs as `bash <file>` under the same empty-environment
# discipline as STAGE U, and any non-zero exit is RED. A new scripts/test/*.test.sh is therefore
# enforced the moment it lands; nothing needs wiring.
OSS_GATE_SHELL_TEST_GLOB="scripts/test/*.test.sh"
# Seconds a single shell test may run before it is killed and counted as a failure.
OSS_GATE_SHELL_TEST_TIMEOUT=300
# There is deliberately NO exclusion list: a test that cannot pass in this repository does not belong
# in it (the fleet-only suites were removed), so "every file matching the glob" is literally what runs.

# --- Internal-refs ban (STAGE R) ----------------------------------------------------------------
# <class><TAB><pcre><TAB><probe>, one per line. Each probe is a synthetic hit of its class; the test
# scripts/test/internal-refs-ban.test.sh plants every probe in a scratch repo and requires RED.
OSS_GATE_REFS_PATTERNS="scripts/oss-gate/internal-refs.patterns"
# <class|*><TAB><path-glob><TAB><line-literal|*><TAB><reason>. A hit is allowed only when an entry's
# class, path glob AND literal all cover it. An entry that covers no hit is itself RED, so the list
# cannot outlive the reason it was written for.
OSS_GATE_REFS_ALLOW="scripts/oss-gate/internal-refs.allow"
# Scan scope: git pathspecs, relative to the repo root. "." = EVERY tracked file; narrowing it to
# source directories is exactly how an eval harness full of internal hosts once shipped unseen.
# scripts/test/gate-refs-scan-coverage.test.sh fails if the scanned list stops equalling
# `git ls-files` minus OSS_GATE_REFS_EXEMPT.
OSS_GATE_REFS_SCOPE=(.)
# The ONLY paths exempt from the scan, with the reason: the pattern list and the allow-list
# necessarily contain the patterns, their probes, and the literals they allow.
OSS_GATE_REFS_EXEMPT=(
  "$OSS_GATE_REFS_PATTERNS"
  "$OSS_GATE_REFS_ALLOW"
)
# How many banned hits a RED prints before summarising the rest.
OSS_GATE_REFS_SHOW=40

# --- Secret scan (STAGE S) -----------------------------------------------------------------------
# The SAME arguments .github/workflows/secrets.yml passes to `gitleaks detect` (pinned equal by
# scripts/test/gate-secret-stage.test.sh): the repo's own config, every ref in the history, redacted.
# The gate's scan must never be weaker than the CI scan it is meant to predict.
OSS_GATE_GITLEAKS_CONFIG=".gitleaks.toml"
OSS_GATE_GITLEAKS_LOG_OPTS="--all"
