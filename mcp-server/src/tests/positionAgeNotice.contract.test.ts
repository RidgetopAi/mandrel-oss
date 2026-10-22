/**
 * POSITION AGE NOTICE — the acceptance contract.
 *
 * THE RULE UNDER TEST: a write made from a position whose `opened_at` is older than
 * MANDREL_POSITION_AGE_NOTICE_HOURS carries an age line in its report; a younger one does
 * not; and the threshold is read from that env var. Visibility only — the membership edge
 * mints identically either way, and nothing is closed.
 *
 * EVERY check drives the FULL PUBLIC PATH — validateToolArguments -> routeExecutor — and
 * reads BOTH channels of the report: the text the agent sees and `positional.ageNotice` in
 * structuredContent. Two write paths are exercised on purpose, because they render through
 * two composers (context_store composes its own text; task_create renders through
 * positionalResponseLines) and a line added to one and not the other is the drift this
 * file exists to catch.
 *
 * THE SMALLEST INPUT WHERE FIXED AND BROKEN DIVERGE: the same session, the same declared
 * position, one write before and one write after `opened_at` is moved back past the
 * threshold. Everything else is held equal, so the only thing that can flip the line is age.
 *
 * Embeddings are mocked to zeros — similarity plays no part in any of this.
 * DB target: the disposable migrated ci_* DB, never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';
import {
  POSITION_AGE_NOTICE_ENV,
  POSITION_AGE_NOTICE_HOURS_DEFAULT,
  formatPositionAge,
  positionAgeNoticeHours,
} from '../config/positionAgeNoticeConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'position-age fixture') RETURNING id`,
      [`posage-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `posage-conn-${label}-${STAMP}`;
  await bindConnectionToProject(conn, projectId);
  return { projectId, conn };
}

/** Move the session's position back in time and PROVE the mutation landed by reading it back. */
async function backdatePosition(projectId: string, interval: string): Promise<void> {
  await db.query(
    `UPDATE branch_positions SET opened_at = now() - $2::interval WHERE project_id = $1`,
    [projectId, interval]
  );
  const r = await db.query(
    `SELECT EXTRACT(EPOCH FROM (now() - opened_at)) AS age_s FROM branch_positions WHERE project_id = $1`,
    [projectId]
  );
  expect(r.rows, 'MUTATION LANDED: exactly one position row').toHaveLength(1);
  const expected = (await db.query(`SELECT EXTRACT(EPOCH FROM $1::interval) AS s`, [interval])).rows[0].s;
  expect(Number(r.rows[0].age_s), 'MUTATION LANDED: opened_at moved back').toBeGreaterThanOrEqual(Number(expected) - 5);
}

async function storeContext(conn: string, content: string) {
  const r = await viaTool('context_store', { content, type: 'completion' }, conn);
  return { positional: r.structuredContent.context.positional, text: responseText(r) };
}
async function createTask(conn: string, title: string) {
  const r = await viaTool('task_create', { title, type: 'feature' }, conn);
  return { positional: r.structuredContent.task.positional, text: responseText(r) };
}
async function edgesTo(fromId: string, toId: string) {
  return (
    await db.query(`SELECT edge_type FROM links WHERE from_id = $1 AND to_id = $2`, [fromId, toId])
  ).rows.map((r) => r.edge_type);
}

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await db.end();
});

const AGE_MARKER = 'branch_close if this is stale';

describe('position age notice', () => {
  test('ACCEPTANCE 1+2: fresh position -> no notice; backdated past threshold -> the literal age string, on BOTH composers', async () => {
    const { projectId, conn } = await freshCase('acc');
    const spineResp = await viaTool('task_create', { title: 'the spine', type: 'feature' }, conn);
    const spine = spineResp.structuredContent.task.id as string;
    await viaTool('branch_open', { id: id8(spine) }, conn);

    // FRESH: the position was opened a moment ago. No line, null field, on both paths.
    const fresh = await storeContext(conn, 'a capture on a fresh position');
    expect(fresh.positional.ageNotice).toBeNull();
    expect(fresh.text).not.toContain(AGE_MARKER);
    const freshTask = await createTask(conn, 'a create on a fresh position');
    expect(freshTask.positional.ageNotice).toBeNull();
    expect(freshTask.text).not.toContain(AGE_MARKER);

    // STALE: 9 days > the 24h default. The same session, the same position, only age moved.
    await backdatePosition(projectId, '9 days');
    const stale = await storeContext(conn, 'a capture on a stale position');
    const expectedLine =
      `Position opened 9d ago on task ${id8(spine)} — ${AGE_MARKER} ` +
      `(notice after ${POSITION_AGE_NOTICE_HOURS_DEFAULT}h; ${POSITION_AGE_NOTICE_ENV}).`;
    expect(stale.positional.ageNotice).toBe(expectedLine);
    expect(stale.text).toContain(expectedLine);
    // VISIBILITY ONLY: the membership still minted and the position is still open.
    expect(stale.positional.membership).toEqual({ minted: true, reason: 'minted' });
    const staleCtxId = (await db.query(
      `SELECT id FROM contexts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, [projectId]
    )).rows[0].id;
    expect(await edgesTo(staleCtxId, spine)).toEqual(['informs']);
    const pos = await db.query(`SELECT origin FROM branch_positions WHERE project_id = $1`, [projectId]);
    expect(pos.rows).toEqual([{ origin: 'declared' }]);

    // The create path renders the SAME sentence through positionalResponseLines.
    const staleTask = await createTask(conn, 'a create on a stale position');
    expect(staleTask.positional.ageNotice).toBe(expectedLine);
    expect(staleTask.text).toContain(expectedLine);
  });

  test('ACCEPTANCE 3: the threshold comes from config — env set low makes a 2h-old position noticed', async () => {
    const { projectId, conn } = await freshCase('env');
    const spineResp = await viaTool('task_create', { title: 'the env spine', type: 'feature' }, conn);
    const spine = spineResp.structuredContent.task.id as string;
    await viaTool('branch_open', { id: id8(spine) }, conn);
    await backdatePosition(projectId, '2 hours');

    // Under the default (24h) a 2h-old position is silent — the control leg.
    expect(positionAgeNoticeHours()).toBe(POSITION_AGE_NOTICE_HOURS_DEFAULT);
    const silent = await storeContext(conn, 'two hours old, default threshold');
    expect(silent.positional.ageNotice).toBeNull();
    expect(silent.text).not.toContain(AGE_MARKER);

    // Flip the threshold through the REAL env var (restored below — the ENV-LEAK guard in
    // vitest.setup.ts fails the file if it is not).
    const before = process.env[POSITION_AGE_NOTICE_ENV];
    process.env[POSITION_AGE_NOTICE_ENV] = '1';
    try {
      expect(positionAgeNoticeHours()).toBe(1);
      const noticed = await storeContext(conn, 'two hours old, one hour threshold');
      expect(noticed.positional.ageNotice).toBe(
        `Position opened 2h ago on task ${id8(spine)} — ${AGE_MARKER} ` +
          `(notice after 1h; ${POSITION_AGE_NOTICE_ENV}).`
      );
      expect(noticed.text).toContain(`Position opened 2h ago on task ${id8(spine)}`);
    } finally {
      if (before === undefined) delete process.env[POSITION_AGE_NOTICE_ENV];
      else process.env[POSITION_AGE_NOTICE_ENV] = before;
    }
  });

  test('garbage or negative env falls back to the default rather than switching the notice off', () => {
    const before = process.env[POSITION_AGE_NOTICE_ENV];
    try {
      for (const bad of ['banana', '-3', 'NaN', 'Infinity']) {
        process.env[POSITION_AGE_NOTICE_ENV] = bad;
        expect(positionAgeNoticeHours(), `env=${bad}`).toBe(POSITION_AGE_NOTICE_HOURS_DEFAULT);
      }
      process.env[POSITION_AGE_NOTICE_ENV] = '0';
      expect(positionAgeNoticeHours()).toBe(0);
    } finally {
      if (before === undefined) delete process.env[POSITION_AGE_NOTICE_ENV];
      else process.env[POSITION_AGE_NOTICE_ENV] = before;
    }
  });

  test('the age string is one whole unit: minutes, then hours, then days', () => {
    expect(formatPositionAge(0)).toBe('0m');
    expect(formatPositionAge(45 * 60_000)).toBe('45m');
    expect(formatPositionAge(3 * 3_600_000 + 59 * 60_000)).toBe('3h');
    expect(formatPositionAge(9 * 86_400_000 + 5 * 3_600_000)).toBe('9d');
  });
});
