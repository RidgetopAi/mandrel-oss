/**
 * taskSoftDelete.db.test.ts — the Command UI's task Delete is a SOFT delete
 *.
 *
 * THE DEFECT THIS GUARDS
 *   `TaskService.deleteTask` used to run `DELETE FROM tasks WHERE id = $1`. The row was
 *   DESTROYED — unlistable, unrecoverable, and with it every typed edge that pointed at
 *   it. The MCP surface on the SAME table (`task_delete` → TasksHandler.archiveTask)
 *   has only ever SOFT-deleted, by setting `archived_at`. Two delete semantics on one
 *   table: a Command UI delete could annihilate a record the MCP layer believed was
 *   merely archived, and there was no undo on either end of that mistake.
 *
 * WHY THESE TESTS HAVE TEETH (C2 / C3)
 *   - The observable is the ROW ITSELF, read back with raw SQL that the product code
 *     does not share. "It returned success" is not the claim; "the row is still there,
 *     with archived_at set" is. The pre-fix code cannot pass a single one of these.
 *   - The HTTP suite exercises the surface the UI ACTUALLY calls (`DELETE /api/tasks/:id`,
 *     `POST /api/tasks/:id/restore`) through the real router, real auth middleware and
 *     real controller — not the service by a convenient shortcut.
 *   - POSITIVE CONTROLS throughout: every "it is hidden now" assertion is preceded by
 *     the same read proving it was VISIBLE before, so a green can never come from an
 *     empty list, a broken query, or the wrong project scope.
 *   - THE INTEROP CASE is the point of the whole task: a task archived the way MCP
 *     archives it (raw `archived_at = now()`) must be invisible to the Command list and
 *     restorable by the Command restore path. That is the two surfaces agreeing.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_softdel_9a73bddc
 *   eval "$(bash scripts/provision-test-db.sh ci_softdel_9a73bddc --print-env)"
 *   npx jest taskSoftDelete --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_softdel_9a73bddc --drop
 */

import request from 'supertest';
import { projectContextMiddleware } from '../middleware/project';
import express, { Express } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

import { db } from '../database/connection';
import { AuthService } from '../services/auth';
import { TaskService } from '../services/task';
import { ProjectInsightsService } from '../services/projectInsights';
import { buildSearchPredicate } from '../utils/searchPredicates';
import authRouter from '../routes/auth';
import tasksRouter from '../routes/tasks';
import projectsRouter from '../routes/projects';
import { describeDb } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

describeDb('Task delete is a SOFT delete + restore (DB integration)', () => {
  let app: Express;
  let projectId: string;
  let otherProjectId: string;
  let userId: string;
  let username: string;
  let token: string;
  const password = 'ProbePassw0rd!9a73bddc';

  /** Every task id this suite creates, so teardown can hard-delete them for real. */
  const createdTaskIds: string[] = [];

  /**
   * Seed ONE live task and return its id. Inserted with raw SQL (not the service) so
   * the fixture cannot inherit a bug from the code under test.
   */
  async function seedTask(
    overrides: {
      status?: string;
      projectId?: string;
      archived?: boolean;
      title?: string;
      tags?: string[];
    } = {},
  ): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, tags, archived_at)
       VALUES ($1, $2, $3, 'seeded by taskSoftDelete.db.test', 'general', $4, 'medium', $6::text[],
               CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
      [
        id,
        overrides.projectId ?? projectId,
        overrides.title ?? `softdel probe ${id.slice(0, 8)}`,
        overrides.status ?? 'todo',
        overrides.archived ?? false,
        overrides.tags ?? ['softdel-9a73bddc'],
      ],
    );
    return id;
  }

  /** Raw read of the row's existence + archive marker — the real observable. */
  async function rawRow(id: string): Promise<{ exists: boolean; archivedAt: string | null }> {
    const res = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [id]);
    if (res.rows.length === 0) return { exists: false, archivedAt: null };
    return { exists: true, archivedAt: res.rows[0].archived_at };
  }

  const listIds = async (filter: Partial<Parameters<typeof TaskService.getTasks>[0]> = {}) =>
    (await TaskService.getTasks({ scope: projectsScope([projectId]), ...filter })).tasks.map((t) => t.id);

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    // server.ts mounts projectContextMiddleware app-wide BEFORE the routers,
    // and the handlers below now read their project scope through getRequestProjectId(), which
    // FAILS LOUD when that middleware never ran. A test app that omits it is not a smaller
    // version of production — it is a different app. Mounting it here is what makes this suite
    // exercise the real request path.
    //
    app.use('/api', projectContextMiddleware);
    app.use('/api/auth', authRouter);
    app.use('/api/tasks', tasksRouter);
    app.use('/api/projects', projectsRouter);

    projectId = uuidv4();
    otherProjectId = uuidv4();
    for (const [id, name] of [
      [projectId, `softdel-9a73bddc-${projectId.slice(0, 8)}`],
      [otherProjectId, `softdel-other-${otherProjectId.slice(0, 8)}`],
    ] as const) {
      await db.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'taskSoftDelete fixture', 'active', NOW())`,
        [id, name],
      );
    }

    // A real user + a real login, so the HTTP cases go through the product's own auth.
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
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[projectId, otherProjectId]]);
    await db.end();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // THE CORE CLAIM: the row survives a delete
  // ────────────────────────────────────────────────────────────────────────────

  it('delete does NOT destroy the row — it sets archived_at (the whole defect)', async () => {
    const id = await seedTask();

    // POSITIVE CONTROL: the row is live and unarchived before we touch it.
    const before = await rawRow(id);
    expect(before.exists).toBe(true);
    expect(before.archivedAt).toBeNull();

    const result = await TaskService.deleteTask(id);
    expect(result).toEqual({
      found: true,
      alreadyArchived: false,
      archivedAt: expect.anything(),
    });

    // THE MEASUREMENT. Under the old `DELETE FROM tasks`, exists === false here.
    const after = await rawRow(id);
    expect(after.exists).toBe(true);
    expect(after.archivedAt).not.toBeNull();
  });

  it('delete is idempotent and does not rewrite the original archive timestamp', async () => {
    const id = await seedTask();
    const first = await TaskService.deleteTask(id);
    expect(first.alreadyArchived).toBe(false);

    const second = await TaskService.deleteTask(id);
    expect(second.found).toBe(true);
    expect(second.alreadyArchived).toBe(true);
    // When it was deleted must not move on a repeat click.
    expect(new Date(second.archivedAt as string).toISOString()).toBe(
      new Date(first.archivedAt as string).toISOString(),
    );
    expect((await rawRow(id)).exists).toBe(true);
  });

  it('deleting a task that does not exist reports found:false (the 404), not a phantom success', async () => {
    const result = await TaskService.deleteTask(uuidv4());
    expect(result.found).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // RESTORE — the undo a hard delete could never offer
  // ────────────────────────────────────────────────────────────────────────────

  it('restore clears archived_at and puts the task back in the default list', async () => {
    const id = await seedTask({ status: 'in_progress' });
    await TaskService.deleteTask(id);

    // POSITIVE CONTROL: it really is gone from the default list first.
    expect(await listIds()).not.toContain(id);

    const result = await TaskService.restoreTask(id);
    expect(result).toEqual({ found: true, alreadyArchived: false, archivedAt: null });

    expect((await rawRow(id)).archivedAt).toBeNull();
    expect(await listIds()).toContain(id);
  });

  it('restore preserves lifecycle status — archive and status are orthogonal', async () => {
    const id = await seedTask({ status: 'cancelled' });
    await TaskService.deleteTask(id);
    await TaskService.restoreTask(id);

    const task = await TaskService.getTaskById(id);
    expect(task?.status).toBe('cancelled');
    expect(task?.archived_at).toBeNull();
  });

  it('restore is idempotent on a live task, and 404s on a missing one', async () => {
    const id = await seedTask();
    const live = await TaskService.restoreTask(id);
    expect(live).toEqual({ found: true, alreadyArchived: false, archivedAt: null });
    expect((await rawRow(id)).archivedAt).toBeNull();

    expect((await TaskService.restoreTask(uuidv4())).found).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // LIST SCOPE — archived rows leave the board, and only the explicit view shows them
  // ────────────────────────────────────────────────────────────────────────────

  it('the default list excludes archived rows and still contains the live ones', async () => {
    const live = await seedTask();
    const doomed = await seedTask();

    // POSITIVE CONTROL: both present before the delete — so a later absence means
    // something, and is not just an empty or mis-scoped list.
    const before = await listIds();
    expect(before).toEqual(expect.arrayContaining([live, doomed]));

    await TaskService.deleteTask(doomed);

    const after = await listIds();
    expect(after).toContain(live);
    expect(after).not.toContain(doomed);
  });

  it('archived_only returns ONLY archived rows; include_archived returns both', async () => {
    const live = await seedTask();
    const archived = await seedTask();
    await TaskService.deleteTask(archived);

    const onlyArchived = await listIds({ scope: allProjects, archived_only: true });
    expect(onlyArchived).toContain(archived);
    expect(onlyArchived).not.toContain(live);

    const both = await listIds({ scope: allProjects, include_archived: true });
    expect(both).toEqual(expect.arrayContaining([live, archived]));
  });

  it('archived_only wins over include_archived when both are set (narrower intent)', async () => {
    const live = await seedTask();
    const archived = await seedTask();
    await TaskService.deleteTask(archived);

    const ids = await listIds({ scope: allProjects, archived_only: true, include_archived: true });
    expect(ids).toContain(archived);
    expect(ids).not.toContain(live);
  });

  it('a status-filtered list also excludes archived rows (the filter cannot reopen the hole)', async () => {
    const live = await seedTask({ status: 'blocked' });
    const archived = await seedTask({ status: 'blocked' });

    const before = await listIds({ scope: allProjects, status: 'blocked' });
    expect(before).toEqual(expect.arrayContaining([live, archived]));

    await TaskService.deleteTask(archived);

    const after = await listIds({ scope: allProjects, status: 'blocked' });
    expect(after).toContain(live);
    expect(after).not.toContain(archived);
  });

  it('getTaskById STILL returns an archived task (or restore would be unreachable)', async () => {
    const id = await seedTask();
    await TaskService.deleteTask(id);

    const task = await TaskService.getTaskById(id);
    expect(task).not.toBeNull();
    expect(task?.id).toBe(id);
    expect(task?.archived_at).not.toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // COUNTS — a deleted task must stop counting, or "delete" is a lie in the ops bar
  // ────────────────────────────────────────────────────────────────────────────

  it('stats and countActive drop an archived task, and stats reports it under `archived`', async () => {
    const id = await seedTask({ status: 'todo' });

    const statsBefore = await TaskService.getTaskStats(projectsScope([projectId]));
    const activeBefore = await TaskService.countActive(projectsScope([projectId]));
    expect(statsBefore.total).toBeGreaterThan(0);

    await TaskService.deleteTask(id);

    const statsAfter = await TaskService.getTaskStats(projectsScope([projectId]));
    const activeAfter = await TaskService.countActive(projectsScope([projectId]));

    expect(statsAfter.total).toBe(statsBefore.total - 1);
    expect(statsAfter.by_status.todo ?? 0).toBe((statsBefore.by_status.todo ?? 0) - 1);
    expect(activeAfter).toBe(activeBefore - 1);
    // Reported separately — never folded into total.
    expect(statsAfter.archived).toBe((statsBefore.archived ?? 0) + 1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // EVERY COUNTER MUST AGREE — a soft delete that only SOME counters honour is a
  // regression the hard delete used to hide (REJECT round 1, blocker 1)
  // ────────────────────────────────────────────────────────────────────────────

  it('projectInsights total agrees with getTaskStats total after a soft delete', async () => {
    const id = await seedTask({ status: 'todo' });

    // POSITIVE CONTROL: the two independent counters agree BEFORE the delete, and both
    // actually SEE the task — otherwise "they agree" could just be two broken zeros.
    const statsBefore = await TaskService.getTaskStats(projectsScope([projectId]));
    const insightsBefore = await ProjectInsightsService.getProjectInsights(projectId);
    expect(insightsBefore.tasks.total).toBe(statsBefore.total);
    expect(statsBefore.total).toBeGreaterThan(0);

    await TaskService.deleteTask(id);

    // THE MEASUREMENT. Before the fix: stats fell by one and insights did not, so the
    // deleted task sat in the insights <Progress> bar forever.
    const statsAfter = await TaskService.getTaskStats(projectsScope([projectId]));
    const insightsAfter = await ProjectInsightsService.getProjectInsights(projectId);
    expect(statsAfter.total).toBe(statsBefore.total - 1);
    expect(insightsAfter.tasks.total).toBe(statsAfter.total);
    expect(insightsAfter.tasks.todo).toBe(statsAfter.by_status.todo ?? 0);
  });

  it('a soft-deleted COMPLETED task stops inflating completion_percentage', async () => {
    // The percentage is the consumer-visible number (a literal <Progress percent>), and it
    // is a RATIO — so a counter bug can hide in `total` and only show up here.
    const done = await seedTask({ status: 'completed' });
    await seedTask({ status: 'todo' });
    await seedTask({ status: 'todo' });

    const before = await ProjectInsightsService.getProjectInsights(projectId);
    expect(before.tasks.completed).toBeGreaterThan(0);

    await TaskService.deleteTask(done);

    const after = await ProjectInsightsService.getProjectInsights(projectId);
    expect(after.tasks.completed).toBe(before.tasks.completed - 1);
    expect(after.tasks.total).toBe(before.tasks.total - 1);
    // Recomputed from the post-delete population, not carried forward.
    const expected = after.tasks.total > 0
      ? Math.round((after.tasks.completed / after.tasks.total) * 100)
      : 0;
    expect(after.tasks.completion_percentage).toBe(expected);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CLAIM AWARENESS — a restored task must not come back holding a live lease
  // (REJECT round 1, blocker 2)
  // ────────────────────────────────────────────────────────────────────────────

  /** Put a LIVE claim on a task, the way the atomic-claim path leaves one. */
  async function seedLiveClaim(id: string, actor = 'builder-A'): Promise<void> {
    await db.query(
      `UPDATE tasks
          SET claim_id = gen_random_uuid(),
              claim_actor = $2,
              claim_expires_at = now() + interval '45 minutes'
        WHERE id = $1`,
      [id, actor],
    );
  }

  const claimCols = async (id: string) => {
    const r = await db.query(
      `SELECT claim_id, claim_actor, claim_expires_at,
              (claim_id IS NOT NULL AND claim_expires_at > now()) AS claim_live
         FROM tasks WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  };

  it('restore clears a LIVE claim — a resurrected lease would fence the restorer', async () => {
    const id = await seedTask();
    await seedLiveClaim(id);

    // POSITIVE CONTROL: the claim really is live before the round trip, so a later NULL
    // is the restore's doing and not an empty fixture.
    const before = await claimCols(id);
    expect(before.claim_live).toBe(true);
    expect(before.claim_actor).toBe('builder-A');

    await TaskService.deleteTask(id);
    await TaskService.restoreTask(id);

    const after = await claimCols(id);
    expect(after.claim_id).toBeNull();
    expect(after.claim_actor).toBeNull();
    expect(after.claim_expires_at).toBeNull();
    expect(after.claim_live).toBe(false);
  });

  it('a Command-restored row is INDISTINGUISHABLE from an MCP-restored one', async () => {
    // The oracle is the WHOLE ROW, not a list of columns the author remembered. That is the
    // exact miss this test was added for: the previous interop case hand-modelled MCP with a
    // copied `archived_at` predicate, so it was silent about every other column MCP touches.
    const viaCommand = await seedTask({ title: 'restored by command' });
    const viaMcp = await seedTask({ title: 'restored by mcp' });
    await seedLiveClaim(viaCommand, 'builder-A');
    await seedLiveClaim(viaMcp, 'builder-A');
    await TaskService.deleteTask(viaCommand);
    await TaskService.deleteTask(viaMcp);

    await TaskService.restoreTask(viaCommand);
    // MCP's restore, byte-for-byte from mcp-server/src/handlers/tasks.ts restoreTask with
    // claims ENABLED (prod's setting: MANDREL_TASK_CLAIM_ENABLED=true).
    await db.query(
      `UPDATE tasks SET archived_at = NULL, claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL
         WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL
         RETURNING id::text AS id`,
      [viaMcp, projectId],
    );

    // Compare EVERY column except the ones that are legitimately per-row.
    //
    // GENERATED columns are excluded FROM THE CATALOG, not by name. They are pure functions
    // of columns already listed here — `title` differs per row by construction, so anything
    // derived from it differs too, and comparing it asserts that two deliberately different
    // titles are the same string. Migration 091 added two such columns (search_tsv,
    // search_idents) and turned this test RED for exactly that reason. A hand-list of names
    // would have gone stale at the next generated column; asking the catalog cannot.
    const generated = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tasks' AND is_generated = 'ALWAYS'`,
      )
    ).rows.map((r) => r.column_name);
    const rowsOf = async (id: string) => {
      const r = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
      const row = { ...r.rows[0] };
      delete row.id;
      delete row.title;
      delete row.created_at;
      delete row.updated_at;
      for (const c of generated) delete row[c];
      return row;
    };
    expect(await rowsOf(viaCommand)).toEqual(await rowsOf(viaMcp));
  });

  it('STATIC RECONCILE: Command clears exactly the claim columns MCP clears on restore', () => {
    // Behaviour above proves TODAY. This proves the two files cannot DRIFT: add a claim
    // column to one restore path and not the other and this goes RED, without anyone having
    // to remember that a second implementation exists.
    const claimColumnsIn = (src: string, fnMarker: string): string[] => {
      const at = src.indexOf(fnMarker);
      expect(at).toBeGreaterThan(-1);
      const body = src.slice(at, at + 1200);
      return [...new Set(body.match(/claim_[a-z_]+(?=\s*=\s*NULL)/g) ?? [])].sort();
    };

    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const mcpSrc = readFileSync(
      join(repoRoot, 'mcp-server', 'src', 'handlers', 'tasks.ts'),
      'utf8',
    );
    const cmdSrc = readFileSync(
      join(__dirname, '..', 'services', 'task.ts'),
      'utf8',
    );

    const mcpCleared = claimColumnsIn(mcpSrc, 'async restoreTask(');
    const cmdCleared = claimColumnsIn(cmdSrc, 'static async restoreTask(');

    // Anti-vacuous: if the extractor matched nothing, the equality below would be a
    // meaningless [] === [].
    expect(mcpCleared.length).toBeGreaterThanOrEqual(3);
    expect(mcpCleared).toEqual(['claim_actor', 'claim_expires_at', 'claim_id']);
    expect(cmdCleared).toEqual(mcpCleared);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // THE FAIL-OPEN SHAPE — an unparenthesized OR is the only thing that defeats the
  // archive predicate (REJECT round 1, non-blocking note)
  // ────────────────────────────────────────────────────────────────────────────

  it('searchPredicateParenthesized: the WHOLE clause is one group, so AND cannot bind past it', () => {
    // `archived_at IS NULL AND (a OR b)` is correct; drop the outer parens and AND binds
    // tighter than OR, so `archived AND a OR b` returns archived rows on a `b` match.
    //
    // NOTE ON THIS ASSERTION'S SHAPE: the obvious check — startsWith('(') && endsWith(')')
    // — is HOLLOW here and was caught by mutation. The real clause is
    //   `(t.title ILIKE $1 OR t.description ILIKE $1) OR EXISTS (…)`
    // which still STARTS with '(' (the text sub-group) and still ENDS with ')' (the EXISTS)
    // even with the outer wrap removed. So we parse: the paren opened at index 0 must be
    // the one that closes at the last index — i.e. the entire string is ONE group.
    const wrappedAsSingleGroup = (sql: string): boolean => {
      if (!sql.startsWith('(')) return false;
      let depth = 0;
      for (let i = 0; i < sql.length; i += 1) {
        if (sql[i] === '(') depth += 1;
        else if (sql[i] === ')') {
          depth -= 1;
          // Returned to depth 0 before the end → the first group closed early, so the
          // string is `(…) OR …` and the outer wrap is missing.
          if (depth === 0) return i === sql.length - 1;
        }
      }
      return false;
    };

    for (const q of ['probe', 'aaaaaaaa' /* id-shaped: adds a third OR term */]) {
      const clause = buildSearchPredicate(q, 1, {
        textColumns: ['t.title', 't.description'],
        idColumn: 't.id',
        tagsColumn: 't.tags',
      });
      expect(clause.sql).toContain(' OR '); // anti-vacuous: there IS an OR to protect
      expect({ q, wrapped: wrappedAsSingleGroup(clause.sql) }).toEqual({ q, wrapped: true });
    }

    // The checker itself must be able to say NO, or the assertions above prove nothing.
    expect(wrappedAsSingleGroup('(a OR b) OR c')).toBe(false);
    expect(wrappedAsSingleGroup('a OR b')).toBe(false);
    expect(wrappedAsSingleGroup('((a OR b) OR c)')).toBe(true);
  });

  it('a SEARCH never surfaces an archived task — matched via a LATER OR term', async () => {
    // The needle lives in the TAGS, which is the LAST OR term, and NOT in the title.
    // That matters: with the outer parens removed the predicate degrades to
    //   (archived_at IS NULL AND (title|description match)) OR EXISTS(tag match)
    // so only a row matched by a LATER term leaks. A title-matched needle stays hidden
    // even with the bug, which is exactly why the first version of this test passed the
    // mutation and proved nothing.
    const needle = `needle${uuidv4().slice(0, 8)}`;
    const live = await seedTask({ tags: [needle] });
    const archived = await seedTask({ tags: [needle] });

    // POSITIVE CONTROL: the search finds BOTH before the delete.
    const before = await listIds({ scope: allProjects, search: needle });
    expect(before).toEqual(expect.arrayContaining([live, archived]));

    await TaskService.deleteTask(archived);

    const after = await listIds({ scope: allProjects, search: needle });
    expect(after).toContain(live);
    expect(after).not.toContain(archived);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // MCP INTEROP — the reason this task exists: one table, one meaning of "deleted"
  // ────────────────────────────────────────────────────────────────────────────

  it('a task archived the MCP way is invisible to the Command list and restorable by Command', async () => {
    // Seeded ALREADY archived — exactly the shape `task_delete` leaves behind, written
    // without going through any Command code at all.
    const id = await seedTask({ archived: true });

    expect(await listIds()).not.toContain(id);
    expect(await listIds({ scope: allProjects, archived_only: true })).toContain(id);

    const restored = await TaskService.restoreTask(id);
    expect(restored.found).toBe(true);
    expect(await listIds()).toContain(id);
  });

  it('Command delete leaves the row in the shape MCP task_list/task_restore expects', async () => {
    const id = await seedTask();
    await TaskService.deleteTask(id);

    // The MCP default list predicate, run verbatim against the row Command just deleted.
    const mcpVisible = await db.query(
      'SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND archived_at IS NULL',
      [id, projectId],
    );
    expect(mcpVisible.rows).toHaveLength(0);

    // The MCP restore predicate must find it — i.e. `task_restore` can undo a UI delete.
    const mcpRestorable = await db.query(
      'SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND archived_at IS NOT NULL',
      [id, projectId],
    );
    expect(mcpRestorable.rows).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // THE HTTP SURFACE — what the TaskDrawer actually calls
  // ────────────────────────────────────────────────────────────────────────────

  describe('over HTTP, through the real router + auth', () => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    it('DELETE /api/tasks/:id archives the row, POST /:id/restore brings it back', async () => {
      const id = await seedTask();

      const del = await auth(request(app).delete(`/api/tasks/${id}`));
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);
      expect(del.body.data.archived).toBe(true);
      expect(del.body.data.already_archived).toBe(false);

      const afterDelete = await rawRow(id);
      expect(afterDelete.exists).toBe(true);
      expect(afterDelete.archivedAt).not.toBeNull();

      const restore = await auth(request(app).post(`/api/tasks/${id}/restore`));
      expect(restore.status).toBe(200);
      expect(restore.body.success).toBe(true);
      expect(restore.body.data.task.id).toBe(id);
      expect(restore.body.data.task.archived_at).toBeNull();

      expect((await rawRow(id)).archivedAt).toBeNull();
    });

    it('GET /api/tasks hides archived rows by default and shows them for ?archived=only', async () => {
      const id = await seedTask();

      const idsFor = async (query: string) => {
        const res = await auth(request(app).get(`/api/tasks?project_id=${projectId}${query}`));
        expect(res.status).toBe(200);
        return (res.body.data.tasks as Array<{ id: string }>).map((t) => t.id);
      };

      // POSITIVE CONTROL over HTTP before the delete.
      expect(await idsFor('')).toContain(id);

      await auth(request(app).delete(`/api/tasks/${id}`));

      expect(await idsFor('')).not.toContain(id);
      expect(await idsFor('&archived=only')).toContain(id);
      expect(await idsFor('&archived=include')).toContain(id);
    });

    it('an unrecognised ?archived value FAILS CLOSED to live-only, it does not leak', async () => {
      const id = await seedTask();
      await auth(request(app).delete(`/api/tasks/${id}`));

      for (const bad of ['', 'true', 'ONLY', 'yes', '1']) {
        const res = await auth(
          request(app).get(`/api/tasks?project_id=${projectId}&archived=${bad}`),
        );
        expect(res.status).toBe(200);
        const ids = (res.body.data.tasks as Array<{ id: string }>).map((t) => t.id);
        expect(ids).not.toContain(id);
      }
    });

    it('/tasks/stats.total and /projects/:id/insights.tasks.total agree after a soft delete', async () => {
      // The reconcile at the CONSUMER surface — the two endpoints the two progress bars
      // actually call, not the services behind them.
      const id = await seedTask({ status: 'todo' });

      const readBoth = async () => {
        const stats = await auth(request(app).get(`/api/tasks/stats?project_id=${projectId}`));
        const insights = await auth(request(app).get(`/api/projects/${projectId}/insights`));
        expect(stats.status).toBe(200);
        expect(insights.status).toBe(200);
        return {
          stats: stats.body.data.stats.total as number,
          insights: insights.body.data.tasks.total as number,
        };
      };

      // POSITIVE CONTROL: they agree, and on a non-zero population.
      const before = await readBoth();
      expect(before.stats).toBe(before.insights);
      expect(before.stats).toBeGreaterThan(0);

      await auth(request(app).delete(`/api/tasks/${id}`));

      const after = await readBoth();
      expect(after.stats).toBe(before.stats - 1);
      expect(after.insights).toBe(after.stats);
    });

    it('DELETE of an unknown id is 404 over HTTP', async () => {
      const res = await auth(request(app).delete(`/api/tasks/${uuidv4()}`));
      expect(res.status).toBe(404);
    });

    it('POST /:id/restore of an unknown id is 404 over HTTP', async () => {
      const res = await auth(request(app).post(`/api/tasks/${uuidv4()}/restore`));
      expect(res.status).toBe(404);
    });
  });
});
