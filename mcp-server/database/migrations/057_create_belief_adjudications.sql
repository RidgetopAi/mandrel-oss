-- Migration 057: BELIEF LAYER — the `belief_adjudications` table (Phase 4, Increment 1).
--
-- WHY (belief-layer design §1, locked): the belief layer adds the
-- TRUTH-NOW axis on top of cosine's relevance axis. A small-LLM adjudicator judges
-- candidate pairs (supersedes / contests / restates / unrelated); this table records
-- EVERY pairwise verdict — including the ones that mint no edge. That gives us three
-- things at once: (1) an AUDIT TRAIL (why we did / didn't mint a supersedes edge),
-- (2) IDEMPOTENCY (don't re-adjudicate the same pair with the same model), and (3) the
-- labeled-set FEEDER that grows the belief-eval over time.
--
-- Edges themselves live in `links` (a `supersedes` edge is minted only for a
-- high-confidence supersession; that edge type already exists — no edge-type change this
-- increment). This table is purely additive telemetry/audit alongside them.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped. No data migration.
--
-- This migration number (057) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH
-- fresh builds (after the 000 baseline) and existing/already-baselined instances.
-- The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to
-- include this table so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

CREATE TABLE IF NOT EXISTS belief_adjudications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Project scope: adjudications are project-scoped so pairing/audit stays within a tenant
  -- (design §9f privacy — never pair across tenants / Daisy / personal). Nullable for
  -- robustness (a pair whose endpoints predate project scoping).
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  -- Canonical unordered-pair key `least(a,b)|greatest(a,b)` — one row per unordered pair
  -- per (provider, model). Set by the store layer, not a magic string here.
  pair_key       TEXT NOT NULL,
  -- The two records adjudicated. Endpoints span contexts/decisions (tasks are not belief
  -- atoms — no embedding). Kept as id + kind (same polymorphic pattern as `links`).
  a_id           UUID NOT NULL,
  a_type         TEXT NOT NULL CHECK (a_type IN ('context', 'decision', 'task')),
  b_id           UUID NOT NULL,
  b_type         TEXT NOT NULL CHECK (b_type IN ('context', 'decision', 'task')),
  -- The adjudicator's structured verdict (single-sourced vocabulary in
  -- src/services/belief/types.ts — the app-layer validation is the contract; these CHECKs
  -- are the DB backstop).
  same_subject   BOOLEAN NOT NULL,
  subject        TEXT,
  verdict        TEXT NOT NULL CHECK (verdict IN ('supersedes', 'contests', 'restates', 'unrelated')),
  direction      TEXT NOT NULL DEFAULT 'none' CHECK (direction IN ('a_supersedes_b', 'b_supersedes_a', 'none')),
  mode           TEXT NOT NULL DEFAULT 'none' CHECK (mode IN ('replaced', 'fallback_retained', 'none')),
  confidence     NUMERIC(4, 3),
  rationale      TEXT,
  -- Stage-1 cosine that nominated the pair (audit; NOT a verdict signal).
  cosine         NUMERIC(6, 5),
  -- Provider + model that produced the verdict (part of the idempotency key — a different
  -- model gets its own row so a size bake-off can compare verdicts side by side).
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  -- The DERIVED action for Increment 1: 'mint_supersedes' or 'none'. Explains the outcome.
  derived_action TEXT NOT NULL CHECK (derived_action IN ('mint_supersedes', 'none')),
  -- When derived_action='none', WHY (below-dial, restates, different-subject, contests-
  -- deferred, ...). NULL when an edge was minted.
  no_edge_reason TEXT,
  -- The `links` row id of the supersedes edge, when one was minted.
  minted_edge_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  adjudicated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- IDEMPOTENCY: one verdict per unordered pair per (provider, model). The store's
  -- ON CONFLICT (pair_key, provider, model) DO UPDATE relies on this.
  CONSTRAINT belief_adjudications_pair_model_uniq UNIQUE (pair_key, provider, model)
);

-- Look up a record's adjudications from either side (audit / surfacing).
CREATE INDEX IF NOT EXISTS idx_belief_adj_a ON belief_adjudications (a_id);
CREATE INDEX IF NOT EXISTS idx_belief_adj_b ON belief_adjudications (b_id);
-- Project-scoped sweeps (the labeled-set feeder / eval exports).
CREATE INDEX IF NOT EXISTS idx_belief_adj_project ON belief_adjudications (project_id);
-- Filter to the verdicts that actually minted (or should have) — the interesting rows.
CREATE INDEX IF NOT EXISTS idx_belief_adj_action ON belief_adjudications (derived_action);

COMMENT ON TABLE belief_adjudications IS
  'Belief layer (Phase 4). One row per pairwise adjudicator verdict — audit trail + idempotency (pair_key,provider,model) + labeled-set feeder. Supersedes edges live in links; this records why each was/wasn''t minted. Verdict vocabulary single-sourced in src/services/belief/types.ts.';

DO $$
BEGIN
  RAISE NOTICE '✅ belief_adjudications table created (Phase 4 Inc-1): pairwise verdict audit + idempotency, additive.';
END $$;
