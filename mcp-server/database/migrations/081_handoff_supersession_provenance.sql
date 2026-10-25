-- Migration 081: classify 'auto:handoff-supersession' as DECLARED in the provenance meter
-- (PHASE 2 item g, folds D5-A from an earlier review).
--
-- WHY: storing a new handoff now deterministically mints a `supersedes` edge to the
-- project's previous newest handoff (src/services/handoffSupersession.ts) — the trunk's
-- own declared-edge feed. Baseline measured 2026-08-12: only 177 of 1,249 handoff-chain
-- links (14.2%) were declared. The predecessor is STRUCTURALLY NAMED (created_at
-- adjacency within the project's handoff timeline), not similarity-guessed, so the stamp
-- belongs in the DECLARED bucket. Without this migration the 079 view fail-closes it to
-- 'unclassified' — correct behavior for an unknown stamp, wrong bucket for this one.
--
-- SINGLE SOURCE unchanged: the CASE below IS the classification (079's contract); this
-- migration re-creates the view with ONE stamp added to the declared set. The weekly
-- rollup views read link_provenance and need no change (CREATE OR REPLACE keeps them).
-- The executable contract test (src/tests/linkProvenanceMeter.contract.test.ts) pins the
-- new stamp to 'declared'.
--
-- ADDITIVE / IDEMPOTENT: CREATE OR REPLACE VIEW only; no table is altered.

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
           'auto:handoff-supersession',
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
  'THE declared-vs-guessed edge provenance classification (+auto:handoff-supersession per an earlier task). Single source: every meter/alarm/coverage consumer reads provenance_class from here; no TypeScript copy exists. declared = explicitly named target (tags, links arg, decision metadata, task deps, positional, handoff-timeline supersession, tag/deps-derived backfill per P3 an earlier task). guessed = auto:inference / auto:active_thread (a guess per an earlier decision) / auto:belief-adjudicator / bare+similarity backfill. Anything else (incl. NULL) = unclassified, fail-closed and surfaced.';

DO $$
BEGIN
  RAISE NOTICE '✅ 081: link_provenance re-created — auto:handoff-supersession classifies DECLARED.';
END $$;
