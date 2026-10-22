/**
 * ACTOR PROJECT DEFAULTS — the durable, actor-keyed current-project store
 * (table: migration 073 `actor_project_defaults`).
 *
 * THE DEFECT THIS REPLACES (behind MANDREL_ACTOR_PROJECT_STATE_ENABLED — see
 * config/actorProjectStateConfig.ts): "current project" keyed on the CONNECTION id, with
 * every identity-less caller collapsed onto one shared literal — one sticky,
 * last-writer-wins slot, lost on restart. Keying on the derived ACTOR gives N agents under
 * one principal N independent current-projects that survive reconnects and restarts.
 *
 * THE KEY RULE lives in exactly one place (actorProjectKey below), used by BOTH the write
 * and the read path so they cannot disagree:
 *   - normalize (normalizeActor — the same stamp-time normalization sessions use, so the
 *     actor written here equals the actor stamped on the session doing the writing);
 *   - REFUSE the anonymous/absent actor. 'anonymous' is itself a shared literal — keying
 *     state by it would rebuild the exact shared-slot defect one identity-layer up. An
 *     anonymous caller simply has no actor-keyed state and falls through to the legacy path.
 *
 * All SQL fully parameterized. Both operations are non-throwing at the call sites
 * (handlers/project.ts wraps them) — a state-persistence failure must never break the
 * user-facing switch/read, matching syncSessionProject's contract.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { normalizeActor, ACTOR_ANONYMOUS } from '../config/actorRegistry.js';

/**
 * Derive the storage key for an actor, or null when the actor has NO actor-keyed state:
 * absent, blank, or the flagged shared `anonymous` fallback. Null means "use the legacy
 * connection-keyed path" — never a shared row here.
 */
export function actorProjectKey(actor?: string | null): string | null {
  const normalized = normalizeActor(actor);
  if (!normalized || normalized === ACTOR_ANONYMOUS) return null;
  return normalized;
}

/**
 * Upsert the actor's current-project default (last switch wins — per ACTOR, which is the
 * whole point: last-writer-wins per identity is correct; per shared transport slot it was
 * the bug). Caller guarantees `actorKey` came from actorProjectKey().
 */
export async function upsertActorProjectDefault(
  actorKey: string,
  projectId: string,
  pool: Pool = db
): Promise<void> {
  await pool.query(
    `INSERT INTO actor_project_defaults (actor, project_id, updated_at)
       VALUES ($1, $2, now())
     ON CONFLICT (actor) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       updated_at = now()`,
    [actorKey, projectId]
  );
}

/**
 * Read the actor's current-project default, or null when none is set. The FK (ON DELETE
 * CASCADE, migration 073) guarantees a returned id references a live project row — a
 * deleted project takes its defaults with it, so no stale-eviction logic is re-implemented
 * here (the DB owns that rule; one copy).
 */
export async function readActorProjectDefault(
  actorKey: string,
  pool: Pool = db
): Promise<string | null> {
  const r = await pool.query(
    `SELECT project_id FROM actor_project_defaults WHERE actor = $1`,
    [actorKey]
  );
  return r.rows[0]?.project_id ?? null;
}
