-- ROLLBACK for migration 089.
--
-- ⚠️ THIS ROLLBACK RESTORES NOTHING, AND THAT IS NOT AN OVERSIGHT.
--
-- 089 is a DELETE of two row classes. It adds no schema, no constraint, no index and no
-- default — so there is no structural state to undo. What it removed was DATA, and that
-- data is not reconstructible:
--
--   1. THE BRANCH IS GONE WITH THE ROW. `branch_memberships` is the only place the branch a
--      write was made on is recorded, and the PK is record_id — one row, no history table
--      (P3 adds one; it did not exist when 089 ran). Once the row is deleted, which spine
--      that handoff was a member of exists nowhere: the position it was read from is a live
--      session row that has long since moved or closed.
--   2. THE EDGE'S TARGET IS NOT THE ANSWER EITHER. The deleted `informs` edge points at the
--      position's ATTACHED-TO record, which for a capture is the branch TIP — an earlier
--      member, not the branch root. Migration 086's header is explicit that a row in that
--      shape is indistinguishable from a nested branch's write; SK2 round 1 tried to walk
--      it and measured 4 members for a branch with 2. Re-deriving membership from the edge
--      would therefore not restore the fact, it would invent a plausible wrong one, and it
--      would do so silently.
--
-- So there is nothing to write here that would be honest. Restoring these rows correctly
-- requires a database backup taken before 089 ran, and nothing else.
--
-- ROLLING BACK THE CODE WITHOUT THIS FILE IS THE EXPECTED ORDER AND IS SAFE. Reverting the
-- positionalMint.ts change simply makes handoffs eligible for membership again; new ones
-- become members from that point on. The already-cleared ones stay trunk records, which is
-- the state P1 wanted anyway — under-membered, never wrongly membered.
--
-- The statement below is a NO-OP that says so out loud, so that running this file cannot be
-- mistaken for having restored anything.

DO $$
DECLARE
  n_handoffs bigint;
BEGIN
  SELECT count(*) INTO n_handoffs FROM contexts WHERE context_type = 'handoff';
  RAISE NOTICE '⏪ 089 rollback is a NO-OP BY CONSTRUCTION: the deleted branch_memberships rows and mint_via=position edges are NOT restorable from anything in this database (see this file''s header) — restore from a pre-089 backup if you need them. Handoffs present: %. Revert services/positionalMint.ts to make handoffs eligible for membership again.', n_handoffs;
END $$;
