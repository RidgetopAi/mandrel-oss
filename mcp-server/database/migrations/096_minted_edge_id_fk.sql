-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 096 — `belief_adjudications.minted_edge_id` gets the FOREIGN KEY it always needed.
--       (follow-on from the fde9bdaf retraction.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT WAS WRONG ═══
-- `minted_edge_id` has documented itself as "the `links` row id of the supersedes edge"
-- since migration 057 — in a COMMENT, which enforces nothing. The column carried no
-- foreign key. MEASURED on prod 2026-08-28:
--
--   SELECT conname FROM pg_constraint WHERE conrelid='belief_adjudications'::regclass
--     AND contype='f';
--   -> belief_adjudications_project_id_fkey            (the ONLY foreign key on the table)
--
--   SELECT count(*) FROM belief_adjudications a
--    WHERE a.minted_edge_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.id = a.minted_edge_id);
--   -> 30        (of 1,970 non-null pointers, in a 23,813-row table)
--
--   Aged, by adjudicated_at::date:  2026-07-08 -> 28 · 2026-08-16 -> 1 · 2026-08-23 -> 1
--
-- So the invariant lived ONLY in the code that writes the pointer, and NOTHING at all
-- maintained it on the DELETE side. `unlinkEdge` — and the reconciler's own retraction
-- sweep, which calls it — deletes the `links` row and touches `belief_adjudications` not at
-- all. Every edge retraction, anywhere, silently manufactures more dangling pointers. The
-- 28 rows from the 2026-07-08 backfill are not a one-off bad run; they are the first
-- deposit from a hole that re-opens on every retraction.
--
-- This is CLASSES.md C1's instrument ladder applied literally: the claim "this points at a
-- links row" was written at the weakest rung available (a comment), one rung below even
-- code enforcement, while the truth is a DB-constraint-shaped fact.
--
-- ═══ WHY THE FK IS THE FIX AND THE CLEANUP IS ONLY ITS CONSEQUENCE ═══
-- A backfill alone cleans today's 30 and the next `unlinkEdge` makes more — the definition
-- of a patch. `ON DELETE SET NULL` makes the database itself do what no writer remembered
-- to do: when the edge goes, the pointer to it goes with it, and the adjudication row
-- survives intact as the audit record it is (its verdict, rationale and cosine are still
-- true; only the "and here is the edge it minted" clause stopped being true).
--
-- ON DELETE SET NULL, specifically, and not the alternatives:
--   * CASCADE would DELETE the adjudication when its edge is retracted. That destroys the
--     audit trail and the (pair_key, provider, model) idempotency row — the retraction
--     would erase the evidence of why the edge existed. Exactly backwards.
--   * RESTRICT / NO ACTION would make `unlinkEdge` FAIL on any belief-minted edge, turning
--     a data-integrity fix into a product outage on the retraction path.
--   * SET NULL reproduces, mechanically, what the fde9bdaf retraction did BY HAND in SQL
--     (it set all 58 to NULL explicitly, which is why none of the 30 orphans were its).
--
-- ═══ ORDERING — THE NULL-OUT MUST COME FIRST, IN THIS SAME FILE ═══
-- `ADD CONSTRAINT ... FOREIGN KEY` validates existing rows immediately, so it would ABORT
-- against the 30 violators. They are nulled first, in the same transaction the migration
-- runner wraps this file in, so there is no window where the cleanup has run and the
-- constraint has not.
--
-- NOT `NOT VALID`: unlike 094's CHECK (where the legacy rows held irreplaceable history we
-- refused to fabricate), these 30 pointers hold NOTHING — they name row ids that do not
-- exist. Nulling them destroys no information; it deletes a false statement. So the
-- constraint goes on fully VALID and the bad state becomes unreachable rather than merely
-- discouraged.
--
-- ═══ THE INDEX IS NOT OPTIONAL ═══
-- Postgres does not index the REFERENCING side of a foreign key for you. Without one, every
-- `DELETE FROM links` triggers a sequential scan of belief_adjudications (23,813 rows and
-- growing) to find rows to null. The partial index covers exactly the 1,970 rows that can
-- ever match; `=` is strict, so the planner proves the IS NOT NULL predicate and can still
-- use it. MEASURED, not assumed — the exact query shape Postgres's RI trigger issues, on a
-- 30,000-row table:
--
--   EXPLAIN (COSTS OFF) SELECT 1 FROM ONLY belief_adjudications x
--     WHERE '...'::uuid OPERATOR(pg_catalog.=) minted_edge_id FOR KEY SHARE OF x;
--   ->  LockRows
--         ->  Index Scan using idx_belief_adj_minted_edge on belief_adjudications x
--               Index Cond: (minted_edge_id = '...'::uuid)
--
-- ═══ IDEMPOTENT ═══
-- The UPDATE is naturally idempotent (a second run matches zero rows once the FK holds),
-- the index is IF NOT EXISTS, and the constraint is added inside a guarded DO block.
-- Re-running this file changes nothing and raises the same notices with zeroes.
--
-- ═══ DEPLOY ═══
-- CN2, migration-bearing, ROLL-FORWARD (the rollback file removes the constraint and index
-- but cannot un-null a pointer, and should not: a nulled pointer named a row that was
-- already gone). Ships through the normal migration path — mcp-server/docker-entrypoint.sh
-- owns migrations, NOT the deploy script.
-- ORDER-INDEPENDENT with respect to application code: no code change accompanies this
-- migration. Old code keeps writing the pointer the same way; it simply can no longer
-- write one that does not resolve, and no longer has to remember to clear it.

-- ── 1. Clear the false statements, so the constraint can be added VALID ──────────────────
DO $$
DECLARE
  orphans bigint;
BEGIN
  UPDATE belief_adjudications a
     SET minted_edge_id = NULL
   WHERE a.minted_edge_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM links l WHERE l.id = a.minted_edge_id);
  GET DIAGNOSTICS orphans = ROW_COUNT;
  RAISE NOTICE '096: cleared % dangling minted_edge_id pointer(s) (expected 30 on prod, 0 on a fresh DB or a re-run).', orphans;
END $$;

-- ── 2. Index the referencing side BEFORE the FK, so no DELETE is ever unindexed ─────────
CREATE INDEX IF NOT EXISTS idx_belief_adj_minted_edge
  ON belief_adjudications (minted_edge_id)
  WHERE minted_edge_id IS NOT NULL;

COMMENT ON INDEX idx_belief_adj_minted_edge IS
  'Referencing side of belief_adjudications_minted_edge_id_fkey (migration 096). Postgres does not create this for you; without it every DELETE FROM links sequentially scans belief_adjudications. Partial because only the non-null pointers can ever match.';

-- ── 3. The invariant, moved into the database ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'belief_adjudications_minted_edge_id_fkey'
  ) THEN
    ALTER TABLE belief_adjudications
      ADD CONSTRAINT belief_adjudications_minted_edge_id_fkey
      FOREIGN KEY (minted_edge_id) REFERENCES links(id) ON DELETE SET NULL;
    RAISE NOTICE '096: belief_adjudications_minted_edge_id_fkey added (ON DELETE SET NULL).';
  ELSE
    RAISE NOTICE '096: belief_adjudications_minted_edge_id_fkey already present — nothing to do.';
  END IF;
END $$;

COMMENT ON COLUMN belief_adjudications.minted_edge_id IS
  'The links row id of the supersedes edge this verdict minted, or NULL. ENFORCED since migration 096 by belief_adjudications_minted_edge_id_fkey (ON DELETE SET NULL): retracting the edge nulls this pointer automatically and keeps the adjudication as the audit record. Before 096 this was a comment-only claim and 30 prod rows pointed at links rows that no longer existed.';
