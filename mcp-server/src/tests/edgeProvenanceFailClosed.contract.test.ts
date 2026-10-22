/**
 * EDGE PROVENANCE, FAIL-CLOSED — end-to-end contract test (SK4).
 *
 * WHAT THIS ASSERTS, and why it is shaped as a SWEEP rather than a list: the deliverable is
 * "every new edge carries a provenance label, normalized to one key". A prose enumeration of
 * the mint sites would be exactly the artifact nothing gates — it can name a path that no
 * longer exists, and it cannot notice a path nobody thought of. So the coverage claim is
 * made EXECUTABLY, in two halves that fail for opposite reasons:
 *
 *   1. EXERCISE — drive every mint path through the real tool surface (context_store with
 *      threading tags, with the `links` param, while POSITIONED on a branch, a handoff
 *      supersession, the similarity fallback, task_create's `dependencies` and
 *      `parentTaskId`, decision_record's evidence and `superseded_by`, and the `link` tool
 *      with a BARE supersedes carrying no metadata at all) and read every edge back.
 *   2. SWEEP — assert over EVERY edge the project now holds, not over the ones named above:
 *      none is unlabelled, none is 'unclassified'. A mint path this file forgot still lands
 *      in that sweep, and an unlabelled one would fail it.
 *
 * The bare-`link` case is the specific hole SK4 closes (scope b): the `link` tool requires
 * no metadata, so `link(from, to, edgeType:'supersedes')` used to write created_by='link',
 * metadata='{}' — an edge with zero provenance that migration 079 nonetheless counted as
 * DECLARED on its stamp alone.
 *
 * ISOLATION: one fresh project + connection per case; the sweep is scoped to those projects.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { embedDim } from './helpers/embedGeometry.js';

// CONTENT-DRIVEN embedding mock (same knob as storeEdgeReporting/noOrphanWrites): "SRCVEC"
// is the established-topic pole and "COS=<c>" lands at exactly that cosine to it, which is
// what makes the inference fallback fire deterministically instead of by luck.
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
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { INFERENCE_THRESHOLD } from '../config/reliableThreadingConfig.js';

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
      `INSERT INTO projects (name, description) VALUES ($1, 'sk4 provenance fixture') RETURNING id`,
      [`sk4-prov-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `sk4-prov-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** Every edge this record minted, as (edge_type, mint_via, provenance_class, metadata). */
async function edgesOf(recordId: string): Promise<
  Array<{ edge_type: string; mint_via: string; provenance_class: string; created_by: string; metadata: any }>
> {
  return (
    await db.query(
      `SELECT edge_type, mint_via, provenance_class, created_by, metadata
         FROM links WHERE from_id = $1 ORDER BY mint_via, edge_type`,
      [recordId]
    )
  ).rows;
}

/** The distinct vias present on a record's out-edges. */
const viasOf = async (recordId: string): Promise<string[]> =>
  [...new Set((await edgesOf(recordId)).map((r) => r.mint_via))].sort();

afterAll(async () => {
  try {
    for (const pid of projectIds) {
      await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await db.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
  } catch {
    /* fixture teardown is best-effort */
  }
  await db.end();
});

describe('SK4 — every edge minted through a real tool call carries its mint_via', () => {
  test('context_store with THREADING TAGS → via tag', async () => {
    const { conn } = await freshCase('tag');
    const task = parseId(await viaTool('task_create', { title: 'sk4 tag target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn); // task_create opens a position; close it so this case is tag-only
    const ctx = parseId(
      await viaTool('context_store', { content: 'sk4 tag write', type: 'discussion', tags: [`task:${id8(task)}`] }, conn)
    );
    expect(await viasOf(ctx)).toEqual([EDGE_MINT_VIA.tag]);
    const [edge] = await edgesOf(ctx);
    expect(edge.provenance_class).toBe('declared');
    // The raw tag TEXT stays in metadata — it is per-edge detail, not the normalized label.
    expect(edge.metadata.source_tag).toBe(`task:${id8(task)}`);
  });

  test('context_store with the LINKS PARAM → via links-param', async () => {
    const { conn } = await freshCase('linksparam');
    const task = parseId(await viaTool('task_create', { title: 'sk4 links target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);
    const ctx = parseId(
      await viaTool('context_store', { content: 'sk4 links write', type: 'discussion', links: [{ task: id8(task) }] }, conn)
    );
    expect(await viasOf(ctx)).toEqual([EDGE_MINT_VIA.linksParam]);
  });

  test('a POSITIONED write → via position (membership)', async () => {
    const { conn } = await freshCase('position');
    const task = parseId(await viaTool('task_create', { title: 'sk4 spine', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(task) }, conn);
    const ctx = parseId(await viaTool('context_store', { content: 'sk4 positioned write', type: 'discussion' }, conn));
    expect(await viasOf(ctx)).toEqual([EDGE_MINT_VIA.position]);
  });

  test('a positioned write NAMING one foreign task IN THE BODY → via named-ref alongside position', async () => {
    const { conn } = await freshCase('namedref');
    const spine = parseId(await viaTool('task_create', { title: 'sk4 namedref spine', type: 'feature' }, conn));
    const foreign = parseId(await viaTool('task_create', { title: 'sk4 namedref foreign', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(spine) }, conn);
    // The id is in the BODY, not in a tag: a `task:` TAG is explicit intent and wins the
    // precedence ladder outright (it mints via tag), so tagging here would exercise the wrong
    // path. named-ref is specifically the positional scan of a foreign id mentioned in prose.
    const ctx = parseId(
      await viaTool(
        'context_store',
        { content: `sk4 named-ref write, mentioning ${id8(foreign)} in prose`, type: 'discussion' },
        conn
      )
    );
    expect(await viasOf(ctx)).toEqual([EDGE_MINT_VIA.namedRef, EDGE_MINT_VIA.position].sort());
  });

  test('a positioned write naming TWO tasks in the body (a TRUNK record) → via trunk-ref', async () => {
    const { conn } = await freshCase('trunkref');
    const spine = parseId(await viaTool('task_create', { title: 'sk4 trunk spine', type: 'feature' }, conn));
    const t1 = parseId(await viaTool('task_create', { title: 'sk4 trunk name 1', type: 'feature' }, conn));
    const t2 = parseId(await viaTool('task_create', { title: 'sk4 trunk name 2', type: 'feature' }, conn));
    await viaTool('branch_open', { id: id8(spine) }, conn);
    // Naming >=2 task ids mints a weak per-task reference edge (via trunk-ref). MEMBERSHIP
    // SURVIVES HERE, and that is not an accident of the fixture: positionalMint protects a
    // DECLARED position from the trunk revert (`trunk = multiName && origin !== 'declared'`),
    // and branch_open sets origin='declared'. So the expected set is BOTH vias — asserting
    // trunk-ref alone would be asserting the behaviour of an AUTO position, which this case
    // does not create.
    const ctx = parseId(
      await viaTool(
        'context_store',
        { content: `sk4 multi-name trunk note covering ${id8(t1)} and ${id8(t2)}`, type: 'discussion' },
        conn
      )
    );
    expect(await viasOf(ctx)).toEqual([EDGE_MINT_VIA.position, EDGE_MINT_VIA.trunkRef].sort());
  });

  test('a HANDOFF supersession → via handoff-timeline', async () => {
    const { conn } = await freshCase('handoff');
    await viaTool('context_store', { content: 'sk4 first handoff', type: 'handoff' }, conn);
    const second = parseId(await viaTool('context_store', { content: 'sk4 second handoff', type: 'handoff' }, conn));
    const edges = await edgesOf(second);
    const supersedes = edges.filter((e) => e.edge_type === 'supersedes');
    expect(supersedes.length, 'the second handoff supersedes the first').toBe(1);
    expect(supersedes[0].mint_via).toBe(EDGE_MINT_VIA.handoffTimeline);
    expect(supersedes[0].provenance_class).toBe('declared');
  });

  test('the SIMILARITY FALLBACK (no tags, no links, no position) → via inference, class guessed', async () => {
    // The floor is config, not a literal: if it ever rises above the fixture's cosine this
    // case would stop exercising the path silently, so break loudly instead.
    expect(INFERENCE_THRESHOLD).toBeLessThanOrEqual(0.9);
    const { conn } = await freshCase('inference');
    // The candidate must itself be REACHABLE — the fallback deliberately will not point a new
    // record at an orphan. So the pole is given a declared edge of its own (via the tag path,
    // through the tool surface) before it can serve as a neighbour.
    const anchorTask = parseId(await viaTool('task_create', { title: 'sk4 inference anchor', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);
    await viaTool(
      'context_store',
      { content: 'sk4 established topic SRCVEC', type: 'discussion', tags: [`task:${id8(anchorTask)}`] },
      conn
    );
    await viaTool('branch_close', {}, conn);
    const ctx = parseId(
      await viaTool('context_store', { content: 'sk4 unanchored capture COS=0.95', type: 'discussion' }, conn)
    );
    const edges = await edgesOf(ctx);
    expect(edges.length, 'the no-orphan fallback minted exactly one edge').toBe(1);
    expect(edges[0].mint_via).toBe(EDGE_MINT_VIA.inference);
    expect(edges[0].provenance_class).toBe('guessed');
    // The measured score stays in metadata — detail, alongside the normalized label.
    expect(typeof edges[0].metadata.similarity).toBe('number');
  });

  test('task_create with DEPENDENCIES and a PARENT TASK → via task-dependencies + parent-task-param', async () => {
    const { conn } = await freshCase('taskdeps');
    const dep = parseId(await viaTool('task_create', { title: 'sk4 dep', type: 'feature' }, conn));
    const parent = parseId(await viaTool('task_create', { title: 'sk4 parent', type: 'feature' }, conn));
    const child = parseId(
      await viaTool(
        'task_create',
        { title: 'sk4 child', type: 'feature', dependencies: [id8(dep)], parentTaskId: id8(parent) },
        conn
      )
    );
    const vias = await viasOf(child);
    expect(vias).toContain(EDGE_MINT_VIA.taskDependencies);
    expect(vias).toContain(EDGE_MINT_VIA.parentTaskParam);
  });

  test('decision_record EVIDENCE → via decision-evidence; decision_update supersededBy → via decision-superseded-by', async () => {
    const { conn } = await freshCase('decision');
    const evidence = parseId(await viaTool('context_store', { content: 'sk4 evidence context', type: 'discussion' }, conn));
    const older = parseId(
      await viaTool(
        'decision_record',
        { title: 'sk4 older decision', description: 'd', rationale: 'r', decisionType: 'architecture', impactLevel: 'low' },
        conn
      )
    );
    await viaTool('branch_close', {}, conn);
    const newer = parseId(
      await viaTool(
        'decision_record',
        {
          title: 'sk4 newer decision',
          description: 'd',
          rationale: 'r',
          decisionType: 'architecture',
          impactLevel: 'low',
          metadata: { evidence: [id8(evidence)] },
        },
        conn
      )
    );
    expect(await viasOf(newer)).toContain(EDGE_MINT_VIA.decisionEvidence);

    // supersededBy is a decision_UPDATE param (decision_record rejects it in strict mode),
    // so the superseded_by column mirror is exercised where it actually lives.
    const upd = await viaTool('decision_update', { decisionId: id8(newer), supersededBy: id8(older) }, conn);
    expect(upd.isError).not.toBe(true);
    expect(await viasOf(newer)).toContain(EDGE_MINT_VIA.decisionSupersededBy);
  });

  /**
   * SCOPE (b) — THE HOLE SK4 CLOSES. `link` requires no metadata, so this exact call used to
   * write an edge with metadata='{}' and no provenance whatsoever, while migration 079
   * classified it DECLARED on the strength of created_by='link' alone.
   */
  test('the LINK TOOL with a BARE supersedes and NO metadata → via link-tool, not unlabelled', async () => {
    const { conn } = await freshCase('linktool');
    const a = parseId(await viaTool('context_store', { content: 'sk4 link tool from', type: 'discussion' }, conn));
    await viaTool('branch_close', {}, conn);
    const b = parseId(await viaTool('context_store', { content: 'sk4 link tool to', type: 'discussion' }, conn));
    // b is stored SECOND, so b is the later record — `b supersedes a` is the chronologically
    // valid direction. This used to read `a supersedes b`, which the mintEdge chronology guard
    // now refuses; the direction was incidental to this test's subject
    // (provenance labelling), so it is corrected rather than exempted.
    const resp = await viaTool(
      'link',
      { from: id8(b), fromType: 'context', to: id8(a), toType: 'context', edgeType: 'supersedes' },
      conn
    );
    expect(resp.isError).not.toBe(true);
    const edge = (await edgesOf(b)).find((e) => e.edge_type === 'supersedes');
    expect(edge, 'the bare supersedes edge exists').toBeTruthy();
    expect(edge!.created_by).toBe('link');
    expect(edge!.metadata, 'metadata is still empty — the label is a COLUMN, not a key').toEqual({});
    expect(edge!.mint_via).toBe(EDGE_MINT_VIA.linkTool);
    expect(edge!.provenance_class).toBe('declared');
  });

  /**
   * THE SWEEP. Deliberately NOT scoped to the edges the cases above name: it is scoped to
   * every edge in every project this file created, so a mint path nobody remembered is still
   * inside the population. This is the coverage claim, made executable.
   */
  test('SWEEP: across every edge these cases produced, none is unlabelled and none is unclassified', async () => {
    const r = await db.query(
      `SELECT count(*)::int                                                     AS total,
              count(*) FILTER (WHERE mint_via IS NULL)::int                     AS unlabelled,
              count(*) FILTER (WHERE provenance_class = 'unclassified')::int    AS unclassified,
              count(*) FILTER (WHERE mint_via = 'legacy-unlabeled')::int        AS legacy
         FROM links WHERE project_id = ANY($1::uuid[])`,
      [projectIds]
    );
    const row = r.rows[0];
    // CONTROL — a sweep over an empty population passes vacuously, so pin the magnitude too.
    expect(row.total, 'the cases above actually minted edges').toBeGreaterThanOrEqual(10);
    expect(row.unlabelled).toBe(0);
    expect(row.unclassified).toBe(0);
    expect(row.legacy, 'nothing NEW may enter the closed legacy class').toBe(0);
  });
});
