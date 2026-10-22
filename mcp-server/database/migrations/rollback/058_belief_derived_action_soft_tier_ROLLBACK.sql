-- ROLLBACK for Migration 058: revert the belief `derived_action` CHECK to the pre-soft set.
--
-- Reverses 058 by narrowing derived_action back to ('mint_supersedes','none'). This is only
-- safe if NO row carries derived_action='soft_possibly_superseded' — narrowing a CHECK is
-- rejected by Postgres if an existing row would violate it. So before applying, either delete
-- or re-derive any soft rows:
--   DELETE FROM belief_adjudications WHERE derived_action = 'soft_possibly_superseded';
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans database/migrations/
-- NON-recursively, so this file lives in the rollback/ subdirectory deliberately — it is the
-- documented manual down-path, never auto-run by the runner or the schema-contract gate.
-- Apply by hand:
--   psql -d <db> -f database/migrations/rollback/058_belief_derived_action_soft_tier_ROLLBACK.sql

ALTER TABLE belief_adjudications
  DROP CONSTRAINT IF EXISTS belief_adjudications_derived_action_check;

ALTER TABLE belief_adjudications
  ADD CONSTRAINT belief_adjudications_derived_action_check
  CHECK (derived_action IN ('mint_supersedes', 'none'));

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 058: derived_action CHECK narrowed to mint_supersedes | none (soft tier removed).';
END $$;
