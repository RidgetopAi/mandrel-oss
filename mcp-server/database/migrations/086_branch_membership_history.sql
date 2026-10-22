-- Migration 086: BRANCH MEMBERSHIP GETS ITS OWN TABLE — because "which branch was this
-- written on" is a first-class fact, and it had no first-class storage.
-- (an earlier task / SK2, STRONG BONES an earlier spine.)
--
-- ══ WHY THIS MIGRATION WAS REWRITTEN TWICE BEFORE IT WAS RIGHT ═══════════════════════════
-- Three rounds of SK2 each produced a confidently wrong member count, and each fix moved the
-- same parasite to a better spot on the same host:
--
--   R1 INFERRED membership from any declared edge      -> 17 members for a branch of 9.
--   R2 ABSORBED it from edge SHAPE (a transitive walk) ->  4 members for a branch of 2.
--   R3 STORED it on a CONTESTED row (links columns)    ->  0 members, reported exact:true.
--
-- R3's failure is the one that names the class. `mintEdge` inserts
-- `ON CONFLICT (from_id, to_id, edge_type) DO NOTHING` (services/links.ts), and the TAG mint
-- runs BEFORE the positional mint on every write path. So a write made while positioned on
-- spine S that ALSO TAGS S produces two mints for the same triple: the tag mint wins, the
-- positional mint is swallowed, and the record silently stops being a member.
--
-- MEASURED ON PROD 2026-08-15 — restricted to spines with real branch activity:
--
--   WITH spines(s) AS (VALUES ('ddba6ec7-'),('e6170769-'),('ee38f63a-'))
--   SELECT sp.s,
--     (SELECT count(*) FROM links l
--       WHERE l.to_id::text LIKE sp.s||'%' AND l.mint_via='position') AS pos_edges,
--     (SELECT count(DISTINCT l.from_id) FROM links l
--       WHERE l.to_id::text LIKE sp.s||'%' AND l.mint_via='tag'
--         AND l.edge_type='informs'   -- only this triple can race the positional mint
--         AND NOT EXISTS (SELECT 1 FROM links p
--                          WHERE p.mint_via='position' AND p.from_id=l.from_id)) AS tag_only
--   FROM spines sp;
--   ->  ddba6ec7 | 8 | 10      e6170769 | 9 | 10      ee38f63a | 8 | 9
--
-- Roughly half of each branch was missing. Two decisions written on e6170769 during this very
-- task (06b87b7d, 43e11051) carry a single `tag`-minted informs edge to it and no position
-- edge at all.
--
-- ══ THE DECISIVE ARGUMENT FOR A TABLE ════════════════════════════════════════════════════
-- SK2 exists because `branch_close` HARD-DELETES position history — a durable fact living on
-- a deletable carrier. Storing membership on `links` repeats exactly that mistake one table
-- over: `unlinkEdge` hard-deletes by (from_id, to_id, edge_type), so the membership fact
-- would ride out with the edge. Membership is not a property of an edge. It is a property of
-- a WRITE, and it gets its own row.
--
-- WHAT THE PRIMARY KEY ENCODES. `record_id` alone is the PK: a write happens at ONE position.
-- That is not asserted in prose anywhere — it is unrepresentable-otherwise. (Measured on
-- prod before choosing it: zero records carry more than one position edge —
-- `SELECT count(*) FROM (SELECT from_id FROM links WHERE mint_via='position'
--  GROUP BY from_id HAVING count(*)>1) d` -> 0.)
--
-- WHY THE EDGE DEDUP IS NOW HARMLESS. positionalMint still mints its `informs` edge, and that
-- mint may still lose the triple to a tag edge. That is FINE and always was: "already linked"
-- is true and sufficient, because the graph edge does exist and recall_thread can traverse
-- it. What must not depend on winning the race is MEMBERSHIP — and it no longer does.
--
-- ══ THREE ALTERNATIVES, REJECTED WITH REASONS ════════════════════════════════════════════
--   * DO UPDATE the incumbent tag row with spine columns — mechanically impossible: the
--     fail-closed CHECK required position columns to be NULL on a non-position row.
--   * WIDEN uniqueness to include mint_via — `unlinkEdge` deletes by the triple, so one
--     unlink would remove BOTH edges; and every triple-keyed consumer double-counts.
--   * REORDER the mints so positional wins — five lines, and it makes correctness
--     order-dependent across three routes and every future write path, while losing tag
--     provenance instead. Trading one lost fact for another is not a fix.
--
-- ADDITIVE: one new table, one new view, two indexes. No existing table is altered and no
-- existing row is changed. Idempotent — re-running inserts nothing new (ON CONFLICT DO
-- NOTHING) and can never re-stamp a 'recorded' row as approximate. The schema-contract
-- reference (scripts/schema-reference.sql.txt) is regenerated in the SAME commit.

-- ── 1. THE TABLE ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_memberships (
  -- THE MEMBER, and the PK. One write, one position (see above).
  record_id        UUID PRIMARY KEY,
  record_type      TEXT NOT NULL CHECK (record_type IN ('context', 'decision', 'task')),

  -- THE BRANCH: the ROOT spine of the position this write was made on — branch_positions
  -- .spine_id, never its tip. This is the membership key and the only thing a reader needs.
  spine_id         UUID NOT NULL,
  spine_type       TEXT NOT NULL CHECK (spine_type IN ('context', 'decision', 'task')),

  -- WHERE THE GRAPH EDGE ATTACHED at mint time: the root for a create, the branch TIP for a
  -- capture (positionTarget(), services/branchPosition.ts). NOT the membership key — a
  -- tip-attached write is a member of the ROOT, which is the distinction rounds 1 and 2 both
  -- got wrong. Recorded here rather than joined out of `links` because it is a fact about
  -- the write, not about whichever edge row currently survives: the edge can be unlinked,
  -- and membership must outlive that (this table exists because facts on deletable carriers
  -- are how SK2 started).
  attached_to_id   UUID NOT NULL,
  attached_to_type TEXT NOT NULL CHECK (attached_to_type IN ('context', 'decision', 'task')),

  -- HOW spine_id was obtained. 'recorded' = from the live position at mint time (a FACT, and
  -- the only value any code path writes). 'legacy-approx' = backfilled below from a pre-
  -- migration position edge's to_id (an APPROXIMATION — see the backfill's note). A CLOSED
  -- class: nothing mints it, so its count can only shrink.
  source           TEXT NOT NULL CHECK (source IN ('recorded', 'legacy-approx')),

  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A record cannot be a member of itself: the spine is the branch, not a write on it. Same
  -- rule mintEdge enforces for self-links, restated where membership is now stored — this is
  -- the layer that holds against raw SQL.
  CONSTRAINT branch_memberships_not_self CHECK (record_id <> spine_id)
);

COMMENT ON TABLE branch_memberships IS
  'WHICH BRANCH EACH WRITE WAS MADE ON (SK2). One row per record, written by services/positionalMint.ts at the membership decision — INDEPENDENTLY of edge minting, because the `informs` edge it also mints can be deduped away by an earlier tag mint on the same (from,to,edge_type) triple and membership must not ride on that. PK on record_id encodes the model: a write happens at one position. Read through the branch_membership VIEW, which is the single predicate both mcp-server (services/branchMembership.ts -> branch_history) and mandrel-command (services/treewalkerTiers.ts getBranches) go through.';

COMMENT ON COLUMN branch_memberships.spine_id IS
  'The branch ROOT — branch_positions.spine_id of the position that was open when this record was written. NOT attached_to_id: a capture attaches to the position TIP, which may be an earlier member.';
COMMENT ON COLUMN branch_memberships.source IS
  '''recorded'' (from the live position — a fact) | ''legacy-approx'' (migration 086 backfill from a pre-migration position edge''s to_id — correct for a directly-attached write, WRONG in the under-counting direction for a tip-chained one, and unrecoverable). Consumers MUST surface the difference: branch_history reports approximateMembers / possiblyIncomplete / exact.';

-- THE ACCESS PATH. Every membership read is `project_id = $1 AND spine_id = $2` ordered by
-- write time (branch_history returns members "in the order they were written"), and
-- getBranches groups by spine within a project scope. created_at is the third column so the
-- ORDER BY is served by the same index rather than a sort.
CREATE INDEX IF NOT EXISTS idx_branch_memberships_spine
  ON branch_memberships (project_id, spine_id, created_at);

COMMENT ON INDEX idx_branch_memberships_spine IS
  'The branch-membership access path (SK2): members of one spine within one project, in write order. Serves branch_history''s read and treewalkerTiers.getBranches'' GROUP BY.';

-- ── 2. THE BACKFILL — AN APPROXIMATION, NEVER PRESENTED AS A FACT ──────────────────────
-- Pre-migration membership lives only as `links.mint_via = 'position'` rows, and those rows
-- do not say which BRANCH they were written on: for a tip-attached capture, to_id is the tip
-- and the root is not recoverable. Setting spine_id = to_id is correct for a directly
-- attached member and WRONG — in the UNDER-counting direction — for a tip-chained one.
-- Under-counting is chosen deliberately: omitting a record is visible and recoverable,
-- whereas ABSORBING another branch's records is the defect this task exists to fix and is
-- indistinguishable from truth. Every such row is marked 'legacy-approx'.
--
-- WHAT IS **NOT** BACKFILLED, and this is the important half: the ~1,760 corpus-wide records
-- that TAG a spine but carry no position edge. Most predate branches entirely or were
-- genuinely written unpositioned, so admitting them as approximate members would turn a 50%
-- UNDER-count into a worse OVER-count — which is round 1's defect, re-created. They are
-- reported instead as a THIRD BAND ("N records tag this spine but carry no recorded
-- position"), surfaced by branch_history and never merged into the member count.
--
-- DISTINCT ON: the PK admits one position per record. Measured on prod, zero records have
-- more than one position edge, so this picks nothing today; it is here so that if the
-- population ever violates the model the migration takes the EARLIEST write rather than
-- failing at 3am on an arbitrary row.
INSERT INTO branch_memberships
  (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source,
   project_id, created_at)
SELECT DISTINCT ON (l.from_id)
       l.from_id, l.from_type, l.to_id, l.to_type, l.to_id, l.to_type, 'legacy-approx',
       l.project_id, l.created_at
  FROM links l
 WHERE l.mint_via = 'position'
   AND l.project_id IS NOT NULL
   AND l.from_id <> l.to_id
   AND l.from_type IN ('context', 'decision', 'task')
   AND l.to_type   IN ('context', 'decision', 'task')
 ORDER BY l.from_id, l.created_at ASC
ON CONFLICT (record_id) DO NOTHING;

-- THE BACKFILL IS NOT ALLOWED TO DROP ROWS SILENTLY. The four filters above exist to keep
-- the table's own constraints satisfiable, and each one is a way a legacy row could vanish
-- without anyone noticing. Measured on prod 2026-08-15 all four exclude ZERO rows
-- (`SELECT count(*) FILTER (WHERE project_id IS NULL), ... FROM links WHERE
--  mint_via='position'` -> 0|0|0 of 88), so a nonzero difference here means the population
-- changed and someone must look. It ABORTS rather than warns: a partially backfilled
-- membership table reports a confidently short branch, which is the whole defect class.
DO $$
DECLARE
  n_source  bigint;
  n_landed  bigint;
BEGIN
  SELECT count(DISTINCT from_id) INTO n_source FROM links WHERE mint_via = 'position';
  SELECT count(*) INTO n_landed FROM branch_memberships WHERE source = 'legacy-approx';
  IF n_landed <> n_source THEN
    RAISE EXCEPTION
      '086 backfill dropped rows: % distinct records carry a position edge but only % legacy-approx membership rows exist. A filter in the INSERT excluded a row shape that did not exist when this was written; find it before proceeding.',
      n_source, n_landed;
  END IF;
END $$;

-- ── 3. THE VIEW — THE PREDICATE, SPELLED ONCE ──────────────────────────────────────────
-- WHY A VIEW AND NOT A SHARED CONSTANT. The membership predicate was being spelled TWICE, in
-- two languages, in two packages, and the two copies DISAGREED:
--
--   * mcp-server read edges minted by position (services/branchMembership.ts).
--   * mandrel-command's dashboard read provenance_class='declared' AND edge_type='informs'
--     (services/treewalkerTiers.ts getBranches) — a strict SUPERSET, since `declared` is
--     also true for tag-, links-param-, decision-evidence- and task-dependency-minted edges.
--
--   MEASURED ON PROD 2026-08-15:
--     an earlier spine   loose predicate: 17 members   |   position edges: 9
--     corpus-wide      loose predicate: 1979         |   position edges: 77
--
-- The backend CANNOT import mcp-server TypeScript (measured, documented at
-- mandrel-command/backend/src/config/treewalkerTrustModel.ts: mcp-server/src is not in the
-- backend's Docker build context). The house workaround elsewhere is a duplicated constant
-- plus a parity test — the weak version, which keeps two copies and asserts they agree. Both
-- packages already talk to the SAME Postgres, so the predicate lives in exactly one place
-- both must go through. There is no second copy that CAN drift.
--
-- THE LEFT JOIN, AND WHY IT IS LEFT. The membership row is the fact; the `informs` edge is
-- the GRAPH's rendering of it, and the two are now genuinely independent. The join reports
-- which edge (if any) carries this membership in the graph and how THAT edge was minted —
-- which is often 'tag' rather than 'position', precisely because of the dedup this migration
-- stops depending on. A member whose edge was later unlinked joins to NULL and is still a
-- member; that is the durability the table was created for, so an INNER join here would
-- quietly re-introduce the defect.
-- DROP first, not CREATE OR REPLACE: this migration was rewritten in place (see the header),
-- and CREATE OR REPLACE cannot change a view's column list or their order. A DB provisioned
-- from an earlier draft of 086 would fail on REPLACE with a misleading error about column
-- types; DROP + CREATE in the migration's transaction is the honest form.
DROP VIEW IF EXISTS branch_membership;
CREATE VIEW branch_membership AS
SELECT
  bm.record_id          AS id,
  bm.record_id          AS member_id,
  bm.record_type        AS member_type,
  bm.spine_id,
  bm.spine_type,
  bm.attached_to_id,
  bm.attached_to_type,
  bm.source             AS spine_source,
  bm.project_id,
  bm.created_at,
  -- FROM THE GRAPH EDGE, NULLABLE. Not the membership predicate — provenance of the edge
  -- that renders it. NULL means "no informs edge survives", not "not a member".
  l.edge_type,
  l.created_by,
  l.mint_via,
  l.provenance_class
FROM branch_memberships bm
LEFT JOIN links l
       ON l.from_id   = bm.record_id
      AND l.to_id     = bm.attached_to_id
      AND l.edge_type = 'informs';

COMMENT ON VIEW branch_membership IS
  'THE branch-membership predicate, in one place (SK2). A record is a member of a branch iff `branch_memberships` says so: one row per record, written by positionalMint at the membership decision. spine_id is the branch ROOT — NOT attached_to_id, which is where the graph edge points (the root for a create, the branch TIP for a capture). Flat equality, no traversal: `spine_id = <root> AND project_id = <p>`. edge_type/mint_via/provenance_class/created_by come from a LEFT JOIN to the surviving `informs` edge and describe THAT edge, not membership — they are frequently mint_via=''tag'' (an earlier tag mint won the ON CONFLICT triple) and may be NULL (the edge was unlinked); neither makes the record any less a member. spine_source flags pre-086 rows as ''legacy-approx'' — consumers must surface that, not hide it. Consumers: mcp-server services/branchMembership.ts (branch_history) and mandrel-command services/treewalkerTiers.ts getBranches, which compute the SAME set.';

-- ── 4. THE OPEN-BRANCH LOOKUP ──────────────────────────────────────────────────────────
-- "Is any session currently standing on this branch?" is answered by looking up
-- branch_positions BY SPINE. The table's only index is its PK (project_id, session_key), so
-- every such lookup is a sequential scan today — measured on prod 2026-08-15:
--
--   EXPLAIN ANALYZE SELECT DISTINCT spine_id FROM branch_positions WHERE spine_id = '<uuid>';
--   ->  Seq Scan on branch_positions  (rows=1) (Rows Removed by Filter: 37)
--
-- At 39 rows the planner will still choose that seq scan, and it should — this index does
-- not make today's query faster and this migration does not claim it does. It exists because
-- the access PATH is wrong, not because the current row count hurts: branch_positions grows
-- with (projects x concurrent sessions), the lookup runs on every branch_history call and on
-- every dashboard branch-list render (treewalkerTiers.ts getBranches), and the point at which
-- a seq scan starts costing is not a point anyone will be watching for.
--
-- LEADING COLUMN IS project_id, not spine_id: both readers are project-scoped
-- (`project_id = ANY($1) AND spine_id = ...` / `... AND spine_id = ANY($2)`), so this index
-- serves the scoped point lookup AND getBranches' scoped `SELECT DISTINCT spine_id`. A
-- spine_id-only index would serve the first and not the second.
CREATE INDEX IF NOT EXISTS idx_branch_positions_spine
  ON branch_positions (project_id, spine_id);

COMMENT ON INDEX idx_branch_positions_spine IS
  'Reverse lookup: which sessions are standing on this spine (SK2). branch_positions is keyed (project_id, session_key), so answering "is this branch open" had no access path but a seq scan. project_id leads because both readers are project-scoped: branch_history''s open-check and treewalkerTiers.getBranches'' DISTINCT spine_id.';

DO $$
DECLARE
  n_total  bigint;
  n_approx bigint;
  n_tagonly bigint;
BEGIN
  SELECT count(*) INTO n_total  FROM branch_memberships;
  SELECT count(*) INTO n_approx FROM branch_memberships WHERE source = 'legacy-approx';
  -- THE THIRD BAND, reported at migrate time so its size is a measured number rather than a
  -- claim in a comment: records that tag a spine but carry no recorded position. These are
  -- deliberately NOT members (see the backfill note) and are surfaced separately by
  -- branch_history as `tagOnlyNoPosition`.
  SELECT count(DISTINCT l.from_id) INTO n_tagonly
    FROM links l
   WHERE l.mint_via = 'tag'
     AND l.edge_type = 'informs'
     AND NOT EXISTS (SELECT 1 FROM branch_memberships m WHERE m.record_id = l.from_id);
  RAISE NOTICE '✅ 086: branch_memberships table + branch_membership view + 2 indexes. % membership rows (% backfilled as legacy-approx). % records tag a spine with no recorded position — the third band, reported separately and never counted as members.', n_total, n_approx, n_tagonly;
END $$;
