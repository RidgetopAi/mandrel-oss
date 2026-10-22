-- ROLLBACK 081: restore the 079 link_provenance view (without 'auto:handoff-supersession'
-- in the declared set — the stamp fail-closes back to 'unclassified').

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
