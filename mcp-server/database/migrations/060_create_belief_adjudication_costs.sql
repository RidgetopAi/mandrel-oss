-- Migration 060: BELIEF LAYER — the APPEND-ONLY cost ledger (Phase 4, BL-10 cost monitor).
--
-- WHY (BL-10): the operator is enabling belief detection (flag default-on, BL-9) and
-- needs LIVE visibility on the per-write LLM spend + a runaway-spend alarm. The COST SOURCE is
-- deliberately NOT columns on belief_adjudications: that table is a verdict SNAPSHOT — it UPSERTs
-- one row per unordered pair per (provider, model) (ON CONFLICT DO UPDATE), and the tiered
-- adjudicator (BL-11) can even write TWO snapshot rows for one pair across a tier flip. Counting
-- money off an upserting/deduped table is wrong. Instead this table is an APPEND-ONLY LEDGER:
-- exactly ONE row per REAL LLM call (the tiered provider writes the Groq tier-1 call ALWAYS, plus
-- the Sonnet tier-2 call WHEN it escalates; single-provider modes write one). Correct accounting,
-- and it sidesteps the dedup problem entirely — the $/day rollup just SUMs rows in a window.
--
-- One row = one billable API call. cost_usd is computed at write time from the call's token
-- counts × a per-model USD rate (config: src/config/beliefCostConfig.ts — env-overridable; an
-- unknown model → 0 + a logged warning). The token columns are retained raw so a rate correction
-- can be re-derived later from the ledger without re-calling any model.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped. No data migration.
--   * A ledger write is FAIL-SAFE + non-blocking in the app (services/belief/costLedger.ts wraps
--     it in try/catch) — a ledger error NEVER breaks or slows an adjudication verdict.
--
-- This migration number (060) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH fresh
-- builds (after the 000 baseline) and existing/already-baselined instances. The schema-contract
-- reference (scripts/schema-reference.sql.txt) is regenerated so the CI drift gate (the CI gate stage
-- 0c) stays GREEN and honest.

CREATE TABLE IF NOT EXISTS belief_adjudication_costs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant scope for per-project/per-tenant cost attribution. Nullable + ON DELETE SET NULL:
  -- deleting a project must NOT erase its historical SPEND (unlike belief_adjudications, whose
  -- verdicts CASCADE) — the cost record outlives the pair so the $ ledger stays complete.
  project_id            UUID REFERENCES projects(id) ON DELETE SET NULL,
  -- The canonical unordered pair this call adjudicated (adjudicationStore.pairKey). A REFERENCE
  -- for audit/join, nullable + free-text (NOT a FK) so the ledger never blocks or fails a write
  -- if the pair record is absent — the money row is the priority.
  pair_key              TEXT,
  -- Which tier made this real call: 'tier1' (Groq prescreen) | 'tier2' (Sonnet confirm) |
  -- 'single' (non-tiered single-provider call). Vocabulary single-sourced in
  -- src/services/belief/types.ts (BELIEF_CALL_TIERS); this CHECK is the DB backstop.
  tier                  TEXT NOT NULL CHECK (tier IN ('tier1', 'tier2', 'single')),
  -- The provider + model that BILLED this call (e.g. 'anthropic'/'claude-sonnet-5',
  -- 'openai-compat'/'openai/gpt-oss-120b'). model is the rate-table key.
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  -- Raw token accounting for the call (defaults 0 so cost math is always total). cache_* are
  -- Anthropic prompt-cache tokens (BL-12): creation = written on a miss, read = served on a hit.
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  -- Computed USD cost for THIS call (tokens × per-model rate at write time). NUMERIC for exact
  -- money math; wide enough for any single-call cost.
  cost_usd              NUMERIC(14, 8) NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Time-window rollups ($/day, calls/day, tokens/day) scan by created_at.
CREATE INDEX IF NOT EXISTS idx_belief_cost_created_at ON belief_adjudication_costs (created_at);
-- Per-project/tenant cost attribution over a window.
CREATE INDEX IF NOT EXISTS idx_belief_cost_project_created
  ON belief_adjudication_costs (project_id, created_at);

COMMENT ON TABLE belief_adjudication_costs IS
  'Belief layer (Phase 4, BL-10). APPEND-ONLY cost ledger: one row per REAL adjudication LLM call (tiered writes tier1 always + tier2 on escalation; single modes write one). cost_usd = tokens x per-model rate (config/beliefCostConfig.ts). Source for the $/day rollup + runaway alarm. Distinct from belief_adjudications (an upserting verdict snapshot — wrong for money). Tier vocab single-sourced in src/services/belief/types.ts.';

DO $$
BEGIN
  RAISE NOTICE '✅ belief_adjudication_costs ledger created (BL-10): one row per real adjudication call, append-only, additive.';
END $$;
