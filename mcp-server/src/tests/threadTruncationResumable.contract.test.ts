/**
 * THE TRUNCATION NOTICE MUST HAND BACK A NUMBER THAT ACTUALLY WORKS.
 *
 * WHAT WENT WRONG. When the node cap filled, the BFS stopped enqueueing, so the frontier
 * emptied and the walk ENDED. Only the overflow of the single level that filled the cap was
 * ever counted, and everything reachable beyond that level was never discovered. The prose
 * then printed `re-call with maxNodes: nodes.length + truncatedCount` as if that number were
 * sufficient. On any graph deeper than one hop it is a FLOOR, and re-calling with it returns
 * a still-truncated thread — a precise-looking number that is not one.
 *
 * WHY THE PRE-EXISTING GUARD DID NOT CATCH IT (threadTraversalBudget.contract.test.ts, "a
 * small maxNodes truncates; re-calling with nodes+truncatedCount returns the WHOLE branch").
 * Its fixture is a depth-1 STAR walked at depth 1 — the one shape in which the floor and the
 * count coincide, because there is no level after the one that overflowed. Its population
 * excluded the defect. This file's fixture is a TWO-LEVEL tree walked at depth 2, so the
 * overflow has descendants and the floor and the true count differ.
 *
 * HOW IT IS ASSERTED. The number is not recomputed here the way the product computes it —
 * that would agree with the bug by construction. It is PARSED OUT OF THE RENDERED TEXT the
 * tool returned and then FED BACK to the real tool, and the re-call's completeness is the
 * assertion. The loop a caller actually runs, executed.
 *
 * Embedding service mocked → deterministic + offline (mirrors recallThread.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { THREAD_CONFIG } from '../config/threadConfig.js';
import { buildThread } from '../services/recallThread.js';
import { renderThreadText, truncationNotice } from '../routes/recall.routes.js';

const STAMP = Date.now();
const CONN = `thread-trunc-conn-${STAMP}`;
const PROJ_NAME = `thread-trunc-P-${STAMP}`;

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function storeContext(content: string): Promise<string> {
  const r = await viaTool('context_store', { content, type: 'planning' });
  return r.structuredContent.context.id;
}
async function link(from: string, to: string, edgeType: string) {
  return viaTool('link', { from, fromType: 'context', to, toType: 'context', edgeType });
}

/**
 * The number the NOTICE HANDS THE CALLER, read back out of the shipped prose. Deliberately
 * a parse and not a recomputation: the defect was that the rendered number was wrong, so a
 * test that recomputes it from the same inputs the renderer used cannot see the defect.
 */
function advisedMaxNodes(text: string): number | null {
  const m = text.match(/re-call with maxNodes: (\d+)/);
  return m ? Number(m[1]) : null;
}

// A TWO-LEVEL TREE. root → CHILDREN children → 2 grandchildren each. Everything is inside
// depth 2, and the cap is set to bite on the FIRST level, so the true reachable set lives
// one level past the level that overflowed.
const CHILDREN = 6;
const GRANDKIDS_PER_CHILD = 2;
const TOTAL_REACHABLE = 1 + CHILDREN + CHILDREN * GRANDKIDS_PER_CHILD; // 19

describe('recall_thread truncation notice — the number it hands back must return the branch', () => {
  let root: string;
  const all: string[] = [];

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'truncation resumability contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    root = await storeContext('truncation tree ROOT (the anchor)');
    all.push(root);
    for (let i = 0; i < CHILDREN; i++) {
      const child = await storeContext(`truncation tree child ${i} (1 hop)`);
      all.push(child);
      await link(root, child, 'caused');
      for (let g = 0; g < GRANDKIDS_PER_CHILD; g++) {
        const gk = await storeContext(`truncation tree grandchild ${i}.${g} (2 hops)`);
        all.push(gk);
        await link(child, gk, 'caused');
      }
    }
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('the fixture really is a two-level tree the walk can see whole (the control)', async () => {
    // Without this, every assertion below could pass on a broken traversal that simply
    // reaches nothing. Ask for the whole thing and check the shape we think we built.
    const whole = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 100,
    });
    expect(whole.structuredContent.truncated).toBe(false);
    expect(whole.structuredContent.nodes.length).toBe(TOTAL_REACHABLE);
    expect(new Set(whole.structuredContent.nodes.map((n: any) => n.id))).toEqual(new Set(all));
  });

  test('the advised maxNodes RETURNS THE WHOLE BRANCH when the overflow has descendants', async () => {
    const small = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 4,
    });
    expect(small.structuredContent.truncated, 'a cap of 4 on a 19-node tree must truncate').toBe(true);

    const advised = advisedMaxNodes(responseText(small));
    expect(advised, 'the notice must name a maxNodes value').not.toBeNull();

    // THE LOOP A CALLER RUNS. Measured pre-fix on this fixture: the notice advised
    // maxNodes 13 (4 listed + a 9-node floor) and this re-call came back STILL TRUNCATED.
    const again = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: advised!,
    });
    expect(again.structuredContent.truncated, 'following the notice must COMPLETE the thread').toBe(false);
    expect(again.structuredContent.truncatedCount).toBe(0);
    expect(new Set(again.structuredContent.nodes.map((n: any) => n.id))).toEqual(new Set(all));
  });

  test('truncatedCount counts EVERY reachable node the cap dropped, not just the overflowing level', async () => {
    const small = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 4,
    });
    // 4 admitted + 15 dropped = the 19 the control proved reachable. Measured pre-fix: 9 —
    // the 3 sibling children plus the 6 grandchildren of the 3 children that WERE admitted.
    // The 6 hanging off the dropped children were invisible, which is the defect.
    expect(small.structuredContent.nodes.length).toBe(4);
    expect(small.structuredContent.truncatedCount).toBe(TOTAL_REACHABLE - 4);
  });

  test('a node reachable ONLY through a dropped node is counted (the walk does not stop at the cap)', async () => {
    // depth 1 admits root + 3 children; the grandchildren are reachable only THROUGH the
    // children, and 3 of those children were dropped. At depth 2 every one of them must
    // still be counted, which is exactly the discovery the old walk never performed.
    const small = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 2,
    });
    expect(small.structuredContent.nodes.length).toBe(2);
    // Measured pre-fix: 7 (the 5 unadmitted children + the 2 grandchildren of the 1 admitted
    // child). 10 nodes existed only behind dropped nodes and were never counted.
    expect(small.structuredContent.truncatedCount).toBe(TOTAL_REACHABLE - 2);
  });

  test('when NO maxNodes can return the branch, the notice says so instead of naming one', async () => {
    // The other honest case: the whole branch is bigger than the server's ceiling, so there
    // is no value to advise. Driven through the SHIPPED engine + the SHIPPED renderer with a
    // ceiling small enough for a test fixture to exceed — the config is a parameter of
    // buildThread precisely so this posture is exercisable.
    const result = await buildThread(
      { anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 4 },
      { ...THREAD_CONFIG, maxNodes: 4, maxNodesCeiling: 5 }
    );
    const text = renderThreadText(result);
    expect(result.truncated).toBe(true);
    expect(text, 'no maxNodes value is advised, because none would work').not.toMatch(
      /re-call with maxNodes: \d+/
    );
    expect(text).toContain('narrow edgeTypes');
    // The count it DOES print is marked as the lower bound it is, and the reason it is one
    // is named — "this branch is bigger than the server allows" is a different instruction
    // from "we could not finish counting".
    expect(text).toMatch(/at least \d+ more reachable/);
    expect(text).toContain("larger than this server's per-call node ceiling");
    expect(result.resumeMaxNodes, 'the engine reports NO resumption value').toBeNull();
    expect(result.truncationCountStop).toBe('ceiling');
  });

  test('the read-failure case names NO maxNodes either', async () => {
    // The third stop state ('error' — a links read failed mid-walk) cannot be produced from
    // the fixture, so it is exercised on the SHIPPED renderer with a REAL result whose stop
    // reason is moved. What is asserted is only what this function decides: which sentence a
    // stop reason selects. The numbers in it come from the engine, and are asserted above.
    const result = await buildThread(
      { anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 4 },
      { ...THREAD_CONFIG, maxNodes: 4, maxNodesCeiling: 500 }
    );
    expect(result.resumeMaxNodes, 'the control: this result DOES have a resumption value').not.toBeNull();
    expect(truncationNotice(result)).toContain('re-call with maxNodes:');

    const failed = { ...result, resumeMaxNodes: null, truncationCountStop: 'error' as const };
    expect(truncationNotice(failed)).not.toMatch(/re-call with maxNodes: \d+/);
    expect(truncationNotice(failed)).toContain('LOWER BOUND');
  });

  test('an untruncated thread renders NO truncation notice at all (the negative control)', async () => {
    const whole = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', depth: 2, maxNodes: 100,
    });
    expect(responseText(whole)).not.toContain('truncated —');
  });
});
