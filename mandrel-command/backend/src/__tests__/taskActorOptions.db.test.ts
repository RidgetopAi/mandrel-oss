/**
 * taskActorOptions — GET /api/tasks/actor-options (Phase 1).
 *
 * =============================================================================
 * WHAT THIS GUARDS, AND THE ORDER IT MATTERS IN
 * =============================================================================
 * 1. PROJECT ISOLATION (T1). The endpoint enumerates who has worked in a project. An
 *    actor list for a project the caller cannot read is a cross-user disclosure of the
 *    same shape as the leak shipped on 2026-08-08 — it names people and agents. This is
 *    asserted first and by a PLANTED MARKER, so "the response contains it" is a fact
 *    about the response rather than a differential the endpoint could equalise away.
 * 2. The merge behaviour the drift fix depends on: `builder` / `Builder` collapse to ONE
 *    option, and `Operator + Coordinator` / `Coordinator + Operator` do NOT.
 * 3. That the built-in registry is present even in a project with no usage at all — the
 *    EMPTY POPULATION (C3), which is the state a brand-new customer project is in.
 *
 * =============================================================================
 * MUTATION EVIDENCE FOR ASSERTION 1 (recorded, not asserted here)
 * =============================================================================
 * The isolation test was run against a deliberately UNSCOPED build of
 * `TaskService.getActorOptions` (both `scopePredicate(...)` calls replaced with `''`).
 * Under that mutation the `granted` persona's response contained the victim project's
 * actors and the test went RED; reverting the mutation returned it to GREEN. The pasted
 * transcript of that probe is in the task report — it is not re-run here, because a guard
 * does not get a guard.
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { BUILTIN_ACTOR_KINDS } from '../config/actorRegistry';
import { CreateTaskSchema, UpdateTaskSchema } from '../validation/schemas';

const P_VICTIM = 'a0a0a0a0-0544-4000-8000-a0a0a0a0a0a0';
const P_GRANTED = 'a1a1a1a1-0544-4000-8000-a1a1a1a1a1a1';
const P_EMPTY = 'a2a2a2a2-0544-4000-8000-a2a2a2a2a2a2';
const U_ADMIN = 'a3a3a3a3-0544-4000-8000-a3a3a3a3a3a3';
const U_GRANT = 'a4a4a4a4-0544-4000-8000-a4a4a4a4a4a4';
const U_ZERO = 'a5a5a5a5-0544-4000-8000-a5a5a5a5a5a5';

/**
 * The planted markers. Each is a string this file chose and NOTHING else in the database
 * can produce, so its presence in a response is unambiguous.
 */
const VICTIM_TASK_ACTOR = 'actoroptvictimtask';
const VICTIM_SESSION_ACTOR = 'actoroptvictimsession';
const GRANTED_TASK_ACTOR = 'actoroptgrantedtask';
const GRANTED_SESSION_ACTOR = 'actoroptgrantedsession';

const ALL_PROJECTS_SEEDED = [P_VICTIM, P_GRANTED, P_EMPTY];
const ALL_USERS = [U_ADMIN, U_GRANT, U_ZERO];

interface ActorOptionResponse {
  actor: string;
  kind: string | null;
  taskCount: number;
  sessionCount: number;
  sources: string[];
  variants: string[];
}

describeDb('GET /api/tasks/actor-options', () => {
  const pool = db;
  const tokens: Record<'admin' | 'granted' | 'zero', string> = {} as never;

  const seedTask = (project: string, assignee: string | null, archived = false) =>
    pool.query(
      `INSERT INTO tasks (project_id, title, type, status, priority, assigned_to, archived_at)
       VALUES ($1, $2, 'general', 'todo', 'medium', $3, $4)`,
      [project, `actoropt ${assignee ?? 'none'}`, assignee, archived ? new Date() : null]
    );

  const seedSession = (project: string | null, actor: string, displayId: string) =>
    pool.query(
      `INSERT INTO sessions (project_id, agent_type, display_id, title, actor, started_at, ended_at)
       VALUES ($1, 'claude', $2, $3, $4, NOW() - interval '2 hour', NOW() - interval '1 hour')`,
      [project, displayId, `actoropt sess ${actor}`, actor]
    );

  const cleanup = async () => {
    for (const t of ['tasks', 'sessions']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [ALL_PROJECTS_SEEDED]);
    }
    await pool.query("DELETE FROM sessions WHERE display_id LIKE 'AO-%'");
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [ALL_USERS]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [ALL_USERS]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [ALL_PROJECTS_SEEDED]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [ALL_USERS]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    for (const [id, name] of [
      [P_VICTIM, 'actoropt-victim'],
      [P_GRANTED, 'actoropt-granted'],
      [P_EMPTY, 'actoropt-empty'],
    ] as const) {
      await pool.query('INSERT INTO projects (id, name, description) VALUES ($1,$2,$3)', [
        id, name, `${name} fixture`,
      ]);
    }

    // ── the victim project: actors the granted persona must NEVER see ────────────────
    await seedTask(P_VICTIM, VICTIM_TASK_ACTOR);
    await seedSession(P_VICTIM, VICTIM_SESSION_ACTOR, 'AO-VIC1');

    // ── the granted project ──────────────────────────────────────────────────────────
    await seedTask(P_GRANTED, GRANTED_TASK_ACTOR);
    await seedSession(P_GRANTED, GRANTED_SESSION_ACTOR, 'AO-GRA1');

    // The measured drift: one actor, two spellings, different volumes.
    await seedTask(P_GRANTED, 'builder');
    await seedTask(P_GRANTED, 'builder');
    await seedTask(P_GRANTED, 'builder');
    await seedTask(P_GRANTED, 'Builder');

    // The pair that must NOT be collapsed — different strings, unproven equivalence.
    await seedTask(P_GRANTED, 'Operator + Coordinator');
    await seedTask(P_GRANTED, 'Coordinator + Operator');

    // Rows that must contribute NOTHING: unassigned, whitespace-only, and archived.
    await seedTask(P_GRANTED, null);
    await seedTask(P_GRANTED, '   ');
    await seedTask(P_GRANTED, 'actoroptarchivedonly', true);

    // A session owned by NO project (sessions.project_id is NULLABLE) — the absent-owner
    // population. "No owner" must behave like "no access", never like "no restriction".
    await seedSession(null, 'actoroptorphansession', 'AO-ORPH');

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active) VALUES
        ($1,'aoadmin','aoadmin@x.test',$4,'admin',true),
        ($2,'aogrant','aogrant@x.test',$4,'user',true),
        ($3,'aozero','aozero@x.test',$4,'user',true)`,
      [U_ADMIN, U_GRANT, U_ZERO, '$2b$04$notarealhashnotarealhashno']
    );
    await pool.query('INSERT INTO user_project_access (user_id, project_id) VALUES ($1,$2)', [
      U_GRANT, P_GRANTED,
    ]);

    for (const [name, id, role] of [
      ['admin', U_ADMIN, 'admin'],
      ['granted', U_GRANT, 'user'],
      ['zero', U_ZERO, 'user'],
    ] as const) {
      const { tokenId } = await AuthService.createSession(id);
      tokens[name] = AuthService.generateJWT(
        { id, username: `ao${name}`, email: `${name}@x.test`, role } as never,
        tokenId
      );
    }
  }, 120000);

  afterAll(async () => {
    await cleanup();
    // CLOSE THE POOL — an open handle makes jest hang under `--runInBand --ci`.
    await pool.end();
  });

  const get = async (path: string, persona?: 'admin' | 'granted' | 'zero') => {
    const req = request(app).get(path);
    if (persona) req.set('Authorization', `Bearer ${tokens[persona]}`);
    const res = await req;
    return {
      status: res.status,
      raw: typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body),
      actors: (res.body?.data?.actors ?? []) as ActorOptionResponse[],
    };
  };

  const find = (actors: ActorOptionResponse[], name: string) =>
    actors.find((a) => a.actor.toLowerCase() === name.toLowerCase());

  // ── 1. AUTH + PROJECT ISOLATION (T1) ──────────────────────────────────────────────
  describe('authorization', () => {
    it('rejects an unauthenticated caller', async () => {
      const res = await get('/api/tasks/actor-options');
      expect(res.status).toBe(401);
      expect(res.raw).not.toContain(VICTIM_TASK_ACTOR);
      expect(res.raw).not.toContain(GRANTED_TASK_ACTOR);
    });

    it('rejects a garbage bearer token', async () => {
      const res = await request(app)
        .get('/api/tasks/actor-options')
        .set('Authorization', 'Bearer not-a-real-token');
      expect(res.status).toBe(401);
    });

    it('a caller scoped to project A cannot obtain project B\'s actors (unscoped request)', async () => {
      const res = await get('/api/tasks/actor-options', 'granted');
      expect(res.status).toBe(200);

      // THE LEAK ASSERTION. Checked on the RAW body, so it holds no matter what shape the
      // response takes — a future field cannot smuggle the value past a parsed lookup.
      expect(res.raw).not.toContain(VICTIM_TASK_ACTOR);
      expect(res.raw).not.toContain(VICTIM_SESSION_ACTOR);
      expect(res.raw).not.toContain('actoroptorphansession');

      // THE CONTROL: the same request DOES return the caller's own project's actors, so
      // the absence above is scoping and not an empty/broken response.
      expect(res.raw).toContain(GRANTED_TASK_ACTOR);
      expect(res.raw).toContain(GRANTED_SESSION_ACTOR);
    });

    it('a caller scoped to project A is refused when it NAMES project B', async () => {
      const res = await get(`/api/tasks/actor-options?project_id=${P_VICTIM}`, 'granted');
      expect(res.status).toBe(403);
      expect(res.raw).not.toContain(VICTIM_TASK_ACTOR);
      expect(res.raw).not.toContain(VICTIM_SESSION_ACTOR);
    });

    it('a ZERO-GRANT caller gets no project data at all — the empty scope returns nothing, not everything', async () => {
      const res = await get('/api/tasks/actor-options', 'zero');
      expect(res.status).toBe(200);
      expect(res.raw).not.toContain(VICTIM_TASK_ACTOR);
      expect(res.raw).not.toContain(GRANTED_TASK_ACTOR);
      expect(res.raw).not.toContain(VICTIM_SESSION_ACTOR);
      expect(res.raw).not.toContain(GRANTED_SESSION_ACTOR);

      // Every option it does get is a zero-usage built-in — the static roster, not data.
      expect(res.actors.length).toBeGreaterThan(0);
      for (const a of res.actors) {
        expect(a.sources).toEqual(['builtin']);
        expect(a.taskCount).toBe(0);
        expect(a.sessionCount).toBe(0);
      }
    });

    it('an ADMIN naming project A gets A\'s actors and not B\'s — the scope follows the named project, not the role', async () => {
      const res = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'admin');
      expect(res.status).toBe(200);
      expect(res.raw).toContain(GRANTED_TASK_ACTOR);
      expect(res.raw).not.toContain(VICTIM_TASK_ACTOR);
    });
  });

  // ── 2. THE MERGE ──────────────────────────────────────────────────────────────────
  describe('deduplication and labelling', () => {
    it('collapses builder/Builder into ONE option under the registry spelling, summing usage', async () => {
      const { actors } = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');

      const matching = actors.filter((a) => a.actor.toLowerCase() === 'builder');
      expect(matching).toHaveLength(1);

      const builder = matching[0];
      // The registry spelling wins over the more-used one only because they agree here;
      // what is being asserted is that ONE canonical spelling is offered.
      expect(builder.actor).toBe('builder');
      expect(builder.taskCount).toBe(4); // 3x 'builder' + 1x 'Builder'
      expect(builder.variants).toEqual(['Builder']);
      expect(builder.kind).toBe('agent');
      expect(builder.sources).toEqual(expect.arrayContaining(['builtin', 'tasks']));
    });

    it('does NOT collapse "Operator + Coordinator" and "Coordinator + Operator" — different strings, unproven equivalence', async () => {
      const { actors } = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');
      expect(find(actors, 'Operator + Coordinator')?.taskCount).toBe(1);
      expect(find(actors, 'Coordinator + Operator')?.taskCount).toBe(1);
    });

    it('counts a session actor separately from a task assignee', async () => {
      const { actors } = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');
      const fromSession = find(actors, GRANTED_SESSION_ACTOR);
      expect(fromSession).toBeDefined();
      expect(fromSession!.sessionCount).toBe(1);
      expect(fromSession!.taskCount).toBe(0);
      expect(fromSession!.sources).toEqual(['sessions']);
      expect(fromSession!.kind).toBeNull(); // not in the registry — honest "unknown"
    });

    it('excludes unassigned, whitespace-only and ARCHIVED assignees', async () => {
      const res = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');
      expect(res.raw).not.toContain('actoroptarchivedonly');
      for (const a of res.actors) expect(a.actor.trim()).not.toBe('');
    });

    it('is ordered by real usage — the most-assigned option comes before a zero-usage built-in', async () => {
      const { actors } = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');
      const builderIdx = actors.findIndex((a) => a.actor === 'builder');
      const unusedIdx = actors.findIndex((a) => a.taskCount === 0 && a.sessionCount === 0);
      expect(builderIdx).toBeGreaterThanOrEqual(0);
      expect(unusedIdx).toBeGreaterThan(builderIdx);
    });
  });

  // ── 3. THE EMPTY POPULATION ───────────────────────────────────────────────────────
  it('a project with NO tasks and NO sessions still returns the whole built-in registry', async () => {
    // A brand-new customer project. The built-in half is not project data, so it must be
    // there; the usage half must be honestly empty rather than absent or borrowed.
    const { status, actors } = await get(`/api/tasks/actor-options?project_id=${P_EMPTY}`, 'admin');
    expect(status).toBe(200);

    const returned = new Set(actors.map((a) => a.actor));
    for (const builtin of Object.keys(BUILTIN_ACTOR_KINDS)) {
      expect(returned.has(builtin)).toBe(true);
    }
    expect(actors).toHaveLength(Object.keys(BUILTIN_ACTOR_KINDS).length);
    for (const a of actors) {
      expect(a.taskCount).toBe(0);
      expect(a.sessionCount).toBe(0);
    }
  });

  // ── 4. FREE TEXT IS STILL LEGAL ───────────────────────────────────────────────────
  it('the write validator accepts an assignee that is NOT in the options list', async () => {
    // The endpoint is a SUGGESTION SOURCE, not a whitelist. `CreateTaskSchema` /
    // `UpdateTaskSchema` are the layer a membership check would have been added at, so
    // that is where this is asserted.
    //
    // NOT asserted through `POST /api/tasks`: that route delegates to the live mcp-server
    // (`TaskService.createTask` → `McpService.callTool('task_create', …)`), which this
    // DB-only suite does not run — it answers 500 for every create, including ones with
    // an assignee that is on the list, so it cannot discriminate and would be a test that
    // fails for a reason unrelated to its own claim.
    const unlisted = 'Someone Nobody Has Ever Heard Of';
    const { actors } = await get(`/api/tasks/actor-options?project_id=${P_GRANTED}`, 'granted');
    expect(actors.map((a) => a.actor)).not.toContain(unlisted); // it really is unlisted

    expect(
      CreateTaskSchema.safeParse({
        title: 'actoropt free text write',
        type: 'general',
        priority: 'medium',
        project_id: P_GRANTED,
        assigned_to: unlisted,
      }).success
    ).toBe(true);
    expect(UpdateTaskSchema.safeParse({ assigned_to: 'Operator + Coordinator' }).success).toBe(true);
  });
});
