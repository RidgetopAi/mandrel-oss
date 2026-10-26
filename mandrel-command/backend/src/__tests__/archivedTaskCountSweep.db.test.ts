/**
 * archivedTaskCountSweep.db.test.ts — ARCHIVED tasks must not be counted anywhere a
 * human reads a number off a Command surface.
 *
 * THE DEFECT
 *   The Tasks board showed 6 in progress while `task_list` showed 4: two archived
 *   (soft-deleted) rows still carried `status = 'in_progress'`, and the count that feeds
 *   the board's In-progress column did not filter `archived_at IS NULL`. Archived is
 *   soft-deleted; a soft-deleted row must not appear in a list OR move a count,
 *   whatever its status.
 *
 * WHY THIS SUITE EXISTS EVEN WHERE THE PREDICATE IS ALREADY PRESENT
 *   The board reads were archive-filtered by the time this was worked, but nothing
 *   asserted the per-status counts — only `total` and `by_status.todo`. `in_progress`,
 *   `blocked`, `completed` and `cancelled` could each have been the next one to drift,
 *   and the original number would not reproduce on today's data because whether an
 *   archived row happens to sit in a given status is a property of the data, not of the
 *   query. So the guard fixes the population instead of the day: EVERY board status gets
 *   a live cohort and an archived cohort, and each rendered count is pinned to the live
 *   one. Mutation evidence for these assertions is the removal of `archived_at IS NULL`
 *   from the read under test — each such removal turns this suite RED.
 *
 * THE SURFACES ASSERTED (HTTP, through the real router + auth — what the UI calls)
 *   - GET /api/tasks/stats   — the OpsBar progress segments + the WIP·blocked KPI tile
 *   - GET /api/tasks         — the rows the board groups into its columns
 *   - GET /api/sessions/:id  — the session detail's task list + its task counters
 *   - GET /api/sessions/summaries — the same two counters on the list surface
 *
 * EVERY count assertion is paired with the SAME count taken WITHOUT the archive
 * predicate, read straight from Postgres. That unfiltered number is the wrong answer the
 * defect produced, so a green here can never come from a fixture that failed to create
 * any skew — the two numbers are asserted to differ.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_archcount_c987497b
 *   eval "$(bash scripts/provision-test-db.sh ci_archcount_c987497b --print-env)"
 *   npx jest archivedTaskCountSweep --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_archcount_c987497b --drop
 */

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { projectContextMiddleware } from '../middleware/project';
import { db } from '../database/connection';
import { AuthService } from '../services/auth';
import authRouter from '../routes/auth';
import tasksRouter from '../routes/tasks';
import sessionsRouter from '../routes/sessions';
import { describeDb } from './helpers/dbContractGate';

/** The four columns the board renders, plus the status the List view can still select. */
const BOARD_STATUSES = ['todo', 'in_progress', 'blocked', 'completed'] as const;
const ALL_STATUSES = [...BOARD_STATUSES, 'cancelled'] as const;
type SeededStatus = (typeof ALL_STATUSES)[number];

/**
 * live/archived counts seeded per status. `in_progress` carries the shape of the
 * original report (live rows plus archived rows that never left `in_progress`).
 */
const SEED_PLAN: Record<SeededStatus, { live: number; archived: number }> = {
  todo: { live: 2, archived: 1 },
  in_progress: { live: 2, archived: 1 },
  blocked: { live: 1, archived: 1 },
  completed: { live: 3, archived: 2 },
  cancelled: { live: 1, archived: 1 },
};

describeDb('Archived tasks never move a rendered count', () => {
  let app: Express;
  let boardProjectId: string;
  let sessionProjectId: string;
  let sessionId: string;
  let userId: string;
  let token: string;

  const createdTaskIds: string[] = [];
  /** Live ids per status in the BOARD project — the answer every read must return. */
  const liveIds: Record<string, string[]> = {};
  /** Archived ids per status in the BOARD project — must appear in no list, no count. */
  const archivedIds: Record<string, string[]> = {};

  /** Seeded with raw SQL so the fixture cannot inherit a bug from the code under test. */
  async function seedTask(opts: {
    projectId: string;
    status: SeededStatus;
    archived: boolean;
    sessionId?: string;
  }): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, session_id, title, description, type, status,
                          priority, tags, archived_at, completed_at)
       VALUES ($1, $2, $3, $4, 'seeded by archivedTaskCountSweep.db.test', 'general', $5::text,
               'medium', ARRAY['archcount-c987f00d']::text[],
               CASE WHEN $6::boolean THEN now() ELSE NULL END,
               CASE WHEN $5::text = 'completed' THEN now() ELSE NULL END)`,
      [
        id,
        opts.projectId,
        opts.sessionId ?? null,
        `archcount ${opts.status}${opts.archived ? ' archived' : ''} ${id.slice(0, 8)}`,
        opts.status,
        opts.archived,
      ],
    );
    return id;
  }

  /**
   * The same count, both ways, straight from Postgres — no product code involved.
   * `live` is the right answer; `unfiltered` is the answer the defect rendered.
   */
  async function rawStatusCounts(
    projectId: string,
    status: string,
  ): Promise<{ live: number; unfiltered: number }> {
    const res = await db.query(
      `SELECT COUNT(*) FILTER (WHERE archived_at IS NULL)::int AS live,
              COUNT(*)::int AS unfiltered
         FROM tasks WHERE project_id = $1 AND status = $2`,
      [projectId, status],
    );
    return { live: res.rows[0].live, unfiltered: res.rows[0].unfiltered };
  }

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api', projectContextMiddleware);
    app.use('/api/auth', authRouter);
    app.use('/api/tasks', tasksRouter);
    app.use('/api/sessions', sessionsRouter);

    boardProjectId = uuidv4();
    sessionProjectId = uuidv4();
    for (const [id, name] of [
      [boardProjectId, `archcount-board-${boardProjectId.slice(0, 8)}`],
      [sessionProjectId, `archcount-sess-${sessionProjectId.slice(0, 8)}`],
    ] as const) {
      await db.query(
        `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1, $2, 'archivedTaskCountSweep fixture', 'active', NOW())`,
        [id, name],
      );
    }

    for (const status of ALL_STATUSES) {
      liveIds[status] = [];
      archivedIds[status] = [];
      for (let i = 0; i < SEED_PLAN[status].live; i++) {
        liveIds[status].push(
          await seedTask({ projectId: boardProjectId, status, archived: false }),
        );
      }
      for (let i = 0; i < SEED_PLAN[status].archived; i++) {
        archivedIds[status].push(
          await seedTask({ projectId: boardProjectId, status, archived: true }),
        );
      }
    }

    // The session fixture lives in its OWN project so its rows cannot perturb the board
    // numbers above. 2 live tasks (1 of them completed) + 2 archived (1 completed).
    sessionId = uuidv4();
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, started_at, ended_at,
                             total_tokens, contexts_created, decisions_created,
                             tasks_created, tasks_completed)
       VALUES ($1, $2, 'claude-code', NOW() - INTERVAL '60 minutes', NOW(), 1000, 0, 0, 0, 0)`,
      [sessionId, sessionProjectId],
    );
    await seedTask({ projectId: sessionProjectId, status: 'todo', archived: false, sessionId });
    await seedTask({ projectId: sessionProjectId, status: 'completed', archived: false, sessionId });
    await seedTask({ projectId: sessionProjectId, status: 'in_progress', archived: true, sessionId });
    await seedTask({ projectId: sessionProjectId, status: 'completed', archived: true, sessionId });

    userId = uuidv4();
    const username = `archcount_${userId.slice(0, 8)}`;
    const password = 'ProbePassw0rd!c987f00d';
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', true, false)`,
      [userId, username, `${username}@example.com`, await AuthService.hashPassword(password)],
    );
    const login = await request(app).post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);
    token = login.body.token as string;
  });

  afterAll(async () => {
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [
      [boardProjectId, sessionProjectId],
    ]);
    await db.end();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE FIXTURE ITSELF — if this fails, every count below is measuring nothing
  // ──────────────────────────────────────────────────────────────────────────────

  it('the fixture really does create archived rows in every board status', async () => {
    for (const status of ALL_STATUSES) {
      const raw = await rawStatusCounts(boardProjectId, status);
      expect(raw.live).toBe(SEED_PLAN[status].live);
      expect(raw.unfiltered).toBe(SEED_PLAN[status].live + SEED_PLAN[status].archived);
      // The skew the defect renders. Without this the suite could pass on empty data.
      expect(raw.unfiltered).toBeGreaterThan(raw.live);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE BOARD — the number in the ticket
  // ──────────────────────────────────────────────────────────────────────────────

  it('GET /api/tasks/stats counts each board status LIVE-only, not unfiltered', async () => {
    const res = await auth(request(app).get(`/api/tasks/stats?project_id=${boardProjectId}`));
    expect(res.status).toBe(200);
    const stats = res.body.data.stats as {
      total: number;
      archived: number;
      by_status: Record<string, number>;
    };

    for (const status of ALL_STATUSES) {
      const raw = await rawStatusCounts(boardProjectId, status);
      expect(stats.by_status[status] ?? 0).toBe(raw.live);
      expect(stats.by_status[status] ?? 0).not.toBe(raw.unfiltered);
    }

    const totals = Object.values(SEED_PLAN).reduce(
      (acc, s) => ({ live: acc.live + s.live, archived: acc.archived + s.archived }),
      { live: 0, archived: 0 },
    );
    expect(stats.total).toBe(totals.live);
    expect(stats.archived).toBe(totals.archived);
  });

  it('GET /api/tasks returns exactly the live rows the board columns render', async () => {
    const res = await auth(request(app).get(`/api/tasks?project_id=${boardProjectId}`));
    expect(res.status).toBe(200);
    const rows = res.body.data.tasks as Array<{ id: string; status: string }>;
    const returned = new Set(rows.map((t) => t.id));

    for (const status of ALL_STATUSES) {
      for (const id of liveIds[status]) expect(returned.has(id)).toBe(true);
      for (const id of archivedIds[status]) expect(returned.has(id)).toBe(false);
      // The column header count IS the length of this group (pages/tasks/Board.tsx).
      expect(rows.filter((t) => t.status === status)).toHaveLength(SEED_PLAN[status].live);
    }
  });

  it('the board list and the board stats report the SAME per-status counts', async () => {
    // The two reads feed two different widgets on one screen (columns vs progress bar).
    // Fixing one archive predicate and not the other is precisely how they disagreed.
    const [list, stats] = await Promise.all([
      auth(request(app).get(`/api/tasks?project_id=${boardProjectId}`)),
      auth(request(app).get(`/api/tasks/stats?project_id=${boardProjectId}`)),
    ]);
    expect(list.status).toBe(200);
    expect(stats.status).toBe(200);
    const rows = list.body.data.tasks as Array<{ status: string }>;
    const byStatus = stats.body.data.stats.by_status as Record<string, number>;

    for (const status of ALL_STATUSES) {
      expect(rows.filter((t) => t.status === status).length).toBe(byStatus[status] ?? 0);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE SIBLING SURFACES — the same predicate, one screen over
  // ──────────────────────────────────────────────────────────────────────────────

  it('GET /api/sessions/:id excludes archived tasks from the list AND its counters', async () => {
    const res = await auth(request(app).get(`/api/sessions/${sessionId}`));
    expect(res.status).toBe(200);
    const session = res.body.data.session as {
      tasks: Array<{ id: string }>;
      task_count: number;
      tasks_created: number;
      tasks_completed: number;
    };

    const raw = await db.query(
      `SELECT COUNT(*) FILTER (WHERE archived_at IS NULL)::int AS live,
              COUNT(*)::int AS unfiltered,
              COUNT(*) FILTER (WHERE archived_at IS NULL AND status = 'completed')::int AS live_done,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS unfiltered_done
         FROM tasks WHERE session_id = $1`,
      [sessionId],
    );
    const { live, unfiltered, live_done, unfiltered_done } = raw.rows[0];
    expect(unfiltered).toBeGreaterThan(live);
    expect(unfiltered_done).toBeGreaterThan(live_done);

    expect(session.tasks).toHaveLength(live);
    expect(session.task_count).toBe(live);
    expect(session.tasks_created).toBe(live);
    expect(session.tasks_completed).toBe(live_done);

    const ids = new Set(session.tasks.map((t) => t.id));
    const archived = await db.query(
      'SELECT id FROM tasks WHERE session_id = $1 AND archived_at IS NOT NULL',
      [sessionId],
    );
    expect(archived.rows.length).toBeGreaterThan(0);
    for (const row of archived.rows) expect(ids.has(row.id)).toBe(false);
  });

  it('GET /api/sessions/summaries counts the same live tasks the detail does', async () => {
    const [summaries, detail] = await Promise.all([
      auth(request(app).get(`/api/sessions/summaries?project_id=${sessionProjectId}&limit=50`)),
      auth(request(app).get(`/api/sessions/${sessionId}`)),
    ]);
    expect(summaries.status).toBe(200);
    expect(detail.status).toBe(200);

    const row = (summaries.body.data.summaries as Array<{
      id: string;
      tasks_created: number;
      tasks_completed: number;
    }>).find((s) => s.id === sessionId);
    expect(row).toBeDefined();

    const raw = await db.query(
      `SELECT COUNT(*) FILTER (WHERE archived_at IS NULL)::int AS live,
              COUNT(*)::int AS unfiltered,
              COUNT(*) FILTER (WHERE archived_at IS NULL AND status = 'completed')::int AS live_done,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS unfiltered_done
         FROM tasks WHERE session_id = $1`,
      [sessionId],
    );
    const { live, unfiltered, live_done, unfiltered_done } = raw.rows[0];
    expect(unfiltered).toBeGreaterThan(live);
    expect(unfiltered_done).toBeGreaterThan(live_done);

    expect(row!.tasks_created).toBe(live);
    expect(row!.tasks_completed).toBe(live_done);
    // LIST == DETAIL: the two surfaces must not be able to answer differently.
    expect(row!.tasks_created).toBe(detail.body.data.session.task_count);
    expect(row!.tasks_completed).toBe(detail.body.data.session.tasks_completed);
  });
});
