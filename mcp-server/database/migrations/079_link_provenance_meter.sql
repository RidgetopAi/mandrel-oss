-- Migration 079: EDGE PROVENANCE METER — declared vs guessed classification + weekly meter
-- (PHASE 0 of the positional-membership plan).
--
-- WHY (graph audit): the `auto:active_thread` minting mechanism died on
-- 2026-07-28 and was invisible for 15 days because the coverage metric counted ALL edges
-- without distinguishing a DECLARED edge (a human/agent explicitly NAMED the target: a
-- threading tag, a `links` arg, an id in the body/metadata) from a GUESSED one (a similarity
-- guess or a retroactive bulk mint). One mechanism's edges silently replaced another's and
-- the dashboard read 97-98% coverage throughout. This migration is the instrument that makes
-- that failure class impossible to miss again.
--
-- SINGLE SOURCE OF TRUTH: the CASE in `link_provenance` below is THE classification. Nothing
-- in TypeScript re-spells it — the meter service, the alarm, and the coverage split all
-- SELECT `provenance_class` from these views. The executable contract test
-- (src/tests/linkProvenanceMeter.contract.test.ts) asserts every provenance stamp the code
-- can mint classifies to a non-'unclassified' bucket, so a new stamp cannot silently drift.
--
-- THE CLASSIFICATION (an earlier task's spec, which follows an earlier decision):
--   DECLARED — the writer explicitly named the target:
--     'auto:context_store' / 'auto:decision_record' / 'auto:decision_update'   (threading
--        tags + decision metadata evidence ids + supersededBy — all explicitly named)
--     'auto:task_create' / 'auto:task_update'   (task threading tags)
--     'auto:task_deps'                          (explicit task `dependencies` field)
--     'links:%'                                 (the explicit `links` argument)
--     'link'                                    (the explicit link tool)
--     'auto:positional'                         (FUTURE — Phase 1 positional membership.
--                                                Classified now so P1 lands in the right
--                                                bucket on arrival; P1 MUST use this stamp.)
--     'backfill:task_tags' / 'backfill:task_deps' (DECLARED backfill — Phase 3's spec,
--                                                distinguishes backfill
--                                                derived from AT-ORIGIN-DECLARED signals
--                                                (threading tags, the explicit task
--                                                `dependencies` field) from similarity-
--                                                derived backfill. The target was named by
--                                                a human at origin; the backfill only
--                                                materializes it late.)
--   GUESSED — the system inferred the target:
--     'auto:inference'          (embedding-similarity no-orphan guess)
--     'auto:active_thread'      (the session anchor — a guess per an earlier decision)
--     'auto:belief-adjudicator' (automated supersession adjudication)
--     'backfill' / other 'backfill:%' (the bare/legacy bulk mint and any similarity-
--                                derived backfill stamp; a NEW backfill:* stamp lands
--                                here by default unless explicitly classified declared)
--   UNCLASSIFIED — anything else, INCLUDING NULL. Fail-closed and VISIBLE: an unknown stamp
--     lands in neither trusted bucket and is surfaced by the meter, never silently absorbed.
--
-- ADDITIVE / IDEMPOTENT: CREATE OR REPLACE VIEW only; no table is altered. Numbered above
-- BASELINE_THROUGH so it runs on both fresh and baselined instances. The schema-contract
-- reference (scripts/schema-reference.sql.txt) is regenerated in the same commit.

CREATE OR REPLACE VIEW link_provenance AS
SELECT
  l.id,
  l.from_id,
  l.from_type,
  l.to_id,
  l.to_type,
  l.edge_type,
  l.project_id,
  l.created_at,
  l.created_by,
  CASE
    WHEN l.created_by IN (
           'link',
           'auto:context_store',
           'auto:decision_record',
           'auto:decision_update',
           'auto:task_create',
           'auto:task_update',
           'auto:task_deps',
           'auto:positional',
           'backfill:task_tags',
           'backfill:task_deps'
         )
      OR l.created_by LIKE 'links:%'
      THEN 'declared'
    WHEN l.created_by IN (
           'auto:inference',
           'auto:active_thread',
           'auto:belief-adjudicator',
           'backfill'
         )
      OR l.created_by LIKE 'backfill:%'
      THEN 'guessed'
    ELSE 'unclassified'
  END AS provenance_class
FROM links l;

COMMENT ON VIEW link_provenance IS
  'THE declared-vs-guessed edge provenance classification. Single source: every meter/alarm/coverage consumer reads provenance_class from here; no TypeScript copy exists. declared = explicitly named target (tags, links arg, decision metadata, task deps, future positional, tag/deps-derived backfill per P3 an earlier task). guessed = auto:inference / auto:active_thread (a guess per an earlier decision) / auto:belief-adjudicator / bare+similarity backfill. Anything else (incl. NULL) = unclassified, fail-closed and surfaced.';

-- ── THE METER, finest grain: week × project × source × class ─────────────────
-- The 2026-07-28 collapse is only visible at SOURCE granularity: auto:active_thread went
-- 93→4→8→0/wk while auto:inference held ~330/wk — and BOTH are in the guessed class, so a
-- class-level rollup alone would have hidden it. The meter therefore exposes both grains.
CREATE OR REPLACE VIEW link_provenance_weekly AS
SELECT
  date_trunc('week', created_at)::date AS week_start,
  project_id,
  created_by,
  provenance_class,
  count(*)::int AS edges
FROM link_provenance
GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW link_provenance_weekly IS
  'Edge provenance meter, source grain: edges minted per week × project × created_by × class. The grain the 2026-07-28 auto:active_thread collapse is visible at (93→4→8→0/wk).';

-- ── THE METER, class rollup: week × project × declared/guessed rate ──────────
CREATE OR REPLACE VIEW link_provenance_weekly_class AS
SELECT
  date_trunc('week', created_at)::date AS week_start,
  project_id,
  count(*) FILTER (WHERE provenance_class = 'declared')::int     AS declared,
  count(*) FILTER (WHERE provenance_class = 'guessed')::int      AS guessed,
  count(*) FILTER (WHERE provenance_class = 'unclassified')::int AS unclassified,
  count(*)::int AS total,
  round(
    count(*) FILTER (WHERE provenance_class = 'declared')::numeric
      / NULLIF(count(*), 0),
    4
  ) AS declared_rate
FROM link_provenance
GROUP BY 1, 2;

COMMENT ON VIEW link_provenance_weekly_class IS
  'Edge provenance meter, class rollup: declared/guessed/unclassified counts + declared_rate per week × project. declared_rate is NULL only when a group is empty (a group only exists with >=1 edge, so in practice never NULL — but the guard stays).';

DO $$
BEGIN
  RAISE NOTICE '✅ link provenance meter views created: link_provenance (the classification, single source), link_provenance_weekly (source grain), link_provenance_weekly_class (class rollup + declared_rate).';
END $$;
