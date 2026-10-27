/**
 * recall_thread — THE HONEST PARTIAL (spec an earlier context section (c)).
 *
 * THE DEFECT THIS SUITE EXISTS TO END. A walk subtracts nodes THREE separate ways — the
 * `maxNodes` cap, the `minTrust` floor, and dangling referents — and only the cap was ever
 * reported. Measured on prod before this change: `maxNodes:25, minTrust:'ok'` returned 14
 * nodes while reporting `truncatedCount:25` (a CAP number), so ELEVEN nodes vanished with no
 * line in either channel. The header's "N node(s)" silently conflated two different
 * subtractions, and a reader had no way to tell a short thread from a filtered one.
 *
 * WHAT IS ASSERTED HERE, all through the REAL tool path (validate → routeExecutor, the exact
 * path the HTTP bridge uses):
 *   - the prose states the trust-floor drop count, and RECONCILES: listed + trust-floor +
 *     dangling = examined. The reconciliation is the load-bearing part — a bare count cannot
 *     be checked by its reader, and a wrong count would still read as authoritative.
 *   - THE ZERO CASE prints too. "Omitted: 0" must be a MEASURED answer, so that a missing
 *     line can never masquerade as "nothing was omitted".
 *   - a clipped snippet carries an ACTIONABLE affordance naming the `altitude` ARGUMENT
 *     (never an env var — a customer running Mandrel in a container cannot set one), and the
 *     clipped-body count is reported.
 *   - the `maxNodesCeiling` clamp is stated in the PROSE, not only in structuredContent: a
 *     caller asking for 900 and getting 500 could previously only learn that by comparing an
 *     argument they sent against a structured field.
 *
 * Embedding service mocked → deterministic + offline (mirrors recallThread.contract).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
import { THREAD_CONFIG, formatClipAffordance } from '../config/threadConfig.js';
import { recallRoutes } from '../routes/recall.routes.js';

const STAMP = Date.now();
const CONN = `recall-omissions-conn-${STAMP}`;
const PROJ_NAME = `recall-omissions-P-${STAMP}`;

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function storeContext(content: string, tags?: string[]): Promise<string> {
  const r = await viaTool('context_store', { content, type: 'planning', tags });
  return r.structuredContent.context.id;
}
async function recordDecision(title: string, outcomeStatus?: string): Promise<string> {
  const r = await viaTool('decision_record', {
    decisionType: 'architecture',
    title,
    description: 'd',
    rationale: 'r',
    impactLevel: 'medium',
    ...(outcomeStatus ? { outcomeStatus } : {}),
  });
  return r.structuredContent.decision.id;
}
async function link(from: string, fromType: string, to: string, toType: string, edgeType: string) {
  return viaTool('link', { from, fromType, to, toType, edgeType });
}

/**
 * Parse the `accounted:` reconciliation OUT OF THE PROSE — deliberately, not off the
 * structured object. The prose is the channel the defect lived in, and a structured-only
 * assertion would pass on a response whose text still lied.
 */
function parseAccounted(text: string): {
  listed: number;
  minTrust: number;
  dangling: number;
  examined: number;
} {
  const m = text.match(
    /accounted: (\d+) listed \+ (\d+) below trust floor \+ (\d+) dangling = (\d+) examined/
  );
  if (!m) throw new Error(`no accounted: line in the prose channel:\n${text}`);
  return {
    listed: Number(m[1]),
    minTrust: Number(m[2]),
    dangling: Number(m[3]),
    examined: Number(m[4]),
  };
}

describe('recall_thread — the honest partial: what the walk dropped, stated in the prose', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'recall_thread omissions') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });

  // RUNS UNPOSITIONED, restored per case — auto-open would otherwise leave
  // this connection standing on a branch and every later write would pick up a positional
  // membership edge, changing the very node counts this suite reconciles.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* best-effort cleanup */
    }
  });

  // ── THE HEADLINE CASE: nodes dropped by the trust floor are COUNTED and RECONCILED ──
  test('GIVEN nodes below the minTrust floor: the prose states the count AND reconciles to the examined population', async () => {
    // Three abstaining nodes (each fed by a FAILED decision → band below 'ok') hung off one
    // anchor. The floor drops all three; the anchor is never dropped.
    const failDec = await recordDecision(`omissions failed decision ${STAMP}`, 'failed');
    const anchor = await storeContext('the omissions anchor');
    const low: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await storeContext(`low-trust node ${i}`, [`decision:${id8(failDec)}`]);
      await link(anchor, 'context', n, 'context', 'caused');
      low.push(n);
    }

    const resp = await viaTool('recall_thread', {
      anchor: id8(anchor),
      altitude: 'headline',
      depth: 2,
      minTrust: 'ok',
    });
    const text = responseText(resp);
    const sc = resp.structuredContent;
    const ids = sc.nodes.map((n: any) => n.id);

    // Precondition of the case: the floor really did drop nodes (otherwise the assertions
    // below would be vacuously satisfiable by a walk that dropped nothing).
    // SOFT so that a failing precondition does not ABORT the case before the reconciliation
    // below is evaluated — the reconciliation is the assertion this suite exists for, and a
    // probe that only ever trips the precondition would leave it unproven.
    expect.soft(ids).toContain(anchor);
    for (const n of low) expect.soft(ids).not.toContain(n);
    expect.soft(sc.omissions.droppedByMinTrust).toBeGreaterThan(0);

    // THE PROSE says it — with the count, and naming the ARGUMENT that would include them.
    expect.soft(text).toContain(`Omitted: ${sc.omissions.droppedByMinTrust} below the minTrust floor`);
    expect.soft(text).toContain('re-call with a lower minTrust');

    // THE RECONCILIATION — this is what makes the header's node count checkable.
    const acc = parseAccounted(text);
    expect(acc.listed).toBe(sc.nodes.length);
    expect(acc.minTrust).toBe(sc.omissions.droppedByMinTrust);
    expect(acc.listed + acc.minTrust + acc.dangling).toBe(acc.examined);
    expect(acc.examined).toBe(sc.omissions.examined);
  });

  // ── THE ZERO CASE: "none" must be MEASURED, never an absent line ────────────────────
  test('GIVEN a subgraph where nothing is dropped: the prose still prints "Omitted: 0" and reconciles', async () => {
    const a = await storeContext('zero-omission anchor');
    const b = await storeContext('zero-omission neighbour');
    await link(a, 'context', b, 'context', 'caused');

    const resp = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', depth: 2 });
    const text = responseText(resp);
    const sc = resp.structuredContent;

    expect(sc.omissions.droppedByMinTrust).toBe(0);
    expect(sc.omissions.droppedDangling).toBe(0);
    // The line is PRESENT at zero — the whole point: no line can never mean nothing omitted.
    expect(text).toContain('Omitted: 0 below the minTrust floor');
    expect(text).toContain('0 dangling referent(s)');
    // ...and it does NOT offer an affordance for an omission that did not happen.
    expect(text).not.toContain('re-call with a lower minTrust');

    const acc = parseAccounted(text);
    expect(acc.listed).toBe(sc.nodes.length);
    expect(acc.listed + acc.minTrust + acc.dangling).toBe(acc.examined);
  });

  // ── THE SECOND CLIPPER, MADE HONEST ─────────────────────────────────────────────────
  test('GIVEN a body over the snippet budget: the snippet carries an actionable affordance and the clip is counted', async () => {
    const long = 'L'.repeat(THREAD_CONFIG.summarySnippetMaxlen * 4);
    const anchor = await storeContext(`clip anchor ${STAMP}`);
    const big = await storeContext(long);
    await link(anchor, 'context', big, 'context', 'caused');

    const resp = await viaTool('recall_thread', { anchor: id8(anchor), altitude: 'summary', depth: 2 });
    const text = responseText(resp);
    const sc = resp.structuredContent;
    const node = sc.nodes.find((n: any) => n.id === big);

    expect(sc.omissions.clippedNodes).toBeGreaterThan(0);
    // The affordance is the CONFIG's, derived here from the same source the product reads —
    // never a literal re-spelled in the test.
    const omitted = long.length - THREAD_CONFIG.summarySnippetMaxlen;
    const affordance = formatClipAffordance(THREAD_CONFIG.summaryClipAffordance, omitted);
    expect(node.content.endsWith(affordance)).toBe(true);
    // It names the ARGUMENT (altitude), and it says HOW MUCH was dropped — the two things a
    // bare '…' could not say. It must NOT name an env var (unusable in a customer container).
    expect(node.content).toContain('altitude');
    expect(node.content).toContain(String(omitted));
    expect(node.content).not.toContain('MANDREL_');
    // The prose channel carries the same affordance (the snippet rides in the story) and the
    // omission line reports the clipped-body count.
    expect(text).toContain(affordance);
    expect(text).toContain(`${sc.omissions.clippedNodes} body(ies) clipped`);
  });

  // ── THE CEILING CLAMP ───────────────────────────────────────────────────────────────
  //
  // ⚠️ THE SPEC'S PREMISE IS REFUTED AT THE TOOL SURFACE, and this pair of cases is where
  // that is written down: "ask for 900, get 500, never told" CANNOT happen through
  // recall_thread. validation.ts derives the `maxNodes` bound from THREAD_CONFIG, so an
  // over-ceiling request is a LOUD actionable rejection, not a silent clamp. The clamp is
  // still reachable by an IN-PROCESS caller (the route/service called with a config-derived
  // number rather than a wire argument), which is the path the prose line serves — so it is
  // exercised there, at the surface where it can actually fire.
  test('the TOOL SURFACE rejects an over-ceiling maxNodes outright (a loud error, not a silent clamp)', async () => {
    const a = await storeContext('ceiling rejection anchor');
    const asked = THREAD_CONFIG.maxNodesCeiling + 400;
    await expect(
      viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', maxNodes: asked })
    ).rejects.toThrow(/maxNodes/);
  });

  test('GIVEN an in-process caller over the ceiling: the PROSE states what was asked for and what was applied', async () => {
    const a = await storeContext('ceiling clamp anchor');
    const b = await storeContext('ceiling clamp neighbour');
    await link(a, 'context', b, 'context', 'caused');

    // The route, called the way an in-process caller reaches it (no wire validation) — the
    // only path on which the clamp can fire. Numbers derive from the config the product
    // reads; a hardcoded 900/500 would stop testing the clamp the moment it were tuned.
    const asked = THREAD_CONFIG.maxNodesCeiling + 400;
    const resp = await recallRoutes.handleRecallThread(
      { anchor: id8(a), altitude: 'headline', maxNodes: asked },
      { connectionId: CONN }
    );
    const text = responseText(resp);
    const sc: any = resp.structuredContent;

    expect(sc.maxNodesRequested).toBe(asked);
    expect(sc.maxNodesUsed).toBe(THREAD_CONFIG.maxNodesCeiling);
    expect(text).toContain(
      `Requested maxNodes: ${asked} — CAPPED to ${THREAD_CONFIG.maxNodesCeiling}`
    );
  });

  test('GIVEN maxNodes within the ceiling: no clamp line is printed (it did not happen)', async () => {
    const a = await storeContext('no-clamp anchor');
    const resp = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', maxNodes: 5 });
    const text = responseText(resp);
    expect(resp.structuredContent.maxNodesRequested).toBe(5);
    expect(resp.structuredContent.maxNodesUsed).toBe(5);
    expect(text).not.toContain('CAPPED to');
  });

  // ── THE PROJECTION ALTITUDE CARRIES THE SAME GATHER ACCOUNTING ──────────────────────
  test("GIVEN altitude:'current': the gather's own drops are reported separately from the projection's", async () => {
    const failDec = await recordDecision(`current omissions failed decision ${STAMP}`, 'failed');
    const anchor = await storeContext('current-state omissions anchor');
    const lowNode = await storeContext('current-state low-trust node', [`decision:${id8(failDec)}`]);
    await link(anchor, 'context', lowNode, 'context', 'caused');

    const resp = await viaTool('recall_thread', {
      anchor: id8(anchor),
      altitude: 'current',
      depth: 2,
      minTrust: 'ok',
    });
    const text = responseText(resp);
    const sc = resp.structuredContent;

    expect(sc.omissions.droppedByMinTrust).toBeGreaterThan(0);
    expect(text).toContain(
      `Gather omitted (before this projection ran): ${sc.omissions.droppedByMinTrust} below the minTrust floor`
    );
    // The projection's OWN omission block still stands, unchanged — two subtractions, two
    // numbers, neither standing in for the other.
    expect(text).toContain('Omitted: ');
    expect(text).toContain('accounted: ');
  });
});
