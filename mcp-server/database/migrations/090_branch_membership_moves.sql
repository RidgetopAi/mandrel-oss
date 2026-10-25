-- Migration 090: MUTABLE BRANCH MEMBERSHIP — a record's branch can be DECLARED after the
-- fact, and every change to it leaves an append-only trace.
-- (P3 of the build spec.)
--
-- ══ WHAT CHANGES, AND WHY IT NEEDS STORAGE OF ITS OWN ════════════════════════════════════
-- Until now `branch_memberships.record_id` was a write-once fact: positionalMint inserted it
-- ON CONFLICT DO NOTHING, so the FIRST position won and a wrong one could only be corrected
-- by an author who never made it. That is not good enough, because the system opens
-- positions the author never asked for (auto/byproduct opens, services/branchPosition.ts) —
-- so the SYSTEM manufactures false memberships and nobody can fix them.
--
-- `branch_assign` / `branch_unassign` make membership correctable. That makes this the first
-- tool in the product that can REWRITE a previously immutable historical fact, and the audit
-- table below is the entire reason that is acceptable.
--
-- ══ WHY AN APPEND-ONLY TABLE AND NOT COLUMNS ═════════════════════════════════════════════
-- Migration 086 exists BECAUSE `branch_close` hard-deleted `branch_positions` — a durable
-- fact on a deletable carrier. An `UPDATE … SET spine_id` with a `previous_spine_id` column
-- is the same mistake one table further on: it is adequate for exactly one move, loses every
-- move but the last, and CANNOT represent an unassign at all (there is no row left to carry
-- the column). `to_spine_id IS NULL` in the table below is that event, and it is the one
-- thing no row-column scheme can express.
--
-- NO FK to `branch_memberships`: an unassign DELETEs the membership row, and its trace must
-- outlive it. A foreign key here would cascade away exactly the record we are keeping.
--
-- ══ THREE THINGS, ALL ADDITIVE ═══════════════════════════════════════════════════════════
--   1. WIDEN the `source` CHECK to admit 'assigned'.
--   2. CREATE the append-only `branch_membership_moves` table + its access index.
--   3. UPDATE the COMMENTs 086 wrote, which enumerate two source values and would otherwise
--      be a contract that no longer describes the column.
--
-- ⚠️ NO BACKFILL, AND THEREFORE NO `RAISE EXCEPTION` ABORT GUARD. This is deliberate and it
-- is the most important line in this file. `docker-entrypoint.sh` runs `tsx scripts/migrate.ts`
-- under `set -e` BEFORE exec'ing the server, and `migrate.ts` exits 1 on failure — so a
-- migration that aborts means the container never becomes healthy, which means a fleet boot
-- loop across all 8 instances. 086 earned its guard because it RECONSTRUCTED data and a
-- partial reconstruction is a confidently short branch. 090 reconstructs NOTHING: it widens a
-- CHECK and creates an empty table. Every abort guard here would be a boot-loop trigger with
-- no defect to catch.
--
-- Idempotent throughout (IF EXISTS / IF NOT EXISTS), so a re-run inserts nothing and changes
-- nothing. The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated in
-- the SAME commit — the CI gate STAGE 0c diffs against it.

-- ── 1. THE SOURCE CHECK, WIDENED ───────────────────────────────────────────────────────
-- 'assigned' = a human DECLARED this record's branch after the fact, through branch_assign.
-- It is NOT an approximation. It belongs on the TRUSTED side of the split alongside
-- 'recorded' — arguably ahead of it, since 'recorded' is an observation the system made at
-- mint time and this is an assertion somebody chose to make. config/membershipSourceConfig.ts
-- is where that classification lives (MEMBERSHIP_SOURCE_TRUST), and it is exhaustive over the
-- TS enum so a new value cannot enter unclassified.
--
-- WIDENING ONLY: the validation scan re-reads every existing row against the new predicate,
-- which every one of them satisfies (the new value is purely additive), and it takes ACCESS
-- EXCLUSIVE for the milliseconds that scan lasts on a table of this size.
ALTER TABLE branch_memberships DROP CONSTRAINT IF EXISTS branch_memberships_source_check;
ALTER TABLE branch_memberships
  ADD CONSTRAINT branch_memberships_source_check
  CHECK (source IN ('recorded', 'legacy-approx', 'assigned'));

-- ── 2. THE MOVE LOG ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_membership_moves (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- THE RECORD whose branch changed. NOT a foreign key to branch_memberships: an unassign
  -- deletes that row and this trace must survive it (see the header).
  record_id     UUID NOT NULL,

  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- WHERE IT CAME FROM. NULL = it had no membership at all before this event, i.e. this was
  -- a first ASSIGN rather than a move. Distinguishing those two is the point: "was never on
  -- a branch" and "was on branch A" are different histories.
  from_spine_id UUID,

  -- WHERE IT WENT. NULL = the membership was REMOVED (branch_unassign). This is the event a
  -- previous_spine_id column on branch_memberships cannot represent, because after an
  -- unassign there is no branch_memberships row left to carry it.
  to_spine_id   UUID,

  -- WHO DID IT — the X-Actor-ID the call presented, or the configured stand-in when the
  -- caller presented none (MEMBERSHIP_MOVE_CONFIG.unknownActor). Prod runs
  -- MANDREL_SESSION_REQUIRE_ACTOR=true, so on prod this is always a real principal. This is
  -- the column that makes rewriting an immutable fact acceptable rather than alarming.
  actor         TEXT NOT NULL,

  moved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional free-text WHY, supplied by the caller. Nullable because most corrections have
  -- no explanation worth storing and an empty string pretending to be one is worse.
  reason        TEXT,

  -- A move that changes nothing is not an event. The routes never write one (an assign onto
  -- the branch a record is already on returns `unchanged` and writes no row); this is the
  -- layer that holds against raw SQL.
  CONSTRAINT branch_membership_moves_not_noop
    CHECK (from_spine_id IS DISTINCT FROM to_spine_id),

  -- A move must move something. Both NULL would be a row asserting no membership before and
  -- none after — an event that did not happen. (Implied by the CHECK above, which rejects
  -- NULL/NULL because NULL IS NOT DISTINCT FROM NULL; stated separately so the intent
  -- survives an edit to either one.)
  CONSTRAINT branch_membership_moves_has_an_end
    CHECK (from_spine_id IS NOT NULL OR to_spine_id IS NOT NULL)
);

COMMENT ON TABLE branch_membership_moves IS
  'APPEND-ONLY AUDIT of every change to a record''s branch membership (P3). One row per branch_assign / branch_unassign that actually changed something. Never updated, never deleted by the product. NOT foreign-keyed to branch_memberships on purpose: an unassign deletes that row and this trace must outlive it. from_spine_id IS NULL = the record had no membership before (a first assign); to_spine_id IS NULL = the membership was REMOVED. Read back with branch_history / readMembershipMoves — branch_memberships.source=''assigned'' is the DENORMALIZED summary of this log on the hot read path, not a second source of truth: this table is the truth.';

COMMENT ON COLUMN branch_membership_moves.from_spine_id IS
  'The branch the record was a member of BEFORE this event, or NULL if it was a member of nothing (a first assign, not a move).';
COMMENT ON COLUMN branch_membership_moves.to_spine_id IS
  'The branch the record is a member of AFTER this event, or NULL if the membership was REMOVED (branch_unassign). The removal case is why this is a log and not a previous_spine_id column.';
COMMENT ON COLUMN branch_membership_moves.actor IS
  'The X-Actor-ID that made the change, or the configured stand-in when the caller presented none (MEMBERSHIP_MOVE_CONFIG.unknownActor). Any actor scoped to the project may reassign any record in it (Operator''s call) — there is no per-record ownership model, consistent with link/unlink; this column is what makes that accountable.';

-- THE ACCESS PATH: "show me this record's branch history", newest or oldest first.
CREATE INDEX IF NOT EXISTS idx_branch_membership_moves_record
  ON branch_membership_moves (record_id, moved_at);

COMMENT ON INDEX idx_branch_membership_moves_record IS
  'One record''s move history in time order (P3) — the only read shape this table has.';

-- ── 3. THE 086 COMMENTS, WHICH NOW ENUMERATE THREE VALUES ──────────────────────────────
-- 086 made surfacing `source` a CONTRACT in prose, and that prose lists the legal values. A
-- comment that enumerates two of three is a contract that no longer describes the column.
COMMENT ON COLUMN branch_memberships.source IS
  '''recorded'' (from the live position at mint time — a fact, written by positionalMint) | ''assigned'' (a human DECLARED this branch after the fact via branch_assign — also a fact, and the audit trail is branch_membership_moves) | ''legacy-approx'' (migration 086 backfill from a pre-migration position edge''s to_id — correct for a directly-attached write, WRONG in the under-counting direction for a tip-chained one, and unrecoverable). Consumers MUST surface the APPROXIMATE one: branch_history reports approximateMembers / possiblyIncomplete / exact. Which values are approximate is defined in ONE place, config/membershipSourceConfig.ts MEMBERSHIP_SOURCE_TRUST — never as `source <> ''recorded''`, which would classify a declared assignment as an approximation.';

COMMENT ON TABLE branch_memberships IS
  'WHICH BRANCH EACH WRITE BELONGS TO (SK2, made correctable by P3). One row per record. Written by services/positionalMint.ts at the membership decision — INDEPENDENTLY of edge minting, because the `informs` edge it also mints can be deduped away by an earlier tag mint on the same (from,to,edge_type) triple and membership must not ride on that. It is also written and MOVED by branch_assign, and DELETED by branch_unassign, both of which append to branch_membership_moves; created_at is never touched by a move, because it is the branch''s write-order key. PK on record_id encodes the model: a record belongs to one branch. Read through the branch_membership VIEW, which is the single predicate both mcp-server (services/branchMembership.ts -> branch_history) and mandrel-command (services/treewalkerTiers.ts getBranches) go through.';

DO $$
DECLARE
  n_moves bigint;
BEGIN
  SELECT count(*) INTO n_moves FROM branch_membership_moves;
  RAISE NOTICE '✅ 090: branch_memberships.source widened to (recorded, legacy-approx, assigned); branch_membership_moves append-only audit table + index created (% existing move rows). No backfill — nothing to reconstruct.', n_moves;
END $$;
