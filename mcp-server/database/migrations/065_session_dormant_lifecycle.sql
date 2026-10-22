-- Migration 065: DORMANT session state + the dormanter/closer lifecycle sweeps
-- (Sessions Foundation Phase 3 — lifecycle decouple).
--
-- WHY (the auditor review §4.2 / §5 "Lifecycle", Break 2): today idle == end — the 1h idle reaper
-- (timeout_inactive_sessions, migration 050) stamps ended_at, so a >1h pause SPLITS one work
-- session into two. The fix is a middle state: active → (idle > idleDormantSec) → DORMANT
-- (ended_at STAYS NULL, resumable) → (idle > hardCapSec, or any open session older than
-- absoluteCapSec) → ended WITH FULL FINALIZE. A returning actor RE-JOINS a dormant session
-- (dormant counts as OPEN), which is what actually fixes Break 2.
--
-- SAFETY / DARKNESS: this migration is ADDITIVE and GLOBAL but DARK.
--   * The new 'dormant' status is only ever WRITTEN by the actor-mode dormanter sweep +
--     graceful-shutdown collapse (both gated on SESSION_CONFIG.resolverMode==='actor', default
--     'legacy'). In legacy/shadow mode NOTHING writes 'dormant', so no existing row ever takes
--     the value — the CHECK/index/predicate additions below are inert there. No existing row
--     uses 'dormant'; every open-vs-closed consumer gates on ended_at (which dormant leaves
--     NULL, correctly reading as OPEN) — so allowing the value changes zero behavior on deploy.
--   * The two new DB functions (dormant_idle_sessions, find_sessions_to_close) are only CALLED
--     by the actor-mode reaper split. The legacy idle reaper (timeout_inactive_sessions,
--     find_timed_out_sessions from 050) is UNTOUCHED and keeps running byte-identically in
--     legacy/shadow mode.
--
-- 065 is ABOVE BASELINE_THROUGH (42), so it runs on BOTH fresh builds (after the 000 baseline)
-- and already-baselined instances. The schema-contract reference (scripts/schema-reference.sql.txt)
-- is regenerated to include the new CHECK value + index predicates so the CI drift gate
-- (the CI gate stage 0c) stays GREEN. (DB FUNCTIONS are not part of the fingerprint; the constraint +
-- index predicate changes ARE.)

-- 1. Allow the 'dormant' status. -----------------------------------------------------------
--    Drop + re-add (a CHECK can't be altered in place); DROP IF EXISTS makes it idempotent.
--    Additive over 061's set (active/inactive/disconnected/interrupted/ended) + 'dormant'.
--    'dormant' is DISTINCT from the legacy idle reaper's 'inactive' (which stamps ended_at):
--    dormant is the resumable, NOT-yet-ended middle state (ended_at NULL).
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
  CHECK (status::text = ANY (ARRAY[
    'active'::character varying,
    'inactive'::character varying,
    'disconnected'::character varying,
    'interrupted'::character varying,
    'ended'::character varying,
    'dormant'::character varying
  ]::text[]));

-- 2. Extend the OPEN-set index predicates to include 'dormant'. ----------------------------
--    The canonical openness predicate becomes status IN ('active','interrupted','dormant')
--    AND ended_at IS NULL (mirrored in the code resolvers: existsActive / findReattachable /
--    newestOpenForActor / createForActorLocked). Keeping the partial-index predicates in
--    lockstep means the query planner can still use these partial indexes once the code
--    queries widen to include 'dormant'. DARK-SAFE: no legacy row is ever 'dormant', so the
--    widened predicate matches exactly the same rows in legacy/shadow mode. Drop+recreate
--    because CREATE INDEX IF NOT EXISTS cannot alter an existing predicate.
DROP INDEX IF EXISTS idx_sessions_connection_reattach;
CREATE INDEX IF NOT EXISTS idx_sessions_connection_reattach
  ON sessions (connection_id, last_activity_at DESC)
  WHERE connection_id IS NOT NULL
    AND ended_at IS NULL
    AND status::text IN ('active', 'interrupted', 'dormant');

DROP INDEX IF EXISTS uq_sessions_open_per_connection;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_open_per_connection
  ON sessions (connection_id)
  WHERE connection_id IS NOT NULL
    AND ended_at IS NULL
    AND status::text IN ('active', 'interrupted', 'dormant');

-- 3. DORMANTER (actor mode only) — active/interrupted idle past the window → 'dormant'. -----
--    ended_at STAYS NULL (resumable; NOT a finalize). Mirrors timeout_inactive_sessions'
--    shape (returns id + connection_id so the caller could evict RAM), but sets 'dormant'
--    instead of terminalizing. The idle window is the call-time `idle_threshold` arg
--    (the service passes SESSION_CONFIG.idleDormantSec — configs-not-hardcoded; the DEFAULT
--    here is a fallback only). Distinct name from the legacy reaper so BOTH coexist and the
--    legacy path is untouched.
CREATE OR REPLACE FUNCTION public.dormant_idle_sessions(
  idle_threshold interval DEFAULT '01:00:00'::interval
)
RETURNS TABLE(session_id uuid, connection_id text, went_dormant_at timestamp with time zone)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  UPDATE sessions s
  SET status = 'dormant'
  WHERE s.status IN ('active', 'interrupted')
    AND s.last_activity_at IS NOT NULL
    AND s.last_activity_at < (CURRENT_TIMESTAMP - idle_threshold)
    AND s.ended_at IS NULL
  RETURNING s.id, s.connection_id, CURRENT_TIMESTAMP;
END;
$function$;

-- 4. CLOSER finder (actor mode only) — READ-ONLY: ids of sessions the closer must finalize. -
--    Two conditions (either qualifies):
--      * a DORMANT session whose last activity is older than `hard_cap` (idle-based dormancy
--        cap — "gone this long → next action is a new session"); COALESCE(last_activity_at,
--        started_at) so a never-touched row still qualifies (mirrors 050:E4's note).
--      * ANY open session (active|interrupted|dormant) STARTED longer ago than `absolute_cap`
--        — the backstop that chops a session which has run continuously for too long.
--    This function does NOT mutate — the closer calls the APP finalize path (endSession) per
--    returned id so productivity/analytics/git-sync all run (review A3: no more unfinalized
--    reaps). Both windows are call-time args (SESSION_CONFIG.hardCapSec / .absoluteCapSec).
CREATE OR REPLACE FUNCTION public.find_sessions_to_close(
  hard_cap interval DEFAULT '24:00:00'::interval,
  absolute_cap interval DEFAULT '168:00:00'::interval
)
RETURNS TABLE(session_id uuid, reason text)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    (CASE
       WHEN s.started_at < (CURRENT_TIMESTAMP - absolute_cap) THEN 'absolute_cap'
       ELSE 'hard_cap'
     END)::text
  FROM sessions s
  WHERE s.ended_at IS NULL
    AND (
      (s.status = 'dormant'
        AND COALESCE(s.last_activity_at, s.started_at) < (CURRENT_TIMESTAMP - hard_cap))
      OR (s.status IN ('active', 'interrupted', 'dormant')
        AND s.started_at < (CURRENT_TIMESTAMP - absolute_cap))
    )
  ORDER BY s.started_at ASC;
END;
$function$;
