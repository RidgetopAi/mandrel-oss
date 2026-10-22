-- Migration 055: DURABLE / HONEST ANCHOR — the `active_thread_anchors` table (ST-3).
--
-- WHY (reliable-auto-threading, spec §A1/A2): the active-thread anchor
-- was in-memory only (handlers/project.ts `sessionStates`), so it was LOST on process
-- restart and could not survive an ephemeral-VM (orb) reboot — every reconnect orphaned its
-- writes. This table makes the anchor DURABLE: the DB is authoritative, the in-memory map is
-- demoted to a cache. `getActiveThread` rehydrates from here when the cache is cold (A2), and
-- a TTL computed at READ from set_at (spec A3) treats a stale anchor as no anchor.
--
-- KEY (spec D2, operator-approved): PRIMARY KEY (project_id, session_key). An exact
-- (project_id, session_key) match rehydrates a reconnecting session; on a miss the store may
-- fall back to the project's most-recent non-expired anchor (behind
-- ANCHOR_PROJECT_FALLBACK_ENABLED — default OFF in code, config/reliableThreadingConfig.ts:
-- the crude project-match would hand another session's anchor to an anchorless connection;
-- enable explicitly only for a single-agent project). session_key is the resolved DB session
-- id when one is bound, else the connection
-- id (derived in handlers/project.ts) — a TEXT handle, NOT a FK, because it may be a raw
-- connection id that has no `sessions` row.
--
-- COLUMNS:
--   * project_id  — FK → projects ON DELETE CASCADE (deleting a project wipes its anchors).
--   * session_key — the per-session handle (see above). PK columns are implicitly NOT NULL.
--   * task_id / decision_id — the anchored referents. Deliberately PLAIN UUID NULL (no FK),
--     mirroring the `links` table: an anchor is BEST-EFFORT and must survive its referent
--     being deleted (the A4 honesty gate, ST-5, handles a stale referent at mint time). A FK
--     here would let a deleted task cascade-mutate the anchor, which we do NOT want.
--   * set_at     — when the anchor was ESTABLISHED (first set / re-set after a clear). TTL is
--     measured from here at READ (spec A3); PRESERVED across a merge upsert so a fixed
--     validity window runs from establishment, not from the last touch.
--   * updated_at — last modification (bumped on every merge upsert). The (project_id,
--     updated_at DESC) index below serves the D2 "most-recent anchor" project-fallback.
--
-- MERGE SEMANTICS: task_id and decision_id ACCUMULATE — an upsert that sets task, then later
-- sets decision, keeps BOTH (the store's ON CONFLICT preserves the un-touched side). This is
-- the durable mirror of the in-memory merge that thread_set already had.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped; no data migration.
--
-- This migration number (055) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include this
-- table so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

CREATE TABLE IF NOT EXISTS active_thread_anchors (
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_key  TEXT NOT NULL,
  -- Anchored referents — plain UUID (no FK): an anchor is best-effort and must outlive a
  -- deleted referent (see header). At least one is normally set; both-null is a no-op anchor.
  task_id      UUID,
  decision_id  UUID,
  -- Establishment time — TTL is computed from here at READ (spec A3). Preserved on merge.
  set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last modification — bumped on every upsert; orders the D2 project-fallback (index below).
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT active_thread_anchors_pkey PRIMARY KEY (project_id, session_key)
);

-- D2 PROJECT-FALLBACK: "most-recent non-expired anchor for the project" — ORDER BY
-- updated_at DESC, scoped to project_id. This index makes that lookup an index scan.
CREATE INDEX IF NOT EXISTS idx_active_thread_anchors_project_recent
  ON active_thread_anchors (project_id, updated_at DESC);

COMMENT ON TABLE active_thread_anchors IS
  'Durable/honest active-thread anchor (reliable-auto-threading ST-3). DB-authoritative per-session anchor; in-memory sessionStates is a cache. Keyed by (project_id, session_key); TTL computed at read from set_at; D2 project-fallback via the (project_id, updated_at DESC) index.';
COMMENT ON COLUMN active_thread_anchors.session_key IS
  'Per-session handle: resolved DB session id when bound, else the connection id. TEXT (not a FK) — a raw connection id has no sessions row.';
COMMENT ON COLUMN active_thread_anchors.set_at IS
  'Anchor establishment time. TTL (ANCHOR_TTL_MS) is measured from here at READ; preserved across merge upserts.';

DO $$
BEGIN
  RAISE NOTICE '✅ active_thread_anchors table created (durable/honest anchor ST-3): PK(project_id,session_key), (project_id,updated_at DESC) index for D2 fallback.';
END $$;
