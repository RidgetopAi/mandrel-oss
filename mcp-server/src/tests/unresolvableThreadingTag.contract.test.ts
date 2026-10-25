/**
 * UNRESOLVABLE THREADING INTENT — the no-silent-orphan floor.
 *
 * THE BUG THIS REPRODUCES (measured on 61df00d before the fix)
 * -----------------------------------------------------------
 * A threading tag (`task:`/`decision:`) sets `hasExplicitTag`, which sets
 * `explicitThreadIntent`, which SUPPRESSES the B1 inference fallback in
 * routes/context.routes.ts. If that tag does not RESOLVE — a typo, a wrong id8, a deleted
 * record — no path mints anything and the write is a GENUINE ORPHAN. A single mistyped
 * character silently costs the capture its threading, and the person who typed it is the
 * least likely to notice.
 *
 * That is a direct violation of Mandrel's floor guarantee ( * ref:reliable-threading): **every store ends with at least one edge or a SURFACED reason.**
 *
 * WHAT IS ASSERTED, AND ON WHAT
 * -----------------------------
 * The observable for "was it orphaned" is THE ROWS IN `links` read straight from Postgres —
 * never a helper's return value and never the response's self-report (a response field can
 * be right while the graph is wrong; that was an earlier task's bug in the other direction).
 *
 * The observable for "was it loud" is the SURFACED REASON on BOTH channels: the MCP text
 * block a model reads, and `structuredContent.context.threadingIntent` a machine reads.
 * "It did not crash" is not the assertion — a silent degradation does not crash either.
 *
 * THE CASES
 *   (1) unresolvable `task:` tag + a reachable neighbour → the fallback RUNS, a weak
 *       related_to exists in `links`, and the unresolved intent is surfaced on both channels.
 *   (2) CONTROL — a RESOLVABLE `task:` tag → the tag edge mints, the fallback does NOT run
 *       (a deliberate writer needs no guess), and nothing is reported unresolved. This is
 *       what stops case (1) from passing for the trivial reason "the fallback always runs".
 *   (3) unresolvable explicit `links` ref → same treatment (the `links` param is the other
 *       half of the same intent channel).
 *   (4) THE EMPTY POPULATION — unresolvable tag AND no neighbour above threshold. Nothing
 *       CAN be minted here, so the whole guarantee rests on the surfaced reason. The record
 *       still persists and the response says, out loud, that the threading reference minted
 *       nothing. This is the case a "just re-enable the fallback" fix would leave silent.
 *   (5) MIXED — one resolvable tag and one unresolvable tag. Intent LANDED (so no guess),
 *       but the broken half is still reported. A count that collapses these is wrong.
 *
 * MUTATION PROBE: restore `explicitThreadIntent = wasExplicit || hasExplicitTag` in
 * routes/context.routes.ts and cases (1), (3) and (4) go RED while (2) stays GREEN.
 *
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';

// CONTENT-DRIVEN embedding mock (same knob as noOrphanWrites.contract.test.ts): "SRCVEC"
// pins the axis-0 unit vector and "COS=<c>" pins a vector whose cosine to it is exactly c,
// making the inference threshold arithmetic deterministic against real pgvector cosine.
function vecArr(cos: number): number[] {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => {
      const m = text.match(/COS=([0-9]*\.?[0-9]+)/);
      const v = m ? vecArr(Number(m[1])) : text.includes('SRCVEC') ? vecArr(1) : new Array(embedDim()).fill(0);
      return { embedding: v, model: 'stub-content-driven', dimensions: embedDim() };
    }),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { mintEdge } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { INFERENCE_THRESHOLD, RELIABLE_THREADING_CONFIG } from '../config/reliableThreadingConfig.js';

const ON_TOPIC_COS = 0.9; // clears the live inference threshold
const WEAK_NEIGHBOR_COS = 0.4; // below it: the "no neighbour" population

/** An id8 that is well-FORMED (so it is never rejected on shape) and matches no row. */
const NO_SUCH_ID8 = 'deadbe0f';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (r: any): string => r?.content?.map((c: any) => c.text).join('\n') ?? '';
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'unresolvable-tag fixture') RETURNING id`,
      [`uthread-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `uthread-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** Pre-seed a neighbour context with a controlled embedding (the inference candidate pool). */
async function seedNeighbor(projectId: string, content: string, cos: number): Promise<string> {
  const ctxId = (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector) RETURNING id::text AS id`,
      [projectId, content, `[${vecArr(cos).join(',')}]`]
    )
  ).rows[0].id;
  // The inference candidate pool only considers NON-orphan neighbours.
  const taskId = (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'neighbour anchor task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  await mintEdge(
    { fromId: ctxId, fromType: 'context', toId: taskId, toType: 'task', edgeType: 'informs', projectId, createdBy: 'test-setup', via: EDGE_MINT_VIA.tag },
    db
  );
  return ctxId;
}

/** THE OBSERVABLE — every edge the GRAPH actually holds out of this record. */
async function edgesInDb(fromId: string): Promise<Array<{ toId: string; edgeType: string; createdBy: string | null }>> {
  return (
    await db.query(
      `SELECT to_id::text AS to_id, edge_type, created_by FROM links WHERE from_id = $1 ORDER BY edge_type`,
      [fromId]
    )
  ).rows.map((r) => ({ toId: r.to_id, edgeType: r.edge_type, createdBy: r.created_by }));
}
async function contextExists(id: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM contexts WHERE id = $1`, [id])).rows.length === 1;
}

describe('unresolvable threading intent — no silent orphan', () => {
  beforeAll(() => {
    expect(ON_TOPIC_COS).toBeGreaterThan(INFERENCE_THRESHOLD);
    expect(WEAK_NEIGHBOR_COS).toBeLessThan(INFERENCE_THRESHOLD);
    expect(RELIABLE_THREADING_CONFIG.enabled, 'reliable-threading must default ON').toBe(true);
  });

  afterAll(async () => {
    for (const pid of projectIds) {
      try {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
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

  // ── (1) THE BUG ─────────────────────────────────────────────────────────────────────
  test('(1) a typo\'d `task:` tag does NOT cost the write its threading — fallback runs and the miss is surfaced', async () => {
    const { projectId, conn } = await freshCase('typo');
    const neighbor = await seedNeighbor(projectId, 'SRCVEC the reachable neighbour', 1);

    const resp = await viaTool(
      'context_store',
      { content: `COS=${ON_TOPIC_COS} a capture whose threading tag has a typo`, type: 'discussion', tags: [`task:${NO_SUCH_ID8}`] },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    // THE GRAPH: not an orphan. Exactly one edge, the labeled weak fallback.
    const edges = await edgesInDb(ctxId);
    expect(edges).toEqual([
      { toId: neighbor, edgeType: 'related_to', createdBy: 'auto:inference' },
    ]);
    expect(resp.structuredContent.context.linksMinted).toBe(1);
    expect(await contextExists(ctxId)).toBe(true);

    // THE SURFACED REASON — machine channel.
    const intent = resp.structuredContent.context.threadingIntent;
    expect(intent.stated).toBe(true);
    expect(intent.landed).toBe(false);
    expect(intent.fallbackEngaged).toBe(true);
    expect(intent.unresolved).toHaveLength(1);
    expect(intent.unresolved[0]).toMatchObject({ via: 'tag', ref: NO_SUCH_ID8 });
    expect(intent.unresolved[0].reason).toContain(NO_SUCH_ID8);

    // THE SURFACED REASON — text channel (what a model actually reads).
    const text = responseText(resp);
    expect(text).toContain('THREADING REFERENCE UNRESOLVED');
    expect(text).toContain(NO_SUCH_ID8);

    // The pre-existing skip report is unchanged (it is the other half of the honesty).
    expect(resp.structuredContent.context.tagEdgeSkips).toHaveLength(1);
    expect(resp.structuredContent.context.tagEdgesMinted).toBe(0);
  });

  // ── (2) CONTROL — the guard is not hollow ───────────────────────────────────────────
  test('(2) CONTROL: a RESOLVABLE `task:` tag still mints its edge and still suppresses the guess', async () => {
    const { projectId, conn } = await freshCase('control');
    await seedNeighbor(projectId, 'SRCVEC the reachable neighbour', 1);
    const task = parseId(await viaTool('task_create', { title: 'a real task', type: 'feature' }, conn));

    const resp = await viaTool(
      'context_store',
      { content: `COS=${ON_TOPIC_COS} a capture with a good threading tag`, type: 'discussion', tags: [`task:${id8(task)}`] },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    // Exactly the tag edge — the fallback did NOT also fire.
    expect(await edgesInDb(ctxId)).toEqual([
      { toId: task, edgeType: 'informs', createdBy: 'auto:context_store' },
    ]);
    expect(resp.structuredContent.context.inference).toBeNull();

    const intent = resp.structuredContent.context.threadingIntent;
    expect(intent.stated).toBe(true);
    expect(intent.landed).toBe(true);
    expect(intent.fallbackEngaged).toBe(false);
    expect(intent.unresolved).toEqual([]);
    expect(responseText(resp)).not.toContain('THREADING REFERENCE UNRESOLVED');
  });

  // ── (3) the other half of the intent channel: the explicit `links` param ────────────
  test('(3) an unresolvable explicit `links` ref gets the same treatment as a bad tag', async () => {
    const { projectId, conn } = await freshCase('linksarg');
    const neighbor = await seedNeighbor(projectId, 'SRCVEC the reachable neighbour', 1);

    const resp = await viaTool(
      'context_store',
      { content: `COS=${ON_TOPIC_COS} a capture whose explicit link is broken`, type: 'discussion', links: [{ task: NO_SUCH_ID8 }] },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    expect(await edgesInDb(ctxId)).toEqual([
      { toId: neighbor, edgeType: 'related_to', createdBy: 'auto:inference' },
    ]);
    const intent = resp.structuredContent.context.threadingIntent;
    expect(intent.stated).toBe(true);
    expect(intent.landed).toBe(false);
    expect(intent.fallbackEngaged).toBe(true);
    expect(intent.unresolved.map((u: any) => u.via)).toEqual([EDGE_MINT_VIA.linksParam]);
    expect(responseText(resp)).toContain('THREADING REFERENCE UNRESOLVED');
  });

  // ── (4) THE EMPTY POPULATION — nothing CAN be minted, so loudness is the whole floor ─
  test('(4) unresolvable tag AND no neighbour above threshold → record saved, and the miss is still LOUD', async () => {
    const { projectId, conn } = await freshCase('empty');
    await seedNeighbor(projectId, `COS=${WEAK_NEIGHBOR_COS} a distant neighbour`, WEAK_NEIGHBOR_COS);

    const resp = await viaTool(
      'context_store',
      { content: 'SRCVEC a capture with a typo\'d tag and nothing to fall back to', type: 'discussion', tags: [`task:${NO_SUCH_ID8}`] },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    // Genuinely no edge — that is honest here, and it is exactly why the REASON must be loud.
    expect(await edgesInDb(ctxId)).toEqual([]);
    expect(await contextExists(ctxId)).toBe(true);

    const intent = resp.structuredContent.context.threadingIntent;
    expect(intent.stated).toBe(true);
    expect(intent.landed).toBe(false);
    expect(intent.fallbackEngaged).toBe(true); // it RAN; it simply found no candidate
    expect(intent.unresolved).toHaveLength(1);

    const text = responseText(resp);
    expect(text).toContain('THREADING REFERENCE UNRESOLVED');
    expect(text).toContain(NO_SUCH_ID8);
    // The fallback's own honest outcome is still reported alongside it.
    expect(resp.structuredContent.context.inference.reason).not.toBe('minted');
  });

  // ── (5) MIXED — one good tag, one bad tag ───────────────────────────────────────────
  test('(5) one resolvable + one unresolvable tag → intent LANDED, no guess, broken half still reported', async () => {
    const { projectId, conn } = await freshCase('mixed');
    await seedNeighbor(projectId, 'SRCVEC the reachable neighbour', 1);
    const task = parseId(await viaTool('task_create', { title: 'a real task', type: 'feature' }, conn));

    const resp = await viaTool(
      'context_store',
      {
        content: `COS=${ON_TOPIC_COS} a capture with one good and one broken tag`,
        type: 'discussion',
        tags: [`task:${id8(task)}`, `task:${NO_SUCH_ID8}`],
      },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    expect(await edgesInDb(ctxId)).toEqual([
      { toId: task, edgeType: 'informs', createdBy: 'auto:context_store' },
    ]);
    const intent = resp.structuredContent.context.threadingIntent;
    expect(intent.stated).toBe(true);
    expect(intent.landed).toBe(true); // one good tag threaded it → no guess needed
    expect(intent.fallbackEngaged).toBe(false);
    expect(intent.unresolved).toHaveLength(1); // …but the broken half is NOT swallowed
    expect(intent.unresolved[0].ref).toBe(NO_SUCH_ID8);
    expect(responseText(resp)).toContain('THREADING REFERENCE UNRESOLVED');
  });
});
