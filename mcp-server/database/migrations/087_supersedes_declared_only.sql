-- Migration 087: AN INFERRED EDGE MUST NEVER BE ABLE TO MAKE A RECORD INVISIBLE.
-- Converts every GUESSED `supersedes` edge to `possibly_supersedes`, then makes the guessed
-- hard edge UNWRITABLE. (P0.)
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────
-- The two supersession edge types are not two strengths of one signal. They are two
-- different KINDS of act, and only one of them is destructive:
--
--   `possibly_supersedes`  ANNOTATES. trust.ts reads it as a SOFT signal — it lowers the
--                          record's score and sets softSuperseded, and it never abstains.
--                          The record still renders. A false positive DEGRADES an answer.
--   `supersedes`           EXCLUDES. It is a NOT EXISTS predicate in projectBriefing.ts
--                          (the handoff, the conventions and the dead-ends sections), so a
--                          false positive does not degrade an answer, it DELETES it.
--
-- `belief-adjudication` is a confidence-scored LLM heuristic, and until this migration it
-- wrote into BOTH channels: beliefDerivation.ts promoted a verdict to the hard channel when
-- confidence >= 0.9 and cosine >= 0.75. That threshold was the defect. 0.9 confidence is
-- still a guess, and the edge it produced was indistinguishable from a declared human act.
--
-- ── WHAT WAS MEASURED ON PROD BEFORE WRITING THIS (2026-08-16) ───────────────────────
--   SELECT edge_type, provenance_class, mint_via, count(*) FROM links
--    WHERE edge_type IN ('supersedes','possibly_supersedes') GROUP BY 1,2,3;
--     -> possibly_supersedes | guessed  | belief-adjudication    | 716
--        supersedes          | guessed  | belief-adjudication    | 942   <- converted here
--        supersedes          | declared | handoff-timeline       |  31
--        supersedes          | declared | links-param            |   7
--        supersedes          | declared | decision-superseded-by |   1
--
--   * Honouring only DECLARED supersedes changed the served briefing handoff for 0 of 84
--     projects — the 942 guessed hard edges bought NOTHING on that path.
--   * 421 live contexts were in the briefing's dead-ends section on a guessed edge ALONE:
--       SELECT count(DISTINCT c.id) FROM contexts c
--         JOIN links l ON l.to_id=c.id AND l.edge_type='supersedes'
--        WHERE c.archived_at IS NULL AND l.provenance_class='guessed'
--          AND NOT EXISTS (SELECT 1 FROM links d WHERE d.to_id=c.id
--                            AND d.edge_type='supersedes' AND d.provenance_class='declared');
--       -> 421
--
-- ── USER-VISIBLE BEHAVIOUR CHANGE, STATED PLAINLY ────────────────────────────────────
-- The converted pairs LEAVE authoritative story ordering. `supersedes` carries weight 100 in
-- threadConfig.ts and drives reverse story-ordering in recallThreadCore.ts /
-- treewalkerStoryOrder.ts; `possibly_supersedes` carries weight 30 and orders nothing. That
-- is the intended consequence — a guess should not order the story authoritatively — but it
-- IS a change a user can see in `recall_thread` output, not merely a cleanup.
--
-- Trust output does NOT change. trust.ts classifies an edge as soft when
-- `edge_type='possibly_supersedes' OR created_by='auto:belief-adjudicator'`, so every row
-- converted here was ALREADY in the soft bucket and stays in it.
--
-- ── NOT ADDITIVE / NOT RE-RUNNABLE-INTO-A-DIFFERENT-STATE ────────────────────────────
-- Idempotent: re-running updates 0 rows (the population is defined by the state it removes)
-- and re-adds the same constraint. See rollback/087_supersedes_declared_only_ROLLBACK.sql.

-- ── (a) THE COLLISION CHECK, IN THE MIGRATION'S OWN TERMS ────────────────────────────
-- `links_from_to_edge_uniq` is UNIQUE (from_id, to_id, edge_type). Converting a row's
-- edge_type collides iff the SAME (from_id, to_id) already carries a `possibly_supersedes`
-- row. Measured 0 on prod, but a migration must not depend on a number measured on one
-- database at one moment (C4) — so it RESOLVES the collision deterministically instead of
-- asserting it away. A colliding guessed hard edge is DELETED, because the row it would
-- collide with is the SAME claim in the SAME direction from the SAME minter, already in the
-- non-destructive channel: keeping both is impossible and keeping the hard one is the bug
-- this migration exists to remove. The count is RAISEd so a non-zero resolution is visible
-- in the migration log rather than silent.
DO $$
DECLARE
  n_collisions bigint;
BEGIN
  WITH doomed AS (
    DELETE FROM links l
     WHERE l.edge_type = 'supersedes'
       AND l.provenance_class = 'guessed'
       AND EXISTS (
             SELECT 1 FROM links p
              WHERE p.from_id = l.from_id
                AND p.to_id   = l.to_id
                AND p.edge_type = 'possibly_supersedes'
           )
    RETURNING 1
  )
  SELECT count(*) INTO n_collisions FROM doomed;
  IF n_collisions > 0 THEN
    RAISE NOTICE '⚠️  087: % guessed `supersedes` row(s) collided with an existing `possibly_supersedes` on the same (from,to) and were DELETED (the surviving row carries the same claim in the non-destructive channel).', n_collisions;
  ELSE
    RAISE NOTICE '087: 0 collisions against links_from_to_edge_uniq — the conversion below is a clean UPDATE.';
  END IF;
END $$;

-- THE CONVERSION. provenance_class is the GENERATED column from migration 085; reading it
-- here rather than re-spelling the `guessed` mint_via list is deliberate — one fact, one
-- surface. Rows minted by handoff-timeline / links-param / decision-superseded-by / the link
-- tool classify 'declared' and are UNTOUCHED.
DO $$
DECLARE
  n_converted bigint;
BEGIN
  WITH moved AS (
    UPDATE links
       SET edge_type = 'possibly_supersedes'
     WHERE edge_type = 'supersedes'
       AND provenance_class = 'guessed'
    RETURNING 1
  )
  SELECT count(*) INTO n_converted FROM moved;
  RAISE NOTICE '087: % guessed `supersedes` edge(s) converted to `possibly_supersedes`.', n_converted;
END $$;

-- ── (b) MAKE THE BAD STATE UNREPRESENTABLE ───────────────────────────────────────────
-- A CHECK constraint referencing the STORED GENERATED `provenance_class` — VERIFIED to be
-- both ACCEPTED and ENFORCED on PostgreSQL 16.14 (the version prod and CI both run), on
-- INSERT and on UPDATE. That is what lets this constraint read the classifier from its
-- single source instead of hardcoding a second copy of the guessed-mint_via list.
--
-- Note the predicate rejects 'unclassified' too, not just 'guessed': a NEW mint_via added in
-- TypeScript without being classified in 085 fail-closes to 'unclassified', and such a via
-- must not be able to mint an exclusion edge on the strength of not having been classified
-- yet. Declared is the allow-list; everything else is denied.
--
-- NOT VALID is deliberately NOT used — the conversion above leaves zero violating rows, so
-- the constraint is validated against the existing table and the migration FAILS LOUDLY here
-- if any guessed hard edge survived, rather than admitting a constraint that does not hold.
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_supersedes_declared_only;
ALTER TABLE links ADD CONSTRAINT links_supersedes_declared_only
  CHECK (edge_type <> 'supersedes' OR provenance_class = 'declared');

COMMENT ON CONSTRAINT links_supersedes_declared_only ON links IS
  'AN INFERRED EDGE MUST NEVER BE ABLE TO MAKE A RECORD INVISIBLE. `supersedes` is an EXCLUSION predicate in projectBriefing.ts, so only a DECLARED edge (a human/agent explicitly named the target) may carry it; an inferred supersession belongs in `possibly_supersedes`, which annotates and demotes but never hides. provenance_class is the GENERATED classifier from migration 085 — this constraint reads it rather than re-listing the mint_via vocabulary, so the two cannot drift.';

DO $$
DECLARE
  n_hard_declared bigint;
  n_soft          bigint;
BEGIN
  SELECT count(*) FILTER (WHERE edge_type = 'supersedes'),
         count(*) FILTER (WHERE edge_type = 'possibly_supersedes')
    INTO n_hard_declared, n_soft
    FROM links;
  RAISE NOTICE '✅ 087: `supersedes` is now DECLARED-BY-CONSTRUCTION. % supersedes (all declared) / % possibly_supersedes.', n_hard_declared, n_soft;
END $$;
