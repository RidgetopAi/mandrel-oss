/**
 * NO-ORPHAN WRITES — the write-path integration contract test.
 *
 * REWRITTEN for PHASE 1 positional membership. The
 * original ST-5 truth table locked the A4 similarity gate + the anchor's TTL semantics —
 * both RETIRED with the anchor (a position is DECLARED: no floor, no TTL, no gate). What
 * this file locks now, through the FULL public path (validate → routeExecutor, the exact
 * path the HTTP bridge uses):
 *
 *   (a) explicit `links` + an open position → the explicit edge AND the positional
 *       membership edge BOTH mint (naming ≠ membership; standing there = membership) and
 *       inference does NOT run.
 *   (b) open position + an OFF-TOPIC capture → `informs` minted anyway (the similarity
 *       gate is GONE — this is the exact write the A4 gate used to refuse), provenance
 *       'auto:positional', no inference.
 *   (c) opt-out (noAutoThread) while positioned → NO membership edge, and the fallback
 *       inference still runs so the write is not silently orphaned.
 *   (d) no position + a good neighbor → the labeled weak `related_to` inference fallback
 *       still mints (created_by 'auto:inference'), and the response carries the
 *       `branch_open <own-id8>` offer.
 *   (e) no position + no neighbor ≥ threshold → surfaced "unthreaded", offer present,
 *       record STILL saved.
 *   (f) reliable-threading kill-switch OFF → inference does NOT run, but the positional
 *       membership edge STILL mints (position is not behind that switch).
 *   (g) every path leaves the record persisted (asserted throughout).
 *
 * THE EMBEDDING FIXTURE (unchanged; mirrors threadInference.unit.test.ts): the house stub
 * returns all-zeros, so this mock is CONTENT-DRIVEN — "SRCVEC" pins the axis-0 unit vector,
 * "COS=<c>" pins a vector whose cosine to axis-0 is exactly c — making the inference
 * threshold arithmetic deterministic against REAL pgvector cosine.
 *
 * ISOLATION: inference's candidate pool is PROJECT-WIDE and positions are per (project,
 * session), so each case runs in its OWN fresh project + its OWN connection id.
 *
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';

// CONTENT-DRIVEN embedding mock — the knob that makes cosine deterministic (see header).
function vecArr(cos: number): number[] {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
function embeddingForText(text: string): number[] {
  const m = text.match(/COS=([0-9]*\.?[0-9]+)/);
  if (m) return vecArr(Number(m[1]));
  if (text.includes('SRCVEC')) return vecArr(1); // axis-0 unit vector
  return new Array(embedDim()).fill(0); // default: zeros (not similarity-tested)
}
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: embeddingForText(text),
      model: 'stub-content-driven',
      dimensions: embedDim(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { mintEdge } from '../services/links.js';
import {
  INFERENCE_THRESHOLD,
  INFERENCE_CANDIDATE_LIMIT,
  RELIABLE_THREADING_CONFIG,
} from '../config/reliableThreadingConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const ON_TOPIC_COS = 0.9; // clears the live inference threshold
const OFF_TOPIC_COS = 0.2; // the cosine family the retired A4 gate used to REFUSE
const WEAK_NEIGHBOR_COS = 0.4; // below the inference threshold: the "no neighbor" case

const STAMP = Date.now();
const projectIds: string[] = [];

/** Full public path: validate THEN routeExecutor, scoped to a connection. */
async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

/** A fresh project + a connection switched to it. Returns { projectId, conn }. */
async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P1 no-orphan fixture') RETURNING id`,
      [`p1no-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p1no-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** Insert a context DIRECTLY with a controlled embedding (a pre-seeded neighbor). */
async function seedContext(projectId: string, content: string, cos: number): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
       VALUES ($1, 'discussion', $2, $3::vector) RETURNING id::text AS id`,
      [projectId, content, `[${vecArr(cos).join(',')}]`]
    )
  ).rows[0].id;
}

/** Make a context a NON-ORPHAN (one real informs edge → a throwaway task). */
async function makeNonOrphan(projectId: string, ctxId: string): Promise<void> {
  const taskId = (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'neighbor anchor task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  await mintEdge(
    { fromId: ctxId, fromType: 'context', toId: taskId, toType: 'task', edgeType: 'informs', projectId, createdBy: 'test-setup', via: EDGE_MINT_VIA.tag },
    db
  );
}

async function edgesFromTo(fromId: string, toId: string): Promise<Array<{ edgeType: string; createdBy: string | null }>> {
  return (
    await db.query(
      `SELECT edge_type, created_by FROM links WHERE from_id = $1 AND to_id = $2 ORDER BY edge_type`,
      [fromId, toId]
    )
  ).rows.map((r) => ({ edgeType: r.edge_type, createdBy: r.created_by }));
}
async function relatedToTargets(fromId: string): Promise<string[]> {
  return (
    await db.query(
      `SELECT to_id FROM links WHERE from_id = $1 AND edge_type = 'related_to' AND created_by = 'auto:inference'`,
      [fromId]
    )
  ).rows.map((r) => r.to_id);
}
async function contextExists(id: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM contexts WHERE id = $1`, [id])).rows.length === 1;
}

describe('no-orphan writes — positional membership + B1 inference wiring (PHASE 1)', () => {
  beforeAll(() => {
    expect(ON_TOPIC_COS, 'the on-topic fixture must clear the live inference threshold')
      .toBeGreaterThan(INFERENCE_THRESHOLD);
    expect(WEAK_NEIGHBOR_COS, 'the weak-neighbor fixture must fall BELOW the live inference threshold')
      .toBeLessThan(INFERENCE_THRESHOLD);
    expect(INFERENCE_CANDIDATE_LIMIT).toBe(1);
    expect(RELIABLE_THREADING_CONFIG.enabled, 'reliable-threading must default ON').toBe(true);
  });

  afterEach(() => {
    // A case may toggle the kill-switch; always restore the default ON afterwards.
    RELIABLE_THREADING_CONFIG.enabled = true;
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
      } catch { /* ignore teardown noise */ }
    }
    await db.end();
  });

  // ── (a) explicit links + open position → BOTH edges mint, no inference ───────────────
  test('(a) explicit `links` + open position → explicit edge AND membership edge mint; no inference', async () => {
    const { projectId, conn } = await freshCase('a-explicit');
    const spineTask = parseId(await viaTool('task_create', { title: 'the branch spine', type: 'feature' }, conn));
    const linkTask = parseId(await viaTool('task_create', { title: 'explicit link target', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(spineTask) }, conn);

    // Pre-seed a good neighbor so we can prove inference is SKIPPED (not just empty).
    const neighbor = await seedContext(projectId, 'SRCVEC neighbor', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool(
      'context_store',
      { content: 'SRCVEC capture with an explicit link', type: 'discussion', links: [{ task: id8(linkTask) }] },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    // The explicit edge is used…
    expect(await edgesFromTo(ctxId, linkTask)).toEqual([
      { edgeType: 'informs', createdBy: 'links:context_store' },
    ]);
    // …AND the membership edge mints too: naming ≠ membership, standing there = membership.
    expect(await edgesFromTo(ctxId, spineTask)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional' },
    ]);
    expect(resp.structuredContent.context.positional.position.spineId).toBe(spineTask);
    // Explicit intent still suppresses the GUESS: no inference.
    expect(resp.structuredContent.context.inference).toBeNull();
    expect(await relatedToTargets(ctxId)).toEqual([]);
    expect(await contextExists(ctxId)).toBe(true); // (g)
  });

  // ── (b) the write the A4 gate used to refuse → now MINTS (no similarity gate) ────────
  test('(b) open position + OFF-TOPIC capture → `informs` minted anyway (declared, not judged)', async () => {
    const { conn } = await freshCase('b-offtopic');
    const task = parseId(await viaTool('task_create', { title: 'topic-A task', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(task) }, conn);

    // Establish topic A on the branch, then write something COMPLETELY off-topic. Under the
    // retired anchor this exact shape was refused below the similarity floor; positional
    // membership is a declaration, so it mints.
    await viaTool('context_store', { content: 'SRCVEC established topic A', type: 'discussion' }, conn);
    const resp = await viaTool(
      'context_store',
      { content: `COS=${OFF_TOPIC_COS} a totally different subject`, type: 'discussion' },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    expect(await edgesFromTo(ctxId, task)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional' },
    ]);
    const positionalEdges = resp.structuredContent.context.positional.edges;
    expect(positionalEdges).toHaveLength(1);
    expect(positionalEdges[0]).toMatchObject({ via: 'position', edgeType: 'informs', toId: task, created: true });
    // Membership minted → no inference, no offer.
    expect(resp.structuredContent.context.inference).toBeNull();
    expect(resp.structuredContent.context.positional.offer).toBeNull();
    expect(await contextExists(ctxId)).toBe(true); // (g)
  });

  // ── (c) opt-out while positioned → no membership edge AND no guess ───────────────────
  test('(c) noAutoThread while positioned → NO membership edge and NO inference (deliberate orphan)', async () => {
    const { projectId, conn } = await freshCase('c-optout');
    const task = parseId(await viaTool('task_create', { title: 'spine task', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(task) }, conn);

    const neighbor = await seedContext(projectId, 'SRCVEC the reachable neighbor', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool(
      'context_store',
      { content: `COS=${ON_TOPIC_COS} an opted-out capture`, type: 'discussion', noAutoThread: true },
      conn
    );
    const ctxId = resp.structuredContent.context.id;

    expect(await edgesFromTo(ctxId, task)).toEqual([]); // opt-out honored on the membership mint
    expect(resp.structuredContent.context.positional.edges).toEqual([]);
    // The opt-out is the writer explicitly saying "do not thread this" — it suppresses the
    // GUESS too (unchanged from the anchor era: an opted-out write may orphan deliberately).
    expect(resp.structuredContent.context.inference).toBeNull();
    expect(await relatedToTargets(ctxId)).toEqual([]);
    expect(await contextExists(ctxId)).toBe(true); // (g)
  });

  // ── (d) no position + good neighbor → related_to minted + the branch_open offer ──────
  test('(d) no position + a good neighbor → weak related_to inferred + `branch_open <id8>` offer', async () => {
    const { projectId, conn } = await freshCase('d-neighbor');
    const neighbor = await seedContext(projectId, 'SRCVEC the reachable neighbor', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool('context_store', { content: `COS=${ON_TOPIC_COS} a fresh capture with no branch`, type: 'discussion' }, conn);
    const ctxId = resp.structuredContent.context.id;

    expect(resp.structuredContent.context.positional.position).toBeNull();
    expect(resp.structuredContent.context.positional.edges).toEqual([]);
    // THE OFFER (spec item b / acceptance 6): the record's OWN id8, literal `branch_open <id8>`.
    expect(resp.structuredContent.context.positional.offer).toBe(`branch_open ${id8(ctxId)}`);
    expect(responseText(resp)).toContain(`branch_open ${id8(ctxId)}`);
    // The fallback still mints ONLY the labeled weak guess.
    expect(resp.structuredContent.context.inference.reason).toBe('minted');
    expect(resp.structuredContent.context.inference.candidateId).toBe(neighbor);
    expect(await relatedToTargets(ctxId)).toEqual([neighbor]);
    expect(await contextExists(ctxId)).toBe(true); // (g)
  });

  // ── (e) no position + no neighbor ≥ threshold → surfaced unthreaded, record saved ────
  test('(e) no position + no neighbor above threshold → surfaced unthreaded, offer present, record saved', async () => {
    const { projectId, conn } = await freshCase('e-unthreaded');
    const neighbor = await seedContext(projectId, 'SRCVEC a distant neighbor', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool('context_store', { content: `COS=${WEAK_NEIGHBOR_COS} an isolated capture`, type: 'discussion' }, conn);
    const ctxId = resp.structuredContent.context.id;

    expect(await relatedToTargets(ctxId)).toEqual([]); // nothing minted
    expect(resp.structuredContent.context.inference.reason).toBe('no-neighbor-above-threshold');
    expect(responseText(resp)).toMatch(/unthreaded/i); // surfaced honestly
    expect(resp.structuredContent.context.positional.offer).toBe(`branch_open ${id8(ctxId)}`);
    expect(await contextExists(ctxId)).toBe(true); // (g) — record persists regardless
  });

  // ── (f) kill-switch OFF → no inference, but the positional mint is NOT behind it ─────
  test('(f) reliable-threading OFF → inference does not run; positional membership STILL mints', async () => {
    RELIABLE_THREADING_CONFIG.enabled = false;

    const { projectId, conn } = await freshCase('f-killswitch');
    const task = parseId(await viaTool('task_create', { title: 'spine under kill-switch', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(task) }, conn);

    const neighbor = await seedContext(projectId, 'SRCVEC a good neighbor (must be ignored)', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool('context_store', { content: `COS=${ON_TOPIC_COS} capture under kill-switch`, type: 'discussion' }, conn);
    const ctxId = resp.structuredContent.context.id;

    // Positional membership is a DECLARED write-path edge, not an inference feature — the
    // reliable-threading kill-switch must not turn it off.
    expect(await edgesFromTo(ctxId, task)).toEqual([
      { edgeType: 'informs', createdBy: 'auto:positional' },
    ]);
    expect(resp.structuredContent.context.inference).toBeNull();
    expect(await relatedToTargets(ctxId)).toEqual([]);
    expect(await contextExists(ctxId)).toBe(true);
  });

  // ── kill-switch OFF + no position → NO inference (a write may orphan, pre-ST-5) ──────
  test('kill-switch OFF + no position → inference does NOT run (pre-ST-5 orphan behavior)', async () => {
    RELIABLE_THREADING_CONFIG.enabled = false;

    const { projectId, conn } = await freshCase('killswitch-nopos');
    const neighbor = await seedContext(projectId, 'SRCVEC a good neighbor', 1);
    await makeNonOrphan(projectId, neighbor);

    const resp = await viaTool('context_store', { content: `COS=${ON_TOPIC_COS} no position, switch off`, type: 'discussion' }, conn);
    const ctxId = resp.structuredContent.context.id;

    expect(resp.structuredContent.context.inference).toBeNull();
    expect(await relatedToTargets(ctxId)).toEqual([]); // orphaned (pre-ST-5), record still saved
    expect(await contextExists(ctxId)).toBe(true);
  });
});
