/**
 * Sessions Foundation Phase 5 — observability counters (the auditor review §5 / F3).
 *
 * PROVES each new attribution-visibility counter increments ON ITS REAL PATH (a past incident — the
 * silent losses F3 flagged are now visible metrics, not just warn logs):
 *
 *   1. sessions_resolver_path        — resolveSession bumps it, labeled by the precedence path it
 *                                      picked (explicit | pin | newest-open | lazy-create). Driven
 *                                      with INJECTED ports (pure, no DB) so every branch is covered.
 *   2. sessions_writes_without_session — an ACTION tool (here task_create) that writes with NO
 *                                      session attributed (session_id NULL) increments it. DB-backed.
 *   3. sessions_ensure_failures      — the action gate ensureSessionForAction, when its ensure
 *                                      throws, SWALLOWS it (fail-open, no throw) AND bumps the
 *                                      counter. Driven by forcing the actor-mode ensure to reject.
 */

import { describe, test, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';

import { db } from '../config/database.js';
import { monitoring } from '../utils/monitoring.js';
import {
  resolveSession,
  type ResolveSessionPorts,
} from '../services/session/domain/lifecycle/resolveSession.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/index.js';
import { ensureSessionForAction } from '../routes/index.js';
import { tasksHandler } from '../handlers/tasks.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

const STAMP = Date.now();

/** Current monotonic value of a counter (0 if never emitted). */
const counter = (name: string): number => monitoring.getLatestMetric(name)?.value ?? 0;
/** Labels attached to the MOST RECENT sample of a counter. */
const latestLabels = (name: string): Record<string, string> | undefined =>
  monitoring.getLatestMetric(name)?.labels;

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode;
  vi.restoreAllMocks();
});

/**
 * Build injectable resolver ports whose four branch inputs are individually controllable, so a
 * single test can steer resolveSession down each precedence path with no DB.
 */
function ports(overrides: Partial<ResolveSessionPorts> = {}): ResolveSessionPorts {
  return {
    existsActive: async () => false,
    getPin: async () => null,
    newestOpenForActor: async () => null,
    classify: () => 'human',
    ...overrides,
  };
}

describe('sessions_resolver_path — labeled by the precedence path resolveSession picks', () => {
  test('explicit path', async () => {
    const before = counter('sessions_resolver_path');
    const r = await resolveSession('coordinator', 'explicit-sess-id', ports({ existsActive: async () => true }));
    expect(r.source).toBe('explicit');
    expect(counter('sessions_resolver_path')).toBe(before + 1);
    expect(latestLabels('sessions_resolver_path')?.path).toBe('explicit');
  });

  test('pin path', async () => {
    const before = counter('sessions_resolver_path');
    // No explicit id; the actor has a pin whose session is still open.
    const r = await resolveSession(
      'coordinator',
      undefined,
      ports({ getPin: async () => ({ sessionId: 'pinned-sess' }), existsActive: async () => true })
    );
    expect(r.source).toBe('pin');
    expect(counter('sessions_resolver_path')).toBe(before + 1);
    expect(latestLabels('sessions_resolver_path')?.path).toBe('pin');
  });

  test('newest-open path', async () => {
    const before = counter('sessions_resolver_path');
    const r = await resolveSession(
      'coordinator',
      undefined,
      ports({ newestOpenForActor: async () => 'newest-sess' })
    );
    expect(r.source).toBe('newest-open');
    expect(counter('sessions_resolver_path')).toBe(before + 1);
    expect(latestLabels('sessions_resolver_path')?.path).toBe('newest-open');
  });

  test('lazy-create path (nothing resolves)', async () => {
    const before = counter('sessions_resolver_path');
    const r = await resolveSession('coordinator', undefined, ports());
    expect(r.source).toBe('lazy-create');
    expect(counter('sessions_resolver_path')).toBe(before + 1);
    expect(latestLabels('sessions_resolver_path')?.path).toBe('lazy-create');
  });
});

describe('sessions_writes_without_session — an action tool wrote with session_id NULL', () => {
  let projectId: string;
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    const r = await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
      [`QA-Observability-${STAMP}`, 'Phase 5 observability counters test']
    );
    projectId = r.rows[0].id;
  });

  afterAll(async () => {
    if (createdTaskIds.length > 0) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  test('task_create with a session-less connection increments the counter', async () => {
    // Legacy default mode + a fresh connection with NO session and NO global fallback ⇒
    // getActiveSession resolves null ⇒ the row is written session-less.
    SESSION_CONFIG.resolverMode = 'legacy';
    const before = counter('sessions_writes_without_session');

    const task = await tasksHandler.createTask(
      projectId,
      `no-session task ${STAMP}`,
      undefined,
      'general',
      'medium',
      undefined,
      undefined,
      [],
      [],
      {},
      `no-session-conn-${STAMP}` // fresh connection ⇒ no session attributed
    );
    createdTaskIds.push(task.id);

    expect(task.sessionId ?? null).toBeNull(); // genuinely wrote without a session
    expect(counter('sessions_writes_without_session')).toBe(before + 1);
    expect(latestLabels('sessions_writes_without_session')?.tool).toBe('task_create');
  });
});

describe('sessions_ensure_failures — the action gate swallowed an ensure error (fail-open)', () => {
  test('gate increments the counter and does NOT throw when ensure rejects', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    // Force the actor-mode ensure to reject; the gate must swallow it (never block the write).
    vi.spyOn(SessionLifecycleService, 'ensureSessionForActor').mockRejectedValue(new Error('boom'));

    const before = counter('sessions_ensure_failures');
    await expect(
      ensureSessionForAction('context_store', `ensurefail-conn-${STAMP}`, 'coordinator')
    ).resolves.toBeUndefined();

    expect(counter('sessions_ensure_failures')).toBe(before + 1);
    expect(latestLabels('sessions_ensure_failures')?.tool).toBe('context_store');
  });
});
