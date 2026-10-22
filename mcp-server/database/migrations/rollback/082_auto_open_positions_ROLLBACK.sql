-- ROLLBACK for migration 082 (AUTO-OPEN POSITIONS + Q3 meter).
--
-- Reverts branch_positions to its 080 shape and drops the two Q3 meter views. Any row
-- currently at origin='auto' or 'trunk' becomes an ordinary (declared) position row — the
-- pre-082 semantics, which is exactly what the reverted code will apply to it. Nothing in
-- `links` is touched: the edges auto-open minted are ordinary auto:positional edges,
-- indistinguishable from a declared position's and equally valid; deleting them would
-- mutate history for no gain.

DROP VIEW IF EXISTS zero_declared_inbound_weekly;
DROP VIEW IF EXISTS record_declared_inbound;

ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_declared_has_no_tip_check;
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_tip_pair_check;
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_tip_type_check;
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_origin_check;

ALTER TABLE branch_positions
  DROP COLUMN IF EXISTS member_writes,
  DROP COLUMN IF EXISTS tip_type,
  DROP COLUMN IF EXISTS tip_id,
  DROP COLUMN IF EXISTS origin;

DO $$
BEGIN
  RAISE NOTICE '↩️  082 rolled back: branch_positions back to the 080 shape; Q3 meter views dropped.';
END $$;
