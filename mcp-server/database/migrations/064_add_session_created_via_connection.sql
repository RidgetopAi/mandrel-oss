-- Migration 064: telemetry column sessions.created_via_connection (Sessions Foundation Phase 2b).
--
-- WHY (the auditor review §4.1 "Prod migration path" + the 2b cutover design):
-- Phase 2b makes `mode='actor'` ACT — resolution keyed to the stable ACTOR, not the physical
-- connection. In actor mode a lazily-created session row is written with `connection_id = NULL`
-- ON PURPOSE: the partial unique index `uq_sessions_open_per_connection` is defined
-- `WHERE connection_id IS NOT NULL`, so a NULL connection_id NEVER conflicts even when two
-- different actors share one physical connection (the escape hatch migration 050 built). But
-- that throws away a genuinely useful debugging signal — WHICH physical connection minted the
-- row. This column preserves it as pure TELEMETRY, decoupled from identity/resolution.
--
-- SCOPE — ADDITIVE, DARK-SAFE, zero behavior change:
--   * ONE new NULLABLE TEXT column. No index is added, dropped, or re-keyed (the actor
--     unique-index re-key is the DEFERRED Release N+1 hardening, blocked on fleet-actor —
--     NOT this migration). uq_sessions_open_per_connection and findReattachable's legacy use
--     are UNTOUCHED.
--   * The column is written ONLY on the actor-mode create path (SessionRepo.createForActorLocked);
--     every legacy/shadow create leaves it NULL. Nothing READS it for behavior — it is
--     debugging telemetry only. So applying 064 changes zero behavior even after deploy; the
--     mode flip (MANDREL_SESSION_RESOLVER_MODE=actor) is what activates the actor path, and it
--     stays 'legacy' by default.
--
-- Idempotent / safe on fresh + existing: ADD COLUMN IF NOT EXISTS. 064 is ABOVE
-- BASELINE_THROUGH (42), so it runs on BOTH fresh builds (after the 000 baseline) and
-- already-baselined instances. The schema-contract reference (scripts/schema-reference.sql.txt)
-- is regenerated to include the new column so the CI drift gate (the CI gate stage 0c) stays GREEN.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_via_connection TEXT;

COMMENT ON COLUMN sessions.created_via_connection IS
  'Sessions Foundation Phase 2b: TELEMETRY — the physical connection id (X-Connection-ID) that '
  'minted this session row on the actor-mode create path. In actor mode connection_id itself is '
  'NULL (so the connection-scoped partial unique index never conflicts when two actors share one '
  'connection); this column preserves "which connection created it" for debugging. NULLABLE, '
  'written only by the actor-mode create; NOT part of identity or resolution and never read for '
  'behavior. NULL on every legacy/shadow-created row.';
