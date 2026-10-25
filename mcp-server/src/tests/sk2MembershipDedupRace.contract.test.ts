/**
 * SK2 ROUND 3 — THE DEDUP RACE, reproduced on demand.
 * (STRONG BONES an earlier spine.)
 *
 * THE DEFECT THIS FILE FREEZES. Membership used to be PARASITIC on the `informs` edge
 * minted by positionalMint. `mintEdge` inserts `ON CONFLICT (from_id, to_id, edge_type) DO
 * NOTHING`, and the TAG mint runs FIRST on every write path (context.routes.ts mints from
 * tags, then calls mintPositional). So a write made WHILE POSITIONED on spine S that ALSO
 * TAGS S produces two mints for the same triple: the tag mint wins, the positional mint is
 * swallowed, and the record silently ceases to be a member — while the report still said
 * `membership: {minted: true}`.
 *
 * MEASURED ON PROD 2026-08-15 (this is not a hypothetical shape):
 *
 *   SELECT mint_via, edge_type FROM links
 *    WHERE from_id::text LIKE '2b3c4d5e%' AND to_id::text LIKE '3c4d5e6f%';
 *   ->  tag | informs          (one row; NO position row)
 *
 *   an earlier Decision were both written while standing on the same branch and both
 *   tagged it. Neither is a member of it. Restricted to spines with real branch activity,
 *   roughly half of each branch was missing this way:
 *
 *     WITH spines(s) AS (VALUES ('ddba6ec7-'),('e6170769-'),('ee38f63a-'))
 *     SELECT sp.s,
 *       (SELECT count(*) FROM links l
 *         WHERE l.to_id::text LIKE sp.s||'%' AND l.mint_via='position') AS pos_edges,
 *       (SELECT count(DISTINCT l.from_id) FROM links l
 *         WHERE l.to_id::text LIKE sp.s||'%' AND l.mint_via='tag'
 *         AND l.edge_type='informs'   -- only this triple can race the positional mint
 *           AND NOT EXISTS (SELECT 1 FROM links p
 *                            WHERE p.mint_via='position' AND p.from_id=l.from_id)) AS tag_only
 *     FROM spines sp;
 *     ->  4d5e6f7a | 8 | 10     3c4d5e6f | 9 | 12     5e6f7a8b | 8 | 10
 *
 * WHY IT IS KEPT RATHER THAN TORN DOWN. This is the canonical keeper: a frozen pre-fix
 * subject is the only thing that can regression-test a bug that is no longer in the tree.
 * The CLASS — "a first-class fact stored on a carrier something else owns and can dedup or
 * delete out from under it" — is the same class SK2 itself exists to fix (branch_close hard-
 * deletes position history). It will recur.
 *
 * THE FIX IT GUARDS. Membership is its own relation, `branch_memberships`, keyed by
 * record_id (migration 086). positionalMint writes that row at the membership DECISION,
 * independently of edge minting, so the edge dedup is genuinely harmless: "already linked"
 * is true and sufficient, because the graph edge does exist.
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

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SK2 dedup-race fixture') RETURNING id`,
      [`sk2race-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `sk2race-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

const ctxId = (r: any) => r.structuredContent.context.id as string;
const taskId = (r: any) => r.structuredContent.task.id as string;
const id8 = (id: string) => id.replace(/-/g, '').slice(0, 8);

/** A spine task created UNPOSITIONED is a root, and is not itself a member. */
async function makeSpine(conn: string, title: string): Promise<string> {
  const r = await viaTool('task_create', { title, type: 'feature', priority: 'low' }, conn);
  await viaTool('branch_close', {}, conn); // R1 auto-opened us onto it; step off deliberately
  return taskId(r);
}

afterAll(async () => {
  for (const pid of projectIds) {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    } catch { /* teardown noise */ }
  }
  await db.end();
});

describe('SK2 dedup race — a positioned write that TAGS its own spine is still a member', () => {
  test('tag mint wins the (from,to,informs) triple; membership survives anyway', async () => {
    const { conn } = await freshCase('tagspine');
    const spine = await makeSpine(conn, 'SK2 dedup-race spine');
    await viaTool('branch_open', { id: spine }, conn);

    // The CONTROL member: positioned, no tag. Its position edge wins the triple uncontested.
    const plain = ctxId(
      await viaTool('context_store', { content: 'positioned, untagged', type: 'planning' }, conn)
    );

    // THE SUBJECT: positioned on the spine AND naming it by tag — the shape that lost.
    const tagged = ctxId(
      await viaTool(
        'context_store',
        {
          content: 'positioned AND tags its own spine',
          type: 'planning',
          tags: [`task:${id8(spine)}`],
        },
        conn
      )
    );

    // ── THE PRECONDITION. Without this the test proves nothing: it must be TRUE that the
    // surviving graph edge for the subject is the TAG edge, i.e. the positional mint really
    // did lose the ON CONFLICT race. If a future change makes the positional mint win, this
    // assertion goes RED and the test must be re-read rather than trusted.
    const edges = await db.query(
      `SELECT mint_via FROM links
        WHERE from_id = $1 AND to_id = $2 AND edge_type = 'informs'`,
      [tagged, spine]
    );
    expect(edges.rowCount).toBe(1);
    expect(edges.rows[0].mint_via).toBe('tag');

    // ── THE CONTRACT. Membership is not the edge. Both records are members.
    const h = await viaTool('branch_history', { id: spine }, conn);
    const ids = h.structuredContent.members.map((m: any) => m.id);
    expect(ids).toContain(plain); // positive set first — an empty list must not pass
    expect(ids).toContain(tagged);
    expect(h.structuredContent.memberCount).toBe(2);

    // ── AND THE REPORT DOES NOT LIE. `minted:true` is now derived from the membership row.
    const rows = await db.query(
      `SELECT spine_id::text AS spine_id, source FROM branch_memberships WHERE record_id = $1`,
      [tagged]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].spine_id).toBe(spine);
    expect(rows.rows[0].source).toBe('recorded');
  });
});
