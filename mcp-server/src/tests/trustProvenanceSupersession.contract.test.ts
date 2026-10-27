/**
 * TRUST — PROVENANCE-WEIGHTED supersession (belief BL-4).
 *
 * BL-4 turns the supersession CONSEQUENCE from "any inbound `supersedes` edge is a HARD cap"
 * into a provenance-weighted decision:
 *   - DECLARED (human / the `link` tool / write-time / decision.superseded_by) → HARD cap:
 *     band=superseded, abstain=true, regardless of score (UNCHANGED behavior).
 *   - SOFT (an AUTO `supersedes` edge stamped created_by='auto:belief-adjudicator', OR any
 *     `possibly_supersedes` edge) → DEMOTE: softSuperseded=true, abstain=false, the record's
 *     score (and therefore band) is lowered, and it is STILL RETURNED (never dropped). NOT a
 *     re-ordering: no read path sorts by trust, and the assertions below are
 *     on the score and the band because those are what the demotion actually moves.
 *   - Declared WINS if both are present on one record.
 *
 * This is the SUPERSESSION of the old BL-3 "possibly_supersedes is recall-inert" guarantee:
 * the soft edge is now READ (as a demote, never an abstain) — the whole point of BL-4.
 *
 * Driven end-to-end through the real HTTP-bridge path (validate → routeExecutor), embeddings
 * mocked for determinism. Rides the CI-migrated Postgres. The AUTO edge is inserted directly
 * with the belief-adjudicator provenance label (exactly the row the reconciler mints) — the
 * `link` tool stamps created_by='link' (declared), so it cannot be used to forge an auto edge.
 *
 * UPDATED BY an earlier change: an inferred supersession can no longer occupy the `supersedes`
 * channel at all (migration 087's links_supersedes_declared_only), so every AUTO fixture here
 * is a `possibly_supersedes` row. The DECLARED fixtures — the `link` tool, a NULL created_by,
 * `auto:decision_backfill` — are unchanged and still ride `supersedes`, which is the whole
 * point of the constraint: the hard channel still works, for declared acts only.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `trust-prov-conn-${STAMP}`;
const PROJ_NAME = `trust-prov-P-${STAMP}`;

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Store a context and return its id. */
async function storeContext(content: string): Promise<string> {
  const resp = await viaTool('context_store', { content, type: 'discussion' });
  return resp.structuredContent.context.id;
}

/** Recall a context by its unique marker content; assert it is RETURNED; return its trust.
 *  A generous limit so the target is never pushed out of the top-N by unrelated contexts
 *  created by sibling tests (embeddings are mocked → similarity is uniform, so ranking falls
 *  back to recency; without a high limit an older target can drop below the default cap). */
async function trustOf(marker: string, id: string): Promise<any> {
  const search = await viaTool('context_search', { query: marker, limit: 100 });
  const row = search.structuredContent.results.find((r: any) => r.id === id);
  expect(row, `the context "${marker}" is STILL RETURNED in the results`).toBeTruthy();
  // THE WIRE, asserted here once so every case below covers it: band + score and NOTHING
  // else. The exact key set, not a subset — a re-grown trust blob must
  // fail rather than slip past an allow-list.
  expect(Object.keys(row.trust).sort()).toEqual(['band', 'score']);
  // THE VERDICT the cases below reason about — supersession tiers, receipts, abstain — is
  // the trust MATH, and the math is unchanged by P3. It is read from the service, which is
  // where it lives, instead of from however much of it a search row happens to carry. The
  // wire's `band` is cross-checked against it so the two cannot silently disagree.
  const full = await trustForRecord({ id, type: 'context' });
  expect(row.trust.band, 'the wire band matches the computed verdict').toBe(full.band);
  return full;
}

/** Insert an inbound edge (newer --edgeType--> older) with an explicit created_by provenance
 *  and (BL-5) optional edge metadata (confidence / reason[] / rationale) — the row the belief
 *  reconciler mints. */
async function insertEdge(
  fromId: string,
  toId: string,
  edgeType: string,
  createdBy: string | null,
  metadata: Record<string, unknown> = {}
) {
  // SK4: mint_via is NOT NULL. The fixture derives it from the stamp it is
  // simulating so the row is shaped like the real one — a belief-reconciler edge carries
  // 'belief-adjudication'; every other stamp here stands in for a hand-made `link` call.
  // trust.ts deliberately keys on created_by EXACT equality (the BL-4 lock), not on
  // provenance_class, so this column does not change what these tests measure.
  const mintVia =
    createdBy === BELIEF_EDGE_CREATED_BY ? EDGE_MINT_VIA.beliefAdjudication : EDGE_MINT_VIA.linkTool;
  await db.query(
    `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, metadata)
     VALUES ($1, 'context', $2, 'context', $3, $4, $5, $6, $7::jsonb)`,
    [fromId, toId, edgeType, projectId, createdBy, mintVia, JSON.stringify(metadata)]
  );
}

describe('trust — provenance-weighted supersession (BL-4)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'trust provenance supersession contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
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

  // ── DELETED BY an earlier change: 'an AUTO supersedes edge SOFT-supersedes' ───────────────────
  // That test inserted `supersedes` + created_by='auto:belief-adjudicator' and asserted trust
  // demoted rather than abstained. Migration 087 makes that row UNWRITABLE (a `supersedes`
  // edge must classify 'declared'), so the test now fails on a constraint violation instead
  // of an assertion — it asserts about a state that cannot exist.
  //
  // COVERAGE MOVED, NOT DROPPED, in two directions:
  //   * that the row is REJECTED is asserted in supersedesDeclaredOnly.contract.test.ts,
  //     with the mutation probe;
  //   * that an inferred supersession DEMOTES rather than abstains is asserted by the
  //     `possibly_supersedes` test immediately below — which is now the only channel an
  //     inferred supersession can arrive on.
  //
  // COVERAGE GENUINELY LOST: trust.ts classifies an edge as soft when
  // `edge_type='possibly_supersedes' OR created_by=BELIEF_EDGE_CREATED_BY`. The second
  // disjunct no longer has reachable data, so it is untested here by construction. It is
  // deliberately NOT deleted from trust.ts in this task — it is the safety net if 087 is
  // rolled back — but it is now dead-by-constraint and worth a follow-up.

  // ── SOFT: a `possibly_supersedes` edge (always auto) → demote, not abstain ────────────
  test('a possibly_supersedes edge SOFT-supersedes: softSuperseded, not abstained, still returned (was inert pre-BL-4)', async () => {
    const OLD = `possibly older record ${STAMP}`;
    const NEW = `possibly newer record ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);

    // Minted via the `link` tool — a possibly_supersedes edge is ALWAYS soft regardless of who
    // created it (BL-3 is auto-only; the edge TYPE itself is the soft signal).
    const linkResp = await viaTool('link', {
      from: id8(newId), fromType: 'context',
      to: id8(oldId), toType: 'context',
      edgeType: 'possibly_supersedes',
    });
    expect(linkResp.isError).not.toBe(true);

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(false);
    expect(trust.softSuperseded).toBe(true);
    expect(trust.abstain).toBe(false);
  });

  // ── DECLARED: a `link`-tool (non-auto) supersedes edge → HARD cap (unchanged) ─────────
  test('a DECLARED supersedes edge (link tool, non-auto provenance) HARD-supersedes: band superseded + abstain', async () => {
    const OLD = `declared older record ${STAMP}`;
    const NEW = `declared newer record ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);

    // The `link` tool stamps created_by='link' → NOT the belief adjudicator → DECLARED → hard.
    const linkResp = await viaTool('link', {
      from: id8(newId), fromType: 'context',
      to: id8(oldId), toType: 'context',
      edgeType: 'supersedes',
    });
    expect(linkResp.isError).not.toBe(true);

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(true); // HARD cap
    expect(trust.softSuperseded).toBe(false);
    expect(trust.band).toBe('superseded');
    expect(trust.abstain).toBe(true);
  });

  // ── PRECEDENCE: BOTH a declared AND an auto/soft edge on one record → HARD wins ────────
  test('BOTH declared (link) + auto (belief) supersedes on ONE record → DECLARED wins (hard superseded/abstain)', async () => {
    const OLD = `both older record ${STAMP}`;
    const NEW_DECL = `both declaring record ${STAMP}`;
    const NEW_AUTO = `both auto record ${STAMP}`;
    const oldId = await storeContext(OLD);
    const declId = await storeContext(NEW_DECL);
    const autoId = await storeContext(NEW_AUTO);

    // A DECLARED (link) `supersedes` AND an AUTO (belief) `possibly_supersedes` both point at
    // the old record. Post-<id> this IS the both-tiers-present shape: an inferred
    // supersession cannot occupy the hard channel, so the soft channel is where it lands.
    const linkResp = await viaTool('link', {
      from: id8(declId), fromType: 'context',
      to: id8(oldId), toType: 'context',
      edgeType: 'supersedes',
    });
    expect(linkResp.isError).not.toBe(true);
    await insertEdge(autoId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY);

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(true); // declared wins → hard
    expect(trust.softSuperseded).toBe(false); // suppressed by the declared cap
    expect(trust.band).toBe('superseded');
    expect(trust.abstain).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BL-5 — the SUPERSESSION RECEIPT ("show receipts"): WHO superseded + WHY.
  // Nested here to SHARE the beforeAll/afterAll (project + pool lifecycle) above.
  // ───────────────────────────────────────────────────────────────────────────
  describe('supersession RECEIPT (BL-5)', () => {
  test('HARD (declared) supersession → receipt { supersededBy = the superseding id, tier: "declared" }', async () => {
    const OLD = `receipt-hard older ${STAMP}`;
    const NEW = `receipt-hard newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);

    // A DECLARED supersedes edge via the `link` tool (created_by='link' → hard).
    const linkResp = await viaTool('link', {
      from: id8(newId), fromType: 'context',
      to: id8(oldId), toType: 'context',
      edgeType: 'supersedes',
    });
    expect(linkResp.isError).not.toBe(true);

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(true);
    expect(trust.supersession).toBeTruthy();
    expect(trust.supersession.supersededBy).toBe(newId); // WHO did it
    expect(trust.supersession.tier).toBe('declared');
    // a declared link-tool edge carries no adjudicator metadata → confidence/reason null.
    expect(trust.supersession.confidence).toBeNull();
    expect(trust.supersession.reason).toBeNull();
  });

  test('SOFT (auto) supersession → receipt { tier: "soft", confidence + reason from edge metadata }', async () => {
    const OLD = `receipt-soft older ${STAMP}`;
    const NEW = `receipt-soft newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);

    // The exact row the reconciler mints for a SOFT tier: auto provenance + confidence +
    // reason[] + rationale in metadata.
    await insertEdge(newId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, {
      confidence: 0.85,
      reason: ['below_confidence', 'below_cosine'],
      rationale: 'newer restates the same subject with a firmer decision',
    });

    const trust = await trustOf(OLD, oldId);
    expect(trust.softSuperseded).toBe(true);
    expect(trust.superseded).toBe(false);
    expect(trust.supersession).toBeTruthy();
    expect(trust.supersession.supersededBy).toBe(newId);
    expect(trust.supersession.tier).toBe('soft');
    expect(trust.supersession.confidence).toBe(0.85);
    // reason = the adjudicator rationale (preferred over the joined reason[]).
    expect(trust.supersession.reason).toBe(
      'newer restates the same subject with a firmer decision'
    );
  });

  test('SOFT with only reason[] (no rationale) → receipt.reason = the joined reason[]', async () => {
    const OLD = `receipt-soft-joined older ${STAMP}`;
    const NEW = `receipt-soft-joined newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);
    await insertEdge(newId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, {
      confidence: 0.6,
      reason: ['below_confidence', 'below_cosine'],
    });

    const trust = await trustOf(OLD, oldId);
    expect(trust.supersession.tier).toBe('soft');
    expect(trust.supersession.reason).toBe('below_confidence, below_cosine');
  });

  test('SOFT with MULTIPLE auto edges → receipt picks the HIGHEST-confidence one', async () => {
    const OLD = `receipt-soft-multi older ${STAMP}`;
    const LOW = `receipt-soft-multi low ${STAMP}`;
    const HIGH = `receipt-soft-multi high ${STAMP}`;
    const oldId = await storeContext(OLD);
    const lowId = await storeContext(LOW);
    const highId = await storeContext(HIGH);
    await insertEdge(lowId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, { confidence: 0.4 });
    await insertEdge(highId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, { confidence: 0.9 });

    const trust = await trustOf(OLD, oldId);
    expect(trust.supersession.tier).toBe('soft');
    expect(trust.supersession.confidence).toBe(0.9);
    expect(trust.supersession.supersededBy).toBe(highId); // the deciding (highest-conf) edge
  });

  test('NOT superseded → receipt is null (empty)', async () => {
    const CLEAN = `receipt-none clean ${STAMP}`;
    const cleanId = await storeContext(CLEAN);
    const trust = await trustOf(CLEAN, cleanId);
    expect(trust.superseded).toBe(false);
    expect(trust.softSuperseded).toBe(false);
    expect(trust.supersession).toBeNull();
  });

  test('PRECEDENCE: declared + soft on one record → the DECLARED receipt is surfaced (tier declared)', async () => {
    const OLD = `receipt-precedence older ${STAMP}`;
    const DECL = `receipt-precedence declaring ${STAMP}`;
    const AUTO = `receipt-precedence auto ${STAMP}`;
    const oldId = await storeContext(OLD);
    const declId = await storeContext(DECL);
    const autoId = await storeContext(AUTO);

    const linkResp = await viaTool('link', {
      from: id8(declId), fromType: 'context',
      to: id8(oldId), toType: 'context',
      edgeType: 'supersedes',
    });
    expect(linkResp.isError).not.toBe(true);
    await insertEdge(autoId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, {
      confidence: 0.95,
    });

    const trust = await trustOf(OLD, oldId);
    expect(trust.supersession.tier).toBe('declared');
    expect(trust.supersession.supersededBy).toBe(declId); // the declared edge wins the receipt
  });

  // WHERE THE RECEIPT LIVES NOW (SEARCH P3): the TEXT
  // channel's trust signal, plus a by-id fetch. structuredContent used to carry the whole
  // receipt object on every row; it no longer does, and this test asserts BOTH halves of
  // that — the wire is band+score, and the receipt is still reachable and still correct.
  test('the receipt rides the TEXT signal and the service, and is OFF the wire', async () => {
    const OLD = `receipt-schema older ${STAMP}`;
    const NEW = `receipt-schema newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);
    await insertEdge(newId, oldId, 'possibly_supersedes', BELIEF_EDGE_CREATED_BY, {
      confidence: 0.7,
      rationale: 'firmer restatement',
    });

    const search = await viaTool('context_search', { query: OLD, limit: 100 });
    const row = search.structuredContent.results.find((r: any) => r.id === oldId);
    expect(row).toBeTruthy();
    // THE WIRE: band + score, and NOTHING else — the receipt object is gone from it.
    expect(Object.keys(row.trust).sort()).toEqual(['band', 'score']);
    // THE RECEIPT, still computed and still complete, read where it lives.
    const full = await trustForRecord({ id: oldId, type: 'context' });
    expect(full.supersession).toMatchObject({
      supersededBy: newId,
      tier: 'soft',
      confidence: 0.7,
      reason: 'firmer restatement',
    });
    // And the TEXT channel carries the receipt in the machine-lean signal (WS1 an earlier task):
    // the superseding id8 + tier ride every row's trust signal.
    const text = search.content?.map((c: any) => c.text).join('\n') ?? '';
    expect(text).toContain(`superseded_by:${id8(newId)} tier:soft`);
  });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BL-4 NIT (Reviewer, test-only): LOCK the EXACT-EQUALITY provenance contract.
  // created_by = NULL and created_by = 'auto:decision_...' must BOTH classify as DECLARED
  // (hard cap) — only the exact belief-adjudicator label is soft. Guards against a future
  // "starts-with auto:" refactor silently softening a human/foreign-auto supersedes edge.
  // ───────────────────────────────────────────────────────────────────────────
  describe('provenance is EXACT-equality (BL-4 lock)', () => {
  test('a supersedes edge with created_by = NULL classifies as DECLARED (hard cap)', async () => {
    const OLD = `exact-null older ${STAMP}`;
    const NEW = `exact-null newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);
    await insertEdge(newId, oldId, 'supersedes', null); // NULL created_by

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(true); // DECLARED → hard
    expect(trust.softSuperseded).toBe(false);
    expect(trust.band).toBe('superseded');
    expect(trust.abstain).toBe(true);
    expect(trust.supersession.tier).toBe('declared');
  });

  test("a supersedes edge with created_by = 'auto:decision_backfill' classifies as DECLARED (NOT soft)", async () => {
    const OLD = `exact-otherauto older ${STAMP}`;
    const NEW = `exact-otherauto newer ${STAMP}`;
    const oldId = await storeContext(OLD);
    const newId = await storeContext(NEW);
    // A DIFFERENT 'auto:...' label — NOT the belief adjudicator → must stay DECLARED. A
    // "starts-with auto:" refactor would wrongly soften this; exact equality keeps it hard.
    await insertEdge(newId, oldId, 'supersedes', 'auto:decision_backfill');

    const trust = await trustOf(OLD, oldId);
    expect(trust.superseded).toBe(true); // DECLARED → hard (exact label mismatch)
    expect(trust.softSuperseded).toBe(false);
    expect(trust.band).toBe('superseded');
    expect(trust.abstain).toBe(true);
    expect(trust.supersession.tier).toBe('declared');
  });
  });
});
