/**
 * Contract tests for an earlier task — the two aggregations whose ANSWERS changed:
 *
 *   1. `getContextsByActor`'s USER-vs-AUTOMATION split (item 3);
 *   2. `getTokenUsagePatterns`'s timezone and window (item 2).
 *
 * Both run against the real migrated Postgres, because both are SQL behaviours: the
 * timezone bucketing and the day window are statements the database makes, and a
 * hand-modelled oracle for them would only re-assert what this file already assumes.
 *
 * WHAT EACH SUITE PROBES ON PURPOSE — the populations that slip through:
 *   - an actor the registry does NOT know (`kind` null): in no group, in no group total;
 *   - an actor whose kind is `human` and one whose kind is `agent`: ONE group, not two;
 *   - a session that crosses a local-day / local-hour boundary, so a UTC-bucketed answer
 *     and a local-bucketed answer are DIFFERENT hours rather than coincidentally equal;
 *
 * Requires a reachable Postgres — see __tests__/helpers/dbContractGate.ts. Never a
 * silent green.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeContract('getContextsByActor: the user-vs-automation split (contract)', () => {
  let pool: Pool;
  const project = uuidv4();
  const sHuman = uuidv4();
  const sAgent = uuidv4();
  const sAutomation = uuidv4();
  const sUnknown = uuidv4();
  const sNoActor = uuidv4();
  const WINDOW_DAYS = 30;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at) VALUES ($1, $2, 'split', NOW())`,
        [project, `split-test-${project.slice(0, 8)}`]
      );
      const session = async (id: string, actor: string | null) =>
        client.query(
          `INSERT INTO sessions (id, project_id, agent_type, actor, started_at, ended_at)
             VALUES ($1, $2, 'mcp-server', $3, NOW() - INTERVAL '2 hours', NOW())`,
          [id, project, actor]
        );
      await session(sHuman, 'operator'); //            registry: human
      await session(sAgent, 'coordinator'); //            registry: agent
      await session(sAutomation, 'coordinator-alert-sink'); // registry: automation (added by THIS task)
      await session(sUnknown, 'some-unregistered-bot'); // registry: nothing
      await session(sNoActor, null);

      const ctx = async (sessionId: string | null, n: number) => {
        for (let i = 0; i < n; i++) {
          await client.query(
            `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
               VALUES ($1, $2, $3, 'code', 'split fixture', NOW() - INTERVAL '1 hour')`,
            [uuidv4(), project, sessionId]
          );
        }
      };
      await ctx(sHuman, 2);
      await ctx(sAgent, 3);
      await ctx(sAutomation, 40);
      await ctx(sUnknown, 5);
      await ctx(sNoActor, 7);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM contexts WHERE project_id = $1', [project]);
        await client.query('DELETE FROM sessions WHERE project_id = $1', [project]);
        await client.query('DELETE FROM projects WHERE id = $1', [project]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('labels each actor with the kind the FIRST-PARTY registry gives it, or null', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([project]),
      WINDOW_DAYS
    );
    const kinds = Object.fromEntries(res.actors.map((a) => [a.actor, a.kind]));
    expect(kinds).toEqual({
      operator: 'human',
      coordinator: 'agent',
      // The registry gap this task closed. Before it, prod's LARGEST automation consumer
      // classified to null and the split counted the biggest machine as unknown.
      'coordinator-alert-sink': 'automation',
      'some-unregistered-bot': null,
    });
  });

  it('human + agent are ONE side; automation is the other', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([project]),
      WINDOW_DAYS
    );
    expect(res.user_driven_contexts).toBe(2 + 3);
    expect(res.automated_contexts).toBe(40);
  });

  it('an UNKNOWN-kind actor is in neither side, and is not silently dropped either', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([project]),
      WINDOW_DAYS
    );
    expect(res.unknown_kind_contexts).toBe(5);
    // It is still an attributed context — it has an actor. What it lacks is the
    // classification, which is why it is stated rather than drawn.
    expect(res.actors.find((a) => a.actor === 'some-unregistered-bot')?.context_count).toBe(5);
  });

  it('the three split figures sum EXACTLY to attributed_contexts', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([project]),
      WINDOW_DAYS
    );
    expect(res.user_driven_contexts + res.automated_contexts + res.unknown_kind_contexts).toBe(
      res.attributed_contexts
    );
    expect(res.attributed_contexts).toBe(2 + 3 + 40 + 5);
    expect(res.unattributed_contexts).toBe(7);
    expect(res.total_contexts).toBe(2 + 3 + 40 + 5 + 7);
  });

  it('the EMPTY population returns zeros for the split, not undefined', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(projectsScope([uuidv4()]), 1);
    expect(res.user_driven_contexts).toBe(0);
    expect(res.automated_contexts).toBe(0);
    expect(res.unknown_kind_contexts).toBe(0);
    expect(res.attributed_contexts).toBe(0);
  });
});

describeContract('getTokenUsagePatterns: timezone and window (contract)', () => {
  let pool: Pool;
  const project = uuidv4();
  const WINDOW_DAYS = 7;

  /**
   * A fixed instant chosen so UTC and New York disagree about the HOUR AND the DAY.
   * 04:30 UTC is 00:30 the previous day in America/New_York (EDT, UTC-4). A test that
   * used an instant where the two zones agree would pass with the fix reverted.
   */
  const CROSSING_HOUR_UTC = 4;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at) VALUES ($1, $2, 'rhythm', NOW())`,
        [project, `rhythm-test-${project.slice(0, 8)}`]
      );
      /**
       * `daysAgo` is a whole number of days back from TODAY at the fixed UTC hour, so the
       * row's local hour is deterministic and independent of when the suite runs.
       */
      const session = async (opts: { daysAgo: number; tokens: number }) => {
        const started = `date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${opts.daysAgo}) + INTERVAL '${CROSSING_HOUR_UTC} hours 30 minutes'`;
        const ended = `${started} + INTERVAL '90 minutes'`;
        await client.query(
          `INSERT INTO sessions (id, project_id, agent_type, actor, started_at, ended_at, total_tokens)
             VALUES ($1, $2, 'mcp-server', 'coordinator', ${started}, ${ended}, $3)`,
          [uuidv4(), project, opts.tokens]
        );
      };

      await session({ daysAgo: 1, tokens: 1000 });
      await session({ daysAgo: 2, tokens: 2000 });
      // OUTSIDE the 7-day window — the read had no window at all before this task.
      await session({ daysAgo: 60, tokens: 999_000 });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM sessions WHERE project_id = $1', [project]);
        await client.query('DELETE FROM projects WHERE id = $1', [project]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  const bucket = (rows: Awaited<ReturnType<typeof SessionAnalyticsService.getTokenUsagePatterns>>, hour: number) =>
    rows.find((r) => r.hour === hour);

  it('always returns all 24 gap-filled hours', async () => {
    const rows = await SessionAnalyticsService.getTokenUsagePatterns(
      projectsScope([project]),
      WINDOW_DAYS
    );
    expect(rows.map((r) => r.hour)).toEqual(Array.from({ length: 24 }, (_, h) => h));
  });

  it('buckets by the VIEWER timezone, not by the server UTC hour', async () => {
    const utc = await SessionAnalyticsService.getTokenUsagePatterns(
      projectsScope([project]),
      WINDOW_DAYS,
      'UTC'
    );
    const ny = await SessionAnalyticsService.getTokenUsagePatterns(
      projectsScope([project]),
      WINDOW_DAYS,
      'America/New_York'
    );
    // Same rows, different local hour. Before the fix both calls answered hour 4, because
    // the hour was extracted from the raw timestamp with the server running Etc/UTC.
    expect(bucket(utc, CROSSING_HOUR_UTC)!.session_count).toBeGreaterThan(0);
    expect(bucket(ny, CROSSING_HOUR_UTC)!.session_count).toBe(0);
    expect(bucket(ny, 0)!.session_count).toBeGreaterThan(0);
  });

  it('honours the WINDOW: a 7-day read does not carry a 60-day-old session', async () => {
    const narrow = await SessionAnalyticsService.getTokenUsagePatterns(
      projectsScope([project]),
      WINDOW_DAYS,
      'UTC'
    );
    const wide = await SessionAnalyticsService.getTokenUsagePatterns(
      projectsScope([project]),
      90,
      'UTC'
    );
    const sum = (rows: typeof narrow) => rows.reduce((s, r) => s + r.session_count, 0);
    expect(sum(narrow)).toBe(2);
    expect(sum(wide)).toBe(3); // + the 60-day-old one
  });




  it('the EMPTY population still returns 24 zeroed hours, not an empty array', async () => {
    const rows = await SessionAnalyticsService.getTokenUsagePatterns(projectsScope([uuidv4()]), 7);
    expect(rows).toHaveLength(24);
    expect(rows.every((r) => r.session_count === 0 && r.total_tokens === 0)).toBe(true);
  });
});
