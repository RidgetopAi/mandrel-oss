-- ROLLBACK for migration 085 (SK4).
--
-- Restores the 081 state: link_provenance classifies on created_by, links carries neither
-- mint_via nor provenance_class. LOSSY BY CONSTRUCTION — dropping mint_via discards the
-- derivation-path label for every edge minted after 085, and there is no way to recover it
-- from created_by (that proxy being wrong is why 085 exists). Roll back only if 085 itself
-- is the problem, and expect the label to be gone for edges minted in the interval.
--
-- NOTE: application code minting through mintEdge() will FAIL after this rollback until the
-- matching code revert lands — the INSERT names mint_via. That is intentional: a rollback
-- that left the code writing to a dropped column would fail per-edge and silently, whereas
-- this fails loudly at the first mint.

-- CASCADE is unavoidable here (the column must go, and the view selects it), which means it
-- takes FOUR dependents with it: link_provenance_weekly + link_provenance_weekly_class (079)
-- and record_declared_inbound + zero_declared_inbound_weekly (082). ALL FOUR are restated at
-- the bottom of this file. If you edit this rollback, keep them — a CASCADE that restates
-- three of four leaves the fourth silently missing, which is exactly how the forward
-- migration's first draft broke the Q3 meter.
DROP VIEW IF EXISTS link_provenance CASCADE;

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_mint_via_nonempty;
DROP INDEX IF EXISTS idx_links_provenance_class;
DROP INDEX IF EXISTS idx_links_mint_via;
ALTER TABLE links DROP COLUMN IF EXISTS provenance_class;
ALTER TABLE links DROP COLUMN IF EXISTS mint_via;

-- link_provenance, as migration 081 left it (the created_by CASE).
CREATE VIEW link_provenance AS
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

-- The two rollups the CASCADE removed, as 079 defined them.
CREATE VIEW link_provenance_weekly AS
SELECT
  date_trunc('week', created_at)::date AS week_start,
  project_id,
  created_by,
  provenance_class,
  count(*)::int AS edges
FROM link_provenance
GROUP BY 1, 2, 3, 4;

CREATE VIEW link_provenance_weekly_class AS
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

-- The Q3 meter views the CASCADE removed, as migration 082 defined them.
CREATE VIEW record_declared_inbound AS
WITH records AS (
  SELECT 'task'::text     AS record_type, t.id AS record_id, t.project_id, t.created_at    AS created_at
    FROM tasks t
  UNION ALL
  SELECT 'decision'::text AS record_type, d.id AS record_id, d.project_id, d.decision_date AS created_at
    FROM technical_decisions d
)
SELECT
  r.record_type,
  r.record_id,
  r.project_id,
  r.created_at,
  count(lp.id) FILTER (WHERE lp.provenance_class = 'declared')::int AS declared_inbound,
  count(lp.id) FILTER (WHERE lp.provenance_class = 'guessed')::int  AS guessed_inbound
FROM records r
LEFT JOIN link_provenance lp
       ON lp.to_id = r.record_id
      AND lp.to_type = r.record_type
GROUP BY r.record_type, r.record_id, r.project_id, r.created_at;

CREATE VIEW zero_declared_inbound_weekly AS
SELECT
  date_trunc('week', created_at)::date AS week_start,
  project_id,
  record_type,
  count(*)::int                                          AS records,
  count(*) FILTER (WHERE declared_inbound = 0)::int      AS zero_declared,
  round(
    count(*) FILTER (WHERE declared_inbound = 0)::numeric / NULLIF(count(*), 0),
    4
  ) AS zero_declared_rate
FROM record_declared_inbound
GROUP BY 1, 2, 3;

DO $$
BEGIN
  RAISE NOTICE '⏪ 085 rolled back: mint_via + provenance_class dropped; link_provenance classifies on created_by again (081 state).';
END $$;
