-- Migration 061: A2 fix — reconcile the LYING `status` column (Sessions Foundation Phase 0).
--
-- WHY (the auditor review finding A2): the normal clean-end path
-- (SessionRepo.finish) stamped `ended_at` but NEVER set `status`, so every cleanly-ended
-- session stayed status='active' WITH ended_at set — a column that lies. Prod had 62 such
-- rows. Any consumer that trusts `status` alone (instead of ended_at) gets wrong answers,
-- and the Sessions redesign's state machine must start from honest data. SessionRepo.finish
-- is fixed in the same commit to set status='ended' going forward; this migration reconciles
-- the historical strand ONCE.
--
-- WHAT (idempotent, guarded, reversible; runs on fresh + existing instances):
--   1. Add 'ended' to sessions_status_check — the clean-end terminal value finish() now
--      writes. Kept DISTINCT from the idle reaper's 'inactive' so the two "ended" row
--      shapes (clean-end vs idle-reap) stay distinguishable. Drop+re-add (a CHECK can't be
--      altered in place); DROP IF EXISTS makes it idempotent. Every consumer that decides
--      open-vs-closed keys off `ended_at` (or `status IN ('active','interrupted')`), so an
--      'ended' row correctly reads as CLOSED everywhere (verified: existsActive,
--      findReattachable, getLastActive, the open-per-connection unique index, the reaper
--      functions, and the Command backend/frontend all gate on ended_at).
--   2. Back up the affected rows (id + pre-change status + ended_at) into
--      sessions_status_reconcile_backup_061 BEFORE mutating — full-fidelity reversibility,
--      not just a marker.
--   3. Flip status='ended' on rows that are ENDED (ended_at NOT NULL) yet still
--      status='active', and stamp a metadata marker for traceability.
--
-- Idempotent: the CHECK add is drop-IF-EXISTS+add; the backup INSERT and the UPDATE both
-- key off (ended_at IS NOT NULL AND status='active'), which matches ZERO rows on re-run.
-- 061 is ABOVE BASELINE_THROUGH (42) so it runs on fresh + existing instances; on a fresh
-- DB it finds zero rows (no-op).
--
-- Reverse (if ever needed):
--   UPDATE sessions s SET status = 'active'
--   FROM sessions_status_reconcile_backup_061 b
--   WHERE s.id = b.session_id AND b.old_status = 'active';

-- 1. Allow the 'ended' terminal status. -----------------------------------------------------
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
  CHECK (status::text = ANY (ARRAY[
    'active'::character varying,
    'inactive'::character varying,
    'disconnected'::character varying,
    'interrupted'::character varying,
    'ended'::character varying
  ]::text[]));

-- 2. Back up the rows we are about to change (before mutating). ------------------------------
CREATE TABLE IF NOT EXISTS sessions_status_reconcile_backup_061 (
  session_id   uuid PRIMARY KEY,
  old_status   text,
  ended_at     timestamptz,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sessions_status_reconcile_backup_061 (session_id, old_status, ended_at)
SELECT id, status::text, ended_at
FROM sessions
WHERE ended_at IS NOT NULL
  AND status::text = 'active'
ON CONFLICT (session_id) DO NOTHING;

-- 3. Reconcile: cleanly-ended-but-still-'active' rows → 'ended' (+ marker). ------------------
UPDATE sessions
SET
  status   = 'ended',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('reconciled_by', '061-status-reconcile')
WHERE ended_at IS NOT NULL
  AND status::text = 'active';
