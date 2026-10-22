-- Migration 089: A HANDOFF IS TRUNK MATERIAL BY TYPE — remove the branch memberships that
-- were minted before that was true. (P1.)
--
-- ── WHY ──────────────────────────────────────────────────────────────────────────────
-- A `handoff` is the project's resume point. It is addressed to whoever boots next, not to
-- the branch its author happened to be standing on, so WHAT IT IS must decide where it
-- lands — and where the author stood must not enter the decision at all.
--
-- Until the code change that ships with this migration, it did. Membership was minted
-- purely from position, with one escape hatch: the multi-name rule demoted a record naming
-- >= 2 task ids to TRUNK. That made the mechanism exactly inverted from the intent.
-- MEASURED ON PROD 2026-08-21, across the 33 handoffs written since positional membership
-- shipped 2026-08-13:
--   * 31 reached the trunk BY ACCIDENT — their ANCHORS section happened to name >= 2 task
--     ids, which tripped a heuristic that knows nothing about handoffs;
--   * the 2 that were trapped as branch members were trapped PRECISELY BECAUSE their
--     authors had opened a position deliberately, which is the one case the rule protects.
-- The more careful the session, the more likely its handoff was filed where nobody would
-- look for it.
--
-- ── WHAT THIS DELETES, AND WHY BOTH DELETES ARE REQUIRED ─────────────────────────────
-- Membership is carried on TWO surfaces, written independently by services/positionalMint
-- .ts (deliberately — migration 086's header explains why the row must not ride on the
-- edge):
--   1. the `branch_memberships` row — the FACT, read by branch_history / the briefing;
--   2. the `informs` edge with mint_via = 'position' — the same fact in the graph.
-- Deleting only (1) leaves a record the graph still renders as a member of that branch
-- while readBranchMemberSummaries does not list it: a NEW inconsistency of exactly the kind
-- 086 was written to remove. So both, in one migration.
--
-- WHAT IT DELIBERATELY LEAVES ALONE: the `related_to` edges with mint_via = 'trunk-ref'.
-- Those are a trunk record's attachment to each task it NAMES — they are what a trunk
-- record is supposed to have, they are still minted by the new code, and they are the
-- reason 31 of the 33 are findable at all.
--
-- ── CLASS-SHAPED, NOT TWO UUIDs ──────────────────────────────────────────────────────
-- The count is 2 on prod today. It is NOT 2 on a tenant, and this file runs on all of them
-- (docker-entrypoint.sh migrates before the server starts). The predicate is therefore the
-- CLASS — every context whose context_type is 'handoff' — which is also what makes the
-- migration idempotent: after it runs, the population it selects is empty, and the new code
-- can never re-add a member to it.
--
-- ── NO ABORT GUARD, DELIBERATELY (point 7) ────────────────────────
-- docker-entrypoint.sh runs migrations BEFORE exec'ing the server and scripts/migrate.ts
-- exits 1 on any failure, so a migration that aborts means the container never becomes
-- healthy — a boot loop across the whole fleet. Migration 086 carried an abort guard
-- because it RECONSTRUCTED data and a wrong reconstruction was worse than a stopped deploy.
-- This one reconstructs nothing: it deletes rows of one named class and computes no values.
-- There is no defect an abort guard here could catch, so every abort guard here would be a
-- boot-loop trigger with nothing on the other side of the trade.
--
-- The counts are RAISEd as notices instead — visible in the migrate log, unable to stop a
-- boot. Zero is a perfectly normal result (a fresh tenant, or a re-run).
--
-- Precedent for a data-cleanup DELETE in a migration: 080_positional_membership.sql:111,146
-- · 083_position_per_loop_purge.sql:19 · 087_supersedes_declared_only.sql:70.

-- ── 1. THE MEMBERSHIP ROWS ─────────────────────────────────────────────────────────────
DELETE FROM branch_memberships bm
 USING contexts c
 WHERE bm.record_id = c.id
   AND bm.record_type = 'context'
   AND c.context_type = 'handoff';

-- ── 2. THE POSITIONAL EDGES THAT CARRY THE SAME FACT IN THE GRAPH ─────────────────────
-- Scoped by mint_via = 'position' so a handoff's OTHER edges are untouched: its
-- 'trunk-ref' attachments, its 'handoff-timeline' supersedes, its tag and links-param
-- edges. mint_via has been NOT NULL and fail-closed since migration 085, so this predicate
-- cannot silently under-select through a null.
DELETE FROM links l
 USING contexts c
 WHERE l.from_id = c.id
   AND c.context_type = 'handoff'
   AND l.mint_via = 'position';

-- ── 3. REPORT (notices only — nothing here can fail the boot) ─────────────────────────
DO $$
DECLARE
  n_handoffs        bigint;
  n_left_members    bigint;
  n_left_edges      bigint;
  n_left_trunk_refs bigint;
BEGIN
  SELECT count(*) INTO n_handoffs FROM contexts WHERE context_type = 'handoff';

  SELECT count(*) INTO n_left_members
    FROM branch_memberships bm JOIN contexts c ON c.id = bm.record_id
   WHERE bm.record_type = 'context' AND c.context_type = 'handoff';

  SELECT count(*) INTO n_left_edges
    FROM links l JOIN contexts c ON c.id = l.from_id
   WHERE c.context_type = 'handoff' AND l.mint_via = 'position';

  SELECT count(*) INTO n_left_trunk_refs
    FROM links l JOIN contexts c ON c.id = l.from_id
   WHERE c.context_type = 'handoff' AND l.mint_via = 'trunk-ref';

  RAISE NOTICE '✅ 089: handoffs are TRUNK MATERIAL BY TYPE. handoffs in this database: %. Branch memberships remaining on a handoff: % (expected 0). mint_via=position edges remaining from a handoff: % (expected 0). trunk-ref edges DELIBERATELY KEPT: %.',
    n_handoffs, n_left_members, n_left_edges, n_left_trunk_refs;
END $$;
