-- ROLLBACK for migration 090 (mutable branch membership: the widened `source` CHECK + the
-- append-only branch_membership_moves audit table, P3 / an earlier task).
--
-- ⚠️ THIS ROLLBACK IS LOSSY, IN TWO DIFFERENT WAYS. Read both before running it.
--
-- 1. THE MOVE LOG IS DESTROYED, AND NOTHING CAN RECONSTRUCT IT. `branch_membership_moves` is
--    the ONLY place a record's branch history lives; `branch_memberships` holds the current
--    branch and nothing else, and an unassigned record leaves no row there at all. Dump it
--    first if the history matters:
--
--        \copy branch_membership_moves TO 'branch_membership_moves.tsv'
--
-- 2. NARROWING THE CHECK CANNOT SUCCEED WHILE AN 'assigned' ROW EXISTS. `ADD CONSTRAINT …
--    CHECK` validates every existing row, so the ALTER below would ERROR on the first
--    deliberately-assigned membership. This script therefore RE-STAMPS those rows to
--    'recorded' FIRST — which is a LOSS OF TRUTH, not a formality: a row that says
--    'recorded' claims the position was observed at mint time, and for these rows it was
--    not. That claim is stronger than the evidence and there is no weaker legal value to
--    use ('legacy-approx' would be a different lie, in the other direction, and would drop
--    `exact` on branches that are exact).
--
--    The re-stamp is announced in the NOTICE below with its row count, so the loss is a
--    measured number rather than a footnote. If that count is nonzero and you care about
--    those rows, dump the table above BEFORE running this — after the re-stamp, which rows
--    were assigned is unrecoverable.
--
-- CONSEQUENCE OF RUNNING THIS WITHOUT ALSO REVERTING THE CODE: branch_assign / branch_unassign
-- will fail loudly — the INSERT into branch_membership_moves hits a missing relation, and the
-- membership write's source='assigned' hits the narrowed CHECK. Both are inside one
-- transaction per call, so a failed call changes nothing. That is the intended direction: a
-- missing audit table must stop the tool that depends on it, never let it write an
-- untraceable rewrite of a historical fact.

DO $$
DECLARE
  n_restamped bigint;
  n_moves     bigint;
BEGIN
  SELECT count(*) INTO n_moves FROM branch_membership_moves;

  UPDATE branch_memberships SET source = 'recorded' WHERE source = 'assigned';
  GET DIAGNOSTICS n_restamped = ROW_COUNT;

  RAISE NOTICE '⏪ 090 rollback: % membership row(s) re-stamped assigned -> recorded (their declared-ness is now UNRECOVERABLE); % move row(s) about to be dropped with the table.',
    n_restamped, n_moves;
END $$;

DROP TABLE IF EXISTS branch_membership_moves;

ALTER TABLE branch_memberships DROP CONSTRAINT IF EXISTS branch_memberships_source_check;
ALTER TABLE branch_memberships
  ADD CONSTRAINT branch_memberships_source_check
  CHECK (source IN ('recorded', 'legacy-approx'));

-- Restore 086's own COMMENT text verbatim, so the schema-contract reference matches the
-- pre-090 state exactly rather than keeping prose about a value the CHECK now rejects.
COMMENT ON COLUMN branch_memberships.source IS
  '''recorded'' (from the live position — a fact) | ''legacy-approx'' (migration 086 backfill from a pre-migration position edge''s to_id — correct for a directly-attached write, WRONG in the under-counting direction for a tip-chained one, and unrecoverable). Consumers MUST surface the difference: branch_history reports approximateMembers / possiblyIncomplete / exact.';

COMMENT ON TABLE branch_memberships IS
  'WHICH BRANCH EACH WRITE WAS MADE ON (SK2). One row per record, written by services/positionalMint.ts at the membership decision — INDEPENDENTLY of edge minting, because the `informs` edge it also mints can be deduped away by an earlier tag mint on the same (from,to,edge_type) triple and membership must not ride on that. PK on record_id encodes the model: a write happens at one position. Read through the branch_membership VIEW, which is the single predicate both mcp-server (services/branchMembership.ts -> branch_history) and mandrel-command (services/treewalkerTiers.ts getBranches) go through.';

DO $$
BEGIN
  RAISE NOTICE '⏪ 090 rolled back: branch_membership_moves dropped, source CHECK narrowed back to (recorded, legacy-approx), 086 comments restored.';
END $$;
