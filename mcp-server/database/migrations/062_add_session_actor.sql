-- Migration 062: ACTOR plumbing — add sessions.actor (Sessions Foundation Phase 1).
--
-- WHY (the auditor review §5 "Identity & ownership" + §6 Phase 1): session
-- identity today is welded to `connection_id` (X-Connection-ID) — invisible to users,
-- per-process-ephemeral for the main bridge client, and absent/shared on the REST and
-- header-less HTTP surfaces. The durable fix (Phase 2) re-keys session identity to a stable,
-- human-meaningful ACTOR (operator, coordinator, builder-<id8>, tick, deploy-smoke…). Phase 1 is the
-- ADDITIVE precursor: introduce the column and start STAMPING it on every new session so we
-- can measure actor coverage in real data BEFORE Phase 2 switches resolution onto it.
--
-- SCOPE — ADDITIVE ONLY, ZERO behavior change:
--   * `actor` is NULLABLE during the transition. NULL never participates in resolution;
--     `connection_id` stays the resolution key for now (findReattachable / the per-connection
--     unique index are UNCHANGED). This migration does NOT re-key any unique index — that is
--     Phase 2's deliberate cutover.
--   * A supporting lookup index over the OPEN set lets Phase 2's "newest open session for an
--     actor" query (and Phase 1's coverage queries) run without a seq-scan, while staying tiny
--     (only live sessions are candidates). It is a plain (non-unique) index: Phase 1 must not
--     constrain "one open per actor" (concurrent same-actor sessions are legal today).
--
-- Idempotent / safe on fresh + existing: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- 062 is ABOVE BASELINE_THROUGH (42), so it runs on BOTH fresh builds (after the 000 baseline)
-- and already-baselined instances. The schema-contract reference (scripts/schema-reference.sql.txt)
-- is regenerated to include the new column + index so the CI drift gate (the CI gate stage 0c) stays
-- GREEN and honest.
--
-- TRUST MODEL (documented here and in the code near the derivation): on the single-tenant
-- container the actor is ATTRIBUTION, not an authz boundary (tenant isolation is at the
-- container/DB level). A declared X-Actor-ID header is therefore acceptable on the un-authed
-- surfaces; where an authenticated principal exists (OAuth `sub`) it takes precedence over any
-- client-declared header. Nobody should ever mistake `actor` for an access-control decision.

-- 1. The stable principal that OWNS the session (Phase 2 identity spine; Phase 1 attribution).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS actor TEXT;

COMMENT ON COLUMN sessions.actor IS
  'Sessions Foundation Phase 1: the stable, human-meaningful principal that owns the session '
  '(operator, coordinator, builder-<id8>, tick, deploy-smoke, anonymous…). Derived from the '
  'authenticated OAuth `sub` where auth exists, else the declared X-Actor-ID header, else the '
  'flagged `anonymous` fallback (counted for coverage). ADDITIVE in Phase 1 — NULLABLE, NOT yet '
  'part of session resolution (connection_id remains the key until Phase 2 re-keys onto actor). '
  'Attribution, NOT an authz boundary on the single-tenant container.';

-- 2. Supporting lookup index for the "newest OPEN session for this actor" query (Phase 2
--    resolution precursor) + Phase 1 coverage grouping. Partial on the OPEN set (ended_at NULL,
--    non-NULL actor) so it stays small; NON-unique (Phase 1 permits concurrent same-actor
--    sessions — the one-open-per-actor invariant is Phase 2's job, added with the re-key).
CREATE INDEX IF NOT EXISTS idx_sessions_actor_open
  ON sessions (actor, last_activity_at DESC)
  WHERE actor IS NOT NULL
    AND ended_at IS NULL;
