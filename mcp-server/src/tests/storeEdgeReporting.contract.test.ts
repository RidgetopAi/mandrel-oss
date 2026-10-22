/**
 * STORE EDGE-REPORTING HONESTY — contract tests (dogfood snag #2,
 * no-orphan guarantee an earlier decision).
 *
 * THE BUG THIS LOCKS OUT: a context_store that minted tag-derived edges returned
 * linksMinted:0, autoThreaded:[], anchor:null, inference:null — the RESPONSE read as a
 * silent orphan while the graph was correct (the edges existed, verified via get_links).
 * The data layer was healthy; the reporting layer lied by omission: linksMinted counted
 * ONLY the explicit `links` param, and no field itemized the tag-derived edges.
 *
 * THE CONTRACT (choke-point invariant, asserted for EACH of the four provenance paths):
 *
 *     store().structuredContent.context.linksMinted
 *       === get_links(id).structuredContent.total
 *
 * i.e. the number the store RESPONSE reports equals the number of edges the GRAPH
 * actually holds for the freshly-written record (a fresh record has no in-edges, so
 * get_links total == the edges this write minted). Plus: every minted edge appears in
 * the unified `edgesMinted` report labeled with its provenance
 * (via: 'tag' | 'links-param' | 'position'/'named-ref'/'trunk-ref' | 'inference' —
 * the anchor's 'anchor' label was retired by PHASE 1 positional membership).
 *
 * THE EMBEDDING FIXTURE mirrors noOrphanWrites.contract.test.ts (content-driven):
 *   • "SRCVEC"  → the axis-0 unit vector (an established-topic pole for seeding),
 *   • "COS=<c>" → a vector whose cosine to axis-0 is EXACTLY c (drives inference),
 *   • anything else → zeros (similarity not exercised — tag/links/anchor cases).
 *
 * ISOLATION: each case runs in its OWN fresh project + connection (anchors are
 * connection-keyed; inference's candidate pool is project-wide).
 *
 * DB target: the disposable migrated ci_* DB from the CI gate — never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';

// CONTENT-DRIVEN embedding mock (same knob as noOrphanWrites — deterministic cosine).
function vecArr(cos: number): number[] {
  const v = new Array(embedDim()).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}
function embeddingForText(text: string): number[] {
  const m = text.match(/COS=([0-9]*\.?[0-9]+)/);
  if (m) return vecArr(Number(m[1]));
  if (text.includes('SRCVEC')) return vecArr(1);
  return new Array(embedDim()).fill(0);
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
import { INFERENCE_EDGE_TYPE } from '../services/threadInference.js';
import { INFERENCE_THRESHOLD } from '../config/reliableThreadingConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

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

/** A fresh project + a connection switched to it (per-case isolation). */
async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'store edge-report fixture') RETURNING id`,
      [`edge-report-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `edge-report-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/**
 * THE INVARIANT's right-hand side: the graph's own edge count for the record, read
 * through the SAME public tool a dogfooding agent used to catch the lie (get_links) —
 * not raw SQL — so the two numbers being compared are both tool-surface numbers.
 */
async function graphTotal(recordId: string, conn: string): Promise<number> {
  const resp = await viaTool('get_links', { id: recordId }, conn);
  expect(resp.isError).not.toBe(true);
  return resp.structuredContent.total ?? 0;
}

/** Shorthand: the store response's context payload. */
const ctxOf = (resp: any) => resp.structuredContent.context;

describe('store edge-reporting honesty (an earlier task — linksMinted === graph total, per provenance path)', () => {
  beforeAll(() => {
    // The inference case stores a COS=0.95 capture; if the configured mint floor ever
    // rises above that, the case would silently stop exercising the path — fail LOUDLY
    // here instead (config drift must break the fuse, not hollow it out).
    expect(INFERENCE_THRESHOLD).toBeLessThanOrEqual(0.9);
  });

  afterAll(async () => {
    try {
      for (const pid of projectIds) {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  // ── via:'tag' — THE dogfood snag path ───────────────────────────────────────
  test("tag-derived edges are REPORTED: linksMinted === graph total, each edge labeled via:'tag'", async () => {
    const { conn } = await freshCase('tag');
    const task = parseId(await viaTool('task_create', { title: 'tag-threaded task', type: 'feature' }, conn));
    const decResp = await viaTool('decision_record', {
      decisionType: 'architecture', title: 'tag-threaded decision', description: 'd',
      rationale: 'r', impactLevel: 'medium',
    }, conn);
    const decId = decResp.structuredContent.decision.id;

    // The EXACT dogfood shape: threading tags only — no links arg, no anchor.
    const resp = await viaTool('context_store', {
      content: 'a capture threaded purely by tags (the c62c2410 shape)',
      type: 'completion',
      tags: [`task:${id8(task)}`, `decision:${id8(decId)}`],
    }, conn);
    expect(resp.isError).not.toBe(true);
    const ctx = ctxOf(resp);

    // THE INVARIANT: the response's number === the graph's number (was 0 vs 2 before).
    // THREE now, not two, and the third is the point of the AUTO-OPEN change:
    // task_create auto-opened a branch on the task, decision_record extended it
    // (so the decision is the TIP), and this capture is therefore a MEMBER — it gets a
    // positional informs edge on top of its two tag edges. The fixture was not changed to
    // dodge that; this is the shape a real agent now produces, and the invariant under test
    // is exactly the claim that the reported number keeps matching the graph when a new
    // mint path joins.
    expect(ctx.linksMinted).toBe(3);
    expect(await graphTotal(ctx.id, conn)).toBe(ctx.linksMinted);

    // The unified report itemizes BOTH tag edges with tag provenance + the minting tag,
    // plus the positional membership edge.
    expect(ctx.edgesMinted).toHaveLength(3);
    expect(ctx.edgesMinted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          via: 'tag', edgeType: 'informs', toType: 'task', toId: task,
          created: true, sourceTag: `task:${id8(task)}`,
        }),
        expect.objectContaining({
          via: 'tag', edgeType: 'decided_by', toType: 'decision', toId: decId,
          created: true, sourceTag: `decision:${id8(decId)}`,
        }),
      ])
    );

    // Back-compat per-path fields still there. AUTO-OPEN: the branch was
    // opened by the task_create above (origin 'auto'), so there is a position, one
    // positional edge, and NO offer — the offer is what auto-open replaced. Explicit tag
    // intent still suppresses the inference guess.
    expect(ctx.tagEdgesMinted).toBe(2);
    expect(ctx.positional.position).toMatchObject({ spineId: task, spineType: 'task', origin: 'auto' });
    expect(ctx.positional.edges).toEqual([
      expect.objectContaining({ via: 'position', edgeType: 'informs', toType: 'decision', toId: decId }),
    ]);
    expect(ctx.positional.offer).toBeNull();
    expect(ctx.inference).toBeNull();

    // The TEXT channel says it too — success as visible as failure.
    expect(responseText(resp)).toMatch(/Linked:/);
    expect(responseText(resp)).toMatch(/informs → task/);
    expect(responseText(resp)).toMatch(/decided_by → decision/);
  });

  // ── via: EDGE_MINT_VIA.linksParam ───────────────────────────────────────────
  test("explicit links-param edges: linksMinted === graph total, labeled via:EDGE_MINT_VIA.linksParam", async () => {
    const { conn } = await freshCase('linksarg');
    const task = parseId(await viaTool('task_create', { title: 'links-param task', type: 'feature' }, conn));

    const resp = await viaTool('context_store', {
      content: 'a capture threaded via the explicit links param',
      type: 'planning',
      links: [{ task: id8(task) }],
    }, conn);
    const ctx = ctxOf(resp);

    // ONE edge, not two: the task_create auto-opened a branch ON that task,
    // and the links-param edge names the SAME task with the same `informs` type — so the
    // positional membership mint DEDUPS onto the identical row. The invariant is what
    // proves it: linksMinted counts created rows, and the graph still holds exactly one.
    expect(ctx.linksMinted).toBe(1);
    expect(await graphTotal(ctx.id, conn)).toBe(ctx.linksMinted);
    expect(ctx.edgesMinted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          via: EDGE_MINT_VIA.linksParam, edgeType: 'informs', toType: 'task', toId: task, created: true,
        }),
      ])
    );
    expect(responseText(resp)).toMatch(/Linked:/);
  });

  // ── via:'position' (PHASE 1 — replaces the retired via:'anchor' case) ───────
  test("positional membership edges: linksMinted === graph total, labeled via:'position'", async () => {
    const { conn } = await freshCase('position');
    const task = parseId(await viaTool('task_create', { title: 'branch spine task', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(task) }, conn);

    const resp = await viaTool('context_store', {
      content: 'a capture made while standing on a branch — no tags, no links',
      type: 'discussion',
    }, conn);
    const ctx = ctxOf(resp);

    expect(ctx.positional.edges).toHaveLength(1); // the per-path field agrees
    expect(ctx.linksMinted).toBe(1);
    expect(await graphTotal(ctx.id, conn)).toBe(ctx.linksMinted);
    expect(ctx.edgesMinted).toEqual([
      expect.objectContaining({
        via: 'position', edgeType: 'informs', toType: 'task', toId: task, created: true,
      }),
    ]);

    await viaTool('branch_close', {}, conn);
  });

  // ── via:'inference' ─────────────────────────────────────────────────────────
  test("B1 inference edge: linksMinted === graph total, labeled via:'inference'", async () => {
    const { projectId, conn } = await freshCase('inference');

    // A NON-ORPHAN neighbor at the axis-0 pole for inference to attach to (the candidate
    // pool only admits already-reachable contexts) — seeded directly, like noOrphanWrites.
    const neighborId = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
         VALUES ($1, 'discussion', 'established topic SRCVEC', $2::vector) RETURNING id::text AS id`,
        [projectId, `[${vecArr(1).join(',')}]`]
      )
    ).rows[0].id;
    const anchorTask = parseId(await viaTool('task_create', { title: 'neighbor anchor task', type: 'general' }, conn));
    // AUTO-OPEN: that task_create opened a branch as a byproduct, and a
    // positioned capture is a MEMBER — which suppresses the B1 guess by design (a declared
    // edge beats an inferred one). This test's subject is the genuinely UNPOSITIONED path,
    // so step off the branch explicitly. branch_close is the declared act that restores the
    // premise; without it this case would silently stop exercising inference at all.
    await viaTool('branch_close', {}, conn);
    await mintEdge({
      fromId: neighborId, fromType: 'context', toId: anchorTask, toType: 'task',
      edgeType: 'informs', projectId, createdBy: 'test:fixture', via: EDGE_MINT_VIA.tag,
    });

    // No tags, no links, no anchor → the B1 no-orphan fallback runs; COS=0.95 clears the floor.
    const resp = await viaTool('context_store', {
      content: 'an unanchored capture near the established topic COS=0.95',
      type: 'discussion',
    }, conn);
    const ctx = ctxOf(resp);

    expect(ctx.inference).toMatchObject({ ran: true, reason: 'minted', candidateId: neighborId });
    expect(ctx.linksMinted).toBe(1);
    expect(await graphTotal(ctx.id, conn)).toBe(ctx.linksMinted);
    expect(ctx.edgesMinted).toEqual([
      expect.objectContaining({
        via: 'inference', edgeType: INFERENCE_EDGE_TYPE, toType: 'context',
        toId: neighborId, created: true,
      }),
    ]);
  });

  // ── DEDUP honesty: two paths minting the SAME edge count it ONCE ────────────
  test('tag + links-param targeting the same edge: linksMinted counts the ONE real edge; both attempts itemized', async () => {
    const { conn } = await freshCase('dedup');
    const task = parseId(await viaTool('task_create', { title: 'dedup task', type: 'feature' }, conn));

    // The tag path runs first (mints), the links-param path then dedups the identical edge.
    const resp = await viaTool('context_store', {
      content: 'a capture naming the same task twice — tag AND links arg',
      type: 'discussion',
      tags: [`task:${id8(task)}`],
      links: [{ task: id8(task) }],
    }, conn);
    const ctx = ctxOf(resp);

    // ONE real edge in the graph → linksMinted reports exactly one (created:true) —
    // the invariant is precisely what forbids double-counting here.
    expect(ctx.linksMinted).toBe(1);
    expect(await graphTotal(ctx.id, conn)).toBe(ctx.linksMinted);

    // All THREE attempts are itemized with their provenance; only the first is `created`.
    // The third is the auto-opened position aiming at the same task — a
    // third independent path onto ONE row, which is the strongest form of this test: the
    // reported total still equals the graph's, and nothing is double-counted.
    expect(ctx.edgesMinted).toHaveLength(3);
    const byVia = Object.fromEntries(ctx.edgesMinted.map((e: any) => [e.via, e]));
    expect(byVia['tag']).toMatchObject({ edgeType: 'informs', toId: task, created: true });
    expect(byVia[EDGE_MINT_VIA.linksParam]).toMatchObject({ edgeType: 'informs', toId: task, created: false });
    expect(byVia['position']).toMatchObject({ edgeType: 'informs', toId: task, created: false });
    expect(responseText(resp)).toMatch(/already linked/);
  });

  // ── The honest ZERO: a genuine orphan reports 0 === 0 ───────────────────────
  test('a genuinely unthreaded write reports linksMinted 0 === graph total 0 (zero now MEANS orphan)', async () => {
    const { conn } = await freshCase('orphan');

    // No tags, no links, no anchor, and an empty project → nothing for inference either.
    const resp = await viaTool('context_store', {
      content: 'a capture with nothing to attach to',
      type: 'discussion',
    }, conn);
    const ctx = ctxOf(resp);

    expect(ctx.linksMinted).toBe(0);
    expect(ctx.edgesMinted).toEqual([]);
    expect(await graphTotal(ctx.id, conn)).toBe(0);
  });
});
