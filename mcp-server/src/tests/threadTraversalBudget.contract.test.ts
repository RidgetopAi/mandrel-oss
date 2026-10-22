/**
 * THE TRAVERSAL BUDGET — recall_thread's depth default and node cap (threading tranche 1).
 *
 * WHAT WENT WRONG. Two shipped defaults were each measured to be actively harmful on real
 * data in the dev snapshot:
 *
 *   DEPTH 3 WAS WORSE THAN DEPTH 2. Distinct nodes reachable at depth 1/2/3 on five real
 *   anchors: 11/36/83 · 50/109/231 · 4/9/41 · 7/19/94 · 17/46/92. The third hop is where a
 *   branch stops being a branch: anchored on the P0-security depth 3
 *   admitted an unrelated Calendar PNG-export handoff that then ordered SECOND and THIRD in
 *   the returned story. It is absent at depth 2 on all five.
 *
 *   THE 50-NODE CAP TRUNCATED EVERY REAL BRANCH (worst: 50 of 196). Truncation was reported
 *   honestly — which is good and is kept — but an honest report of a missing 74% is not a
 *   resumable thread, and the only remedy the tool offered was an ENV VAR, which a customer
 *   running Mandrel in a per-tenant container cannot set.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS BEHAVIOURAL. Every test below drives the real tool
 * and asserts on the RETURNED THREAD, never on the config value. A test that reads
 * THREAD_CONFIG.defaultDepth and compares it to 2 would pass with the traversal deleted; it
 * would restate the config file rather than measure it. So the depth default is asserted the
 * only way that can fail for the right reason: a node exactly 3 hops out is ABSENT when
 * `depth` is omitted and PRESENT when `depth: 3` is passed.
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

const STAMP = Date.now();
const CONN = `thread-budget-conn-${STAMP}`;
const PROJ_NAME = `thread-budget-P-${STAMP}`;

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
const idsOf = (resp: any): string[] => resp.structuredContent.nodes.map((n: any) => n.id);

describe('recall_thread traversal budget — depth default + node cap', () => {
  // A straight chain a → b → c → d. `d` sits exactly 3 hops from `a`: inside depth 3,
  // outside depth 2. It is the whole point of the chain.
  let a: string, b: string, c: string, d: string;
  // A hub with a known neighbour count, for the cap tests.
  const HUB_NEIGHBOURS = 8;
  let hub: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'thread budget contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    a = await storeContext('budget chain A (the anchor)');
    b = await storeContext('budget chain B (1 hop)');
    c = await storeContext('budget chain C (2 hops)');
    d = await storeContext('budget chain D (3 hops — the off-branch node)');
    await link(a, b, 'caused');
    await link(b, c, 'caused');
    await link(c, d, 'caused');

    hub = await storeContext('budget hub');
    for (let i = 0; i < HUB_NEIGHBOURS; i++) {
      const n = await storeContext(`budget hub neighbour ${i}`);
      await link(hub, n, 'caused');
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

  // ── THE DEPTH DEFAULT (fix 1) ───────────────────────────────────────────────
  describe('the default depth walks the BRANCH, not the neighbourhood', () => {
    test('omitting `depth` excludes the 3-hop node that an explicit depth 3 includes', async () => {
      const dflt = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline' });
      const deep = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', depth: 3 });

      // The 2-hop node is inside the default walk — this is the control that stops the test
      // from passing because the traversal is broken rather than because it is bounded.
      expect(idsOf(dflt), 'the 2-hop node IS in the default walk').toContain(c);
      // The 3-hop node is the one the default must NOT reach.
      expect(idsOf(dflt), 'the 3-hop node is OUTSIDE the default walk').not.toContain(d);
      // ...and is reachable when the caller explicitly asks for it. Nothing is unreachable;
      // the default is a default, not a ceiling.
      expect(idsOf(deep), 'depth 3 still reaches it when asked for').toContain(d);
    });

    test('the response REPORTS the depth it actually walked', async () => {
      const resp = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline' });
      // Derived from the config the product reads — never hardcoded here, or this test would
      // pin a number the product could drift away from without failing (C4).
      expect(resp.structuredContent.depthUsed).toBe(THREAD_CONFIG.defaultDepth);
    });
  });

  // ── THE NODE CAP (fix 3) ────────────────────────────────────────────────────
  describe('the node cap is a per-call argument, and truncation is resumable', () => {
    test('a small maxNodes truncates; re-calling with nodes+truncatedCount returns the WHOLE branch', async () => {
      // THE RESUMABILITY CONTRACT. This is the loop a caller actually runs, executed here
      // rather than described in a comment: call, read the honest signal, re-call, get
      // everything. If the arithmetic the tool tells you to do does not close the gap, this
      // test fails — which is precisely what "honest but not resumable" meant.
      const small = await viaTool('recall_thread', {
        anchor: id8(hub), altitude: 'headline', depth: 1, maxNodes: 3,
      });
      expect(small.structuredContent.truncated, 'a cap of 3 on a hub of 8 must truncate').toBe(true);
      expect(small.structuredContent.nodes.length).toBe(3);
      expect(small.structuredContent.truncatedCount).toBeGreaterThan(0);

      const need =
        small.structuredContent.nodes.length + small.structuredContent.truncatedCount;
      const full = await viaTool('recall_thread', {
        anchor: id8(hub), altitude: 'headline', depth: 1, maxNodes: need,
      });
      expect(full.structuredContent.truncated, 'the re-call is complete').toBe(false);
      expect(full.structuredContent.truncatedCount).toBe(0);
      expect(full.structuredContent.nodes.length, 'hub + every neighbour').toBe(HUB_NEIGHBOURS + 1);
    });

    test('the truncation notice names the ARGUMENT to pass, not an env var a container customer cannot set', async () => {
      const small = await viaTool('recall_thread', {
        anchor: id8(hub), altitude: 'headline', depth: 1, maxNodes: 3,
      });
      const text = responseText(small);
      expect(text).toContain('maxNodes: 9'); // 3 returned + 6 more reachable
      expect(text, 'no env var in a user-facing remedy').not.toContain('MANDREL_THREAD_MAX_NODES');
    });

    test('maxNodes is CLAMPED to the ceiling and the applied value is reported', async () => {
      const resp = await viaTool('recall_thread', {
        anchor: id8(hub), altitude: 'headline', depth: 1,
        maxNodes: THREAD_CONFIG.maxNodesCeiling,
      });
      // Asking for the ceiling is honoured exactly...
      expect(resp.structuredContent.maxNodesUsed).toBe(THREAD_CONFIG.maxNodesCeiling);

      // ...and asking for MORE than the ceiling is refused at the schema boundary, so an
      // unbounded walk is not reachable from the tool at all. (The engine's own clamp is the
      // backstop for a direct service caller the schema cannot see.)
      const over = await viaTool('recall_thread', {
        anchor: id8(hub), altitude: 'headline', maxNodes: THREAD_CONFIG.maxNodesCeiling + 1,
      }).catch((e: unknown) => e);
      expect(over instanceof Error || over?.isError, 'over-ceiling is rejected').toBeTruthy();
    });

    test('the DEFAULT cap does not truncate this hub (the default is not the thing being tested around)', async () => {
      // The empty/zero-pressure population: with no maxNodes argument the same hub must come
      // back whole, or every assertion above would be measuring an artificial squeeze rather
      // than the shipped behaviour.
      const resp = await viaTool('recall_thread', { anchor: id8(hub), altitude: 'headline', depth: 1 });
      expect(resp.structuredContent.truncated).toBe(false);
      expect(resp.structuredContent.maxNodesUsed).toBe(THREAD_CONFIG.maxNodes);
      expect(resp.structuredContent.nodes.length).toBe(HUB_NEIGHBOURS + 1);
    });
  });
});
