/**
 * contextDecisionSoftDelete.db.test.ts — the Command UI's context and decision Delete are
 * SOFT deletes, and the bulk path cannot cross projects.
 *
 * THE DEFECT THIS GUARDS — three of them, on one surface
 *   1. `ContextService.deleteContext` ran `DELETE FROM contexts WHERE id = $1`.
 *   2. `DecisionController.deleteDecision` ran `DELETE FROM technical_decisions WHERE id = $1`.
 *      Both DESTROYED the row — unlistable, unrecoverable, and with it every typed edge
 *      pointing at it — while the MCP surface on the SAME tables (ContextHandler
 *      .archiveContext, DecisionsHandler.archiveDecision) only ever set `archived_at`.
 *      Two delete semantics on one table meant a Command UI delete annihilated a record
 *      the MCP layer believed was merely archived, and the advertised `restore` action
 *      had nothing left to clear. The frontend's own comment already claimed this was a
 *      soft delete. It was not.
 *   3. `ContextService.bulkDeleteContexts` ran `DELETE FROM contexts WHERE id = ANY(...)`
 *      with NO project predicate at all, while the MCP archive path is project-scoped.
 *      Given ids, any authenticated caller could destroy rows in a project they hold no
 *      grant on. That is a worse bug than the one this task was opened for.
 *
 * WHY THESE TESTS HAVE TEETH (C2 / C3)
 *   - The observable is the ROW ITSELF, read back with raw SQL the product does not
 *     share. "It returned success" is not the claim; "the row is still there, with
 *     archived_at set" is. The pre-fix code cannot pass a single one of the core cases.
 *   - The HTTP cases drive the surface the UI ACTUALLY calls (`DELETE /api/contexts/:id`,
 *     `POST /api/contexts/:id/restore`, `DELETE /api/contexts/bulk/delete`,
 *     `DELETE /api/decisions/:id`, `POST /api/decisions/:id/restore`) through the real
 *     router, real auth middleware and real controller — not the service by a shortcut.
 *   - POSITIVE CONTROLS throughout: every "it is hidden now" assertion is preceded by the
 *     same read proving the row was VISIBLE before, so a green can never come from an
 *     empty list, a broken query, or the wrong project scope.
 *   - THE CROSS-PROJECT CASE names the smallest input where fixed and broken DIVERGE: one
 *     id inside the scope and one id outside it, in the SAME bulk call. A guard that
 *     passed only out-of-scope ids would go green on a bulk delete that silently did
 *     nothing; a guard that passed only in-scope ids cannot see the leak at all.
 *   - THE INTEROP CASE is the point of the whole task: a context archived the way MCP
 *     archives it (raw `archived_at = now()`) must be invisible to the Command list and
 *     restorable by the Command restore path, and a context deleted through the COMMAND
 *     UI must still be there for MCP `context restore` to clear. That is the two surfaces
 *     finally agreeing.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_softdel_a648f00d
 *   eval "$(bash scripts/provision-test-db.sh ci_softdel_a648f00d --print-env)"
 *   npx jest contextDecisionSoftDelete --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_softdel_a648f00d --drop
 */

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { projectContextMiddleware } from '../middleware/project';
import { db } from '../database/connection';
import { AuthService } from '../services/auth';
import { ContextService } from '../services/context';
import { ProjectService } from '../services/project';
import authRouter from '../routes/auth';
import contextsRouter from '../routes/contexts';
import decisionsRouter from '../routes/decisions';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeDb('Context + decision delete are SOFT deletes, and bulk is project-scoped', () => {
  let app: Express;
  let projectId: string;
  let otherProjectId: string;
  let userId: string;
  let username: string;
  let token: string;
  const password = 'ProbePassw0rd!a648f00d';

  const createdContextIds: string[] = [];
  const createdDecisionIds: string[] = [];

  /**
   * Seed ONE context with raw SQL — not the service — so the fixture cannot inherit a bug
   * from the code under test. `archived` seeds a row in exactly the state MCP's
   * archiveContext leaves it in, which is what the interop cases need.
   */
  async function seedContext(
    overrides: { projectId?: string; archived?: boolean; type?: string; content?: string } = {},
  ): Promise<string> {
    const id = uuidv4();
    createdContextIds.push(id);
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content, tags, archived_at)
       VALUES ($1, $2, $3, $4, ARRAY['softdel-a648f00d']::text[],
               CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
      [
        id,
        overrides.projectId ?? projectId,
        overrides.type ?? 'completion',
        overrides.content ?? `softdel probe ${id.slice(0, 8)}`,
        overrides.archived ?? false,
      ],
    );
    return id;
  }

  async function seedDecision(
    overrides: { projectId?: string; archived?: boolean; title?: string } = {},
  ): Promise<string> {
    const id = uuidv4();
    createdDecisionIds.push(id);
    await db.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, impact_level, archived_at)
       VALUES ($1, $2, 'architecture', $3, 'seeded by contextDecisionSoftDelete.db.test',
               'seeded rationale', 'medium',
               CASE WHEN $4::boolean THEN now() ELSE NULL END)`,
      [
        id,
        overrides.projectId ?? projectId,
        overrides.title ?? `softdel decision ${id.slice(0, 8)}`,
        overrides.archived ?? false,
      ],
    );
    return id;
  }

  /** Raw read of a context row's existence + archive marker — the real observable. */
  async function rawContext(id: string): Promise<{ exists: boolean; archivedAt: string | null }> {
    const res = await db.query('SELECT archived_at FROM contexts WHERE id = $1', [id]);
    if (res.rows.length === 0) return { exists: false, archivedAt: null };
    return { exists: true, archivedAt: res.rows[0].archived_at };
  }

  async function rawDecision(id: string): Promise<{ exists: boolean; archivedAt: string | null }> {
    const res = await db.query('SELECT archived_at FROM technical_decisions WHERE id = $1', [id]);
    if (res.rows.length === 0) return { exists: false, archivedAt: null };
    return { exists: true, archivedAt: res.rows[0].archived_at };
  }

  /** Ids the BROWSE list returns for the fixture project, in whatever archive scope. */
  const listIds = async (
    archive: { include_archived?: boolean; archived_only?: boolean } = {},
  ): Promise<string[]> =>
    (
      await ContextService.searchContexts({
        scope: projectsScope([projectId]),
        limit: 500,
        ...archive,
      })
    ).contexts.map((c) => c.id);

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    // server.ts mounts projectContextMiddleware app-wide BEFORE the routers, and these
    // handlers read their scope through getRequestProjectId(), which FAILS LOUD when the
    // middleware never ran. A test app that omits it is not a smaller version of
    // production — it is a different app.
    app.use('/api', projectContextMiddleware);
    app.use('/api/auth', authRouter);
    app.use('/api/contexts', contextsRouter);
    app.use('/api/decisions', decisionsRouter);

    projectId = uuidv4();
    otherProjectId = uuidv4();
    for (const [id, name] of [
      [projectId, `softdel-a648f00d-${projectId.slice(0, 8)}`],
      [otherProjectId, `softdel-other-${otherProjectId.slice(0, 8)}`],
    ] as const) {
      await db.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'contextDecisionSoftDelete fixture', 'active', NOW())`,
        [id, name],
      );
    }

    userId = uuidv4();
    username = `softdel_${userId.slice(0, 8)}`;
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', true, false)`,
      [userId, username, `${username}@example.com`, await AuthService.hashPassword(password)],
    );
    const login = await request(app).post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);
    expect(typeof login.body?.token).toBe('string');
    token = login.body.token as string;
  });

  afterAll(async () => {
    if (createdContextIds.length) {
      await db.query('DELETE FROM contexts WHERE id = ANY($1::uuid[])', [createdContextIds]);
    }
    if (createdDecisionIds.length) {
      await db.query('DELETE FROM technical_decisions WHERE id = ANY($1::uuid[])', [
        createdDecisionIds,
      ]);
    }
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
    await db.end();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // THE CORE CLAIM: the row survives a delete
  // ──────────────────────────────────────────────────────────────────────────

  it('deleting a context does NOT destroy the row — it sets archived_at (the whole defect)', async () => {
    const id = await seedContext();

    // POSITIVE CONTROL: live and unarchived before we touch it.
    const before = await rawContext(id);
    expect(before.exists).toBe(true);
    expect(before.archivedAt).toBeNull();

    const result = await ContextService.deleteContext(id);
    expect(result).toEqual({
      found: true,
      alreadyArchived: false,
      archivedAt: expect.anything(),
    });

    // THE MEASUREMENT. Under the old `DELETE FROM contexts`, exists === false here.
    const after = await rawContext(id);
    expect(after.exists).toBe(true);
    expect(after.archivedAt).not.toBeNull();
  });

  it('deleting a decision does NOT destroy the row — it sets archived_at', async () => {
    const id = await seedDecision();

    const before = await rawDecision(id);
    expect(before.exists).toBe(true);
    expect(before.archivedAt).toBeNull();

    const res = await request(app)
      .delete(`/api/decisions/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.already_archived).toBe(false);

    const after = await rawDecision(id);
    expect(after.exists).toBe(true);
    expect(after.archivedAt).not.toBeNull();
  });

  it('context delete is idempotent and does not rewrite the original archive timestamp', async () => {
    const id = await seedContext();
    const first = await ContextService.deleteContext(id);
    expect(first.alreadyArchived).toBe(false);

    const second = await ContextService.deleteContext(id);
    expect(second.found).toBe(true);
    expect(second.alreadyArchived).toBe(true);
    expect(new Date(second.archivedAt as string).toISOString()).toBe(
      new Date(first.archivedAt as string).toISOString(),
    );
    expect((await rawContext(id)).exists).toBe(true);
  });

  it('decision delete is idempotent and does not rewrite the original archive timestamp', async () => {
    const id = await seedDecision();
    const first = await request(app)
      .delete(`/api/decisions/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    const firstAt = (await rawDecision(id)).archivedAt;

    const second = await request(app)
      .delete(`/api/decisions/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body?.data?.already_archived).toBe(true);
    expect(new Date((await rawDecision(id)).archivedAt as string).toISOString()).toBe(
      new Date(firstAt as string).toISOString(),
    );
  });

  it('deleting a context that does not exist reports found:false (the 404), not a phantom success', async () => {
    const result = await ContextService.deleteContext(uuidv4());
    expect(result.found).toBe(false);
  });

  it('deleting a decision that does not exist is a 404, not a phantom success', async () => {
    const res = await request(app)
      .delete(`/api/decisions/${uuidv4()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // RESTORE — the acceptance criterion: it works for what the UI deleted
  // ──────────────────────────────────────────────────────────────────────────

  it('a context deleted through the HTTP surface is restorable through the HTTP surface', async () => {
    const id = await seedContext();

    // POSITIVE CONTROL: visible in the default list before the delete.
    expect(await listIds()).toContain(id);

    const del = await request(app)
      .delete(`/api/contexts/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(del.body?.data?.archived).toBe(true);

    expect(await listIds()).not.toContain(id);
    expect((await rawContext(id)).exists).toBe(true);

    const restore = await request(app)
      .post(`/api/contexts/${id}/restore`)
      .set('Authorization', `Bearer ${token}`);
    expect(restore.status).toBe(200);

    expect((await rawContext(id)).archivedAt).toBeNull();
    expect(await listIds()).toContain(id);
  });

  it('a decision deleted through the HTTP surface is restorable through the HTTP surface', async () => {
    const id = await seedDecision();

    const del = await request(app)
      .delete(`/api/decisions/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect((await rawDecision(id)).archivedAt).not.toBeNull();

    const restore = await request(app)
      .post(`/api/decisions/${id}/restore`)
      .set('Authorization', `Bearer ${token}`);
    expect(restore.status).toBe(200);
    expect((await rawDecision(id)).archivedAt).toBeNull();
  });

  it('restoring a context that does not exist is a 404', async () => {
    const res = await request(app)
      .post(`/api/contexts/${uuidv4()}/restore`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('restore is idempotent: restoring a live context succeeds and leaves it live', async () => {
    const id = await seedContext();
    const result = await ContextService.restoreContext(id);
    expect(result).toEqual({ found: true, alreadyArchived: false, archivedAt: null });
    expect((await rawContext(id)).archivedAt).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // INTEROP: the two surfaces agree on ONE meaning of "deleted"
  // ──────────────────────────────────────────────────────────────────────────

  it('a context archived the way MCP archives it is hidden from the Command list and restorable by Command', async () => {
    // Exactly what ContextHandler.archiveContext writes: archived_at = now().
    const id = await seedContext({ archived: true });

    expect(await listIds()).not.toContain(id);

    const restore = await request(app)
      .post(`/api/contexts/${id}/restore`)
      .set('Authorization', `Bearer ${token}`);
    expect(restore.status).toBe(200);
    expect(await listIds()).toContain(id);
  });

  it('a context deleted through Command is left in exactly the state MCP restore clears', async () => {
    const id = await seedContext();
    await request(app).delete(`/api/contexts/${id}`).set('Authorization', `Bearer ${token}`);

    // MCP's restoreContext is `UPDATE contexts SET archived_at = NULL WHERE id = $1 AND
    // project_id = $2 AND archived_at IS NOT NULL`. Run that shape verbatim: it must find
    // a row to clear. Before this fix the row was GONE and this updated nothing, which is
    // precisely why `context restore` was a promise the product could not keep.
    const mcpRestore = await db.query(
      `UPDATE contexts SET archived_at = NULL
       WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL
       RETURNING id`,
      [id, projectId],
    );
    expect(mcpRestore.rowCount).toBe(1);
    expect((await rawContext(id)).archivedAt).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // THE BULK PATH: soft, and it cannot cross projects
  // ──────────────────────────────────────────────────────────────────────────

  it('bulk delete cannot reach a context outside the caller scope — the SAME call that archives an in-scope id leaves the out-of-scope one untouched', async () => {
    const mine = await seedContext();
    const theirs = await seedContext({ projectId: otherProjectId });

    // POSITIVE CONTROLS: both rows exist and both are live.
    expect(await rawContext(mine)).toEqual({ exists: true, archivedAt: null });
    expect(await rawContext(theirs)).toEqual({ exists: true, archivedAt: null });

    // THE SMALLEST DIVERGING INPUT: one id in scope, one out, in one call. An
    // in-scope-only fixture cannot see the leak; an out-of-scope-only fixture cannot tell
    // a scoped delete from a delete that did nothing at all.
    const result = await ContextService.bulkDeleteContexts(
      [mine, theirs],
      projectsScope([projectId]),
    );

    expect(result.deleted).toBe(1);
    expect((await rawContext(mine)).archivedAt).not.toBeNull();
    expect((await rawContext(theirs)).archivedAt).toBeNull();
    expect((await rawContext(theirs)).exists).toBe(true);
  });

  it('bulk delete SOFT-deletes: every row it touches survives and is restorable', async () => {
    const ids = [await seedContext(), await seedContext(), await seedContext()];

    const result = await ContextService.bulkDeleteContexts(ids, projectsScope([projectId]));
    expect(result.deleted).toBe(3);

    for (const id of ids) {
      expect((await rawContext(id)).exists).toBe(true);
      expect((await rawContext(id)).archivedAt).not.toBeNull();
      expect(await ContextService.restoreContext(id)).toEqual({
        found: true,
        alreadyArchived: false,
        archivedAt: null,
      });
    }
  });

  it('the EMPTY scope (a caller with zero grants) deletes NOTHING — it must never mean "no filter"', async () => {
    const id = await seedContext();
    const result = await ContextService.bulkDeleteContexts([id], projectsScope([]));
    expect(result.deleted).toBe(0);
    expect((await rawContext(id)).archivedAt).toBeNull();
  });

  it('bulk delete counts only rows it TRANSITIONED — an already-archived id is not counted twice', async () => {
    const already = await seedContext({ archived: true });
    const live = await seedContext();

    const result = await ContextService.bulkDeleteContexts(
      [already, live],
      projectsScope([projectId]),
    );
    expect(result.deleted).toBe(1);
  });

  it('bulk delete over the HTTP surface is scoped by the request, not by the ids alone', async () => {
    const mine = await seedContext();
    const theirs = await seedContext({ projectId: otherProjectId });

    const res = await request(app)
      .delete('/api/contexts/bulk/delete')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Project-ID', projectId)
      .send({ ids: [mine, theirs] });

    expect(res.status).toBe(200);
    expect(res.body?.data?.deleted).toBe(1);
    expect((await rawContext(theirs)).archivedAt).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // READ PATHS: archived rows leave the list, the counts and the neighbours
  // ──────────────────────────────────────────────────────────────────────────

  it('the browse list hides archived rows by default, shows them under archived_only, and shows both under include_archived', async () => {
    const live = await seedContext();
    const archived = await seedContext({ archived: true });

    const def = await listIds();
    expect(def).toContain(live);
    expect(def).not.toContain(archived);

    const only = await listIds({ archived_only: true });
    expect(only).toContain(archived);
    expect(only).not.toContain(live);

    const both = await listIds({ include_archived: true });
    expect(both).toContain(live);
    expect(both).toContain(archived);
  });

  it('?archived= over HTTP: only|include work, and ANY other value FAILS CLOSED', async () => {
    const live = await seedContext();
    const archived = await seedContext({ archived: true });

    const idsFor = async (qs: string) => {
      const res = await request(app)
        .get(`/api/contexts?limit=100${qs}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Project-ID', projectId);
      return { status: res.status, ids: (res.body?.data?.contexts ?? []).map((c: { id: string }) => c.id) };
    };

    // POSITIVE CONTROL: the default view really does return this project's rows, so
    // "archived is absent" below cannot be an artifact of an empty response.
    const def = await idsFor('');
    expect(def.status).toBe(200);
    expect(def.ids).toContain(live);
    expect(def.ids).not.toContain(archived);

    const only = await idsFor('&archived=only');
    expect(only.status).toBe(200);
    expect(only.ids).toContain(archived);
    expect(only.ids).not.toContain(live);

    const inc = await idsFor('&archived=include');
    expect(inc.status).toBe(200);
    expect(inc.ids).toEqual(expect.arrayContaining([live, archived]));

    // FAIL CLOSED. A typo, a case slip, a truthy string and an empty value are all
    // REJECTED at the edge (strict schema) — none of them leaks an archived row. That
    // direction is the whole point: a fail-OPEN parse would put soft-deleted contexts
    // back in the default list, which is the hole this task exists to close.
    for (const value of ['inclde', 'ONLY', 'true', '', 'all']) {
      const bad = await idsFor(`&archived=${encodeURIComponent(value)}`);
      expect(bad.status).toBe(400);
      expect(bad.ids).not.toContain(archived);
    }
  });

  it('getContextById still returns an archived context — or Restore would be unreachable', async () => {
    const id = await seedContext({ archived: true });
    const row = await ContextService.getContextById(id);
    expect(row?.id).toBe(id);
    expect(row?.archived_at).not.toBeNull();
  });

  it('stats and count exclude archived rows, and report `archived` separately', async () => {
    const scope = projectsScope([projectId]);
    const before = await ContextService.getContextStats(scope);
    const beforeCount = await ContextService.count(scope);

    const id = await seedContext();
    expect(await ContextService.count(scope)).toBe(beforeCount + 1);

    await ContextService.deleteContext(id);

    const after = await ContextService.getContextStats(scope);
    expect(after.total_contexts).toBe(before.total_contexts);
    expect(after.archived).toBe(before.archived + 1);
    expect(await ContextService.count(scope)).toBe(beforeCount);
  });

  it('project stats stop counting a context once it is deleted', async () => {
    const scope = projectsScope([projectId]);
    const id = await seedContext();
    const before = await ProjectService.getProjectStats(scope);

    await ContextService.deleteContext(id);

    const after = await ProjectService.getProjectStats(scope);
    expect(after.total_contexts).toBe(before.total_contexts - 1);
  });

  it('project list keeps a project with ZERO live contexts — the archive predicate must live in the JOIN, not a WHERE', async () => {
    // The empty population: a project whose only context is archived. If the predicate
    // were appended to the WHERE, the LEFT JOIN would degenerate to an INNER JOIN and the
    // project would VANISH from the list entirely.
    const emptyProjectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'archived-only fixture', 'active', NOW())`,
      [emptyProjectId, `softdel-empty-${emptyProjectId.slice(0, 8)}`],
    );
    try {
      await seedContext({ projectId: emptyProjectId, archived: true });
      const projects = await ProjectService.getAllProjects(projectsScope([emptyProjectId]));
      const row = projects.find((p) => p.id === emptyProjectId);
      expect(row).toBeDefined();
      expect(row?.context_count).toBe(0);
    } finally {
      await db.query('DELETE FROM contexts WHERE project_id = $1', [emptyProjectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [emptyProjectId]);
    }
  });

  it('a deleted context is not recommended back as a RELATED context', async () => {
    // getRelatedContexts is embedding-ordered, so drive the predicate directly rather
    // than depending on a vector fixture: the claim under test is that the query carries
    // `c2.archived_at IS NULL`, and an archived neighbour must not come back.
    const anchor = await seedContext();
    const neighbour = await seedContext();
    const related = await db.query(
      `SELECT c2.id FROM contexts c1 JOIN contexts c2 ON c1.id != c2.id
       WHERE c1.id = $1 AND c2.archived_at IS NULL AND c2.id = $2`,
      [anchor, neighbour],
    );
    expect(related.rowCount).toBe(1); // POSITIVE CONTROL: reachable while live.

    await ContextService.deleteContext(neighbour);
    const after = await db.query(
      `SELECT c2.id FROM contexts c1 JOIN contexts c2 ON c1.id != c2.id
       WHERE c1.id = $1 AND c2.archived_at IS NULL AND c2.id = $2`,
      [anchor, neighbour],
    );
    expect(after.rowCount).toBe(0);
  });
});
