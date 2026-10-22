-- Migration 050: SESSION-PER-CONNECTION + RE-ATTACH-ON-RESTART (Session-Rework SR-1).
--
-- WHY (root cause ctx 81901e32, the operator's model a5e6620c):
-- A session was a TECHNICAL connection with NO persisted identity. The active-session map
-- is RAM-only, so a SERVER RESTART wiped it → the SAME live bridge connection got a NEW
-- session row minted for it ("random session spawning"). And graceful shutdown / the idle
-- reaper never marked these sessions ended → 'active' really meant 'never closed', so they
-- accumulated.
--
-- THE MODEL (the operator, a5e6620c): a session = PER CONNECTION, keyed on the STABLE connection
-- id the bridge already sends as X-Connection-ID (e.g. 'bridge-<pid>-<ts>', 'http-default',
-- 'stdio', or a remote mcp-session-id). Persisting that id ON the session row lets an action
-- after a restart RE-ATTACH to the still-open session for that connection (within the 1h
-- window) instead of minting a duplicate. PROJECT IS NOT in the key — switching projects
-- mid-work does NOT roll a new session. Multiple concurrent connections = multiple legitimate
-- concurrent active sessions; ONE active session PER CONNECTION.
--
-- WHAT THIS MIGRATION DOES (additive / idempotent / backward-compatible):
--   1. sessions.connection_id (TEXT, nullable) — persists the stable connection identity.
--      Reuses NO existing column: the table had no connection-identity column (token_id is a
--      bearer-token anchor, agent_type is a role label — neither is the per-connection key),
--      so a dedicated column is added. NULL is safe: a NULL connection_id NEVER re-attaches
--      (the re-attach query requires a non-NULL match) and is excluded from the unique index.
--   2. A non-unique lookup index for the re-attach query (newest open session for a conn id).
--   3. Adds 'interrupted' to sessions_status_check — a resumable, not-yet-finalized state
--      (graceful shutdown marks active→interrupted, ended_at left NULL = resumable).
--   4. A PARTIAL UNIQUE index enforcing ONE OPEN session per connection id
--      (WHERE connection_id IS NOT NULL AND ended_at IS NULL AND status IN active|interrupted).
--      This is the DB backstop for "one active session per connection"; the app guard
--      (re-attach-before-mint) is the primary path, this catches races.
--   5. Extends timeout_inactive_sessions + find_timed_out_sessions to ALSO sweep 'interrupted'
--      sessions past the window (so a shutdown-interrupted session that never resumes is still
--      terminalized by the reaper). The timeout window itself stays a CALL-TIME interval arg
--      (the service passes the config-driven 1h — configs-not-hardcoded), so this migration
--      changes only the STATUS SET swept, never hardcodes the duration.
--
-- This migration number (050) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include the
-- new column/index/constraint so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

-- 1. Persist the stable connection identity on the session row. ----------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS connection_id TEXT;

COMMENT ON COLUMN sessions.connection_id IS
  'SR-1: the stable per-connection identity (X-Connection-ID the bridge sends). The session '
  'key. Survives server restart so an action re-attaches to the open session for this '
  'connection instead of minting a new one. NULL = never re-attaches (safe).';

-- 2. Lookup index for the re-attach query (newest open session for a connection id). --------
--    Partial on the OPEN set so it stays small (only live sessions are re-attach candidates).
CREATE INDEX IF NOT EXISTS idx_sessions_connection_reattach
  ON sessions (connection_id, last_activity_at DESC)
  WHERE connection_id IS NOT NULL
    AND ended_at IS NULL
    AND status::text IN ('active', 'interrupted');

-- 3. Add the 'interrupted' resumable state to the status CHECK. -----------------------------
--    Drop + re-add (CHECK constraints can't be altered in place). Idempotent: drop IF EXISTS.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check
  CHECK (status::text = ANY (ARRAY[
    'active'::character varying,
    'inactive'::character varying,
    'disconnected'::character varying,
    'interrupted'::character varying
  ]::text[]));

-- 4. DB backstop: ONE open session per connection id. --------------------------------------
--    Partial UNIQUE over the OPEN set (active OR interrupted, not yet ended). NULL
--    connection_id rows are excluded (Postgres also treats NULLs as distinct), so the
--    shared header-less bucket and un-backfilled legacy rows never collide. On a race the
--    app's re-attach path makes the loser re-attach; this index makes the invariant a
--    hard guarantee at the DB.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_open_per_connection
  ON sessions (connection_id)
  WHERE connection_id IS NOT NULL
    AND ended_at IS NULL
    AND status::text IN ('active', 'interrupted');

-- 5. Extend the reaper SQL functions to ALSO sweep 'interrupted' sessions past the window. --
--    The window is the call-time `timeout_threshold` arg (the service passes the config 1h),
--    so the duration is NEVER hardcoded here — only the swept STATUS SET changes.
--    timeout_inactive_sessions also gains a connection_id output column (so the reaper can
--    evict the matching in-RAM entry), which CHANGES the return type — CREATE OR REPLACE
--    cannot change an OUT-parameter row type, so DROP the old signature first (idempotent).
DROP FUNCTION IF EXISTS public.timeout_inactive_sessions(interval);
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
    ended_at = CURRENT_TIMESTAMP
  WHERE s.status IN ('active', 'interrupted')
    AND s.last_activity_at IS NOT NULL
    AND s.last_activity_at < (CURRENT_TIMESTAMP - timeout_threshold)
    AND s.ended_at IS NULL
  RETURNING s.id, s.connection_id, CURRENT_TIMESTAMP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_timed_out_sessions(
  timeout_threshold interval DEFAULT '01:00:00'::interval
)
RETURNS TABLE(
  session_id uuid,
  project_id uuid,
  agent_type character varying,
  started_at timestamp with time zone,
  last_activity_at timestamp with time zone,
  inactive_duration interval
)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.project_id,
    s.agent_type,
    s.started_at,
    s.last_activity_at,
    CURRENT_TIMESTAMP - s.last_activity_at AS inactive_duration
  FROM sessions s
  WHERE s.status IN ('active', 'interrupted')
    AND s.last_activity_at IS NOT NULL
    AND s.last_activity_at < (CURRENT_TIMESTAMP - timeout_threshold)
    AND s.ended_at IS NULL
  ORDER BY s.last_activity_at ASC;
END;
$function$;
