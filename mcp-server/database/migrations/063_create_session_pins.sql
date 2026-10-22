-- Migration 063: DB-persisted session PIN — session_pins (Sessions Foundation Phase 2a).
--
-- WHY (the auditor review §4.1 "PIN as the targeting primitive" + §6 Phase 2):
-- the shared resolver's targeting precedence is  explicit id → actor's PIN → actor's newest
-- open → lazy-create. The PIN ("this is my session") is the user-controlled targeting
-- primitive. It MUST be DB-persisted, not RAM: the entire SR-1 saga (stale RAM maps, eviction
-- bugs, restart wipes) is the case study for why in-memory targeting state does not survive.
-- A DB row survives a server restart, a bridge PID change, and connection loss — which is the
-- whole point of moving identity off the connection.
--
-- SHAPE — one open pin per actor:
--   * actor      TEXT PRIMARY KEY — the stable principal (operator, coordinator, builder-<id8>, tick…).
--                PK gives the UNIQUE-per-actor guarantee for free (one pin per actor) and lets
--                setPin upsert via ON CONFLICT (actor). Stored already-normalized (the repo
--                normalizes before writing) so equivalent actor strings collapse to one pin.
--   * session_id UUID NOT NULL → sessions(id) ON DELETE CASCADE. If the pinned session row is
--                ever deleted, the dangling pin is removed automatically (no orphaned pointer).
--                Openness is NOT enforced here — the resolver re-validates existsActive() at
--                read time, so a pin to a since-closed session is simply ignored (falls through
--                to newest-open / lazy-create), never resurrected.
--   * pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now() — when the pin was set (telemetry / "most
--                recent intent" tie-break if ever needed).
--
-- SCOPE — ADDITIVE, DARK-SAFE:
--   This migration only CREATES a new table (+ its FK-supporting index). It touches NO existing
--   table, column, index, or row. Nothing reads session_pins until resolveSession() is consulted,
--   and resolveSession() is consulted only when SESSION_CONFIG.resolverMode != 'legacy' (default
--   'legacy'). So applying 063 changes zero behavior — safe to migrate + deploy in the dark.
--
-- Idempotent / safe on fresh + existing: CREATE TABLE/INDEX IF NOT EXISTS. 063 is ABOVE
-- BASELINE_THROUGH (42), so it runs on both fresh builds (after the 000 baseline) and
-- already-baselined instances. schema-reference.sql.txt is regenerated to include the new table
-- + index + FK so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

CREATE TABLE IF NOT EXISTS session_pins (
  actor      TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE session_pins IS
  'Sessions Foundation Phase 2a: DB-persisted session PIN (the user-controlled targeting '
  'primitive "this is my session"). One row per actor (PK). Read by the shared resolver as '
  'precedence step 2 (after an explicit session id, before newest-open). Openness is re-validated '
  'at read time; a pin to a closed session is ignored, never resurrected. INERT until '
  'SESSION_CONFIG.resolverMode != legacy.';

-- Supporting index for the FK back-reference (find/clean pins for a given session, e.g. the
-- ON DELETE CASCADE and any future "who pinned this session" lookup). The actor read-path is
-- already served by the PK.
CREATE INDEX IF NOT EXISTS idx_session_pins_session
  ON session_pins (session_id);
