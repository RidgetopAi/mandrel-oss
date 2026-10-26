-- Migration 082: AUTO-OPEN POSITIONS + the trunk-revert coordinator detector, and the
-- Q3 zero-declared-inbound meter.
-- (design an earlier context.)
--
-- WHY (the measured gap, not a theory): the first customer-shaped session against v0.22.0
-- prod — the operator's Pi agent "rivet", a small model with zero house habits, building a weather
-- app in project `rivet-weather` — ended with its decision and its task
-- each carrying ZERO inbound edges. "What this decision shaped" rendered empty,
-- correctly, because nothing pointed at it. Two independent legs caused it: the agent never
-- read the `branch_open <id8>` OFFER (small models do not read response prose), so no
-- position ever existed; and the weak inference fallback is context->context only, so a
-- decision or a task can never be rescued by a guess. Rivet did the RIGHT first acts and
-- the system demanded a SECOND, separate act to make them count.
--
-- THE RULE SET this migration's columns encode ("breadth reverts to trunk, depth extends
-- the branch"). The rules themselves live in ONE place, src/services/positionalMint.ts —
-- these columns are only the state they read and write:
--
--   origin        — HOW the position came to exist, and therefore which rule set governs it:
--                     'declared' = branch_open / task_claim / task_update(in_progress).
--                                  P1 semantics, BYTE-IDENTICAL to v0.23.0. Explicit intent
--                                  outranks every byproduct (R0 — the single most important
--                                  invariant in this change).
--                     'auto'     = opened as a byproduct of a create by an UNPOSITIONED
--                                  session (R1). Carries tip + member_writes.
--                     'trunk'    = the session fanned out (R2) and reverted to trunk; it
--                                  mints no membership and auto-opens nothing for the rest
--                                  of its life. Only a DECLARED act exits (R5).
--                   ONE state field rather than a pair of booleans, so "auto AND trunk" is
--                   structurally unreachable rather than merely never written.
--                   NOTE for origin='trunk': spine_id retains the record the session
--                   reverted FROM. It is provenance, not a position — nothing is minted to
--                   it. branch_current renders trunk as trunk, never as "standing on" it.
--
--   tip_id/type   — R3/R4 depth. A cross-type create on an auto position mints informs to
--                   the ROOT (spine_id) and becomes the TIP; subsequent captures inform the
--                   TIP. NULL tip means "tip = root", which is why a DECLARED position —
--                   where the tip is never set — behaves exactly as it did in P1.
--                   Minting to the ROOT rather than the tip is deliberate and measured: it
--                   keeps the whole thread inside recall_thread's defaultDepth
--                   (mcp-server/src/config/threadConfig.ts, defaultDepth 2).
--
--   member_writes — R2 virginity. A position is VIRGIN while zero member writes have been
--                   made from it. A SECOND same-type create on a still-virgin auto position
--                   is fan-out (a coordinator batching siblings), not depth.
--
-- NO TTL, NO new config key, NO new env var, nothing required of any customer agent —
-- the same three refusals P1 made, for the same reasons.
--
-- ALSO HERE — THE Q3 METER: inference-widening to decision/task targets
-- is DEFERRED because a guess can never mint trust and therefore cannot close the measured
-- gap. What ships instead is the INSTRUMENT that decides whether widening ever earns a
-- designed pass: the zero-declared-inbound RATE for decisions and tasks — literally the
-- shape rivet's session produced. Same doctrine as the 079 meter: the SQL view is the
-- single source; no TypeScript re-spells the classification.
--
-- ADDITIVE / IDEMPOTENT / ABOVE BASELINE_THROUGH (42): safe on fresh and baselined
-- instances. Every statement is IF NOT EXISTS or CREATE OR REPLACE, so a re-run is a no-op.
-- The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated in the
-- same commit.

-- ── 1. The auto-open state on the position row ───────────────────────────────
ALTER TABLE branch_positions
  ADD COLUMN IF NOT EXISTS origin        TEXT    NOT NULL DEFAULT 'declared',
  ADD COLUMN IF NOT EXISTS tip_id        UUID,
  ADD COLUMN IF NOT EXISTS tip_type      TEXT,
  ADD COLUMN IF NOT EXISTS member_writes INTEGER NOT NULL DEFAULT 0;

-- Every EXISTING row predates auto-open and was therefore opened by a declared act
-- (branch_open / task_claim / task_update) — the DEFAULT above is the correct backfill,
-- and it is the value that preserves R0 for every position already standing.

ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_origin_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_origin_check
  CHECK (origin IN ('declared', 'auto', 'trunk'));

ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_tip_type_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_tip_type_check
  CHECK (tip_type IS NULL OR tip_type IN ('context', 'decision', 'task'));

-- tip_id and tip_type are set and cleared together, always. The pair is the R3/R4 TIP;
-- a half-set pair would make "tip = root when null" ambiguous at read time.
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_tip_pair_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_tip_pair_check
  CHECK ((tip_id IS NULL) = (tip_type IS NULL));

-- R0, IN THE DATABASE rather than only in the service: a DECLARED position can never carry
-- a tip. Tip mechanics on declared positions is the anchor's mistake repeated (it is on the
-- design's already-rejected list), so the bad state is made unreachable instead of merely
-- unwritten. If a future edit to positionalMint.ts tries it, the write fails loudly here.
ALTER TABLE branch_positions DROP CONSTRAINT IF EXISTS branch_positions_declared_has_no_tip_check;
ALTER TABLE branch_positions ADD CONSTRAINT branch_positions_declared_has_no_tip_check
  CHECK (origin <> 'declared' OR tip_id IS NULL);

COMMENT ON COLUMN branch_positions.origin IS
  'HOW this position came to exist, and which rule set governs it: declared = branch_open/task_claim/task_update(in_progress), P1 semantics byte-identical to v0.23.0 (R0); auto = opened as a byproduct of a create by an unpositioned session (R1); trunk = the session fanned out (R2) and reverted, minting nothing until a declared act (R5). For trunk rows spine_id retains the record reverted FROM — provenance, not a position.';
COMMENT ON COLUMN branch_positions.tip_id IS
  'R3/R4 TIP: the deepest record on an auto branch. NULL means tip = root (spine_id), which is why declared positions behave exactly as in P1. Membership from a cross-type create is minted to the ROOT, not the tip, to stay inside recall_thread defaultDepth.';
COMMENT ON COLUMN branch_positions.member_writes IS
  'R2 virginity counter: member writes made from this position. Zero = VIRGIN; a second same-type create on a still-virgin auto position is fan-out (coordinator), not depth.';

-- ── 2. THE Q3 METER — zero-declared-inbound rate for decisions and tasks ─────
-- Grain 1: one row per decision/task with its DECLARED inbound edge count. Classification
-- is READ from link_provenance (migration 079) — the single source — never re-spelled here.
CREATE OR REPLACE VIEW record_declared_inbound AS
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
-- to_type is joined as well as to_id: an inbound edge is only this record's when the edge
-- itself says so. Matching on the id alone would silently absorb a same-id edge aimed at a
-- different node kind.
LEFT JOIN link_provenance lp
       ON lp.to_id = r.record_id
      AND lp.to_type = r.record_type
GROUP BY r.record_type, r.record_id, r.project_id, r.created_at;

COMMENT ON VIEW record_declared_inbound IS
  'Q3 METER, record grain: every decision and task with its DECLARED and GUESSED inbound edge counts. declared_inbound = 0 is exactly the shape the rivet session produced — a record nothing points at, whose "what this shaped" renders empty. Classification is read from link_provenance (079), the single source.';

-- Grain 2: the RATE, per week x project x record type. This is the number that decides
-- whether inference-widening (deferred in an earlier decision) ever earns a designed pass,
-- and the instrument for the accepted R2 misclassification risk.
CREATE OR REPLACE VIEW zero_declared_inbound_weekly AS
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

COMMENT ON VIEW zero_declared_inbound_weekly IS
  'Q3 METER, rate grain: share of decisions/tasks created per week x project that end with ZERO declared inbound edges. Q3 ruling — inference-widening to decision/task targets is DEFERRED because a guess can never mint trust; this meter is what decides whether it ever earns a designed pass, and it is the instrument that shows whether the accepted R2 coordinator-misclassification shape occurs at a rate that matters.';

DO $$
BEGIN
  RAISE NOTICE '✅ 082 auto-open positions: branch_positions gains origin/tip/member_writes (declared positions default to origin=declared — R0 preserved for every standing position); Q3 meter views record_declared_inbound + zero_declared_inbound_weekly created.';
END $$;
