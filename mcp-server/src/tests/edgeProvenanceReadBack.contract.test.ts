/**
 * EDGE PROVENANCE READ-BACK — the contract whose ABSENCE let SK8 ship.
 *
 * WHAT BROKE: SK4 moved edge provenance out of `links.metadata` into the
 * NOT NULL `links.mint_via` column, and made `provenance_class` a generated column over it.
 * The WRITE path was migrated; the READ path was not. `readConnected`/`fetchDirection` in
 * services/links.ts selected `id, edge_type, <conn>_id, <conn>_type, metadata` and nothing
 * else, so the public `get_links` tool — the traversal primitive for trust and
 * recall_thread — reported provenance as ABSENT on EVERY edge. The rows were correct the
 * whole time; the window onto them was missing. The SK1 canary caught it against prod
 * minutes after the v0.31.0 fleet deploy; no in-repo test could, because every provenance
 * assertion we had reads the DB directly.
 *
 * THE INVARIANT THIS LOCKS: a write's provenance is READABLE THROUGH THE TOOL SURFACE.
 *
 *     get_links(record).results[e].mintVia         === the row's links.mint_via
 *     get_links(record).results[e].provenanceClass === the row's links.provenance_class
 *
 * Both sides are asserted, deliberately: comparing the tool only against a hardcoded
 * literal would pass if the read projected a constant, and comparing it only against the
 * row would pass if BOTH were wrong. The literal pins the VALUE, the row pins the SOURCE.
 *
 * Driven through the FULL public path (validate → routeExecutor), never raw SQL for the
 * read, because "raw SQL says the data is fine" is exactly the reasoning that let this ship.
 *
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
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SK8 provenance read-back fixture') RETURNING id`,
      [`sk8-prov-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `sk8-prov-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** The edges get_links reports for a record, out-direction only. */
async function toolEdges(recordId: string, conn: string): Promise<any[]> {
  const resp = await viaTool('get_links', { id: recordId, direction: 'out' }, conn);
  expect(resp.isError).not.toBe(true);
  return resp.structuredContent.results ?? [];
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

describe('SK8 — edge provenance is readable through the get_links tool surface', () => {
  test('a POSITIONED write reads back with mintVia=position / provenanceClass=declared', async () => {
    const { conn } = await freshCase('position');
    const spine = (await viaTool('task_create', { title: `SK8 spine ${STAMP}`, type: 'feature' }, conn))
      .structuredContent.task.id;
    await viaTool('branch_open', { id: id8(spine) }, conn);
    const ctxId = (await viaTool('context_store', { content: 'a capture on the spine', type: 'discussion' }, conn))
      .structuredContent.context.id;

    const resp = await viaTool('get_links', { id: ctxId, direction: 'out' }, conn);
    expect(resp.isError).not.toBe(true);
    const membership = (resp.structuredContent.results ?? []).filter(
      (e: any) => e.connectedId === spine && e.edgeType === 'informs'
    );
    expect(membership).toHaveLength(1);

    // (0) THE TEXT CHANNEL — a model reading the text block is this tool's primary consumer,
    //     so provenance must be visible THERE too, not only in structuredContent.
    expect(resp.content[0].text).toContain('[via position/declared]');

    // (1) THE VALUE — the closed-vocabulary label, from the config, not a bare string.
    expect(membership[0].mintVia).toBe(EDGE_MINT_VIA.position);
    expect(membership[0].provenanceClass).toBe('declared');

    // (2) THE SOURCE — identical to the row's own columns, so the read is a projection of
    //     links.mint_via and not a value the response layer invented.
    const row = (
      await db.query(`SELECT mint_via, provenance_class FROM links WHERE id = $1`, [membership[0].edgeId])
    ).rows[0];
    expect(membership[0].mintVia).toBe(row.mint_via);
    expect(membership[0].provenanceClass).toBe(row.provenance_class);

    // (3) SK4's NORMALIZATION HOLDS: the column is the source of truth and the fix did NOT
    //     put `via` back into the metadata blob. If this flips, the four-keys drift is back.
    expect(membership[0].metadata?.via).toBeUndefined();
  });

  test('the explicit `link` tool edge reads back with its own mintVia — one path is not the population', async () => {
    const { conn } = await freshCase('linktool');
    const a = (await viaTool('task_create', { title: `SK8 link A ${STAMP}`, type: 'feature' }, conn))
      .structuredContent.task.id;
    const b = (await viaTool('task_create', { title: `SK8 link B ${STAMP}`, type: 'feature' }, conn))
      .structuredContent.task.id;
    await viaTool(
      'link',
      { from: id8(a), fromType: 'task', to: id8(b), toType: 'task', edgeType: 'related_to' },
      conn
    );

    const edge = (await toolEdges(a, conn)).find((e) => e.connectedId === b && e.edgeType === 'related_to');
    expect(edge, 'the link-tool edge should be visible on the read').toBeDefined();
    expect(edge.mintVia).toBe(EDGE_MINT_VIA.linkTool);
    expect(edge.provenanceClass).toBe('declared');
  });

  test('EMPTY POPULATION — a record with no edges returns no results and does not throw', async () => {
    const { conn } = await freshCase('empty');
    const lone = (await viaTool('task_create', { title: `SK8 lone ${STAMP}`, type: 'feature' }, conn))
      .structuredContent.task.id;
    const resp = await viaTool('get_links', { id: lone, direction: 'out' }, conn);
    expect(resp.isError).not.toBe(true);
    expect(resp.structuredContent.results ?? []).toHaveLength(0);
  });
});
