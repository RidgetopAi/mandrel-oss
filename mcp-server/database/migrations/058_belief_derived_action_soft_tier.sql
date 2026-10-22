-- Migration 058: BELIEF LAYER — the SOFT derivation tier (Phase 4, BL-2 / two-tier v1).
--
-- WHY (BL-2): the two-tier derivation (beliefDerivation.ts) splits a
-- below-hard-bar supersession into a new deliberate outcome — `soft_possibly_superseded` —
-- instead of the old silent `none/below_supersede_confidence` drop. The adjudication store
-- records EVERY verdict (audit + idempotency + the labeled-set feeder), so the SOFT action
-- must persist too. Migration 057's `derived_action` CHECK only allowed
-- ('mint_supersedes','none') — a soft row would VIOLATE that DB backstop, throw, and be
-- swallowed by the adjudicator's per-pair try/catch → a silent drop (the exact anti-pattern
-- BL-2 removes). This migration widens the DB backstop to match the app vocabulary
-- (src/services/belief/beliefDerivation.ts — "the app-layer validation is the contract;
-- these CHECKs are the DB backstop", per migration 057).
--
-- SCOPE: `soft_possibly_superseded` mints NO edge in this increment (edgeReconciliation only
-- acts on `mint_supersedes`); it is RECORDED so BL-3 can consume it. The indexed
-- derived_action column (idx_belief_adj_action) can then filter the soft rows directly.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * Only WIDENS an allowed set — every existing row already satisfies the new CHECK.
--   * DROP CONSTRAINT IF EXISTS then ADD (same name) — safe to re-run.
--   * No column/table added or dropped; no data migration.
--
-- Above BASELINE_THROUGH (42), so it runs normally on fresh + already-baselined instances.
-- The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated so the CI
-- drift gate (the CI gate stage 0c) stays GREEN and honest.

ALTER TABLE belief_adjudications
  DROP CONSTRAINT IF EXISTS belief_adjudications_derived_action_check;

ALTER TABLE belief_adjudications
  ADD CONSTRAINT belief_adjudications_derived_action_check
  CHECK (derived_action IN ('mint_supersedes', 'soft_possibly_superseded', 'none'));

DO $$
BEGIN
  RAISE NOTICE '✅ belief_adjudications.derived_action widened for the SOFT tier (BL-2): mint_supersedes | soft_possibly_superseded | none.';
END $$;
