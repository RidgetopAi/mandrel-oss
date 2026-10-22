/**
 * recall_thread — integration + adversarial contract tests (Mandrel Core Redesign T3,
 * an earlier task). THE headline pull tool, driven end-to-end.
 *
 * Tests are armor (spec §6). The pure ordering/altitude/causal logic is covered by
 * recallThread.unit.test.ts; THIS suite drives the REAL tool through validate →
 * routeExecutor (the EXACT path the HTTP bridge uses) against the CI Postgres, building
 * the graph with the PUBLIC tools (context_store/decision_record auto-mint edges from
 * threading tags; the `link` tool mints arbitrary typed edges), and asserts:
 *   - ANCHOR RESOLUTION: ref:<slug>, id8, and full uuid all resolve to the right node,
 *   - BFS to depth, BOTH directions, dedupe,
 *   - CYCLE-SAFETY: a self/loop edge does NOT hang and returns a finite thread,
 *   - edgeTypes filter restricts the walk,
 *   - minTrust filter drops low-trust nodes (never the anchor),
 *   - altitude content levels (headline/summary/full) DIFFER correctly,
 *   - trust annotation present on every node + the abstain list is correct,
 *   - max-nodes truncation signal is honest (truncated:true + a count),
 *   - ADVERSARIAL: unresolvable anchor → actionable error (no crash); anchor with NO
 *     edges → just the anchor node (not an error); a deep cycle; a huge fan-out hits the cap.
 *   - NO server-side LLM is invoked.
 *
 * Embedding service mocked → deterministic + offline (mirrors trust.contract).
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
import { buildThread } from '../services/recallThread.js';
import { THREAD_CONFIG, type ThreadConfig } from '../config/threadConfig.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `recall-thread-conn-${STAMP}`;
const PROJ_NAME = `recall-thread-P-${STAMP}`;

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

describe('recall_thread (T3) — traverse + trust + narrate, one call', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'recall_thread contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
  });
  // THIS SUITE RUNS UNPOSITIONED — restored explicitly, not assumed.
  // Auto-open means a task_create / decision_record in any earlier case leaves this shared
  // connection standing on a branch, so every later write in the file would pick up a
  // positional membership edge and the suite would be measuring recall_thread traversal PLUS
  // positional membership. Each case here states its own precondition ("mints exactly
  // that edge", "an anchor with NO edges"), and this is what makes that precondition true
  // again rather than re-baselining every count around a second mechanism.
  // Auto-open's own behaviour is contracted in autoOpenPositions.contract.test.ts.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
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

  // ── ANCHOR RESOLUTION ───────────────────────────────────────────────────────
  test('anchor resolution: ref:<slug> resolves to the tagged context', async () => {
    const slug = `ref:rt-resume-${STAMP}`;
    const ctxId = await storeContext('the resume handoff context', [slug]);
    const resp = await viaTool('recall_thread', { anchor: slug, altitude: 'headline' });
    expect(resp.structuredContent.ok).toBe(true);
    expect(resp.structuredContent.anchor).toBe(ctxId);
    expect(resp.structuredContent.nodes[0].id).toBe(ctxId); // anchor pinned first
  });

  test('anchor resolution: id8 and full uuid both resolve to the same node', async () => {
    const ctxId = await storeContext('anchor by id context');
    const byId8 = await viaTool('recall_thread', { anchor: id8(ctxId), altitude: 'headline' });
    const byUuid = await viaTool('recall_thread', { anchor: ctxId, altitude: 'headline' });
    expect(byId8.structuredContent.anchor).toBe(ctxId);
    expect(byUuid.structuredContent.anchor).toBe(ctxId);
  });

  // ── BFS / BOTH-DIRECTION / DEDUPE ───────────────────────────────────────────
  test('BFS both directions to depth: pulls the connected story; reads top-to-bottom', async () => {
    // evidence(ctx) --learned_from--> decision --caused--> outcome(ctx)
    const ev = await storeContext('evidence context for the story');
    const dec = await recordDecision(`the central decision ${STAMP}`, 'successful');
    const out = await storeContext('the outcome context of the story');
    await link(dec, 'decision', ev, 'context', 'learned_from');
    await link(dec, 'decision', out, 'context', 'caused');

    // Anchor on the DECISION; depth 1 reaches both neighbors (one in, one out direction).
    const resp = await viaTool('recall_thread', { anchor: id8(dec), altitude: 'summary', depth: 1 });
    const ids = resp.structuredContent.nodes.map((n: any) => n.id);
    expect(ids).toContain(dec);
    expect(ids).toContain(ev);
    expect(ids).toContain(out);
    expect(resp.structuredContent.nodes[0].id).toBe(dec); // anchor first
    // causal order: evidence (precedes dec) ranks earlier than the outcome (dec caused it).
    expect(ids.indexOf(ev)).toBeLessThan(ids.indexOf(out));
    // No duplicate nodes.
    expect(new Set(ids).size).toBe(ids.length);
    // The text channel reads as a numbered story.
    expect(responseText(resp)).toMatch(/^Thread for/);
  });

  test('depth bounds the walk: depth 1 excludes a 2-hop node that depth 2 includes', async () => {
    const a = await storeContext('chain node A');
    const b = await storeContext('chain node B');
    const c = await storeContext('chain node C (two hops from A)');
    await link(a, 'context', b, 'context', 'caused');
    await link(b, 'context', c, 'context', 'caused');

    const d1 = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', depth: 1 });
    const d1ids = d1.structuredContent.nodes.map((n: any) => n.id);
    expect(d1ids).toContain(b);
    expect(d1ids).not.toContain(c); // 2 hops away — beyond depth 1

    const d2 = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', depth: 2 });
    const d2ids = d2.structuredContent.nodes.map((n: any) => n.id);
    expect(d2ids).toContain(c); // now reached
  });

  // ── edgeTypes FILTER ────────────────────────────────────────────────────────
  test('edgeTypes filter restricts the walk', async () => {
    const root = await storeContext('filter root context');
    const viaCaused = await storeContext('reached via caused');
    const viaLearned = await storeContext('reached via learned_from');
    await link(root, 'context', viaCaused, 'context', 'caused');
    await link(root, 'context', viaLearned, 'context', 'learned_from');

    const onlyCaused = await viaTool('recall_thread', {
      anchor: id8(root), altitude: 'headline', edgeTypes: ['caused'],
    });
    const ids = onlyCaused.structuredContent.nodes.map((n: any) => n.id);
    expect(ids).toContain(viaCaused);
    expect(ids).not.toContain(viaLearned); // filtered out
  });

  // ── ALTITUDE content levels ─────────────────────────────────────────────────
  test('altitude content levels (headline/summary/full) differ correctly', async () => {
    // NB: context_store trims content, so use an already-trimmed body for the exact-length
    // assertion below (a trailing space would be stripped → off-by-one).
    const longBody =
      ('A long-form context body. ' + 'lorem ipsum dolor sit amet '.repeat(40)).trim();
    const ctxId = await storeContext(longBody);

    const headline = await viaTool('recall_thread', { anchor: id8(ctxId), altitude: 'headline' });
    const summary = await viaTool('recall_thread', { anchor: id8(ctxId), altitude: 'summary' });
    const full = await viaTool('recall_thread', { anchor: id8(ctxId), altitude: 'full' });

    const hNode = headline.structuredContent.nodes[0];
    const sNode = summary.structuredContent.nodes[0];
    const fNode = full.structuredContent.nodes[0];

    expect(hNode.content).toBeUndefined(); // headline = 1-liner, no content
    expect(sNode.content).toBeTruthy();
    expect(fNode.content).toBeTruthy();
    expect(sNode.content.length).toBeLessThan(fNode.content.length); // summary clipped
    expect(fNode.content.length).toBe(longBody.length); // full = whole body
    expect(summary.structuredContent.altitude).toBe('summary');
  });

  test('altitude defaults to summary when omitted', async () => {
    const ctxId = await storeContext('default altitude probe');
    const resp = await viaTool('recall_thread', { anchor: id8(ctxId) });
    expect(resp.structuredContent.altitude).toBe('summary');
  });

  // ── TRUST annotation + ABSTAIN list ─────────────────────────────────────────
  test('every node carries a well-formed trust object; abstain list is correct', async () => {
    // A context tied to a FAILED decision → it abstains; a fresh lonely context → it does not.
    const failDec = await recordDecision(`a failed decision ${STAMP}`, 'failed');
    // Step off the branch that decision_record auto-opened. Without this
    // the `fresh` context below would also be a MEMBER of the failed decision's branch, so
    // it would abstain too — and the assertion that abstain is SELECTIVE (the whole point
    // of this case) would be measuring the fixture's session shape, not the trust rule.
    await viaTool('branch_close', {});
    const sinking = await storeContext('context tied to a failed decision', [`decision:${id8(failDec)}`]);
    const fresh = await storeContext('a fresh trustworthy context');
    await link(fresh, 'context', sinking, 'context', 'caused'); // thread them so both appear

    const resp = await viaTool('recall_thread', { anchor: id8(fresh), altitude: 'headline', depth: 2 });
    const nodes = resp.structuredContent.nodes;
    for (const n of nodes) {
      expect(n.trust).toBeTruthy();
      expect(['trusted', 'ok', 'unproven', 'stale', 'superseded', 'contradicted']).toContain(n.trust.band);
      // WIRE SHAPE: band + score, and nothing else. Asserted as an exact
      // key set so a re-grown trust blob fails here rather than passing an allow-list.
      expect(Object.keys(n.trust).sort()).toEqual(['band', 'score']);
    }
    // The abstain VERDICT is no longer a per-node wire field — it is the thread-level abstain
    // LIST, which is the surface a caller actually acts on, and it is asserted right below.
    // The per-record flag is read from the service, where the rule lives.
    const sinkTrust = await trustForRecord({ id: sinking, type: 'context' });
    expect(sinkTrust.abstain).toBe(true); // failed downstream → abstain
    expect(resp.structuredContent.abstain).toContain(sinking);
    expect(resp.structuredContent.abstain).not.toContain(fresh);
  });

  // ── BL-4: a SOFT-superseded node is DEMOTED but NOT abstained and NOT dropped ──────
  test('a SOFT-superseded node is NOT in the abstain list and is NOT dropped by minTrust (score demoted, still shown)', async () => {
    // The soft node has a SUCCESSFUL downstream outcome (so its base score is high) AND an
    // inbound possibly_supersedes edge (soft). Post-demotion it lands at band 'ok' / score
    // ~0.5 — demoted below its would-be 'trusted', but still visible and non-abstaining.
    const goodDec = await recordDecision(`soft-node successful decision ${STAMP}`, 'successful');
    const softNode = await storeContext('the softly-superseded node', [`decision:${id8(goodDec)}`]);
    const anchor = await storeContext('the soft-supersession anchor');
    const newer = await storeContext('a newer record that possibly supersedes the soft node');
    await link(anchor, 'context', softNode, 'context', 'caused'); // thread the anchor to it
    // SOFT edge: newer --possibly_supersedes--> softNode (always soft).
    await link(newer, 'context', softNode, 'context', 'possibly_supersedes');

    const resp = await viaTool('recall_thread', { anchor: id8(anchor), altitude: 'headline', depth: 3 });
    const nodes = resp.structuredContent.nodes;
    const soft = nodes.find((n: any) => n.id === softNode);
    expect(soft, 'the soft-superseded node is RETURNED (never dropped)').toBeTruthy();
    // The soft/hard/abstain flags left the wire with the rule they encode
    // did not. Read them from the service, and keep the wire assertion on what the wire says.
    const softTrust = await trustForRecord({ id: softNode, type: 'context' });
    expect(softTrust.softSuperseded).toBe(true); // flagged
    expect(softTrust.superseded).toBe(false); // NOT hard-superseded
    expect(softTrust.abstain).toBe(false); // NOT abstained
    // ...and therefore NOT on the abstain list.
    expect(resp.structuredContent.abstain).not.toContain(softNode);

    // minTrust: its demoted band ('ok') still clears an 'ok' floor → it is NOT dropped purely
    // for being soft (contrast: a HARD-superseded node's band='superseded' would be dropped).
    const floored = await viaTool('recall_thread', {
      anchor: id8(anchor), altitude: 'headline', depth: 3, minTrust: 'ok',
    });
    const flooredIds = floored.structuredContent.nodes.map((n: any) => n.id);
    expect(flooredIds).toContain(softNode);
  });

  // ── minTrust FILTER ─────────────────────────────────────────────────────────
  test('minTrust filter drops low-trust nodes but NEVER the anchor', async () => {
    const failDec = await recordDecision(`mintrust failed decision ${STAMP}`, 'failed');
    const lowTrust = await storeContext('a low-trust (abstaining) context', [`decision:${id8(failDec)}`]);
    const anchor = await storeContext('the mintrust anchor context');
    await link(anchor, 'context', lowTrust, 'context', 'caused');

    // Floor at 'ok' band → the failed/abstaining low-trust node is dropped; anchor stays.
    const resp = await viaTool('recall_thread', {
      anchor: id8(anchor), altitude: 'headline', depth: 2, minTrust: 'ok',
    });
    const ids = resp.structuredContent.nodes.map((n: any) => n.id);
    expect(ids).toContain(anchor); // anchor never dropped
    expect(ids).not.toContain(lowTrust); // below the floor → hidden
  });

  // ── CYCLE-SAFETY ────────────────────────────────────────────────────────────
  test('CYCLE-SAFE: a 2-node loop edge does not hang and returns a finite thread', async () => {
    const x = await storeContext('cycle node X');
    const y = await storeContext('cycle node Y');
    await link(x, 'context', y, 'context', 'caused');
    await link(y, 'context', x, 'context', 'caused'); // the loop back

    const resp = await viaTool('recall_thread', { anchor: id8(x), altitude: 'headline', depth: 5 });
    const ids = resp.structuredContent.nodes.map((n: any) => n.id);
    expect(ids).toContain(x);
    expect(ids).toContain(y);
    expect(new Set(ids).size).toBe(ids.length); // each node once despite the cycle
  });

  test('CYCLE-SAFE: a deeper 3-node cycle terminates with a finite thread', async () => {
    const a = await storeContext('deep cycle A');
    const b = await storeContext('deep cycle B');
    const c = await storeContext('deep cycle C');
    await link(a, 'context', b, 'context', 'caused');
    await link(b, 'context', c, 'context', 'caused');
    await link(c, 'context', a, 'context', 'caused');

    const resp = await viaTool('recall_thread', { anchor: id8(a), altitude: 'headline', depth: 6 });
    const ids = resp.structuredContent.nodes.map((n: any) => n.id);
    expect(ids.sort()).toEqual([a, b, c].sort());
  });

  // ── ADVERSARIAL ─────────────────────────────────────────────────────────────
  test('adversarial: unresolvable anchor → actionable error, not a crash', async () => {
    const resp = await viaTool('recall_thread', { anchor: 'ref:does-not-exist-anywhere' });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.ok).toBe(false);
    expect(responseText(resp)).toMatch(/recall_thread:/);
  });

  test('adversarial: a non-id, non-ref garbage anchor → actionable error', async () => {
    const resp = await viaTool('recall_thread', { anchor: 'not-a-valid-anchor-zzz' });
    expect(resp.isError).toBe(true);
    expect(responseText(resp)).toMatch(/not a ref|short id|UUID/i);
  });

  test('adversarial: an anchor with NO edges → just the anchor node (NOT an error)', async () => {
    const lonely = await storeContext('a lonely context with zero edges');
    const resp = await viaTool('recall_thread', { anchor: id8(lonely), altitude: 'summary' });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.ok).toBe(true);
    expect(resp.structuredContent.nodes.length).toBe(1);
    expect(resp.structuredContent.nodes[0].id).toBe(lonely);
    expect(resp.structuredContent.edges.length).toBe(0);
    expect(resp.structuredContent.truncated).toBe(false);
  });

  test('adversarial: a huge fan-out hits the node cap with an HONEST truncation signal', async () => {
    // A hub with many neighbors. The cap (THREAD_MAX_NODES) is config-driven; to make the
    // assertion deterministic without depending on a process-wide env (config is read once
    // at module load), inject a TINY maxNodes config straight into the engine. This drives
    // the SAME traverse() cap path the tool uses, just with a small ceiling.
    const hub = await storeContext('the fan-out hub');
    const neighborCount = 6;
    for (let i = 0; i < neighborCount; i++) {
      const n = await storeContext(`fan-out neighbor ${i}`);
      await link(hub, 'context', n, 'context', 'caused');
    }
    const tinyCap: ThreadConfig = { ...THREAD_CONFIG, maxNodes: 3 };
    const result = await buildThread(
      { anchor: id8(hub), altitude: 'headline', depth: 1, projectId },
      tinyCap
    );
    // hub + (cap-1) neighbors = 3 nodes; the rest are reported truncated, never silently cut.
    expect(result.nodes.length).toBeLessThanOrEqual(3);
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(result.nodes.some((n) => n.id === hub)).toBe(true); // anchor survives the cap
  });

  // ── FRONTIER PRIORITY under the cap ──────────────────────────
  test('the maxNodes cap RETAINS high-value "gold" nodes reachable only LATER in insertion order', async () => {
    // The robustness bug: BFS admitted neighbors in raw getLinks/insertion order (created_at
    // ASC), so when the cap bit it kept whatever was enqueued first and DROPPED high-value
    // nodes reached later. This asserts the FIX: with the cap tight enough that insertion
    // order would drop the gold, the prioritized walk keeps the structural gold instead.
    const anchor = await storeContext('priority-cap anchor');

    // WEAK neighbors minted FIRST → earliest created_at → FIRST in getLinks/insertion order.
    // 'related_to' is the lowest-priority edge ("a low-confidence association; NOT evidence").
    const weak: string[] = [];
    for (let i = 0; i < 4; i++) {
      const w = await storeContext(`weak related neighbor ${i}`);
      await link(anchor, 'context', w, 'context', 'related_to');
      weak.push(w);
    }
    // GOLD neighbors minted LATER → later insertion order → in the OLD code these were the
    // ones the cap dropped. Reached via a STRUCTURAL 'decided_by' edge (highest priority).
    const gold1 = await recordDecision(`gold decision A ${STAMP}`, 'successful');
    const gold2 = await recordDecision(`gold decision B ${STAMP}`, 'successful');
    await link(anchor, 'context', gold1, 'decision', 'decided_by');
    await link(anchor, 'context', gold2, 'decision', 'decided_by');

    // Cap = anchor + 2. Insertion order would admit weak[0], weak[1] and DROP BOTH gold nodes.
    const tinyCap: ThreadConfig = { ...THREAD_CONFIG, maxNodes: 3 };
    const result = await buildThread(
      { anchor: id8(anchor), altitude: 'headline', depth: 1, projectId },
      tinyCap
    );
    const ids = result.nodes.map((n) => n.id);

    expect(result.nodes.length).toBe(3); // anchor + exactly (cap - 1) survivors
    expect(ids).toContain(anchor); // anchor always survives the cap
    // THE FIX: the two structural gold nodes survive over the earlier-inserted weak neighbors.
    expect(ids).toContain(gold1);
    expect(ids).toContain(gold2);
    // ...and the weak (earlier-inserted, lower-value) neighbors are the ones dropped.
    expect(weak.every((w) => !ids.includes(w))).toBe(true);
    // The drop is HONEST, never silent.
    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
  });

  test('behavior-preserving: when the cap is NOT hit, ALL reachable neighbors are returned', async () => {
    // Same shape as above but a roomy cap — every neighbor fits, so the prioritization path is
    // a no-op and nothing is dropped (the fix only changes WHICH nodes survive when the cap bites).
    const anchor = await storeContext('no-cap anchor');
    const weak: string[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await storeContext(`uncapped weak neighbor ${i}`);
      await link(anchor, 'context', w, 'context', 'related_to');
      weak.push(w);
    }
    const gold = await recordDecision(`uncapped gold decision ${STAMP}`, 'successful');
    await link(anchor, 'context', gold, 'decision', 'decided_by');

    const roomyCap: ThreadConfig = { ...THREAD_CONFIG, maxNodes: 50 };
    const result = await buildThread(
      { anchor: id8(anchor), altitude: 'headline', depth: 1, projectId },
      roomyCap
    );
    const ids = result.nodes.map((n) => n.id);
    expect(result.truncated).toBe(false); // cap not hit
    expect(ids).toContain(anchor);
    expect(ids).toContain(gold);
    for (const w of weak) expect(ids).toContain(w); // every weak neighbor kept — nothing dropped
    expect(result.nodes.length).toBe(1 + weak.length + 1); // anchor + all neighbors
  });

  test('no server-side LLM: the engine + route source contain no LLM/API call', async () => {
    // Belt-and-braces with the grep proof in the report: assert at runtime that a thread
    // builds with NO network/LLM dependency available (the suite mocks embeddings only; if
    // recall_thread reached for an LLM it would need a key/client we never provide).
    const ctxId = await storeContext('llm-free probe context');
    const result = await buildThread(
      { anchor: id8(ctxId), altitude: 'summary', projectId },
      THREAD_CONFIG
    );
    expect(result.anchor).toBe(ctxId);
    expect(result.nodes.length).toBe(1);
  });
});
