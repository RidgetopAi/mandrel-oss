/**
 * DROP-REASONS ON THE WIRE — end to end through the real tool path (P5.3 half A).
 *
 * The unit test next door (recallThreadDropReasons.unit.test.ts) proves the FIELD agrees with
 * the prose the shell parses. What it cannot prove is that the field SURVIVES the trip: that
 * `buildThread` attaches it, that the route's structured shaping does not strip it, and that
 * the population it covers is exactly the `Do NOT rely on …` list the text channel prints in
 * the SAME response.
 *
 * So this drives `recall_thread` through validate → routeExecutor — the exact path the HTTP
 * bridge uses — over a real declared supersession chain, and asserts BOTH channels of ONE
 * response against each other. If the two ever disagree about who was dropped, the shell we
 * are trying to delete would have been right to distrust the structured channel.
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
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const CONN = `recall-drop-conn-${STAMP}`;
const PROJ_NAME = `recall-drop-P-${STAMP}`;

let projectId: string;
let head: string, mid: string, tail: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

beforeAll(async () => {
  await viaTool('project_create', { name: PROJ_NAME, description: 'drop-reason wire contract' });
  await viaTool('project_switch', { project: PROJ_NAME });
  projectId = (await viaTool('project_current', {})).structuredContent.project.id;

  const store = async (content: string) =>
    (await viaTool('context_store', { content, type: 'planning' })).structuredContent.context.id;
  head = await store('HEAD — the live record');
  mid = await store('MID — replaced by HEAD');
  tail = await store('TAIL — replaced by MID');

  // A DECLARED supersession chain: head → mid → tail. `handoff-timeline` is the mint path
  // handoffSupersession.ts stamps, and migration 085/087 require a declared class here.
  for (const [newer, older] of [
    [head, mid],
    [mid, tail],
  ] as const) {
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, created_by, mint_via)
       VALUES ($1,'context',$2,'context','supersedes','auto:handoff-supersession',$3)`,
      [newer, older, EDGE_MINT_VIA.handoffTimeline]
    );
  }
}, 120_000);

afterAll(async () => {
  await db.query(`DELETE FROM links WHERE from_id = ANY($1) OR to_id = ANY($1)`, [[head, mid, tail]]);
  await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('nodes[].dropped on the wire', () => {
  test('the structured drop set is EXACTLY the do-not-rely list the prose prints', async () => {
    const resp = await viaTool('recall_thread', { anchor: head, depth: 3, altitude: 'headline' });
    const sc = resp.structuredContent;

    // The two channels, from ONE response.
    const proseLine = responseText(resp)
      .split('\n')
      .find((l: string) => l.startsWith('Do NOT rely on '));
    const proseIds = proseLine
      ? proseLine.slice(proseLine.indexOf('): ') + 3).split(', ').map((s: string) => s.trim())
      : [];
    const structuredIds = sc.nodes.filter((n: any) => n.dropped).map((n: any) => n.id);

    // A PROBE THAT READS A NULL FIELD FAILS CLOSED INTO A FALSE RED. Prove the population is
    // non-empty FIRST, so the set-equality below cannot pass by both sides being empty.
    expect(sc.abstain.length, 'the fixture must actually drop something').toBeGreaterThan(0);
    expect([...structuredIds].sort()).toEqual([...sc.abstain].sort());
    expect([...proseIds].sort()).toEqual([...sc.abstain].sort());
  });

  test('a declared-superseded node carries the WHY, with the FULL replacement id', async () => {
    const resp = await viaTool('recall_thread', { anchor: head, depth: 3, altitude: 'headline' });
    const midNode = resp.structuredContent.nodes.find((n: any) => n.id === mid);
    expect(midNode?.dropped).toMatchObject({
      reason: 'declared-superseded',
      supersededBy: head, // the FULL uuid — the text channel only ever carried its 8 hex chars
      tier: 'declared',
      conf: null,
      replacementInWalk: true,
    });
    // `head` is the live tip and is NOT dropped, so the reader is not being sent from one
    // untrusted record to another.
    expect(midNode.dropped.replacementAlsoDropped).toBe(false);
  });

  test('"the replacement is ALSO dropped — keep walking" is a FIELD, not an inference', async () => {
    const resp = await viaTool('recall_thread', { anchor: head, depth: 3, altitude: 'headline' });
    const tailNode = resp.structuredContent.nodes.find((n: any) => n.id === tail);
    expect(tailNode?.dropped).toMatchObject({
      reason: 'declared-superseded',
      supersededBy: mid,
      tier: 'declared',
      replacementAlsoDropped: true, // mid is itself on the do-not-rely list
      replacementInWalk: true,
    });
  });

  test('CONTROL — the live tip carries NO dropped field at all', async () => {
    // Absent, not `{}` and not a null-filled object: "this node was not de-emphasised" and
    // "it was de-emphasised for no reason" must not render identically.
    const resp = await viaTool('recall_thread', { anchor: head, depth: 3, altitude: 'headline' });
    const headNode = resp.structuredContent.nodes.find((n: any) => n.id === head);
    expect(headNode).toBeDefined();
    expect(headNode.trust.band).not.toBe('superseded');
    expect('dropped' in headNode).toBe(false);
  });

  test('the TEXT channel is unchanged — the drop reason adds a field, not a byte', async () => {
    // Coordinator's constraint: our shell parses the prose today and this is not a flag day. The
    // structured field must be additive. Asserted at the shape the shell anchors on.
    const text = responseText(await viaTool('recall_thread', { anchor: head, depth: 3, altitude: 'headline' }));
    for (const line of text.split('\n')) {
      if (/^\d+\. \[/.test(line)) {
        expect(line, 'a node line still carries the verdict tail the shell anchors on').toMatch(
          /^\d+\. \[.* — trust:[^ ]* score:/
        );
      }
    }
    expect(text).not.toContain('dropped:');
    expect(text).not.toContain('replacementAlsoDropped');
  });
});
