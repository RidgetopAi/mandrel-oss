/**
 * THE PRIORITY-4 AMBIENT FALLBACK ANNOUNCES ITSELF IN TESTS — an earlier task's class fix,
 * landed from the 04a4c7d9 lane because handlers/project.ts belongs to it this batch.
 *
 * WHY THIS EXISTS RATHER THAN FOUR MORE CALL-SITE FIXES. The L7 lane fixed the four sites
 * its decoy run measured. That protects those four and does nothing for the next test
 * anyone writes — allow-by-default, class still open. And the failure mode is MISDIRECTION:
 * of the four failures L7 measured, NOT ONE named a project-scope cause; they named
 * `recall_thread`, `session_list`, and two bare `expected undefined` diffs. The fix is for
 * the fallback itself to say what happened.
 *
 * THE ADVERSE ORDERING IS PLANTED, NOT HOPED FOR — a decoy project dated a year forward, so
 * it stays `projects[0]` for the whole file regardless of what the suite writes meanwhile.
 * That instrument is L7's (tests/ambientProjectInheritance.contract.test.ts); it is reused
 * here deliberately rather than reinvented, because a different instrument would leave the
 * two files agreeing only by luck.
 *
 * THE THREE ASSERTIONS THIS FILE OWES (C3), and the third is the one that matters most:
 *   A — the fallback fires LOUDLY under NODE_ENV=test.
 *   B — a BOUND connection never reaches it, so the loudness cannot be bought by breaking
 *       every test that already does the right thing.
 *   C — with NODE_ENV flipped OFF 'test', the SAME call on the SAME database succeeds and
 *       lands on exactly `projects[0]`. Production is unchanged as a MEASUREMENT, not as a
 *       promise: both behaviours are observed in one run, on one tree.
 *
 * DB target: the disposable migrated ci_* database, never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub-zero' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { projectHandler } from '../handlers/project.js';
import { AMBIENT_FALLBACK_LOUD_NODE_ENV } from '../config/ambientProjectFallbackConfig.js';

const STAMP = Date.now();
const FIXTURE_NAME = `apfl-fixture-${STAMP}`;
const DECOY_NAME = `ZZZ-apfl-decoy-${STAMP}`;
let fixtureId = '';
let decoyId = '';

async function viaTool(tool: string, rawArgs: any, conn: string, projectBinding?: string): Promise<any> {
  return routeExecutor(tool, validateToolArguments(tool, rawArgs), { connectionId: conn, projectBinding });
}

/** The text a caller actually reads back, whether the result was in-band error or success. */
const said = (resp: any): string => String(resp?.content?.[0]?.text ?? '');

beforeAll(async () => {
  decoyId = (
    await db.query(
      `INSERT INTO projects (name, description, updated_at)
       VALUES ($1, 'apfl adverse-ordering decoy', now() + interval '365 days') RETURNING id`,
      [DECOY_NAME]
    )
  ).rows[0].id;
  fixtureId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'apfl fixture') RETURNING id`, [
      FIXTURE_NAME,
    ])
  ).rows[0].id;
});

afterAll(async () => {
  for (const pid of [decoyId, fixtureId]) {
    if (!pid) continue;
    for (const t of ['links', 'branch_positions', 'contexts', 'tasks', 'analytics_events', 'sessions']) {
      try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [pid]); } catch { /* teardown noise */ }
    }
    try { await db.query('DELETE FROM projects WHERE id = $1', [pid]); } catch { /* teardown noise */ }
  }
});

describe('Priority-4 ambient project fallback is loud in tests', () => {
  test('WITNESS — the decoy really is projects[0], so the hazard is actually in force', async () => {
    // Without this the whole file is green for free: if the decoy did not sort first there
    // would be no ambient winner to inherit, and A/C would be proving nothing. Read from the
    // PRODUCT's own ordering rather than re-implemented here.
    const projects = await projectHandler.listProjects(false);
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(projects[0].id, 'the decoy must sort first or this file tests nothing').toBe(decoyId);
  });

  test('A — an UNBOUND connection FAILS LOUDLY, and the message names the cause', async () => {
    expect(process.env.NODE_ENV, 'this probe is only meaningful in the loud environment').toBe(
      AMBIENT_FALLBACK_LOUD_NODE_ENV
    );
    const conn = `apfl-unbound-${STAMP}`;
    const resp = await viaTool('context_store', { content: 'ambient probe: unbound', type: 'completion' }, conn);

    expect(resp.isError, 'the silent inheritance must not succeed under NODE_ENV=test').toBe(true);
    const text = said(resp);
    // THE POINT OF THE WHOLE CHANGE: the message must name the project-scope cause, because
    // the four failures L7 measured named everything except that.
    expect(text).toContain('AMBIENT_PROJECT_FALLBACK');
    expect(text, 'it must name the connection that failed to choose').toContain(conn);
    expect(text, 'and what it would have silently picked').toContain(DECOY_NAME);
    expect(text, 'and what to do instead').toMatch(/bind|projectId|project_switch/);

    // Nothing was written anywhere — a loud failure that still leaves a row behind would be
    // the worst of both.
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM contexts WHERE content = 'ambient probe: unbound'`
    );
    expect(rows.rows[0].n).toBe(0);
  });

  test('B — a BOUND connection never reaches Priority 4 and is completely unaffected', async () => {
    const conn = `apfl-bound-${STAMP}`;
    const resp = await viaTool(
      'context_store',
      { content: `ambient probe: bound ${STAMP}`, type: 'completion' },
      conn,
      FIXTURE_NAME
    );
    expect(resp.isError, `bound store failed: ${said(resp).slice(0, 200)}`).not.toBe(true);
    const row = await db.query('SELECT project_id::text AS pid FROM contexts WHERE id = $1', [
      resp.structuredContent.context.id,
    ]);
    expect(row.rows[0].pid, 'a bound connection lands where it said, decoy or no decoy').toBe(fixtureId);
  });

  test('B2 — a connection that CHOSE a project with project_switch is unaffected too', async () => {
    // The other legitimate way to answer the question. Included so "loud" cannot be
    // satisfied by a rule that simply breaks every unbound-looking call: Priority 0 short
    // circuits the ladder long before Priority 4, and this proves the throw sits below it.
    const conn = `apfl-switched-${STAMP}`;
    const sw = await viaTool('project_switch', { project: FIXTURE_NAME }, conn);
    expect(sw.isError, `switch failed: ${said(sw).slice(0, 200)}`).not.toBe(true);
    const resp = await viaTool(
      'context_store',
      { content: `ambient probe: switched ${STAMP}`, type: 'completion' },
      conn
    );
    expect(resp.isError, `store after switch failed: ${said(resp).slice(0, 200)}`).not.toBe(true);
    const row = await db.query('SELECT project_id::text AS pid FROM contexts WHERE id = $1', [
      resp.structuredContent.context.id,
    ]);
    expect(row.rows[0].pid).toBe(fixtureId);
  });

  test('C — PRODUCTION IS UNCHANGED: with NODE_ENV off "test" the same call silently takes projects[0]', async () => {
    // The constraint stated as a measurement. Same tree, same database, same unbound call —
    // only the environment differs, and the pre-change behaviour returns whole: no throw, and
    // the record lands on exactly `projects[0]`, which is the decoy.
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      projectHandler.clearSessionCache();
      const conn = `apfl-prodmode-${STAMP}`;
      const resp = await viaTool(
        'context_store',
        { content: `ambient probe: prodmode ${STAMP}`, type: 'completion' },
        conn
      );
      expect(resp.isError, `prod-mode store must SUCCEED: ${said(resp).slice(0, 200)}`).not.toBe(true);
      const row = await db.query('SELECT project_id::text AS pid FROM contexts WHERE id = $1', [
        resp.structuredContent.context.id,
      ]);
      expect(row.rows[0].pid, 'prod behaviour is byte-identical: the ambient winner, silently').toBe(decoyId);
    } finally {
      process.env.NODE_ENV = saved;
      projectHandler.clearSessionCache();
    }
  });
});
