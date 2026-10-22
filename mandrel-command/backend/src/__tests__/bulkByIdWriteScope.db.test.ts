/**
 * bulkByIdWriteScope.db.test.ts — every BULK-BY-ID WRITE on the Command backend is
 * constrained to the caller's project scope (REALIGN step 9 lane AUTHZ,  * sibling of the UI lane's FOUND-NOT-FIXED f6c5f364).
 *
 * THE DEFECT THIS GUARDS — one class, three surfaces
 *   The single-record routes authorize `:id` via `router.param('id', authorizeIdParam)`.
 *   The bulk routes take their ids in the BODY, so nothing authorizes them per id, and the
 *   handler's scope is the whole of the authorization. Three handlers had none:
 *     1. POST /api/contexts/bulk/update   — `UPDATE contexts … WHERE id = ANY(ids)`
 *     2. POST /api/tasks/bulk/move        — `UPDATE tasks SET project_id … WHERE id = ANY(ids)`
 *        (the DESTINATION was authorized as a scope candidate; the SOURCE rows were not)
 *     3. POST /api/tasks/bulk-update      — grouped by the ROW's project and delegated with
 *        that project as the tool scope; the caller's grants never entered the decision.
 *   Any caller with a session could retag, re-home or re-status any row on the box by id.
 *   The bulk DELETE on contexts had already been scoped; this brings the
 *   other three to the same shape.
 *
 * WHY THESE TESTS HAVE TEETH (C2 / C3)
 *   - The caller is a NON-ADMIN with grants on projects A and C and none on B. An admin
 *     resolves to ALL_PROJECTS and cannot see the leak; a header-only fixture tests the
 *     filter, not the authorization.
 *   - Every case is the SMALLEST DIVERGING INPUT: one id inside the scope and one outside,
 *     in the SAME call. In-scope-only cannot see the leak; out-of-scope-only cannot tell a
 *     scoped write from a write that did nothing.
 *   - The observable is the ROW, read back with raw SQL the product does not share, with a
 *     POSITIVE CONTROL that the in-scope row DID change — so a green cannot come from a
 *     write that silently did nothing.
 *   - The surface is the one the UI calls: real routers, real auth, real
 *     projectContextMiddleware. The bulk-status case stubs ONLY `McpService.callTool` (the
 *     delegated write leaves this process) and asserts what was sent to it.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_authz_rl9
 *   eval "$(bash scripts/provision-test-db.sh ci_authz_rl9 --print-env)"
 *   npx jest bulkByIdWriteScope --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_authz_rl9 --drop
 */

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { execFileSync } from 'child_process';
import path from 'path';

import { projectContextMiddleware } from '../middleware/project';
import { db } from '../database/connection';
import { AuthService } from '../services/auth';
import { ContextService } from '../services/context';
import { McpService } from '../services/mcp';
import authRouter from '../routes/auth';
import contextsRouter from '../routes/contexts';
import tasksRouter from '../routes/tasks';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeDb('Bulk-by-id writes are constrained to the caller scope (REALIGN 9 AUTHZ)', () => {
  let app: Express;
  let projectA: string; // granted
  let projectB: string; // NOT granted — the row the leak reached
  let projectC: string; // granted — a legal move destination
  let userId: string;
  let username: string;
  let token: string;
  const password = 'ProbePassw0rd!rl9authz';

  const contextIds: string[] = [];
  const taskIds: string[] = [];

  /** Raw seed — not the service — so the fixture cannot inherit a bug from the code under test. */
  async function seedContext(projectId: string): Promise<string> {
    const id = uuidv4();
    contextIds.push(id);
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags)
       VALUES ($1, $2, 'completion', $3, ARRAY['rl9-authz-seed']::text[])`,
      [id, projectId, `rl9 authz probe ${id.slice(0, 8)}`],
    );
    return id;
  }

  async function seedTask(projectId: string): Promise<string> {
    const id = uuidv4();
    taskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority)
       VALUES ($1, $2, $3, 'seeded by bulkByIdWriteScope.db.test', 'general', 'todo', 'medium')`,
      [id, projectId, `rl9 authz task ${id.slice(0, 8)}`],
    );
    return id;
  }

  const rawContext = async (id: string): Promise<{ project_id: string; tags: string[] }> =>
    (await db.query('SELECT project_id, tags FROM contexts WHERE id = $1', [id])).rows[0];

  const rawTask = async (id: string): Promise<{ project_id: string; status: string }> =>
    (await db.query('SELECT project_id, status FROM tasks WHERE id = $1', [id])).rows[0];

  const authed = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${token}`);

  /**
   * The REAL `project_move_record` service, run out of process against THIS test's DB
   * (mcp-server/scripts/move-record-cli.ts via tsx). Only the HTTP transport between the two
   * services is replaced — the reproject code, its satellite registry and the DB writes are
   * the shipped ones, so the "attachments follow" assertion below is against the product, not
   * a stub that agrees with itself.
   */
  const MCP_SERVER_DIR = path.resolve(__dirname, '../../../../mcp-server');
  const realProjectMoveRecord = (args: unknown): { success: boolean; data?: Record<string, unknown>; error?: string } => {
    try {
      const out = execFileSync(
        path.join(MCP_SERVER_DIR, 'node_modules/.bin/tsx'),
        ['scripts/move-record-cli.ts', JSON.stringify(args)],
        { cwd: MCP_SERVER_DIR, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { success: true, data: JSON.parse(out.trim().split('\n').pop() as string) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    // server.ts mounts projectContextMiddleware app-wide BEFORE the routers; a test app
    // that omits it is a different app, not a smaller one.
    app.use('/api', projectContextMiddleware);
    app.use('/api/auth', authRouter);
    app.use('/api/contexts', contextsRouter);
    app.use('/api/tasks', tasksRouter);

    projectA = uuidv4();
    projectB = uuidv4();
    projectC = uuidv4();
    for (const [id, tag] of [[projectA, 'a'], [projectB, 'b'], [projectC, 'c']] as const) {
      await db.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'bulkByIdWriteScope fixture', 'active', NOW())`,
        [id, `rl9-authz-${tag}-${id.slice(0, 8)}`],
      );
    }

    // A NON-ADMIN granted A and C. The role is the point: 'admin' resolves to ALL_PROJECTS.
    userId = uuidv4();
    username = `rl9authz_${userId.slice(0, 8)}`;
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'user', true, false)`,
      [userId, username, `${username}@example.com`, await AuthService.hashPassword(password)],
    );
    await db.query(
      'INSERT INTO user_project_access (user_id, project_id) VALUES ($1, $2), ($1, $3)',
      [userId, projectA, projectC],
    );

    const login = await request(app).post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);
    expect(typeof login.body?.token).toBe('string');
    token = login.body.token as string;
  });

  afterAll(async () => {
    if (contextIds.length) await db.query('DELETE FROM contexts WHERE id = ANY($1::uuid[])', [contextIds]);
    if (taskIds.length) await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [taskIds]);
    await db.query('DELETE FROM user_project_access WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectA, projectB, projectC]]);
    await db.end();
  });

  afterEach(() => jest.restoreAllMocks());

  // ──────────────────────────────────────────────────────────────────────────
  // 1. contexts bulk update
  // ──────────────────────────────────────────────────────────────────────────

  it('service: the SAME call that retags an in-scope context leaves the out-of-scope one untouched and names it in `skipped`', async () => {
    const mine = await seedContext(projectA);
    const theirs = await seedContext(projectB);

    const result = await ContextService.bulkUpdateContexts(
      [mine, theirs],
      { tags: ['retagged'] },
      projectsScope([projectA]),
    );

    expect(result).toEqual({ updated: 1, skipped: [theirs] });
    expect((await rawContext(mine)).tags).toEqual(['retagged']); // positive control
    expect((await rawContext(theirs)).tags).toEqual(['rl9-authz-seed']);
  });

  it('service: the EMPTY scope (zero grants) updates NOTHING — it must never mean "no filter"', async () => {
    const id = await seedContext(projectA);
    const result = await ContextService.bulkUpdateContexts([id], { tags: ['x'] }, projectsScope([]));
    expect(result).toEqual({ updated: 0, skipped: [id] });
    expect((await rawContext(id)).tags).toEqual(['rl9-authz-seed']);
  });

  it('HTTP: a non-admin viewing project A cannot retag a project-B context by id; the response is additive (success + updated + skipped)', async () => {
    const mine = await seedContext(projectA);
    const theirs = await seedContext(projectB);

    const res = await authed(request(app).post('/api/contexts/bulk/update'))
      .set('X-Project-ID', projectA)
      .send({ ids: [mine, theirs], updates: { tags: ['via-http'] } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ updated: 1, skipped: [theirs] });
    expect((await rawContext(mine)).tags).toEqual(['via-http']);
    expect((await rawContext(theirs)).tags).toEqual(['rl9-authz-seed']);
  });

  it('HTTP: with NO project named, the scope is the caller\'s GRANTS — B is still unreachable', async () => {
    const mine = await seedContext(projectA);
    const theirs = await seedContext(projectB);

    const res = await authed(request(app).post('/api/contexts/bulk/update'))
      .send({ ids: [mine, theirs], updates: { tags: ['no-header'] } });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 1, skipped: [theirs] });
    expect((await rawContext(theirs)).tags).toEqual(['rl9-authz-seed']);
  });

  it('HTTP: moving contexts INTO a project the caller holds no grant on is 403 and writes nothing', async () => {
    const mine = await seedContext(projectA);

    const res = await authed(request(app).post('/api/contexts/bulk/update'))
      .set('X-Project-ID', projectA)
      .send({ ids: [mine], updates: { project_id: projectB } });

    expect(res.status).toBe(403);
    expect((await rawContext(mine)).project_id).toBe(projectA);
  });

  it('HTTP: moving contexts into a GRANTED destination re-homes only the in-scope rows', async () => {
    const mine = await seedContext(projectA);
    const theirs = await seedContext(projectB);

    const res = await authed(request(app).post('/api/contexts/bulk/update'))
      .set('X-Project-ID', projectA)
      .send({ ids: [mine, theirs], updates: { project_id: projectC } });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 1, skipped: [theirs] });
    expect((await rawContext(mine)).project_id).toBe(projectC);
    expect((await rawContext(theirs)).project_id).toBe(projectB);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. tasks bulk move — the SOURCE rows are scoped, not just the destination
  // ──────────────────────────────────────────────────────────────────────────

  it('HTTP: POST /tasks/bulk/move re-homes only the tasks the caller may reach; the project-B task stays and is named in `skipped`', async () => {
    const mine = await seedTask(projectA);
    const theirs = await seedTask(projectB);
    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_tool: string, args: unknown) => realProjectMoveRecord(args),
    );

    // No header on purpose: body.project_id (the destination, C) is then the resolved
    // project, which is exactly the case where a list-scope would have scoped the move to
    // rows already in C and left the source rows unconstrained.
    const res = await authed(request(app).post('/api/tasks/bulk/move'))
      .send({ ids: [mine, theirs], project_id: projectC });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 1, skipped: [theirs], errors: [] });
    // Delegated EXACTLY once, for the in-scope id only — the project-B id never reached the tool.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('project_move_record');
    expect(spy.mock.calls[0][1]).toEqual({ recordType: 'task', recordId: mine, toProject: projectC });
    expect((await rawTask(mine)).project_id).toBe(projectC);
    expect((await rawTask(theirs)).project_id).toBe(projectB);
    spy.mockRestore();
  });

  it('HTTP: POST /tasks/bulk/move carries a task\'s before-attachment with it — project_id follows (the raw UPDATE left it behind)', async () => {
    const taskId = await seedTask(projectA);
    const seeded = await db.query(
      `INSERT INTO task_attachments (task_id, project_id, kind, filename, mime, byte_size, data, created_by)
       VALUES ($1, $2, 'before', 'before.png', 'image/png', 4, '\\x89504e47'::bytea, 'seed')
       RETURNING id`,
      [taskId, projectA],
    );
    const attachmentId: string = seeded.rows[0].id;
    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_tool: string, args: unknown) => realProjectMoveRecord(args),
    );

    const res = await authed(request(app).post('/api/tasks/bulk/move'))
      .send({ ids: [taskId], project_id: projectC });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 1, skipped: [], errors: [] });
    expect((await rawTask(taskId)).project_id).toBe(projectC);
    const att = await db.query('SELECT project_id FROM task_attachments WHERE id = $1', [attachmentId]);
    expect(att.rows[0].project_id).toBe(projectC);
    // and the tool REPORTED the follow, so a caller reading the delegation sees it too
    await expect(spy.mock.results[0].value).resolves.toMatchObject({
      data: { satellites: expect.arrayContaining([expect.objectContaining({ table: 'task_attachments', rows: 1 })]) },
    });
    spy.mockRestore();
  });

  it('HTTP: POST /tasks/bulk/move reports a task the tool refuses under `errors` with its reason, and still moves the rest', async () => {
    const good = await seedTask(projectA);
    const bad = await seedTask(projectA);
    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_tool: string, args: { recordId?: string }) =>
        args.recordId === bad
          ? { success: true, data: { ok: false, error: 'simulated tool refusal' } }
          : realProjectMoveRecord(args),
    );

    const res = await authed(request(app).post('/api/tasks/bulk/move'))
      .send({ ids: [good, bad], project_id: projectC });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 1, skipped: [], errors: [{ id: bad, reason: 'simulated tool refusal' }] });
    expect((await rawTask(good)).project_id).toBe(projectC);
    expect((await rawTask(bad)).project_id).toBe(projectA);
    spy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. tasks bulk status — the caller's scope enters the decision before delegation
  // ──────────────────────────────────────────────────────────────────────────

  it('HTTP: POST /tasks/bulk-update delegates ONLY the in-scope ids and reports the project-B id as skipped with a reason', async () => {
    const mine = await seedTask(projectA);
    const theirs = await seedTask(projectB);

    const spy = jest.spyOn(McpService, 'callTool').mockImplementation(
      async (_tool: string, args: { task_ids?: string[] }) => ({
        success: true,
        data: { updatedTaskIds: args.task_ids, errors: [] },
      }),
    );

    const res = await authed(request(app).post('/api/tasks/bulk-update'))
      .set('X-Project-ID', projectA)
      .send({ updates: [{ id: mine, status: 'completed' }, { id: theirs, status: 'completed' }] });

    expect(res.status).toBe(200);
    // Exactly one delegated group, scoped to A, carrying only A's id. Before the fix this
    // was TWO calls — the second scoped to B with B's id, on the caller's behalf.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toMatchObject({ projectId: projectA, task_ids: [mine] });
    expect(res.body.data.skipped).toEqual([
      { id: theirs, reason: expect.stringMatching(/scope/) },
    ]);
    expect(res.body.data.tasks.map((t: { id: string }) => t.id)).toEqual([mine]);
  });
});
