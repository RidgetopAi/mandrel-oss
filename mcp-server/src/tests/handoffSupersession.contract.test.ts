/**
 * HANDOFF SUPERSESSION — the PHASE 2 item-g acceptance contract ( * folds D5-A from 8f218f17).
 *
 * Driven through the FULL public path (validate → routeExecutor — the exact path the
 * HTTP bridge uses), asserted at the ROW level, same conventions as
 * positionalMembership.contract.test.ts:
 *
 *   1. Storing handoff B after handoff A mints EXACTLY ONE declared `supersedes` edge
 *      B → A (created_by 'auto:handoff-supersession') — the edge ROW is asserted.
 *   2. The FIRST handoff in a project mints nothing (no predecessor — honest no-op).
 *   3. A THIRD handoff supersedes only the SECOND (created_at adjacency, not fan-out):
 *      C → B exists, C → A does NOT. The chain is a line, never a web — this is the
 *      structural "never recurse for ordering" guarantee at the write end.
 *   4. A NON-handoff write mints NO supersession edge (the guard population is
 *      context_type='handoff', not all contexts).
 *   5. PROVENANCE (acceptance 7): the minted edge classifies DECLARED in the
 *      link_provenance view (migration 081) — read from the VIEW, the single source.
 *      On new writes the handoff-chain declared coverage is 100% by construction,
 *      up from the measured 14.2% prod baseline (177/1,249, task description).
 *   6. Cross-project isolation: a handoff in project Q never supersedes project P's.
 *
 * Embeddings mocked to zeros (similarity plays NO role — determinism is the point).
 * DB target: the disposable migrated ci_* DB — never production.
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
import {
  READ_HANDOFF_LANE_TAG_PREFIX,
  READ_HANDOFF_DEFAULT_LANE,
} from '../config/handoffLaneConfig.js';
import { HANDOFF_SUPERSESSION_CREATED_BY } from '../services/handoffSupersession.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P2 handoff fixture') RETURNING id`,
      [`p2ho-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p2ho-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

async function storeContext(conn: string, type: string, content: string, tags?: string[]): Promise<string> {
  const r = await viaTool('context_store', tags ? { content, type, tags } : { content, type }, conn);
  const id = r.structuredContent?.context?.id;
  expect(id, `context_store (${type}) must return an id`).toBeTruthy();
  return id as string;
}

/** The supersedes edge rows FROM a record (row-level assertion surface). */
async function supersedesRows(fromId: string) {
  return (
    await db.query(
      `SELECT to_id, edge_type, created_by FROM links
        WHERE from_id = $1 AND edge_type = 'supersedes' ORDER BY to_id`,
      [fromId]
    )
  ).rows as Array<{ to_id: string; edge_type: string; created_by: string | null }>;
}

afterAll(async () => {
  for (const pid of projectIds) {
    await db.query(`DELETE FROM links WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }
  await db.end?.();
});

describe('PHASE 2 item g — handoff supersession minting', () => {
  test('1+2. first handoff mints nothing; the second mints EXACTLY the declared edge B → A', async () => {
    const { conn } = await freshCase('chain');
    const a = await storeContext(conn, 'handoff', `handoff A ${STAMP} — first trunk entry`);
    expect(await supersedesRows(a)).toEqual([]); // first handoff: no predecessor

    const b = await storeContext(conn, 'handoff', `handoff B ${STAMP} — second trunk entry`);
    const rows = await supersedesRows(b);
    expect(rows).toEqual([
      { to_id: a, edge_type: 'supersedes', created_by: HANDOFF_SUPERSESSION_CREATED_BY },
    ]);

    // 3. The third supersedes ONLY the second — a line, not a web.
    const c = await storeContext(conn, 'handoff', `handoff C ${STAMP} — third trunk entry`);
    const cRows = await supersedesRows(c);
    expect(cRows.map((r) => r.to_id)).toEqual([b]);
    expect(cRows.map((r) => r.to_id)).not.toContain(a);
  });

  test('4. a non-handoff write mints NO supersession edge', async () => {
    const { conn } = await freshCase('nonhandoff');
    await storeContext(conn, 'handoff', `handoff base ${STAMP}`);
    const note = await storeContext(conn, 'discussion', `an ordinary note ${STAMP}`);
    expect(await supersedesRows(note)).toEqual([]);
  });

  test('5. the minted edge classifies DECLARED in link_provenance (migration 081), and new handoff chains are 100% declared vs the 14.2% baseline', async () => {
    const { projectId, conn } = await freshCase('meter');
    await storeContext(conn, 'handoff', `handoff M1 ${STAMP}`);
    await storeContext(conn, 'handoff', `handoff M2 ${STAMP}`);
    await storeContext(conn, 'handoff', `handoff M3 ${STAMP}`);

    // Read from the VIEW — the single source of the classification, never a TS copy.
    const meter = (
      await db.query(
        `SELECT provenance_class, count(*)::int AS n
           FROM link_provenance
          WHERE project_id = $1 AND edge_type = 'supersedes'
          GROUP BY 1`,
        [projectId]
      )
    ).rows as Array<{ provenance_class: string; n: number }>;
    // The whole new chain (2 edges for 3 handoffs) is DECLARED — nothing unclassified,
    // nothing guessed. 2/2 = 100% declared on new writes (baseline was 14.2%).
    expect(meter).toEqual([{ provenance_class: 'declared', n: 2 }]);
  });

  test('6. cross-project isolation: a handoff never supersedes another project\'s trunk', async () => {
    const p = await freshCase('isoP');
    const q = await freshCase('isoQ');
    const pHandoff = await storeContext(p.conn, 'handoff', `P trunk ${STAMP}`);
    const qHandoff = await storeContext(q.conn, 'handoff', `Q trunk ${STAMP}`);
    expect(await supersedesRows(qHandoff)).toEqual([]); // Q's first — P's is invisible to it
    expect(await supersedesRows(pHandoff)).toEqual([]);
  });

  test('7. lanes: ws:research never supersedes ws:coordinator; untagged shares the default lane', async () => {
    const { conn } = await freshCase('lanes');
    const coordinator = `${READ_HANDOFF_LANE_TAG_PREFIX()}${READ_HANDOFF_DEFAULT_LANE()}`;
    const research = `${READ_HANDOFF_LANE_TAG_PREFIX()}research`;
    const a = await storeContext(conn, 'handoff', `lane A ${STAMP}`, [coordinator]);
    const b = await storeContext(conn, 'handoff', `lane B ${STAMP}`, [research]);
    expect(await supersedesRows(b)).toEqual([]); // research's first — A is another lane
    const c = await storeContext(conn, 'handoff', `lane C ${STAMP}`, [coordinator]);
    expect((await supersedesRows(c)).map((r) => r.to_id)).toEqual([a]);
    expect(await supersedesRows(b)).toEqual([]); // no edge between B and C, either way
    const d = await storeContext(conn, 'handoff', `lane D ${STAMP}`); // untagged = default lane
    expect((await supersedesRows(d)).map((r) => r.to_id)).toEqual([c]);
  });
});
