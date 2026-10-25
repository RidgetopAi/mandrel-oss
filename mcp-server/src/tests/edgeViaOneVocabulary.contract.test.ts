/**
 * ONE FACT, ONE VOCABULARY — contract test.
 *
 * TWO defects, one subject: "which path minted this edge?" had two spellings and two
 * reporting holes.
 *
 *   the store RESPONSE spelled the label differently from the stored COLUMN.
 *     `MintedEdgeVia` said 'links-arg' / 'handoff-supersession'; `EDGE_MINT_VIA` (which is
 *     what actually reaches `links.mint_via`) says 'links-param' / 'handoff-timeline'. A
 *     consumer reading the response and a consumer reading the column disagreed about the
 *     same edge, and nothing could tell them they disagreed.
 *
 *   `link` and `unlink` ADVERTISE `mintVia` + `provenanceClass` in the shared
 *     `edgeRecord` output schema and never populated either. A declared contract field that
 *     is permanently absent is worse than an undeclared one: a consumer coded to the schema
 *     reads `undefined` as "this edge has no provenance", when in fact `mint_via` is NOT
 *     NULL and every edge has one.
 *
 * HOW THIS IS ASSERTED, AND WHY NOT AS A LIST: comparing two hand-written lists for
 * equality is the weak form — it passes while both are wrong, and it is a THIRD copy of the
 * vocabulary. Every assertion here instead reads the SAME edge through both surfaces and
 * requires the two answers to be the same string. That cannot pass while a spelling drifts,
 * and it needs no list at all.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { embedDim } from './helpers/embedGeometry.js';

// EMBEDDING STUB. Not an optimization — a REQUIREMENT for running alongside the other edge
// suites: onnxruntime-node's native binding cannot self-register twice in one worker, so a
// file that loads the real embedding service dies with "Module did not self-register" the
// moment it shares a worker with a file that mocked it. Nothing here asserts on similarity,
// so the stub is also honest: it removes a dependency this file never had.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: new Array(embedDim()).fill(0),
      model: 'stub-zero',
      dimensions: embedDim(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { outputZodSchemas } from '../config/outputSchemas.js';
import { EDGE_MINT_VIA, EDGE_MINT_VIA_VALUES } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${responseText(resp).slice(0, 300)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'one-vocabulary fixture') RETURNING id`,
      [`onevocab-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `onevocab-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** The stored row for one edge, straight off the columns. */
async function storedEdge(fromId: string, toId: string, edgeType: string) {
  const r = await db.query(
    `SELECT id, mint_via, provenance_class FROM links
      WHERE from_id=$1::uuid AND to_id=$2::uuid AND edge_type=$3`,
    [fromId, toId, edgeType]
  );
  return r.rows[0];
}

afterAll(async () => {
  for (const p of projectIds) {
    await db.query('DELETE FROM links WHERE project_id = $1', [p]);
    await db.query('DELETE FROM contexts WHERE project_id = $1', [p]);
    await db.query('DELETE FROM tasks WHERE project_id = $1', [p]);
    await db.query('DELETE FROM projects WHERE id = $1', [p]);
  }
});

describe('edge provenance: the response and the column say the SAME word', () => {
  /**
   * THE HEADLINE. A `links`-param edge, read through BOTH surfaces. The assertion is an
   * IDENTITY between two independently-produced values — not either one against a literal —
   * so re-spelling either surface breaks it, and no third copy of the vocabulary is created.
   */
  test('a links-param edge: store response `via` === the row\'s `links.mint_via`', async () => {
    const { conn } = await freshCase('linksparam');
    const task = parseId(await viaTool('task_create', { title: `onevocab task ${STAMP}`, type: 'feature' }, conn));
    // task_create AUTO-OPENS a branch position on the new task, so an unqualified store would
    // also mint a positional `informs` to it — the same (from,to,type) triple, reported twice.
    // Stand at the trunk so the links-param edge is the only one aimed at this task.
    await viaTool('branch_close', {}, conn);
    const resp = await viaTool(
      'context_store',
      { content: `onevocab links-param source ${STAMP}`, type: 'completion', links: [{ task: id8(task), edgeType: 'informs' }] },
      conn
    );
    const ctx = parseId(resp);
    const reported = (resp.structuredContent?.context?.edgesMinted ?? []).filter((e: any) => e.toId === task);
    expect(reported.length, 'the links-param edge is itemized in the response').toBe(1);

    const row = await storedEdge(ctx, task, 'informs');
    expect(row, 'the edge row exists').toBeTruthy();
    expect(reported[0].via).toBe(row.mint_via);
    // …and that shared word is a member of the ONE closed vocabulary, not a private synonym.
    expect(EDGE_MINT_VIA_VALUES).toContain(reported[0].via);
    expect(reported[0].via).toBe(EDGE_MINT_VIA.linksParam);
  });

  /**
   * THE OTHER MEMBER THAT DIVERGED. A handoff's timeline supersession was reported as
   * 'handoff-supersession' while the column said 'handoff-timeline'.
   */
  test('a handoff-timeline edge: store response `via` === the row\'s `links.mint_via`', async () => {
    const { conn } = await freshCase('handoff');
    const first = parseId(await viaTool('context_store', { content: `onevocab handoff one ${STAMP}`, type: 'handoff' }, conn));
    const resp = await viaTool('context_store', { content: `onevocab handoff two ${STAMP}`, type: 'handoff' }, conn);
    const second = parseId(resp);

    const reported = (resp.structuredContent?.context?.edgesMinted ?? []).filter((e: any) => e.edgeType === 'supersedes');
    expect(reported.length, 'the timeline supersession is itemized').toBe(1);

    const row = await storedEdge(second, first, 'supersedes');
    expect(row, 'the supersession row exists').toBeTruthy();
    expect(reported[0].via).toBe(row.mint_via);
    expect(reported[0].via).toBe(EDGE_MINT_VIA.handoffTimeline);
  });

  /**
   * THE SWEEP — the coverage claim, made executably rather than as a sentence. EVERY via any
   * write path reports must be a member of the closed vocabulary. A future mint path that
   * invents a private spelling lands here even though this file never heard of it.
   */
  test('SWEEP: every reported `via`, from every path one write can trigger, is in EDGE_MINT_VIA', async () => {
    const { conn } = await freshCase('sweep');
    const task = parseId(await viaTool('task_create', { title: `onevocab sweep task ${STAMP}`, type: 'feature' }, conn));
    const decision = parseId(
      await viaTool('decision_record', {
        title: `onevocab sweep decision ${STAMP}`, description: 'sweep', rationale: 'sweep',
        decisionType: 'architecture', impactLevel: 'low',
      }, conn)
    );
    const responses = [
      await viaTool('context_store', {
        content: `onevocab sweep tagged ${STAMP}`, type: 'completion',
        tags: [`task:${id8(task)}`, `decision:${id8(decision)}`],
        links: [{ task: id8(task), edgeType: 'depends_on' }],
      }, conn),
      await viaTool('context_store', { content: `onevocab sweep handoff a ${STAMP}`, type: 'handoff' }, conn),
      await viaTool('context_store', { content: `onevocab sweep handoff b ${STAMP}`, type: 'handoff' }, conn),
    ];
    const vias = responses.flatMap((r) => (r.structuredContent?.context?.edgesMinted ?? []).map((e: any) => e.via));
    expect(vias.length, 'the sweep exercised at least one mint path').toBeGreaterThan(0);
    for (const v of vias) expect(EDGE_MINT_VIA_VALUES, `reported via "${v}"`).toContain(v);
  });
});

describe('link / unlink populate the provenance they advertise', () => {
  test('`link` reports the created edge\'s mintVia + provenanceClass, matching the row', async () => {
    const { conn } = await freshCase('linktool');
    const a = parseId(await viaTool('context_store', { content: `onevocab link a ${STAMP}`, type: 'discussion' }, conn));
    await viaTool('branch_close', {}, conn);
    const b = parseId(await viaTool('context_store', { content: `onevocab link b ${STAMP}`, type: 'discussion' }, conn));

    const resp = await viaTool(
      'link',
      { from: id8(a), fromType: 'context', to: id8(b), toType: 'context', edgeType: 'informs' },
      conn
    );
    expect(resp.isError).not.toBe(true);
    // The DECLARED contract is the thing being honoured, so validate against it, not a shape
    // written out by hand here — a hand-written expectation could not have caught the defect,
    // since the schema was already correct and the route simply never filled it in.
    outputZodSchemas.link.parse(resp.structuredContent);

    const row = await storedEdge(a, b, 'informs');
    expect(resp.structuredContent.edge.mintVia).toBe(row.mint_via);
    expect(resp.structuredContent.edge.mintVia).toBe(EDGE_MINT_VIA.linkTool);
    expect(resp.structuredContent.edge.provenanceClass).toBe(row.provenance_class);
    expect(resp.structuredContent.edge.provenanceClass).not.toBeNull();
  });

  /**
   * A DEDUP reports the ORIGINAL minter, not the label this call would have written. This is
   * the case that distinguishes reading the row back from echoing the input — an echo would
   * answer 'link-tool' here and look perfectly plausible.
   */
  test('`link` on an EXISTING edge reports the ORIGINAL mintVia, not `link-tool`', async () => {
    const { conn } = await freshCase('dedup');
    const task = parseId(await viaTool('task_create', { title: `onevocab dedup task ${STAMP}`, type: 'feature' }, conn));
    const ctx = parseId(
      await viaTool('context_store', {
        content: `onevocab dedup source ${STAMP}`, type: 'completion',
        links: [{ task: id8(task), edgeType: 'informs' }],
      }, conn)
    );

    const resp = await viaTool(
      'link',
      { from: id8(ctx), fromType: 'context', to: id8(task), toType: 'task', edgeType: 'informs' },
      conn
    );
    expect(resp.structuredContent.action).toBe('exists');
    expect(resp.structuredContent.edge.mintVia).toBe(EDGE_MINT_VIA.linksParam);
    expect(resp.structuredContent.edge.mintVia).not.toBe(EDGE_MINT_VIA.linkTool);
  });

  test('`unlink` reports the REMOVED edge\'s mintVia + provenanceClass; the absent path reports null', async () => {
    const { conn } = await freshCase('unlink');
    const a = parseId(await viaTool('context_store', { content: `onevocab unlink a ${STAMP}`, type: 'discussion' }, conn));
    await viaTool('branch_close', {}, conn);
    const b = parseId(await viaTool('context_store', { content: `onevocab unlink b ${STAMP}`, type: 'discussion' }, conn));
    await viaTool('link', { from: id8(a), fromType: 'context', to: id8(b), toType: 'context', edgeType: 'informs' }, conn);

    // Read the row BEFORE the delete — after it, the row is gone and the only remaining
    // witness is the response itself. That is exactly the fact the response must carry.
    const row = await storedEdge(a, b, 'informs');
    const resp = await viaTool('unlink', { from: id8(a), to: id8(b), edgeType: 'informs' }, conn);
    outputZodSchemas.unlink.parse(resp.structuredContent);
    expect(resp.structuredContent.edge.removed).toBe(true);
    expect(resp.structuredContent.edge.mintVia).toBe(row.mint_via);
    expect(resp.structuredContent.edge.provenanceClass).toBe(row.provenance_class);

    // THE EMPTY POPULATION: nothing removed. There is genuinely no row to describe, so the
    // honest answer is null — never a fabricated label, and never a stale one from before.
    const absent = await viaTool('unlink', { from: id8(a), to: id8(b), edgeType: 'informs' }, conn);
    expect(absent.structuredContent.edge.removed).toBe(false);
    expect(absent.structuredContent.edge.mintVia).toBeNull();
    expect(absent.structuredContent.edge.provenanceClass).toBeNull();
  });
});
