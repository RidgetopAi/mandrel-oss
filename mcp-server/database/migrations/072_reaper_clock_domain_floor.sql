-- Migration 072: floor the idle reaper's ended_at so a clock-domain row cannot abort the sweep
-- Task: an earlier change (class fix — fix the class, not the instance)
--
-- ── WHAT WAS BROKEN ────────────────────────────────────────────────────────────────────
-- `timeout_inactive_sessions()` writes a Postgres-clock `ended_at = CURRENT_TIMESTAMP`,
-- but `sessions.started_at` is written from the NODE clock (SessionRepo.create binds
-- `params.startTime`). The DB compares them:
--
--     CONSTRAINT reasonable_session_duration
--       CHECK (ended_at IS NULL OR ended_at >= started_at)
--
-- The sibling defect in `POST /api/users/revoke-sessions` (fixed in the same commit) was
-- called out as "ungated", with this reaper described as SAFE BY MARGIN because it only
-- touches rows idle >= 1-2h. **That claim is false and was measured false.** The margin
-- only holds while the Node-ahead skew is SMALLER than the idle threshold. A session
-- created while the Node clock ran ahead by MORE than the threshold is selected by the
-- sweep (its last_activity_at is genuinely old) while its started_at is still in the DB's
-- future -> `ended_at = CURRENT_TIMESTAMP` lands BELOW started_at -> CHECK violation.
--
-- ── WHY THIS IS WORSE THAN THE ROUTE IT WAS COMPARED TO ────────────────────────────────
--   1. LIVE: called every sweep from mcp-server/src/services/sessionTimeout.ts (the
--      periodic checkTimeouts, and manualCheck).
--   2. WHOLE-TABLE UPDATE: it is ONE statement, so a SINGLE poisoned row aborts the
--      ENTIRE sweep and NO session is reaped at all, indefinitely, until the clocks
--      re-converge. Measured: with one poisoned row + one perfectly normal idle session,
--      the normal session was left status='active', ended_at NULL — never reaped.
--   3. SILENT: the callers in sessionTimeout.ts swallow the rejection into
--      `logger.error(...)`, and setInterval keeps firing, so the idle reaper simply dies
--      quietly and the only signal is a log line. (That call site now counts consecutive
--      failures and escalates — see sessionTimeout.ts.)
--
-- ── THE FIX, AND WHY THIS SHAPE ────────────────────────────────────────────────────────
--     ended_at = GREATEST(s.started_at, CURRENT_TIMESTAMP)
--
-- The alternative considered was adding `AND s.started_at <= CURRENT_TIMESTAMP` to the
-- selection predicate. Rejected: that makes the sweep SKIP the poisoned row, so the
-- bystanders get reaped but the affected session stays 'active' forever while the skew
-- lasts — it silently drops a row out of a core guarantee, and "idle but immortal" is a
-- worse failure than an honest close time. The floor keeps the reaper's contract intact
-- (every idle session past the threshold IS reaped) and is identical in spirit to the
-- users.ts fix shipped alongside it, so the codebase has ONE idiom for this class:
-- never let a second clock's now() land below a timestamp the first clock wrote.
--
-- In the normal case (no skew) CURRENT_TIMESTAMP > started_at, so GREATEST returns
-- CURRENT_TIMESTAMP and behaviour is byte-for-byte what it is today. The floor only
-- engages on a row that would otherwise abort the sweep.
--
-- `timed_out_at` in the RETURNING clause uses the SAME expression, so the value reported
-- to the caller is the value actually written — not a second column claiming a close time
-- that is not in the row.
--
-- ── FLEET SAFETY ───────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE, body-only: the signature (args + RETURNS TABLE) is UNCHANGED from
-- migration 050, which is the LIVE definition (verified against the running schema with
-- pg_get_functiondef — 050 supersedes both 019 and the 000 baseline copy, and is the one
-- with the `connection_id` return column and the 1h default). Keeping the signature
-- identical is what lets this be a pure REPLACE; changing RETURNS TABLE would require
-- DROP + CREATE, which is not safely idempotent across the fleet.
--
-- 072 is ABOVE BASELINE_THROUGH (42), so it runs on fresh AND already-baselined
-- instances. Idempotent: re-running just replaces the function with the same body.
--
-- NOT changed here: migration 051's one-shot stranded-session UPDATE has the same 1h gate
-- and could abort under a >1h skew, but it is a historical one-shot that finds zero rows
-- on a fresh DB and has already run everywhere else. Surfaced, deliberately not touched.

CREATE OR REPLACE FUNCTION public.timeout_inactive_sessions(
  timeout_threshold interval DEFAULT '01:00:00'::interval
)
RETURNS TABLE(session_id uuid, connection_id text, timed_out_at timestamp with time zone)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  UPDATE sessions s
  SET
    status = 'inactive',
    -- Floored: never below the session's own (app-clock) start. See header.
    ended_at = GREATEST(s.started_at, CURRENT_TIMESTAMP)
  WHERE s.status IN ('active', 'interrupted')
    AND s.last_activity_at IS NOT NULL
    AND s.last_activity_at < (CURRENT_TIMESTAMP - timeout_threshold)
    AND s.ended_at IS NULL
  RETURNING s.id, s.connection_id, GREATEST(s.started_at, CURRENT_TIMESTAMP);
END;
$function$;

COMMENT ON FUNCTION public.timeout_inactive_sessions IS
'Reap sessions idle beyond the threshold (active + interrupted). ended_at is FLOORED at started_at (GREATEST) because started_at is written from the app/Node clock while this writes the Postgres clock — an unfloored CURRENT_TIMESTAMP violates reasonable_session_duration under a Node-ahead skew larger than the threshold, and because this is one whole-table UPDATE, a single such row aborts the entire sweep. Migration 072.';
