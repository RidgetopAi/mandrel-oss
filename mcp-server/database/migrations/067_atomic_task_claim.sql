-- Migration 067: ATOMIC TASK CLAIM — CAS + lease fenced by a server-minted claim_id,
-- plus an insert-only claim audit (SPEC v1 §6.2).
--
-- WHY: `task_update` is an unconditional last-writer-wins write — the UPDATE's WHERE is
-- `id` ONLY (handlers/tasks.ts:331), with no project, status, or assignee guard. A second
-- worker that OBSERVES an active assignment can overwrite it and BOTH calls return success
-- (externally reproduced: Amp-orb evaluation probe). Independent agents therefore
-- cannot safely coordinate THROUGH Mandrel — every multi-agent topology is forced back onto
-- a single trusted scheduler. We already patched around this once with a file lock
-- (runtime/control-plane/dispatch-claim.ts, which says verbatim "since a bare task_update
-- has no compare-and-swap"). This is the whole-class fix ([[no-patching-permanent-fixes]]).
--
-- SCOPE (all ADDITIVE — no destructive DDL, no data rewrite, no column drop/retype):
--   1. tasks.version           — integer NOT NULL DEFAULT 0, the CAS/optimistic-lock counter.
--   2. tasks.claim_id          — uuid, SERVER-MINTED. THE FENCING TOKEN.
--   3. tasks.claim_actor       — varchar(200), ATTRIBUTION ONLY. Never the lock key.
--   4. tasks.claim_expires_at  — timestamptz, the lease deadline.
--   5. trigger_bump_tasks_version — a BEFORE UPDATE trigger that OWNS the version bump.
--   6. task_claim_events       — insert-only immutable audit of every claim attempt.
--   7. two partial indexes for the live-claim / expiry lookups + one audit lookup index.
--
-- WHY claim_id AND NOT claim_actor IS THE LOCK KEY (SPEC D2): `assigned_to`/`claim_actor` is
-- a free-form varchar(200) — not an FK, not a uuid, validated against no actor registry. If
-- mutual exclusion were keyed on the actor string, two builders, two tick runs, or any two
-- callers that share an actor name would BOTH satisfy the predicate and BOTH "hold" the
-- claim — decorative exactly for the collision class this migration exists to kill. Re-entry
-- and renewal require presenting the matching claim_id, so correctness is also fully
-- decoupled from the (separately blocked) actor-normalization work.
--
-- WHY THE VERSION BUMP LIVES IN A TRIGGER (SPEC D4): `version` is a LIE unless EVERY write
-- bumps it, and three write paths are unguarded — the ordinary task_update (tasks.ts:331),
-- the mandrel-command backend (services/task.ts:474), and bulkUpdateTasks (tasks.ts:478). An
-- `expectedVersion` CAS that passes while the row changed underneath via one of those paths
-- is WORSE than no version at all. Putting the bump in a trivial BEFORE UPDATE trigger makes
-- it surface-independent BY CONSTRUCTION: every UPDATE through every path, present and
-- future (including raw psql and future migrations), bumps it. This is the one piece of
-- DB-level enforcement the spec takes (§6.7/§7) — it is mechanical, not policy.
--
-- TRIGGER ORDER: Postgres fires same-timing triggers in NAME order, so
-- `trigger_bump_tasks_version` runs BEFORE the pre-existing `trigger_update_tasks_updated_at`.
-- The two touch disjoint columns (version vs updated_at) so the order is immaterial; it is
-- recorded here only so a future reader does not have to re-derive it.
--
-- AUDIT IMMUTABILITY: task_claim_events follows the house `session_activities` shape
-- (insert-only, typed event + jsonb + occurred_at). It is additionally IMMUTABLE by DB
-- enforcement: a BEFORE UPDATE trigger raises, so no code path — not even raw psql — can
-- rewrite history. DELETE is deliberately LEFT OPEN because retention/rollup pruning must
-- remain possible (see RETENTION below).
--
-- RETENTION (stated up front so it is a decision, not a surprise — SPEC §6.4): every claim
-- ATTEMPT writes a row, so a hot contended board grows this table fast. The expectation is
-- time-based pruning at MANDREL_TASK_CLAIM_EVENT_RETENTION_DAYS (default 90; see
-- src/config/claimConfig.ts), executed by TaskClaimService.pruneEvents(). Scheduling that
-- sweep on a timer/cron is a NAMED FOLLOW-UP, not part of this migration.
--
-- IDEMPOTENT / ADDITIVE / BACKWARD-COMPATIBLE:
--   * Every DDL statement is IF NOT EXISTS / DROP-then-CREATE — safe to re-run.
--   * All four new task columns are NULLABLE or DEFAULTed, so existing rows are valid the
--     instant they are added; nothing is rewritten and no existing query changes meaning.
--   * The feature itself ships DARK: src/config/claimConfig.ts defaults
--     MANDREL_TASK_CLAIM_ENABLED=false, so with this schema in place the runtime behaves
--     EXACTLY as it does today until the flag is flipped (migrate, deploy, and
--     enable are three separate decisions). The version trigger is the one exception and is
--     intentionally always-on: it writes only the new column, which nothing read before.
--   * ROLL-FORWARD ONLY: pinning code back does not revert schema (that is safe here —
--     old code simply ignores the new columns).
--
-- This migration number (067) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include the
-- new columns/table/indexes so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

-- 1. The CAS / optimistic-lock counter. ----------------------------------------------------
--    DEFAULT 0 + NOT NULL: every one of the existing rows reads as version 0 immediately,
--    with no backfill pass, and the trigger below takes over from the first UPDATE onward.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

-- 2-4. The claim triple. --------------------------------------------------------------------
--    claim_id is the ONLY exclusion token. claim_actor mirrors the assigned_to width (200)
--    because it carries the same free-form actor string, for ATTRIBUTION.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claim_id uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claim_actor character varying(200);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claim_expires_at timestamp with time zone;

COMMENT ON COLUMN public.tasks.version IS
  'Optimistic-lock counter. Bumped by trigger_bump_tasks_version on EVERY update (surface-independent). Used by the task claim''s optional expectedVersion CAS.';
COMMENT ON COLUMN public.tasks.claim_id IS
  'Server-minted fencing token for the atomic task claim. THE exclusion key — mutual exclusion is NEVER keyed on claim_actor/assigned_to (free-form, no FK).';
COMMENT ON COLUMN public.tasks.claim_actor IS
  'Who holds the claim — ATTRIBUTION ONLY, never the lock key (see claim_id).';
COMMENT ON COLUMN public.tasks.claim_expires_at IS
  'Lease deadline. A claim with claim_expires_at <= now() is EXPIRED and re-claimable by anyone.';

-- 5. The version-bump trigger — the one piece of DB-level enforcement (SPEC D4/§6.7). -------
CREATE OR REPLACE FUNCTION public.bump_tasks_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Deliberately unconditional: any UPDATE of the row is a new version, whatever columns it
  -- touched and WHICHEVER write path issued it. A conditional bump would reintroduce exactly
  -- the surface-dependence this trigger exists to remove.
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_bump_tasks_version ON public.tasks;
CREATE TRIGGER trigger_bump_tasks_version
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.bump_tasks_version();

-- 6. The immutable claim audit. -------------------------------------------------------------
--    Shape follows the house session_activities pattern (insert-only, typed event + jsonb +
--    occurred_at) with the claim-specific columns promoted out of jsonb because they are
--    QUERIED (who held what, at which version, and why an attempt was refused).
CREATE TABLE IF NOT EXISTS public.task_claim_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    project_id uuid,
    -- What happened: claim_won | claim_reentered | claim_rejected | renewed | renew_rejected |
    -- released | release_rejected | fence_rejected | force_override | claim_cleared.
    -- Vocabulary lives in src/services/taskClaim.ts (TASK_CLAIM_EVENT); intentionally NOT a
    -- DB CHECK so adding an event type never needs a migration on the fleet.
    event_type character varying(40) NOT NULL,
    -- won | rejected | ok — the coarse outcome, for cheap aggregate reads.
    outcome character varying(20) NOT NULL,
    -- Attribution only (mirrors tasks.claim_actor).
    actor character varying(200),
    -- The claim token this event is ABOUT (the winner's token, or the token a loser presented).
    claim_id uuid,
    -- The token that was on the row BEFORE this event (NULL when the row was unclaimed).
    previous_claim_id uuid,
    old_version integer,
    new_version integer,
    -- Typed conflict reason for a rejection: held | wrong-status | archived | version-stale |
    -- not-found | claim-lost | disabled | conflict. NULL on success.
    reason character varying(40),
    lease_seconds integer,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- SERVER timestamp (never client-supplied) — the audit's time is our time.
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_claim_events_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.task_claim_events IS
  'Immutable, insert-only audit of every atomic-task-claim attempt (won and lost). The winner event is written INSIDE the claim transaction — if it fails, the claim rolls back: an unauditable claim is not a claim.';

-- FK with CASCADE so a project_delete cascade (projects -> tasks -> here) stays consistent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_claim_events_task_id_fkey'
  ) THEN
    ALTER TABLE public.task_claim_events
      ADD CONSTRAINT task_claim_events_task_id_fkey
      FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;
  END IF;
END $$;

-- IMMUTABILITY: block UPDATE at the DB. DELETE stays permitted so retention pruning works.
CREATE OR REPLACE FUNCTION public.task_claim_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'task_claim_events is an immutable audit log — UPDATE is not permitted (row id %)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS trigger_task_claim_events_immutable ON public.task_claim_events;
CREATE TRIGGER trigger_task_claim_events_immutable
  BEFORE UPDATE ON public.task_claim_events
  FOR EACH ROW EXECUTE FUNCTION public.task_claim_events_immutable();

-- 7. Indexes. --------------------------------------------------------------------------------
--    (a) LIVE-CLAIM lookups + the expiry/reaper scan. Partial (claim_id IS NOT NULL) because
--        the overwhelming majority of rows are unclaimed — all 3,152 existing rows are.
CREATE INDEX IF NOT EXISTS idx_tasks_claim_live
  ON public.tasks (claim_expires_at)
  WHERE claim_id IS NOT NULL;
--    (b) "what does this token hold" — the fenced-write lookup path.
CREATE INDEX IF NOT EXISTS idx_tasks_claim_id
  ON public.tasks (claim_id)
  WHERE claim_id IS NOT NULL;
--    (c) the audit read path: a task's claim history, newest first.
CREATE INDEX IF NOT EXISTS idx_task_claim_events_task
  ON public.task_claim_events (task_id, occurred_at DESC);
--    (d) retention pruning scans purely by age.
CREATE INDEX IF NOT EXISTS idx_task_claim_events_occurred_at
  ON public.task_claim_events (occurred_at);

DO $$
BEGIN
  RAISE NOTICE '✅ 067: atomic task claim — tasks.version/claim_id/claim_actor/claim_expires_at + version-bump trigger + immutable task_claim_events.';
END $$;
