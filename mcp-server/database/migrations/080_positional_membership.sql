-- Migration 080: POSITIONAL MEMBERSHIP — session branch positions, the `subtask_of`
-- structural edge, and D1 (demote the retired anchor's strong `informs` mints).
-- (PHASE 1 of the positional-membership plan.)
--
-- WHY: branch membership was GUESSED (embedding
-- similarity, TTL windows) or depended on a human remembering thread_set — a habit measured
-- decaying to zero (anchor set in 25 of 288 sessions; the mechanism starved to death
-- 2026-07-28 and a 97-98% coverage metric hid it for 15 days). Membership is now POSITIONAL,
-- like git: each session/connection carries a current branch and every write stamps a
-- DECLARED edge to it. No TTL, no similarity gate, no guess.
--
-- THREE PARTS, one migration (the task requires D1 ride WITH the feature):
--
--   1. `branch_positions` — the per-(project, session) current-branch position. Same keying
--      shape as `active_thread_anchors` (the X-Connection-ID isolation model), but NO TTL
--      semantics: a position lives until branch_close / re-open. The spine may be a context,
--      decision, OR task (spine-first, not task-first — the fold-in), so spine_id
--      is a soft reference (no FK; endpoints span three tables, same reasoning as links).
--
--   2. `subtask_of` edge type — the structural parent edge (task → task), minted at
--      task_create while POSITIONED ON A TASK SPINE. Closes the epic→subtask hole from
--      an earlier decision follow-up 3 (`2b3c4d5e` was lost because nothing structural links
--      epics to subtasks). Migration 066 deliberately declined `subtask_of` because a
--      `task:` TAG is an ambiguous signal; POSITION is not — you are standing on the parent
--      when you create the child. A strong edge earns its strength from a strong signal, and
--      this one now exists. NOT AN OUTCOME EDGE: `subtask_of` must never enter
--      services/trust.ts OUTCOME_OUT_EDGE_TYPES (scheduling/containment structure, not
--      evidence) — enforced by the load-time assertion there.
--      The value list below is the materialized projection of
--      mcp-server/src/config/edgeTypes.ts edgeTypeCheckSqlList() (same shape as 054/059/066).
--
--   3. D1 — the anchor (`auto:active_thread`) is RETIRED as a strong-edge minter,
--      permanently. Its historical strong mints — BOTH `informs` AND `decided_by` — are
--      DEMOTED to the weak tier (`related_to`), with provenance preserved: created_by
--      stays 'auto:active_thread' (so the 079 meter still classifies them GUESSED) and
--      the original edge_type + demotion timestamp land in metadata. Records stay
--      REACHABLE — recall_thread walks related_to — they just no longer carry
--      trust-bearing strength (the requirement: demotion must not silently
--      delete what blanket-P6 would have).
--      SCOPE (the coordinator ruling 2026-08-13, widening the task text's informs-only wording):
--      the task's D1 line said `informs` because the audit counted informs, but a
--      trust-bearing `decided_by` minted by the same similarity guess is the same defect
--      in a different edge type — "the anchor mints nothing strong" (an earlier decision /
--      the position design) covers both. Measured on prod 2026-08-13 before this migration:
--      SELECT edge_type, count(*) FROM links WHERE created_by='auto:active_thread' GROUP BY 1
--      → informs 157, decided_by 111.
--      DEDUP COLLISION: links dedups on UNIQUE(from_id, to_id, edge_type); where a
--      related_to twin already exists for a pair, the demoting UPDATE would collide — so
--      those strong rows are DELETED instead, after stamping the surviving twin with
--      d1_absorbed_informs / d1_absorbed_decided_by (reachability via the twin is
--      preserved; nothing is silently lost). All counts are RAISEd.
--      IDEMPOTENT: every statement keys on created_by='auto:active_thread' AND
--      edge_type IN ('informs','decided_by') — after one run that population is empty,
--      so a re-run mints, updates, and deletes nothing.
--
-- ADDITIVE / IDEMPOTENT / ABOVE BASELINE_THROUGH: safe on fresh and baselined instances.
-- The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated in the
-- same commit.

-- ── 1. The per-session branch position ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_positions (
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  spine_id    UUID NOT NULL,
  spine_type  TEXT NOT NULL CHECK (spine_type IN ('context', 'decision', 'task')),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, session_key)
);

COMMENT ON TABLE branch_positions IS
  'PHASE 1 positional membership: the per-(project, session) CURRENT BRANCH. Every write made while positioned stamps a declared informs edge (created_by auto:positional) to the spine. Keyed exactly like active_thread_anchors (the X-Connection-ID isolation shape); NO TTL — a position lives until branch_close or re-open. spine_id is a soft reference (context/decision/task span three tables).';

-- ── 2. Widen the edge-type domain with `subtask_of` ─────────────────────────
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes', 'possibly_supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome', 'depends_on',
  'subtask_of', 'related_to'
));

-- ── 3. D1 — demote ALL the anchor's strong mints (informs + decided_by) ─────
DO $$
DECLARE
  demoted_informs     INT;
  demoted_decided_by  INT;
  absorbed_count      INT;
  remaining           INT;
BEGIN
  -- 3a. Stamp the surviving related_to twin where one already exists (the strong row for
  -- that pair will be deleted below, not converted — the UNIQUE(from,to,type) dedup).
  -- The stamp names WHICH strong type the twin absorbed (d1_absorbed_informs /
  -- d1_absorbed_decided_by), so nothing about the deletion is unattributable.
  UPDATE links r
     SET metadata = COALESCE(r.metadata, '{}'::jsonb)
                    || jsonb_build_object('d1_absorbed_' || l.edge_type, true,
                                          'd1_absorbed_at', now()::text)
    FROM links l
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  IN ('informs', 'decided_by')
     AND r.from_id    = l.from_id
     AND r.to_id      = l.to_id
     AND r.edge_type  = 'related_to';

  -- 3b. Delete the strong rows whose related_to twin exists (conversion would collide).
  -- NOTE: if a pair carried BOTH an informs and a decided_by anchor mint, 3c would also
  -- collide converting the second one — but both are covered here, because after this
  -- DELETE at most one strong anchor row per (from,to) remains only when NO related_to
  -- twin exists, and 3c converts the lower-priority type second (see 3c ordering).
  DELETE FROM links l
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  IN ('informs', 'decided_by')
     AND EXISTS (SELECT 1 FROM links r
                  WHERE r.from_id = l.from_id
                    AND r.to_id   = l.to_id
                    AND r.edge_type = 'related_to');
  GET DIAGNOSTICS absorbed_count = ROW_COUNT;

  -- 3c. Demote the rest in place: strong → related_to, provenance preserved
  -- (original_edge_type carries which strong type each row was). Converted PER TYPE, and
  -- informs first: if one (from,to) pair somehow carries BOTH anchor types with no twin,
  -- the informs conversion creates the related_to row and the decided_by pass then takes
  -- the 3b-shaped path below (absorb-and-delete) instead of colliding.
  UPDATE links l
     SET edge_type = 'related_to',
         metadata  = COALESCE(l.metadata, '{}'::jsonb)
                     || jsonb_build_object('d1_demoted', true,
                                           'original_edge_type', 'informs',
                                           'demoted_at', now()::text)
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  = 'informs';
  GET DIAGNOSTICS demoted_informs = ROW_COUNT;

  -- The both-types-on-one-pair guard for the second pass (same shape as 3a+3b).
  UPDATE links r
     SET metadata = COALESCE(r.metadata, '{}'::jsonb)
                    || jsonb_build_object('d1_absorbed_decided_by', true,
                                          'd1_absorbed_at', now()::text)
    FROM links l
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  = 'decided_by'
     AND r.from_id    = l.from_id
     AND r.to_id      = l.to_id
     AND r.edge_type  = 'related_to';
  DELETE FROM links l
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  = 'decided_by'
     AND EXISTS (SELECT 1 FROM links r
                  WHERE r.from_id = l.from_id
                    AND r.to_id   = l.to_id
                    AND r.edge_type = 'related_to');

  UPDATE links l
     SET edge_type = 'related_to',
         metadata  = COALESCE(l.metadata, '{}'::jsonb)
                     || jsonb_build_object('d1_demoted', true,
                                           'original_edge_type', 'decided_by',
                                           'demoted_at', now()::text)
   WHERE l.created_by = 'auto:active_thread'
     AND l.edge_type  = 'decided_by';
  GET DIAGNOSTICS demoted_decided_by = ROW_COUNT;

  SELECT count(*) INTO remaining
    FROM links
   WHERE created_by = 'auto:active_thread' AND edge_type IN ('informs', 'decided_by');

  RAISE NOTICE '✅ 080 positional membership: branch_positions ready; edge domain + subtask_of; D1 demoted % informs + % decided_by → related_to, absorbed % into existing related_to twins (first pass), % strong anchor edges remaining (must be 0).',
    demoted_informs, demoted_decided_by, absorbed_count, remaining;
END $$;
