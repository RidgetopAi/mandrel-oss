-- Migration 051: ONE-TIME CLEANUP of stranded 'active' sessions (Session-Rework SR-1).
--
-- WHY (root cause ctx 81901e32): before SR-1, graceful shutdown ended only the 'stdio'
-- session and the idle sweep never wrote ended_at, so bridge/http/remote sessions
-- accumulated as status='active' with ended_at NULL FOREVER ("Active" really meant "never
-- closed"). After migration 050 the live machinery (shutdown→interrupted, the 1h reaper,
-- re-attach) keeps the table honest going forward — but the EXISTING strand of long-dead
-- 'active' rows must be cleaned up ONCE.
--
-- WHAT (idempotent, guarded, reversible-ish — runs AFTER 050 so the schema is in place):
--   * Mark only STALE 'active' rows (idle longer than the SR-1 idle window) as ended:
--       status   = 'inactive'
--       ended_at = COALESCE(last_activity_at, started_at)   -- honest close time, not now()
--       metadata = metadata || {"closed_by":"SR-1-migration"}  -- marker for reversibility
--     The marker lets an operator find + reopen exactly these rows if ever needed:
--       UPDATE sessions SET status='active', ended_at=NULL
--       WHERE metadata->>'closed_by' = 'SR-1-migration';
--   * LEAVE recent (< window) open rows untouched — they are legitimately live and will
--     be re-attached by the next action or terminalized naturally by the reaper.
--   * connection_id backfill: there is NO historical source column that held the
--     per-connection id (it was never persisted pre-050), so it CANNOT be derived for
--     existing rows. We leave it NULL — which is SAFE: a NULL connection_id never
--     re-attaches (findReattachable requires a real id) and is excluded from the
--     open-per-connection unique index. No bogus backfill that could mis-route a write.
--
-- THE WINDOW: the threshold below is the SR-1 idle window (default 1h = '01:00:00'),
-- the same value SESSION_CONFIG.idleTimeoutSec defaults to. A one-time SQL migration
-- can't read the TS config, so it is written here as a single named literal with this
-- note; if an operator has overridden the runtime window they can adjust this one line
-- before running, but the default keeps cleanup consistent with the live reaper.
--
-- Idempotent: re-running only ever (re-)closes rows that are STILL stale-and-open; rows
-- already closed by a prior run are skipped (status != 'active'). 051 is ABOVE
-- BASELINE_THROUGH (42) so it runs on fresh + existing instances; on a fresh DB it
-- simply finds zero stranded rows (no-op).

UPDATE sessions
SET
  status   = 'inactive',
  ended_at = COALESCE(last_activity_at, started_at),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('closed_by', 'SR-1-migration')
WHERE status::text = 'active'
  AND ended_at IS NULL
  AND COALESCE(last_activity_at, started_at) < (CURRENT_TIMESTAMP - INTERVAL '1 hour');
