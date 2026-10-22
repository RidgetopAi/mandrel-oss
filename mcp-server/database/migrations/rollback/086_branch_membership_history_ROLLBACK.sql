-- ROLLBACK for migration 086 (branch_memberships table + branch_membership view + 2 indexes,
-- an earlier task / SK2).
--
-- 086 is purely additive to the EXISTING schema: it creates one new TABLE, one VIEW over it,
-- and two INDEXes. No pre-086 table, column, constraint or row was touched, so dropping all
-- of it restores the 085 state EXACTLY at the schema level.
--
-- ⚠️ THIS ROLLBACK IS LOSSY IN DATA, AND THE LOSS IS NOT RECOVERABLE BY RE-MIGRATING.
-- Every 'recorded' membership row minted after 086 shipped is DESTROYED here, and re-running
-- 086 will NOT bring it back: the backfill reconstructs membership only from
-- `links.mint_via='position'` rows, and the whole reason this table exists is that the
-- positional edge can be swallowed by an earlier tag mint on the same (from,to,edge_type)
-- triple — so those members leave no trace in `links` at all. Dump the table first if the
-- history matters:
--
--     \copy branch_memberships TO 'branch_memberships.tsv'
--
-- CONSEQUENCE OF RUNNING THIS WITHOUT ALSO REVERTING THE CODE: branch_history and
-- mandrel-command's getBranches both SELECT from branch_membership and will error loudly
-- ("relation branch_membership does not exist") rather than silently fall back to the loose
-- predicate. That is the intended direction — a missing membership definition must not
-- degrade into the wrong one.

DROP VIEW IF EXISTS branch_membership;
DROP TABLE IF EXISTS branch_memberships;
DROP INDEX IF EXISTS idx_branch_positions_spine;

DO $$
BEGIN
  RAISE NOTICE '⏪ 086 rolled back: branch_membership view + branch_memberships table + idx_branch_positions_spine dropped (schema back to the 085 state; recorded membership rows are GONE).';
END $$;
