-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 096 — remove the minted_edge_id foreign key + its referencing-side index
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- SCHEMA-REVERSIBLE, NOT DATA-REVERSIBLE — and the data half must not be reversed.
--
-- What comes back: the ABILITY for `belief_adjudications.minted_edge_id` to point at a
-- `links` row that no longer exists. That is the defect, restored. After this runs, nothing
-- maintains the pointer on the DELETE side again, so the next `unlinkEdge` on a
-- belief-minted edge resumes manufacturing dangling references silently.
--
-- What does NOT come back, deliberately: the 30 pointers 096 nulled out. They named `links`
-- row ids that were already gone — restoring them would mean re-writing statements that were
-- false when they were nulled and are still false now. There is no information in them to
-- recover, so this file does not try, and no correct version of it could.
--
-- To see which rows 096 nulled, before running this:
--   SELECT id, pair_key, adjudicated_at FROM belief_adjudications
--    WHERE derived_action = 'mint_supersedes' AND minted_edge_id IS NULL;

ALTER TABLE belief_adjudications
  DROP CONSTRAINT IF EXISTS belief_adjudications_minted_edge_id_fkey;

DROP INDEX IF EXISTS idx_belief_adj_minted_edge;

DO $$
BEGIN
  RAISE NOTICE '096 ROLLBACK: belief_adjudications_minted_edge_id_fkey + idx_belief_adj_minted_edge removed. minted_edge_id can dangle again; the pointers 096 nulled stay null (they named rows that no longer existed).';
END $$;
