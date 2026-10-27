-- Migration 073: ACTOR-KEYED CURRENT-PROJECT — the `actor_project_defaults` table
-- Task: an earlier change (an earlier decision — the permanent fix the guards point at)
--
-- ── WHAT THIS REPLACES (eventually) ────────────────────────────────────────────────────
-- "Current project" lives in a process-global in-memory Map keyed by CONNECTION id
-- (handlers/project.ts `sessionStates`), with every identity-less caller collapsed onto
-- one shared literal ('http-default' / 'default-session') — the shared, sticky,
-- last-writer-wins slot measured flip-flopping on prod 2026-07-27/28 (~13 header-less
-- switches cycled it riverbend→personal→acme). It is also LOST on every restart.
--
-- This table keys the current-project on the ACTOR — the durable identity the composite
-- actor work made per-agent — so N agents under one OAuth principal, or
-- one agent across N reconnects, each keep their OWN current project, durably.
--
-- ── KEY DESIGN ─────────────────────────────────────────────────────────────────────────
-- PRIMARY KEY (actor): ONE current-project per actor. Each tenant container owns its own
-- DB, so the actor namespace is per-tenant by construction — no tenant column, no
-- cross-tenant concern. The actor value is the NORMALIZED derived actor (normalizeActor;
-- composite `<sub>/<handle>` kept whole — the composite IS the distinct identity).
-- The flagged `anonymous` actor and absent actors are NEVER written or read here
-- (services/actorProjectDefaults.ts actorProjectKey): keying shared-anonymous state by
-- the literal 'anonymous' would recreate the exact shared-slot defect one layer up.
--
-- project_id: FK → projects ON DELETE CASCADE — deleting a project silently drops every
-- actor default pointing at it, so a read can never resolve to a dead project (the same
-- guarantee the in-memory Map gets from its stale-cache eviction, enforced by the DB).
--
-- ── FLAG-GATED CONSUMER (shipped dark) ────────────────────────────────────
-- Read AND written only when MANDREL_ACTOR_PROJECT_STATE_ENABLED=true
-- (config/actorProjectStateConfig.ts, default OFF). With the flag off nothing touches
-- this table and the legacy connection-Map path is byte-identical — this migration is
-- pure additive schema. Precedence when ON (handlers/project.ts getCurrentProjectId):
--   rung 1 explicit projectId arg  >  rung 2 X-Mandrel-Project binding
--   >  rung 2.5 actor default (THIS TABLE)  >  rung 3 legacy connection Map.
--
-- ── ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE ───────────────────────────────────────
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Brand-new table; nothing existing is altered or dropped; no data migration.
--   * Above BASELINE_THROUGH, so it runs normally on fresh AND existing instances.
--   * scripts/schema-reference.sql.txt regenerated so the CI drift gate (0c) stays honest.

CREATE TABLE IF NOT EXISTS actor_project_defaults (
  -- The NORMALIZED derived actor (never 'anonymous', never blank — enforced at the one
  -- write path, services/actorProjectDefaults.ts). TEXT to match sessions.actor.
  actor        TEXT NOT NULL,
  -- The actor's current project. FK CASCADE: a deleted project takes its defaults with it.
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Last switch — diagnostics/audit only (which default is stale, who moved last).
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT actor_project_defaults_pkey PRIMARY KEY (actor)
);

-- The FK's delete path: ON DELETE CASCADE from projects scans this table by project_id
-- (Postgres does not auto-index FK referencing columns). Small table, but a project
-- delete must not seq-scan per row.
CREATE INDEX IF NOT EXISTS idx_actor_project_defaults_project
  ON actor_project_defaults(project_id);

COMMENT ON TABLE public.actor_project_defaults IS
  'Actor-keyed current-project: one durable current-project per derived actor, replacing the connection-keyed in-memory slot when MANDREL_ACTOR_PROJECT_STATE_ENABLED=true. Never holds the anonymous actor.';
COMMENT ON COLUMN public.actor_project_defaults.actor IS
  'Normalized derived actor (composite <sub>/<handle> kept whole). The anonymous/absent actor is never written — a shared-literal key here would recreate the shared-slot leak.';
