/**
 * SESSION ACTOR STAMPING — DB-backed contract tests (Sessions Foundation Phase 1,
 * an earlier decision). Runs against the shared CI Postgres (real migrate).
 *
 * Locks the Phase 1 additive behavior:
 *   - actor is STAMPED on a new session from a DECLARED actor (bridge/MCP surface),
 *     normalized to a stable slug, with metadata (actor_kind, actor_is_anonymous);
 *   - actor is STAMPED from an auth-derived principal via the REST handler path;
 *   - when NO actor is derivable, the session is stamped with the flagged `anonymous`
 *     actor AND the sessions_created_anonymous_actor counter increments (coverage is
 *     measurable) + metadata.actor_is_anonymous is true;
 *   - RESOLUTION IS UNCHANGED: a session created WITH an actor is still resolved by
 *     getActiveSession(connectionId) exactly as before — actor stamping does not touch
 *     the connection-keyed resolution/re-attach path (Phase 1 is additive only).
 */

import { describe, expect, beforeAll, afterAll, it } from 'vitest';
import { db } from '../config/database.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { SessionAnalyticsHandler } from '../handlers/sessionAnalytics/analytics/SessionAnalyticsHandler.js';
import { monitoring } from '../utils/monitoring.js';
import { projectHandler } from '../handlers/project.js';

async function sessionRow(id: string): Promise<{ actor: string | null; metadata: any }> {
  const r = await db.query('SELECT actor, metadata FROM sessions WHERE id = $1', [id]);
  return r.rows[0];
}

describe('Session ACTOR stamping (Phase 1, additive)', () => {
  let testProjectId: string;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    const project = await projectHandler.createProject({
      name: 'QA-Actor-Phase1-' + Date.now(),
      description: 'Test project for Phase 1 actor stamping',
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    if (createdSessionIds.length > 0) {
      await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
      await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
    }
    await db.query('DELETE FROM analytics_events WHERE project_id = $1', [testProjectId]);
    await db.query('DELETE FROM sessions WHERE project_id = $1', [testProjectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
  });

  it('stamps a DECLARED actor (normalized) with taxonomy metadata', async () => {
    const sessionId = await SessionTracker.startSession(
      testProjectId, undefined, undefined, undefined, undefined, undefined, undefined,
      'conn-actor-1', '  Builder ABC ', // connectionId, actor (raw — proves normalize-at-stamp)
    );
    createdSessionIds.push(sessionId);

    const row = await sessionRow(sessionId);
    expect(row.actor).toBe('builder-abc');
    expect(row.metadata.actor).toBe('builder-abc');
    expect(row.metadata.actor_kind).toBe('agent'); // builder- prefix → agent
    expect(row.metadata.actor_is_anonymous).toBe(false);
  });

  it('stamps an AUTH-derived actor via the REST handler path', async () => {
    const result = await SessionAnalyticsHandler.startSession(
      testProjectId, undefined, undefined, undefined, undefined, undefined, undefined,
      'operator', // actor as derived by the REST controller (auth sub)
    );
    expect(result.success).toBe(true);
    const sessionId = result.data!.session_id;
    createdSessionIds.push(sessionId);

    const row = await sessionRow(sessionId);
    expect(row.actor).toBe('operator');
    expect(row.metadata.actor_kind).toBe('human');
    expect(row.metadata.actor_is_anonymous).toBe(false);
  });

  it('falls back to `anonymous` + increments the coverage counter when NO actor is derivable', async () => {
    const before = monitoring.getLatestMetric('sessions_created_anonymous_actor')?.value ?? 0;

    const sessionId = await SessionTracker.startSession(
      testProjectId, undefined, undefined, undefined, undefined, undefined, undefined,
      'conn-actor-anon', undefined, // connectionId, NO actor
    );
    createdSessionIds.push(sessionId);

    const row = await sessionRow(sessionId);
    expect(row.actor).toBe('anonymous');
    expect(row.metadata.actor_is_anonymous).toBe(true);
    // 'agent', not 'automation': the stamped taxonomy metadata follows the
    // registry — interactive is the default, so a header-less caller is not marked machinery.
    expect(row.metadata.actor_kind).toBe('agent');

    const after = monitoring.getLatestMetric('sessions_created_anonymous_actor')?.value ?? 0;
    expect(after).toBeGreaterThan(before); // coverage counter moved
  });

  it('does NOT change resolution: a session stamped with an actor still resolves by connectionId', async () => {
    const connectionId = 'conn-actor-resolve-' + Date.now();
    const sessionId = await SessionTracker.startSession(
      testProjectId, undefined, undefined, undefined, undefined, undefined, undefined,
      connectionId, 'coordinator',
    );
    createdSessionIds.push(sessionId);

    // The connection-keyed resolution is unchanged by actor stamping.
    const resolved = await SessionTracker.getActiveSession(connectionId);
    expect(resolved).toBe(sessionId);

    // And the row carries both the connection key (still the resolution key) AND the actor.
    const r = await db.query('SELECT connection_id, actor FROM sessions WHERE id = $1', [sessionId]);
    expect(r.rows[0].connection_id).toBe(connectionId);
    expect(r.rows[0].actor).toBe('coordinator');
  });
});
