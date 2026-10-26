/**
 * DB-integration tests for the Calendar DAY-SUMMARY aggregation endpoint.
 * Exercises the REAL DaySummaryService against seeded rows so
 * every assertion FAILS if the aggregation, the TZ bucketing, or the momentum math is reverted
 * (mutation-resistant — tests-are-the-rock).
 *
 * WHAT IT PROVES
 *   1. TZ-CORRECT day boundary: an 8pm-EDT record (00:00Z the NEXT day) lands
 *      on the LOCAL day 2026-07-15 under America/New_York, but on 2026-07-16 under UTC.
 *   2. Exact KPI values + deltas vs the seeded rolling 7-day baseline.
 *   3. The TRANSPARENT momentum breakdown math (output / followThrough / depth sub-scores +
 *      the weighted blend + the baseline-relative delta), computed from hand-picked seed raws.
 *   4. Ribbon (24h density), highlights + auto-headline, decisions, tasks-completed, and the
 *      by-actor attribution (via the recording session's `actor`).
 *
 * Provision a throwaway migrated DB first (creates sessions/contexts/decisions/tasks + exts):
 *   bash scripts/provision-test-db.sh ci_daysummary_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_daysummary_fm --print-env)"
 *   npm test -- daySummary
 *   bash scripts/provision-test-db.sh ci_daysummary_fm --drop
 *
 * Gated by describeDb (helpers/dbContractGate): runs whenever Postgres is
 * reachable, and FAILS LOUDLY rather than skipping when it is not.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { DaySummaryService } from '../services/daySummary';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


const TZ = 'America/New_York';
const TARGET = '2026-07-15';
// The boundary instant: 00:00:02Z on 07-16 == 20:00:02 EDT on 07-15. Under Eastern it's the
// 15th; under UTC it's the 16th — the exact straddle an earlier task must get right.
const BOUNDARY = '2026-07-16 00:00:02+00';

describeDb('Calendar day-summary — aggregation + TZ bucketing + momentum (DB integration)', () => {
  let pool: Pool;
  const project = uuidv4();
  // Target-day sessions (actors drive the by-actor attribution).
  const sessCoordinator = uuidv4(); // actor coordinator
  const sessBuilder = uuidv4(); // actor builder

  async function insSession(id: string, actor: string, startedExpr: string, files: number) {
    await pool.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, started_at, actor, files_modified_count)
       VALUES ($1,$2,'mcp-server',$3,$4::timestamptz,$5,$6)`,
      [id, project, `ds-${id.slice(0, 8)}`, startedExpr, actor, files],
    );
  }
  async function insActivity(sessionId: string, occurredExpr: string) {
    await pool.query(
      `INSERT INTO session_activities (session_id, activity_type, occurred_at)
       VALUES ($1,'context_store',$2::timestamptz)`,
      [sessionId, occurredExpr],
    );
  }
  async function insContext(sessionId: string, type: string, content: string, createdExpr: string, relevance = 1.0) {
    await pool.query(
      `INSERT INTO contexts (id, project_id, session_id, context_type, content, relevance_score, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [uuidv4(), project, sessionId, type, content, relevance, createdExpr],
    );
  }
  async function insDecision(sessionId: string, title: string, dateExpr: string) {
    await pool.query(
      `INSERT INTO technical_decisions (id, project_id, session_id, decision_type, title, description, rationale, decision_date)
       VALUES ($1,$2,$3,'code_style',$4,'seed desc','seed rationale',$5::timestamptz)`,
      [uuidv4(), project, sessionId, title, dateExpr],
    );
  }
  /** Insert a task; returns its id. `completedExpr` null → not completed. */
  async function insTask(opts: {
    sessionId?: string | null;
    title?: string;
    createdExpr: string;
    completedExpr?: string | null;
  }): Promise<string> {
    const id = uuidv4();
    const { sessionId = null, title = 'seed task', createdExpr, completedExpr = null } = opts;
    await pool.query(
      `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, tags, created_at, completed_at)
       VALUES ($1,$2,$3,$4,'general',$5,'medium','{}',$6::timestamptz,${completedExpr ? '$7::timestamptz' : 'NULL'})`,
      completedExpr
        ? [id, project, sessionId, title, 'completed', createdExpr, completedExpr]
        : [id, project, sessionId, title, 'todo', createdExpr],
    );
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    await pool.query(
      `INSERT INTO projects (id, name, description, status, created_at) VALUES ($1,$2,$3,'active',NOW())`,
      [project, `daysummary-test-${project.slice(0, 8)}`, 'day-summary aggregation test'],
    );

    // ── TARGET DAY 2026-07-15 (Eastern) ──────────────────────────────────────────
    // sessions=2 (files 3+5=8); Session B starts at the boundary (20:00 EDT) to prove tz.
    await insSession(sessCoordinator, 'coordinator', '2026-07-15 14:00:00+00', 3); // 10:00 EDT
    await insSession(sessBuilder, 'builder', BOUNDARY, 5); // 20:00:02 EDT on the 15th

    // active_minutes=4 (distinct minutes): coordinator 10:00 & 10:05 EDT (hour 10), builder 20:00 &
    // 20:06 EDT (hour 20) → ribbon hour 10=2, hour 20=2.
    await insActivity(sessCoordinator, '2026-07-15 14:00:00+00');
    await insActivity(sessCoordinator, '2026-07-15 14:05:00+00');
    await insActivity(sessBuilder, BOUNDARY);
    await insActivity(sessBuilder, '2026-07-16 00:06:00+00');

    // contexts=5 (milestone + completion + 3 code), all on session coordinator. The milestone sits
    // at the boundary instant → also proves tz bucketing for contexts.
    await insContext(sessCoordinator, 'milestone', 'Shipped the day-summary aggregation endpoint to prod', BOUNDARY, 0.9);
    await insContext(sessCoordinator, 'completion', 'Closed out the calendar backend work', '2026-07-15 14:00:00+00', 0.8);
    await insContext(sessCoordinator, 'code', 'code note 1', '2026-07-15 14:10:00+00');
    await insContext(sessCoordinator, 'code', 'code note 2', '2026-07-15 14:11:00+00');
    await insContext(sessCoordinator, 'code', 'code note 3', '2026-07-15 14:12:00+00');

    // decisions=2 (session coordinator).
    await insDecision(sessCoordinator, 'Adopt the day-summary endpoint', '2026-07-15 15:00:00+00');
    await insDecision(sessCoordinator, 'Momentum weights config', '2026-07-15 15:30:00+00');

    // tasks: 4 opened on 07-15; 3 completed on 07-15 (2 via coordinator, 1 via builder).
    await insTask({ sessionId: sessCoordinator, title: 't1', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 18:00:00+00' });
    await insTask({ sessionId: sessCoordinator, title: 't2', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 18:30:00+00' });
    await insTask({ sessionId: sessBuilder, title: 't3', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 19:00:00+00' });
    await insTask({ sessionId: sessCoordinator, title: 't4-open', createdExpr: '2026-07-15 13:00:00+00' }); // opened, not done

    // ── BASELINE: 7 identical days 2026-07-08..07-14 (Eastern), seeded at noon EDT (16:00Z)
    // so they're unambiguously that day. Per day: output=10 (ctx6+dec2+done2), followThrough
    // 0.5 (2 done / 4 opened), depth=6 (1 session + 5 active-min + 0 milestone).
    for (let day = 8; day <= 14; day++) {
      const dd = String(day).padStart(2, '0');
      const noonZ = `2026-07-${dd} 16:00:00+00`;
      const bSess = uuidv4();
      await insSession(bSess, 'coordinator', noonZ, 2);
      for (let min = 0; min < 5; min++) {
        await insActivity(bSess, `2026-07-${dd} 16:0${min}:00+00`); // 5 distinct minutes
      }
      for (let c = 0; c < 6; c++) await insContext(bSess, 'code', `b-ctx ${dd}-${c}`, noonZ);
      await insDecision(bSess, `b-dec ${dd}-1`, noonZ);
      await insDecision(bSess, `b-dec ${dd}-2`, noonZ);
      // 4 opened, 2 completed
      await insTask({ sessionId: bSess, createdExpr: noonZ, completedExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ, completedExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ });
    }
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM session_activities WHERE session_id IN (SELECT id FROM sessions WHERE project_id=$1)`,
      [project],
    );
    await pool.query('DELETE FROM contexts WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM technical_decisions WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM tasks WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM sessions WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM projects WHERE id=$1', [project]);
    await pool.end();
  });

  // ── KPIs (target-day counts + deltas vs the 7-day rolling baseline) ────────────
  describe('KPIs — TZ-correct counts + baseline deltas', () => {
    it('counts the target day correctly and computes deltas vs the seeded baseline', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      // Baseline per-day: sessions 1, activeMin 5, contexts 6, decisions 2, tasksDone 2, files 2.
      expect(r.kpis.sessions).toEqual({ value: 2, delta: 1 });
      expect(r.kpis.activeMinutes).toEqual({ value: 4, delta: -1 });
      expect(r.kpis.contexts).toEqual({ value: 5, delta: -1 });
      expect(r.kpis.decisions).toEqual({ value: 2, delta: 0 });
      expect(r.kpis.tasksDone).toEqual({ value: 3, delta: 1 });
      expect(r.kpis.filesTouched).toEqual({ value: 8, delta: 6 });
    });
  });

  // ── TZ BOUNDARY (the whole point of an earlier task) ────────────────────────────
  describe('TZ-correct day boundary', () => {
    it('the 8pm-EDT session lands on 2026-07-15 under America/New_York (sessions=2)', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      expect(r.kpis.sessions.value).toBe(2);
    });

    it('under UTC the boundary session shifts to 07-16, so 07-15 shows sessions=1', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, 'UTC', projectsScope([project]));
      expect(r.kpis.sessions.value).toBe(1);
    });

    it('under UTC that session appears on 2026-07-16 instead', async () => {
      const r = await DaySummaryService.getDaySummary('2026-07-16', 'UTC', projectsScope([project]));
      expect(r.kpis.sessions.value).toBe(1);
    });
  });

  // ── MOMENTUM (transparent, baseline-relative — the breakdown math) ────────────
  describe('momentum breakdown math', () => {
    it('computes each sub-score vs the baseline and blends by the config weights', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      // output:  raw 10 (ctx5+dec2+done3) / baselineAvg 10  → ratio 1.0  → 50
      // follow:  raw 0.75 (3/4)          / baselineAvg 0.5  → ratio 1.5  → 75
      // depth:   raw 7 (sess2+actMin4+ms1) / baselineAvg 6  → ratio 1.166 → round(58.3)=58
      expect(r.momentum.breakdown).toEqual({ output: 50, followThrough: 75, depth: 58 });
      // blend (default weights 0.4/0.3/0.3): 0.4*50 + 0.3*75 + 0.3*58 = 59.9 → 60
      expect(r.momentum.score).toBe(60);
      // delta vs the on-par (50) baseline day.
      expect(r.momentum.delta).toBe(10);
    });
  });

  // ── RIBBON / HIGHLIGHTS / HEADLINE / DECISIONS / TASKS / BY-ACTOR ──────────────
  describe('assembled report panels', () => {
    it('ribbon has 24 buckets with density at the local activity hours (10 & 20)', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      expect(r.ribbon).toHaveLength(24);
      const byHour = new Map(r.ribbon.map((b) => [b.hour, b.count]));
      expect(byHour.get(10)).toBe(2);
      expect(byHour.get(20)).toBe(2);
      expect(r.ribbon.reduce((s, b) => s + b.count, 0)).toBe(4);
    });

    it('highlights list the milestone + completion (milestone first) and drive the headline', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      expect(r.highlights).toHaveLength(2);
      expect(r.highlights[0].type).toBe('milestone');
      expect(r.highlights[1].type).toBe('completion');
      expect(r.headline).toBe('Shipped the day-summary aggregation endpoint to prod');
    });

    it('lists the decisions recorded that day', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      expect(r.decisions).toHaveLength(2);
      expect(r.decisions.map((x) => x.title).sort()).toEqual(
        ['Adopt the day-summary endpoint', 'Momentum weights config'].sort(),
      );
    });

    it('lists the tasks completed that day with a total count', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      expect(r.tasksCompleted.count).toBe(3);
      expect(r.tasksCompleted.items).toHaveLength(3);
      expect(r.tasksCompleted.items.map((x) => x.title).sort()).toEqual(['t1', 't2', 't3']);
    });

    it('attributes the day records by the recording session actor (coordinator 9, builder 1)', async () => {
      const r = await DaySummaryService.getDaySummary(TARGET, TZ, projectsScope([project]));
      const byActor = Object.fromEntries(r.byActor.map((a) => [a.actor, a.count]));
      // coordinator: 5 contexts + 2 decisions + 2 completed tasks = 9; builder: 1 completed task.
      expect(byActor).toEqual({ coordinator: 9, builder: 1 });
    });
  });

  // ── HONEST EMPTY (a day with nothing) ─────────────────────────────────────────
  describe('honest empty day', () => {
    it('returns zeroed KPIs, empty panels and a null headline for a day with no records', async () => {
      const r = await DaySummaryService.getDaySummary('2026-07-01', TZ, projectsScope([project]));
      expect(r.headline).toBeNull();
      expect(r.highlights).toEqual([]);
      expect(r.decisions).toEqual([]);
      expect(r.tasksCompleted).toEqual({ count: 0, items: [] });
      expect(r.byActor).toEqual([]);
      expect(r.kpis.sessions.value).toBe(0);
      expect(r.ribbon).toHaveLength(24);
      expect(r.ribbon.every((b) => b.count === 0)).toBe(true);
    });
  });
});
