-- Migration 097: BELIEF LAYER — the APPEND-ONLY ATTEMPT ledger (observability).
--
-- WHY. The belief pipeline's failure rate was UNOBSERVABLE AT EVERY SURFACE:
--   * belief_adjudications only ever receives a row when a pair REACHES a verdict. A pair whose
--     provider call throws is caught and skipped (beliefAdjudicator.ts — correct degradation),
--     so it is persisted NOWHERE. The verdict table therefore cannot report its own miss rate
--     BY CONSTRUCTION: its denominator is its numerator.
--   * belief_adjudication_costs (060) has the same blind spot for the same reason — a ledger row
--     is written from the provider's per-call usage AFTER the call returns, so a failed call
--     writes nothing.
--   * The container log is not a substitute: it is ephemeral (reset by every redeploy), carries
--     no tier/status attribution, and cannot be aggregated. Measured 2026-08-28: `docker logs
--     mandrel-prod-mcp-server --since 168h` returned only ~6h of lines because the container had
--     been recreated — so "0 hits for json_validate_failed" was never evidence of a zero rate.
--
-- WHAT THIS TABLE IS. One APPEND-ONLY row per ADJUDICATION ATTEMPT, written for BOTH outcomes.
-- That is the whole point: "attempted" and "completed" become readable from ONE query over ONE
-- population, so a MISS is COUNTED rather than inferred from an absence:
--
--   SELECT scope, count(*) AS attempted,
--          count(*) FILTER (WHERE outcome = 'completed') AS completed,
--          count(*) FILTER (WHERE outcome = 'failed')    AS failed
--     FROM belief_adjudication_attempts
--    WHERE created_at > now() - interval '7 days'
--    GROUP BY scope;
--
-- TWO SCOPES, because there are two places an attempt dies:
--   * 'pair'          — one candidate pair (adjudicatePair). A tier-1/tier-2 provider error kills
--                       this pair only; its neighbours still proceed.
--   * 'neighbourhood' — the whole per-record job (adjudicateNeighbourhood). A failure BEFORE any
--                       pair is reached (provider construction with no API key, the candidate
--                       query) loses EVERY pair for that record and would otherwise leave no pair
--                       rows at all — the exact shape measured on the tenant fleet 2026-08-28,
--                       where 7 instances logged 23 whole-neighbourhood failures and ZERO
--                       successful adjudications, invisibly.
--
-- APPEND-ONLY, deliberately, like 060 and unlike belief_adjudications (which UPSERTs one verdict
-- snapshot per pair): a rate is a count of EVENTS over a window. An upserting table cannot count
-- two attempts at the same pair, which is precisely what a retry is.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped. No data migration.
--   * The write is FAIL-SAFE + non-blocking in the app (services/belief/attemptLedger.ts wraps it
--     in try/catch) — a ledger error NEVER changes a verdict or the degradation behaviour.
--
-- This migration number (097) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH fresh
-- builds (after the 000 baseline) and existing/already-baselined instances. The schema-contract
-- reference (scripts/schema-reference.sql.txt) is regenerated so the CI drift gate stays honest.

CREATE TABLE IF NOT EXISTS belief_adjudication_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope. Nullable + ON DELETE SET NULL for the SAME reason as the cost ledger: deleting
  -- a project must not erase the historical reliability record of the pipeline.
  project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
  -- 'pair' | 'neighbourhood' — see the header. Vocabulary single-sourced in
  -- src/services/belief/attemptLedger.ts (BELIEF_ATTEMPT_SCOPES); this CHECK is the DB backstop.
  scope             TEXT NOT NULL CHECK (scope IN ('pair', 'neighbourhood')),
  -- 'completed' | 'failed'. BOTH are written; that is what makes the rate computable.
  outcome           TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  -- The canonical unordered pair (adjudicationStore.pairKey) for scope='pair'; NULL for a
  -- neighbourhood attempt. Free text, NOT a FK — the observability row must never fail to write
  -- because the record it describes is gone.
  pair_key          TEXT,
  a_id              UUID,
  b_id              UUID,
  -- The record whose neighbourhood was being adjudicated (scope='neighbourhood').
  source_id         UUID,
  -- The provider/model the attempt was made WITH, when it is known. NULLABLE on purpose: an
  -- attempt that dies while CONSTRUCTING the provider (missing API key) has no model yet, and a
  -- NULL here is itself the diagnostic.
  provider          TEXT,
  model             TEXT,
  -- FAILURE ATTRIBUTION (all NULL for outcome='completed'):
  --   failed_stage — where it died: 'provider' (an LLM call), 'provider_init' (factory/ctor),
  --                  'pairing' (candidate query), 'derivation', 'persist' (edge/row write),
  --                  'unknown'.
  --   failed_tier  — WHICH tier's call threw: 'tier1' | 'tier2' | 'single'. This is the column
  --                  that answers "should tier-1 failures fall through to tier-2?".
  --   http_status  — the provider's HTTP status when the failure was an HTTP error (400 for
  --                  Groq's json_validate_failed), else NULL.
  failed_stage      TEXT CHECK (failed_stage IN ('provider', 'provider_init', 'pairing', 'derivation', 'persist', 'unknown')),
  failed_tier       TEXT CHECK (failed_tier IN ('tier1', 'tier2', 'single')),
  error_class       TEXT,
  http_status       INTEGER,
  -- The error message, TRUNCATED at write time (config: beliefConfig BELIEF_ATTEMPT_CONFIG
  -- .errorMessageMaxChars). Provider error bodies can be large and are not worth unbounded rows.
  error_message     TEXT,
  -- Wall time of the attempt, for latency context on failures (timeouts look different).
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The rate query scans a time window and filters on outcome.
CREATE INDEX IF NOT EXISTS idx_belief_attempt_created_at
  ON belief_adjudication_attempts (created_at);
-- "show me the failures" — a partial index, because failures are (we hope) the small side.
CREATE INDEX IF NOT EXISTS idx_belief_attempt_failed
  ON belief_adjudication_attempts (created_at) WHERE outcome = 'failed';
-- Per-project/tenant reliability attribution over a window.
CREATE INDEX IF NOT EXISTS idx_belief_attempt_project_created
  ON belief_adjudication_attempts (project_id, created_at);

COMMENT ON TABLE belief_adjudication_attempts IS
  'Belief layer. APPEND-ONLY attempt ledger: one row per adjudication ATTEMPT, written for BOTH outcomes (completed/failed), at two scopes (pair | neighbourhood). Makes the pipeline MISS RATE computable from ONE query over ONE population — belief_adjudications and belief_adjudication_costs can only ever record successes, so neither can report its own miss rate. Failure attribution: failed_stage / failed_tier / http_status. Written fail-safe in src/services/belief/attemptLedger.ts.';

DO $$
BEGIN
  RAISE NOTICE '✅ belief_adjudication_attempts created: attempted AND completed are now one query.';
END $$;
