/**
 * DB-integration tests for the WHOLE-CLASS timezone day-bucketing fix (an earlier task
 * / a past incident).
 *
 * THE BUG: Postgres runs Etc/UTC, so a server-side per-day aggregation that groups by a
 * raw DATE(x)/date_trunc('day', x) buckets by the UTC calendar day — while the UI shows
 * day-cells in the VIEWER's browser-local tz. An evening-EDT record therefore lands on
 * the WRONG day. Proof case (from the task): a record at 2026-07-16 00:00:02+00
 * (= 2026-07-15 20:00 America/New_York) must bucket to:
 *    • 2026-07-15 when tz = America/New_York (the viewer's local day), and
 *    • 2026-07-16 when tz is absent / UTC (backward-compatible, unchanged behaviour).
 *
 * These exercise the REAL service methods (SessionAnalyticsService.getSessionTrends,
 * TaskService.getThroughputSeries, EmbeddingService.getUsagePatterns) against seeded rows
 * with an explicit timestamptz, so each assertion FAILS if the fix is reverted
 * (mutation-resistant — tests-are-the-rock). Rows are scoped to disjoint throwaway
 * projects so nothing else in the DB pollutes the counts.
 *
 * Provision a throwaway migrated DB first (creates sessions/contexts/tasks + extensions):
 *   bash scripts/provision-test-db.sh ci_tzbucket_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_tzbucket_fm --print-env)"
 *   npm test -- tzDayBucketing
 *   bash scripts/provision-test-db.sh ci_tzbucket_fm --drop
 *
 * Gated by describeDb (helpers/dbContractGate): runs whenever Postgres is
 * reachable, and FAILS LOUDLY rather than skipping when it is not.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { TaskService } from '../services/task';
// Import the daily-activity source directly (not via EmbeddingService, whose `.js`-suffixed
// re-export chain doesn't resolve under ts-jest) — this is the exact function the route calls.
import { getUsagePatterns } from '../services/embedding/usagePatterns';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


// The task's exact proof instant + its two correct buckets. 00:00:02+00 on the 16th is
// 20:00:02 EDT on the 15th, so UTC buckets it a day LATER than America/New_York does.
const PROOF_INSTANT = '2026-07-16 00:00:02+00';
const EASTERN_TZ = 'America/New_York';
const DAY_UTC = '2026-07-16'; // raw DATE() / AT TIME ZONE 'UTC' bucket
const DAY_EASTERN = '2026-07-15'; // AT TIME ZONE 'America/New_York' bucket
// Window wide enough that the fixed proof instant is always inside the trailing window,
// no matter when the suite runs (it only recedes further into the past over time).
const WIDE_DAYS = 4000;

/** Normalise a trend row's `date` (node-pg may give a Date at LOCAL midnight, or a string). */
function ymd(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const dt = v as Date;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describeDb('Timezone day-bucketing (whole class) — sessions trends / throughput / contexts-per-day', () => {
  let pool: Pool;

  const pTrends = uuidv4();
  const pThroughput = uuidv4();
  const pUsage = uuidv4();
  const allProjects = [pTrends, pThroughput, pUsage];

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    for (const pid of allProjects) {
      await pool.query(
        `INSERT INTO projects (id, name, description, status, created_at) VALUES ($1,$2,$3,'active',NOW())`,
        [pid, `tz-bucket-test-${pid.slice(0, 8)}`, 'tz day-bucketing test'],
      );
    }

    // ── Session at the proof instant (Calendar / Dashboard trends) ──────────────
    const sid = uuidv4();
    await pool.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, started_at, total_tokens, tasks_created)
       VALUES ($1, $2, 'mcp-server', $3, $4::timestamptz, 100, 0)`,
      [sid, pTrends, `tz-${sid.slice(0, 8)}`, PROOF_INSTANT],
    );

    // ── Task created AND completed at the proof instant (Throughput) ────────────
    const tid = uuidv4();
    await pool.query(
      `INSERT INTO tasks (id, project_id, title, type, status, priority, tags, created_at, completed_at)
       VALUES ($1, $2, 'tz throughput', 'general', 'completed', 'medium', '{}', $3::timestamptz, $3::timestamptz)`,
      [tid, pThroughput, PROOF_INSTANT],
    );

    // ── Context at a RELATIVE evening-EDT instant (contexts/day usage patterns) ──
    // usagePatterns has a FIXED NOW()-30d window, so we anchor the seed relative to now
    // (midnight-UTC 2 days ago = the prior evening in America/New_York) — same UTC-vs-
    // local day divergence as the proof case, but always inside the 30-day window.
    const cid = uuidv4();
    await pool.query(
      `INSERT INTO contexts (id, project_id, context_type, content, created_at)
       VALUES ($1, $2, 'code', 'tz usage seed', (date_trunc('day', now()) - INTERVAL '2 days'))`,
      [cid, pUsage],
    );
  });

  afterAll(async () => {
    for (const pid of allProjects) {
      await pool.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
    await pool.end();
  });

  /** Format a timestamptz into its calendar day under a given tz, straight from Postgres. */
  async function bucketDayInPg(instant: string, tz: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT to_char(($1::timestamptz) AT TIME ZONE $2, 'YYYY-MM-DD') AS d`,
      [instant, tz],
    );
    return rows[0].d as string;
  }

  // ── SESSION TRENDS (Calendar + Dashboard "Workspace activity") ────────────────
  describe('getSessionTrends buckets the session by the viewer-local day', () => {
    it('sanity: the proof instant really straddles the UTC/Eastern day boundary', async () => {
      expect(await bucketDayInPg(PROOF_INSTANT, 'UTC')).toBe(DAY_UTC);
      expect(await bucketDayInPg(PROOF_INSTANT, EASTERN_TZ)).toBe(DAY_EASTERN);
    });

    it('tz = America/New_York → the session lands on 2026-07-15 (not 07-16)', async () => {
      const trends = await SessionAnalyticsService.getSessionTrends(projectsScope([pTrends]), WIDE_DAYS, undefined, EASTERN_TZ);
      const byDay = new Map(trends.map((t) => [ymd(t.date), t.session_count]));
      expect(byDay.get(DAY_EASTERN)).toBe(1);
      expect(byDay.get(DAY_UTC) ?? 0).toBe(0);
    });

    it('tz absent → defaults to UTC → the session lands on 2026-07-16 (unchanged behaviour)', async () => {
      const trends = await SessionAnalyticsService.getSessionTrends(projectsScope([pTrends]), WIDE_DAYS);
      const byDay = new Map(trends.map((t) => [ymd(t.date), t.session_count]));
      expect(byDay.get(DAY_UTC)).toBe(1);
      expect(byDay.get(DAY_EASTERN) ?? 0).toBe(0);
    });

    it('explicit tz = UTC matches the default (no drift from the legacy path)', async () => {
      const trends = await SessionAnalyticsService.getSessionTrends(projectsScope([pTrends]), WIDE_DAYS, undefined, 'UTC');
      const byDay = new Map(trends.map((t) => [ymd(t.date), t.session_count]));
      expect(byDay.get(DAY_UTC)).toBe(1);
    });
  });

  // ── TASK THROUGHPUT (Tasks Analytics + Dashboard throughput card) ─────────────
  describe('getThroughputSeries buckets completed/created by the viewer-local day', () => {
    it('tz = America/New_York → the completion + creation land on 2026-07-15', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pThroughput]), null, EASTERN_TZ);
      const byDay = new Map(series.map((p) => [p.day, p]));
      expect(byDay.get(DAY_EASTERN)).toEqual({ day: DAY_EASTERN, completed: 1, created: 1 });
      expect(byDay.get(DAY_UTC)?.completed ?? 0).toBe(0);
    });

    it('tz absent → defaults to UTC → they land on 2026-07-16 (unchanged behaviour)', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pThroughput]), null);
      const byDay = new Map(series.map((p) => [p.day, p]));
      expect(byDay.get(DAY_UTC)).toEqual({ day: DAY_UTC, completed: 1, created: 1 });
      expect(byDay.get(DAY_EASTERN)?.completed ?? 0).toBe(0);
    });
  });

  // ── CONTEXTS / DAY (Embedding usage-pattern daily activity) ───────────────────
  describe('getUsagePatterns daily activity buckets contexts by the viewer-local day', () => {
    it('an evening-local context shifts one day earlier under America/New_York vs UTC', async () => {
      const seededInstant = "date_trunc('day', now()) - INTERVAL '2 days'";
      const { rows } = await pool.query(
        `SELECT to_char((${seededInstant}) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day,
                to_char((${seededInstant}) AT TIME ZONE $1, 'YYYY-MM-DD') AS local_day`,
        [EASTERN_TZ],
      );
      const expectedUtcDay = rows[0].utc_day as string;
      const expectedLocalDay = rows[0].local_day as string;
      // Guard the test's own premise: midnight-UTC must fall on the PRIOR local day.
      expect(expectedLocalDay < expectedUtcDay).toBe(true);

      const utc = await getUsagePatterns('test-user', { projectId: pUsage }, 'UTC');
      const eastern = await getUsagePatterns('test-user', { projectId: pUsage }, EASTERN_TZ);

      const utcDays = new Set(utc.dailyActivity.map((r: { date: string }) => r.date));
      const easternDays = new Set(eastern.dailyActivity.map((r: { date: string }) => r.date));

      expect(utcDays.has(expectedUtcDay)).toBe(true);
      expect(utcDays.has(expectedLocalDay)).toBe(false);
      expect(easternDays.has(expectedLocalDay)).toBe(true);
      expect(easternDays.has(expectedUtcDay)).toBe(false);
    });
  });
});
