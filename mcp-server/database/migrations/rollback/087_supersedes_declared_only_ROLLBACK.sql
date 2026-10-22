-- ROLLBACK for migration 087.
--
-- Drops the constraint, so a guessed `supersedes` edge becomes writable again.
--
-- ── WHAT THIS DOES *NOT* DO, AND WHY ─────────────────────────────────────────────────
-- It does NOT convert the 942 rows back to `supersedes`. That is not an oversight — it is
-- not possible to do correctly, and doing it approximately would be worse than not doing it:
--
--   1. THE POPULATION IS NOT RECOVERABLE. After 087, a converted row is byte-identical to a
--      `possibly_supersedes` edge that the belief layer minted normally (same edge_type, same
--      mint_via, same created_by). 716 such rows existed BEFORE 087 and more are minted every
--      adjudication pass. Nothing on the row records "I used to be hard", so a reverse UPDATE
--      keyed on (edge_type, provenance_class) would promote all of them — turning ~716+
--      never-hard annotations into exclusion edges. That is a strictly worse state than
--      either side of this migration, and it is silent.
--   2. THE THRESHOLD IS GONE TOO. Which rows WOULD have been hard is a function of the
--      confidence and cosine dials that the matching code change deleted; re-deriving it
--      would mean re-adjudicating, not rolling back.
--
-- So this rollback restores the CONSTRAINT state (what 087 added) and not the DATA state.
-- Rolling back therefore leaves the 942 in the non-destructive channel, which is safe: an
-- annotation that should have been an exclusion under-hides a record, and the failure mode
-- 087 exists to remove is over-hiding. Recovery in the other direction is a re-adjudication
-- pass, not a SQL statement.
--
-- NOTE: rolling this back WITHOUT reverting the matching code change is fine and is the
-- expected order. The code (beliefDerivation.ts) can no longer construct a hard mint at all,
-- so dropping the constraint re-opens the door but nothing in the repo walks through it.

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_supersedes_declared_only;

DO $$
DECLARE
  n_guessed_hard bigint;
BEGIN
  SELECT count(*) INTO n_guessed_hard
    FROM links WHERE edge_type = 'supersedes' AND provenance_class <> 'declared';
  RAISE NOTICE '⏪ 087 rolled back: links_supersedes_declared_only DROPPED — a guessed `supersedes` is writable again. Converted rows were NOT restored (see this file''s header). Non-declared `supersedes` rows present: %.', n_guessed_hard;
END $$;
