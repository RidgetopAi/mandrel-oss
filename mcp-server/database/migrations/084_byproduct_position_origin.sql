-- Migration 084: BYPRODUCT position origin — make "I chose this branch" distinguishable
-- from "a status change moved me here".
-- (an earlier task / SK1, STRONG BONES an earlier spine.)
--
-- WHY (measured on prod 2026-08-15, and then measured again in the code):
-- A coordinator flipped two tasks to in_progress as a dispatcher — never working either —
-- and its branch position landed on whichever it touched LAST, arbitrarily. Every record it
-- wrote afterwards would have minted a DECLARED `via:position` membership edge onto a spine
-- nobody stood on. That is not a MISSING edge, it is a CONFIDENTLY WRONG one, and a wrong
-- declared edge is strictly worse than none: the whole premise of the branch model is that a
-- declared edge can be walked without re-judging it.
--
-- THE PART THAT WAS NOT TRUE BEFORE THIS MIGRATION. 082 added `origin`, so it LOOKED like
-- the row already distinguished the two — a branch_open reads back `origin:'declared'`. It
-- does not: `setPositionByproduct` called `openPosition` WITHOUT an origin, and that
-- parameter defaults to 'declared' (services/branchPosition.ts). So a task_claim and a
-- task_update(in_progress) stored the SAME origin a deliberate branch_open stores, and no
-- policy could tell them apart from the row. The column existed; the distinction did not.
-- This migration adds the value, and the service stops omitting it.
--
--   'declared'  — branch_open ONLY. A human/agent stated where it is standing.
--   'byproduct' — task_claim, or task_update flipping status to in_progress. Work-start
--                 inferred from another act. Behaves EXACTLY like 'declared' for minting
--                 (tipless, no auto-open, membership to the spine) — it differs in ONE
--                 respect: it YIELDS. A byproduct never overwrites a 'declared' position.
--   'auto'      — R1 auto-open on a create by an unpositioned session. Unchanged.
--   'trunk'     — R2 fan-out revert. Unchanged.
--
-- WHY 'byproduct' RATHER THAN A BOOLEAN COLUMN: origin is already the ONE state field that
-- makes contradictory combinations ("auto AND trunk") structurally unreachable — 082's own
-- stated reason for choosing it. A parallel boolean would reintroduce exactly the pair of
-- fields that can disagree.
--
-- ADDITIVE / IDEMPOTENT: every statement drops-then-adds a named CHECK, so a re-run is a
-- no-op. NO existing row changes value: rows written before this are byproduct-or-declared
-- and indistinguishable by construction, so they keep 'declared' — the conservative
-- direction (an old row is treated as deliberate, and is therefore protected rather than
-- silently overwritable). The schema-contract reference is regenerated in the same commit.

ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_origin_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_origin_check
  CHECK (origin IN ('declared', 'auto', 'byproduct', 'trunk'));

-- R0 IN THE DATABASE, widened to cover the new value. 082 made "a declared position with a
-- tip" unreachable because tip mechanics on a stated position is the retired anchor's
-- mistake. A byproduct position is P1-shaped in exactly the same way — it never advances a
-- tip — so the same bad state must be unreachable for it, not merely unwritten. Widening the
-- constraint here rather than leaving byproduct unconstrained is the fail-closed direction:
-- if a future edit to positionalMint.ts tries to advance a tip on one, the write fails loudly.
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_declared_has_no_tip_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_declared_has_no_tip_check
  CHECK (origin NOT IN ('declared', 'byproduct') OR tip_id IS NULL);

COMMENT ON COLUMN branch_positions.origin IS
  'HOW this position came to exist, and which rule set governs it (082 + 084/an earlier task): declared = branch_open, a stated stance; byproduct = task_claim or task_update(in_progress), work-start inferred from another act — mints identically to declared but YIELDS to a declared position rather than overwriting it; auto = opened as a byproduct of a create by an unpositioned session (R1); trunk = the session fanned out (R2) and reverted, minting nothing until a declared act (R5). For trunk rows spine_id retains the record reverted FROM — provenance, not a position. Rows predating 084 carry declared and are therefore protected, which is the conservative direction.';

DO $$
BEGIN
  RAISE NOTICE '✅ 084 byproduct position origin: branch_positions.origin accepts byproduct; the no-tip CHECK now covers it. A byproduct open no longer masquerades as a deliberate branch_open.';
END $$;
