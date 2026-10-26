/**
 * DB-integration tests for the Calendar MOMENTUM-SERIES endpoint.
 * Exercises the REAL MomentumSeriesService against seeded rows to prove
 * the load-bearing guarantee: the per-cell score a day earns in the series is IDENTICAL to
 *   (a) the shared `computeMomentum` helper's output, and
 *   (b) what `/api/day-summary` (DaySummaryService) returns for that same date.
 * If any of the three ever drift apart, this suite goes red (tests-are-the-rock).
 *
 * ALSO PROVES
 *   • TZ-correct day boundary: an 8pm-EDT record (00:00Z the NEXT day) lands
 *     on the LOCAL day 2026-07-15 under America/New_York, but on 2026-07-16 under UTC — and
 *     the momentum series buckets it on the same local day the card does.
 *   • `hasData=false` for a quiet in-range day (→ the cell renders blank).
 *
 * Provision a throwaway migrated DB first (creates sessions/contexts/decisions/tasks + exts):
 *   bash scripts/provision-test-db.sh ci_momentumseries_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_momentumseries_fm --print-env)"
 *   npm test -- momentumSeries
 *   bash scripts/provision-test-db.sh ci_momentumseries_fm --drop
 *
 * Gated by describeDb (helpers/dbContractGate): runs whenever Postgres is
 * reachable, and FAILS LOUDLY rather than skipping when it is not.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { MomentumSeriesService } from '../services/momentumSeries';
import { DaySummaryService } from '../services/daySummary';
import { computeMomentum } from '../services/momentum';
import { queryDailySeries, emptyDailyRow } from '../services/dailySeries';
import { DAY_SUMMARY_CONFIG } from '../config/daySummary';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


const TZ = 'America/New_York';
const FROM = '2026-07-09';
const TO = '2026-07-15';
const TARGET = '2026-07-15';
// The boundary instant: 00:00:02Z on 07-16 == 20:00:02 EDT on 07-15. Under Eastern it's the
// 15th; under UTC it's the 16th — the exact straddle an earlier task must get right.
const BOUNDARY = '2026-07-16 00:00:02+00';

describeDb('Calendar momentum-series — no-drift vs card/helper + TZ bucketing (DB integration)', () => {
  let pool: Pool;
  const project = uuidv4();
  const sessCoordinator = uuidv4();
  const sessBuilder = uuidv4();

  async function insSession(id: string, actor: string, startedExpr: string, files: number) {
    await pool.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, started_at, actor, files_modified_count)
       VALUES ($1,$2,'mcp-server',$3,$4::timestamptz,$5,$6)`,
      [id, project, `ms-${id.slice(0, 8)}`, startedExpr, actor, files],
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
  async function insTask(opts: {
    sessionId?: string | null;
    title?: string;
    createdExpr: string;
    completedExpr?: string | null;
  }): Promise<void> {
    const { sessionId = null, title = 'seed task', createdExpr, completedExpr = null } = opts;
    await pool.query(
      `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, tags, created_at, completed_at)
       VALUES ($1,$2,$3,$4,'general',$5,'medium','{}',$6::timestamptz,${completedExpr ? '$7::timestamptz' : 'NULL'})`,
      completedExpr
        ? [uuidv4(), project, sessionId, title, 'completed', createdExpr, completedExpr]
        : [uuidv4(), project, sessionId, title, 'todo', createdExpr],
    );
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
      [project, `momentumseries-test-${project.slice(0, 8)}`, 'momentum series aggregation test'],
    );

    // ── TARGET DAY 2026-07-15 (Eastern) — mirrors the day-summary seed so the momentum is
    // a rich, non-trivial value. Session B starts at the boundary (20:00 EDT) to prove tz.
    await insSession(sessCoordinator, 'coordinator', '2026-07-15 14:00:00+00', 3);
    await insSession(sessBuilder, 'builder', BOUNDARY, 5);
    await insActivity(sessCoordinator, '2026-07-15 14:00:00+00');
    await insActivity(sessCoordinator, '2026-07-15 14:05:00+00');
    await insActivity(sessBuilder, BOUNDARY);
    await insActivity(sessBuilder, '2026-07-16 00:06:00+00');
    await insContext(sessCoordinator, 'milestone', 'Shipped the momentum cells', BOUNDARY, 0.9);
    await insContext(sessCoordinator, 'completion', 'Closed out the calendar cells work', '2026-07-15 14:00:00+00', 0.8);
    await insContext(sessCoordinator, 'code', 'code note 1', '2026-07-15 14:10:00+00');
    await insContext(sessCoordinator, 'code', 'code note 2', '2026-07-15 14:11:00+00');
    await insContext(sessCoordinator, 'code', 'code note 3', '2026-07-15 14:12:00+00');
    await insDecision(sessCoordinator, 'Adopt the momentum series endpoint', '2026-07-15 15:00:00+00');
    await insDecision(sessCoordinator, 'Momentum bands config', '2026-07-15 15:30:00+00');
    await insTask({ sessionId: sessCoordinator, title: 't1', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 18:00:00+00' });
    await insTask({ sessionId: sessCoordinator, title: 't2', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 18:30:00+00' });
    await insTask({ sessionId: sessBuilder, title: 't3', createdExpr: '2026-07-15 13:00:00+00', completedExpr: '2026-07-15 19:00:00+00' });
    await insTask({ sessionId: sessCoordinator, title: 't4-open', createdExpr: '2026-07-15 13:00:00+00' });

    // ── BASELINE: identical days 2026-07-02..07-14 (Eastern), seeded at noon EDT (16:00Z).
    // Covers the whole [FROM − window .. TARGET] span so every in-range day has a full
    // trailing baseline. Per day: output=10 (ctx6+dec2+done2), followThrough 0.5, depth=6.
    for (let day = 2; day <= 14; day++) {
      const dd = String(day).padStart(2, '0');
      const noonZ = `2026-07-${dd} 16:00:00+00`;
      const bSess = uuidv4();
      await insSession(bSess, 'coordinator', noonZ, 2);
      for (let min = 0; min < 5; min++) await insActivity(bSess, `2026-07-${dd} 16:0${min}:00+00`);
      for (let c = 0; c < 6; c++) await insContext(bSess, 'code', `b-ctx ${dd}-${c}`, noonZ);
      await insDecision(bSess, `b-dec ${dd}-1`, noonZ);
      await insDecision(bSess, `b-dec ${dd}-2`, noonZ);
      await insTask({ sessionId: bSess, createdExpr: noonZ, completedExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ, completedExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ });
      await insTask({ sessionId: bSess, createdExpr: noonZ });
    }
    // NOTE: 2026-07-09 stays intentionally quiet-of-baseline? No — it IS seeded above (day 9),
    // so the series has data for it. The quiet-day check uses a project with no records.
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

  // ── THE NO-DRIFT GUARANTEE (the whole point of an earlier task) ──────────────────
  describe('no drift: series score == shared helper == day-summary card', () => {
    it('every in-range day agrees across all three computations', async () => {
      const series = await MomentumSeriesService.getMomentumSeries(FROM, TO, TZ, projectsScope([project]));
      expect(series.map((r) => r.date)).toEqual([
        '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15',
      ]);

      const window = DAY_SUMMARY_CONFIG.baselineWindowDays;

      for (const row of series) {
        // (a) equals the shared helper computed from the raw daily series for that date.
        const span = await queryDailySeries(row.date, TZ, window, projectsScope([project]));
        const target = span.find((r) => r.day === row.date) ?? emptyDailyRow(row.date);
        const baseline = span.filter((r) => r.day < row.date);
        const helper = computeMomentum(target, baseline, window);
        expect(row.momentum.score).toBe(helper.score);
        expect(row.momentum.delta).toBe(helper.delta);

        // (b) equals what the day-summary CARD returns for that same date.
        const card = await DaySummaryService.getDaySummary(row.date, TZ, projectsScope([project]));
        expect(row.momentum.score).toBe(card.momentum.score);
        expect(row.momentum.delta).toBe(card.momentum.delta);
      }
    });

    it('the target day reproduces the known day-summary momentum (score 60, delta 10)', async () => {
      const series = await MomentumSeriesService.getMomentumSeries(TARGET, TARGET, TZ, projectsScope([project]));
      expect(series).toHaveLength(1);
      expect(series[0].momentum).toEqual({ score: 60, delta: 10 });
      // Headline counts match the target day's session/context/completed-task totals.
      expect(series[0].sessions).toBe(2);
      expect(series[0].contexts).toBe(5);
      expect(series[0].tasks).toBe(3);
      expect(series[0].hasData).toBe(true);
    });
  });

  // ── TZ BOUNDARY ────────────────────────────────────────────────────────────────
  describe('TZ-correct day boundary', () => {
    it('the 8pm-EDT session counts on 2026-07-15 under America/New_York (sessions=2)', async () => {
      const series = await MomentumSeriesService.getMomentumSeries(TARGET, TARGET, TZ, projectsScope([project]));
      expect(series[0].sessions).toBe(2);
    });

    it('under UTC that boundary session shifts to 07-16, so 07-15 shows sessions=1', async () => {
      const series = await MomentumSeriesService.getMomentumSeries(TARGET, TARGET, 'UTC', projectsScope([project]));
      expect(series[0].sessions).toBe(1);
    });

    it('under UTC the session appears on 2026-07-16 instead (sessions=1)', async () => {
      const series = await MomentumSeriesService.getMomentumSeries('2026-07-16', '2026-07-16', 'UTC', projectsScope([project]));
      expect(series[0].sessions).toBe(1);
    });
  });

  // ── HONEST EMPTY (a day with nothing → hasData=false) ───────────────────────────
  describe('quiet day → hasData=false', () => {
    it('a project with no records reports hasData=false for every in-range day', async () => {
      const empties = await MomentumSeriesService.getMomentumSeries(FROM, TO, TZ, projectsScope([uuidv4()]));
      expect(empties).toHaveLength(7);
      expect(empties.every((r) => r.hasData === false)).toBe(true);
      expect(empties.every((r) => r.sessions === 0 && r.contexts === 0 && r.tasks === 0)).toBe(true);
    });
  });
});
