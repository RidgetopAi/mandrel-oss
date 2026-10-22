/**
 * ONE VOLUME VOCABULARY — the class guard (SEARCH P3).
 *
 * THE BUG CLASS THIS EXISTS TO STOP: three names for one idea, and a fourth on the way.
 * `response_format: concise|detailed`, `altitude: headline|summary|full`, and
 * MANDREL_RECALL_STRUCTURED_MODE: full|lean all meant "give me less", on three surfaces, with
 * three vocabularies — while smart_search had no dial at all and returned whole bodies for
 * every row. Standardising once fixes today; a guard is what stops the fourth.
 *
 * ★ AND THE HALF THAT ACTUALLY COST THE TOKENS: two of those three dials moved ONLY the prose
 * channel while `structuredContent` stayed at full size — and structured is the LARGER half.
 * Measured on prod 2026-08-22, smart_search at limit 10: 1,119 prose tokens against 14,379
 * structured. A dial that leaves structuredContent full is not a dial, so this file asserts
 * the movement CHANNEL BY CHANNEL. Asserting only the prose would reproduce the exact defect.
 *
 * WHAT THIS FILE IS NOT. It does not re-test the projection arithmetic (that is
 * altitudeProjection's own unit coverage) and it does not test the trust math (unchanged by
 * P3). It asserts the four CROSS-TOOL invariants that only exist between tools, and which no
 * single tool's test can see:
 *   1. all four read tools accept `altitude` with the IDENTICAL enum, derived from ONE list;
 *   2. an off-axis value THROWS on every one of them — it is never defaulted;
 *   3. the dial moves BOTH channels, on all FOUR of BODY_RETURNING_READ_TOOLS, in bytes;
 *   4. trust on the LIST/RECALL surfaces is exactly {band, score} on every tool — while a
 *      DIRECT LOOKUP carries the complete verdict, and the two shapes cannot converge.
 *
 * Real DB, real routes, through validate → routeExecutor: the exact path the HTTP bridge
 * uses. Embedding stubbed for determinism (mirrors trust.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

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
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { ALTITUDES, RESPONSE_FORMAT_TO_ALTITUDE } from '../config/altitudeConfig.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';

const STAMP = Date.now();
const CONN = `altitude-conn-${STAMP}`;
const PROJ_NAME = `altitude-P-${STAMP}`;
const MARKER = `altitude vocabulary probe ${STAMP}`;
/** Reaches context_search's TAGS-ONLY branch — a third return site, neither by-id nor semantic. */
const ALT_TAG = `ref:altitude-probe-${STAMP}`;

/**
 * THE POPULATION, stated in the guard next to the enumeration (C3).
 *
 * These are every advertised READ tool that returns record BODIES — the whole set an earlier decision
 * governs, and the set the task scoped. It is deliberately NOT "every tool": a tool
 * that returns counts (task_progress_summary), a single computed answer (get_recommendations)
 * or a projection with its own shape has no body to zoom, and demanding `altitude` of them
 * would be a guard that blocks correct work. `recall_thread` is here too — it is the tool the
 * vocabulary was TAKEN from, and it must not drift away from what it donated.
 */
const BODY_RETURNING_READ_TOOLS = [
  'context_search',
  'context_get_recent',
  'smart_search',
  'recall_thread',
] as const;

/** The tools that shipped `response_format` and must keep accepting it as a DEPRECATED alias. */
const ALIAS_TOOLS = ['context_search', 'context_get_recent'] as const;

let projectId: string;
let ctxId: string;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** The two channels, separately — because the whole point is that they move together. */
function channels(resp: any): { prose: number; structured: number } {
  const prose = resp?.content?.map((c: any) => c.text ?? '').join('\n') ?? '';
  return {
    prose: Buffer.byteLength(prose, 'utf8'),
    structured: Buffer.byteLength(JSON.stringify(resp?.structuredContent ?? null), 'utf8'),
  };
}

/** Every trust object anywhere in a response payload, however deeply nested. */
function everyTrustObject(node: any, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const v of node) everyTrustObject(v, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'trust' && v && typeof v === 'object' && !Array.isArray(v)) acc.push(v);
    everyTrustObject(v, acc);
  }
  return acc;
}

/** A body long enough that `summary` must clip it and `full` must not. */
const BIG_BODY = `${MARKER} :: ` + 'y'.repeat(4000);

describe('ONE volume vocabulary — altitude, on every read tool, in both channels', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'altitude vocabulary contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    // Several rows so a list response is a LIST — a one-row list can hide a per-row defect.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await viaTool('context_store', {
        content: `${BIG_BODY} #${i}`,
        type: 'planning',
        tags: [ALT_TAG],
      });
      ids.push(r.structuredContent.context.id);
    }
    ctxId = ids[0];
    // THREAD them, so recall_thread has a real graph and a NON-EMPTY edge list to return.
    // Without edges the edge-preservation assertion below would pass on an empty array —
    // vacuously — which is the failure mode it exists to catch.
    await viaTool('link', {
      from: ids[0], fromType: 'context', to: ids[1], toType: 'context', edgeType: 'caused',
    });
    await viaTool('link', {
      from: ids[1], fromType: 'context', to: ids[2], toType: 'context', edgeType: 'caused',
    });
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ── 1. ONE ENUM, FOUR TOOLS ────────────────────────────────────────────────
  test('every body-returning read tool accepts `altitude` with the IDENTICAL enum', () => {
    // context_search's schema is wrapped in .refine(), so the object shape sits one level
    // down. Unwrap rather than special-case: a guard that only reads the UNwrapped shape
    // would silently skip the one tool with the most parameters.
    const shapeOf = (schema: any): Record<string, unknown> => {
      let z = schema;
      while (z && !z.shape && (z._def?.schema || z._def?.innerType)) {
        z = z._def.schema ?? z._def.innerType;
      }
      return z?.shape ?? {};
    };
    for (const tool of BODY_RETURNING_READ_TOOLS) {
      const shape = shapeOf((validationSchemas as any)[tool]);
      expect(Object.keys(shape).length, `${tool} has no zod shape`).toBeGreaterThan(0);
      expect(Object.keys(shape), `${tool} declares no altitude param`).toContain('altitude');
    }
    // The ADVERTISED enum, read off the real tool definitions the model sees. recall_thread
    // carries the three zoom values PLUS its own projection altitude `current` — a second
    // AXIS, not a fourth volume — so it is asserted as a superset rather than equality.
    for (const tool of BODY_RETURNING_READ_TOOLS) {
      const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === tool);
      expect(def, `${tool} is not advertised`).toBeTruthy();
      const advertised: string[] = (def!.inputSchema as any).properties.altitude.enum;
      for (const a of ALTITUDES) {
        expect(advertised, `${tool} does not advertise altitude "${a}"`).toContain(a);
      }
      if (tool !== 'recall_thread') {
        expect(advertised, `${tool} advertises an altitude off the shared axis`).toEqual([
          ...ALTITUDES,
        ]);
      }
    }
  });

  // ── 2. OFF-AXIS THROWS — never a silent default ───────────────
  test('an off-axis altitude is REJECTED on every tool, not defaulted', () => {
    for (const tool of BODY_RETURNING_READ_TOOLS) {
      const base: any =
        tool === 'recall_thread' ? { anchor: 'x'.repeat(8) } : { query: MARKER };
      expect(
        () => validateToolArguments(tool, { ...base, altitude: 'brief' }),
        `${tool} accepted an off-axis altitude — a caller who asked for "brief" and got ` +
          `"summary" was told nothing`
      ).toThrow();
    }
  });

  // ── 3. THE DIAL MOVES BOTH CHANNELS ────────────────────────────────────────
  test('headline < summary < full IN BOTH CHANNELS, on every body-returning read tool', async () => {
    const calls: Record<string, (a: string) => Promise<any>> = {
      context_search: (a) => viaTool('context_search', { query: MARKER, limit: 10, altitude: a }),
      context_get_recent: (a) => viaTool('context_get_recent', { limit: 10, altitude: a }),
      smart_search: (a) => viaTool('smart_search', { query: MARKER, limit: 10, altitude: a }),
      // recall_thread ADDED in round 2. Reviewer's Probe A rebuilt this
      // tool's structuredContent at full size while the prose obeyed the dial and this file
      // stayed 14/14 GREEN — the header claimed "every tool" while the loop covered three.
      // The gap was real, so it is CLOSED rather than the sentence narrowed: recall_thread is
      // the tool the whole vocabulary was taken from, and it is the one with the largest
      // structured channel (33,420 -> 20,998 o200k tokens at headline on a real anchor).
      recall_thread: (a) => viaTool('recall_thread', { anchor: ctxId, altitude: a }),
    };
    for (const [tool, call] of Object.entries(calls)) {
      const h = channels(await call('headline'));
      const s = channels(await call('summary'));
      const f = channels(await call('full'));
      // PROSE
      expect(h.prose, `${tool}: prose headline < summary`).toBeLessThan(s.prose);
      expect(s.prose, `${tool}: prose summary < full`).toBeLessThan(f.prose);
      // STRUCTURED — the half that used not to move, and the larger half.
      expect(
        h.structured,
        `${tool}: structuredContent did NOT shrink at headline. A dial that moves only the ` +
          `prose channel is not a dial — structured is the bigger half (measured on prod: ` +
          `1,119 prose vs 14,379 structured for smart_search at limit 10).`
      ).toBeLessThan(s.structured);
      expect(s.structured, `${tool}: structuredContent summary < full`).toBeLessThan(f.structured);
      // AND BY A MEANINGFUL AMOUNT, not by a byte. The mutation probe for this guard
      // (structuredContent carrying the raw body while the prose clipped) failed the strict
      // `<` above by ONE byte — because the echoed `altitude` string happens to differ in
      // length. A guard whose margin is incidental would pass a PARTIAL trim. This fixture
      // stores three ~4,000-char bodies into an otherwise-empty project, so bodies dominate
      // the payload by construction and a real headline must be a small fraction of full.
      expect(
        h.structured * 2,
        `${tool}: structuredContent barely moved between headline and full — bodies dominate ` +
          `this fixture, so a headline that is more than half of full has not dropped them`
      ).toBeLessThan(f.structured);
    }
  });

  test('at `headline` the body key is ABSENT, not empty', async () => {
    const cs = await viaTool('context_search', { query: MARKER, limit: 10, altitude: 'headline' });
    for (const row of cs.structuredContent.results) {
      expect(row, 'context row must carry NO content key at headline').not.toHaveProperty('content');
    }
    const ss = await viaTool('smart_search', { query: MARKER, limit: 10, altitude: 'headline' });
    for (const row of ss.structuredContent.results) {
      expect(row, 'smart_search row must carry NO summary key at headline').not.toHaveProperty(
        'summary'
      );
    }
  });

  /**
   * ★ THE DIAL ZOOMS BODIES — IT MUST NOT AMPUTATE THE GRAPH.
   *
   * ADDED when recallThreadStructuredTrim.contract.test.ts was deleted with the full|lean
   * mode it covered (SEARCH P3). Two of that file's properties were NOT about
   * lean at all and would otherwise have been orphaned: (a) the edge list survives intact —
   * it exists in NO other channel, since renderThreadText prints no edge, so losing it is a
   * silent amputation rather than a trim; (b) the `shape` discriminator names which of the
   * tool's two answer shapes came back. A measuring harness once read `nodes.length` on a
   * `current` response and reported "0 nodes for 16k chars"; the discriminator exists so that
   * mistake is unmakeable, and a discriminator nothing asserts is a comment.
   *
   * It also closes a hole in THIS file: every size assertion above would stay GREEN if a
   * future headline shrank structuredContent by dropping `edges` instead of dropping bodies.
   */
  test('recall_thread: the edge list and the node SET are altitude-INVARIANT', async () => {
    const at = async (a: string) =>
      (await viaTool('recall_thread', { anchor: ctxId, altitude: a })).structuredContent;
    const h = await at('headline');
    const s = await at('summary');
    const f = await at('full');

    // GUARD THE GUARD: with no edges, the equality below is vacuous.
    expect(f.edges.length, 'the fixture produced no edges — this assertion was vacuous')
      .toBeGreaterThan(0);
    expect(h.edges, 'headline dropped or altered edges — that is amputation, not a zoom')
      .toEqual(f.edges);
    expect(s.edges, 'summary dropped or altered edges').toEqual(f.edges);

    const idsOf = (sc: any) => sc.nodes.map((n: any) => n.id).sort();
    expect(f.nodes.length).toBeGreaterThan(1);
    expect(idsOf(h), 'headline returned a different node SET').toEqual(idsOf(f));
    expect(idsOf(s), 'summary returned a different node SET').toEqual(idsOf(f));
  });

  test('recall_thread: `shape` names which of the two answer shapes came back', async () => {
    for (const a of ALTITUDES) {
      const sc = (await viaTool('recall_thread', { anchor: ctxId, altitude: a })).structuredContent;
      expect(sc.shape, `altitude ${a} must be the story shape`).toBe('thread');
      expect(Array.isArray(sc.nodes)).toBe(true);
      expect(sc.currentState).toBeUndefined();
    }
    // The PROJECTION altitude is the other shape — a different read model on a second axis,
    // not a fourth volume. `nodes`/`edges` are ABSENT, not empty: the walk examined real
    // records, so `[]` would be a lie, and it is exactly the lie that once confirmed a
    // harness in its own misreading.
    const cur = (await viaTool('recall_thread', { anchor: ctxId, altitude: 'current' }))
      .structuredContent;
    expect(cur.shape).toBe('currentState');
    expect(cur.currentState).toBeDefined();
    expect('nodes' in cur).toBe(false);
    expect('edges' in cur).toBe(false);
  });

  /**
   * THE RESPONSE SAYS WHICH DIAL ANSWERED — on every tool, and it says the TRUE one.
   *
   * ADDED as a mid-task fold-in: smart_search and recall_thread echoed
   * `altitude`, context_search and context_get_recent did not. That gap is not cosmetic — a
   * caller holding a clipped record cannot tell a SHORT record from a CLIPPED one without
   * the echo, and the safe response to that ambiguity is to re-fetch. An absent echo
   * silently teaches agents to double-fetch, which is the exact cost this task exists to cut.
   *
   * IT ASSERTS EQUALITY WITH WHAT WAS ASKED, NOT MERE PRESENCE. `toBeDefined()` would pass
   * against a hardcoded `altitude: 'summary'` — an echo that is always the same string is
   * indistinguishable from no echo at all for the one question it exists to answer. Looping
   * the axis and demanding the round-trip is what makes it a measurement.
   */
  test('every read tool ECHOES the altitude that actually shaped the response', async () => {
    const perTool: Record<string, (a: string) => Promise<any>> = {
      context_search: (a) => viaTool('context_search', { query: MARKER, limit: 3, altitude: a }),
      context_get_recent: (a) => viaTool('context_get_recent', { limit: 3, altitude: a }),
      smart_search: (a) => viaTool('smart_search', { query: MARKER, limit: 3, altitude: a }),
      recall_thread: (a) => viaTool('recall_thread', { anchor: ctxId, altitude: a }),
    };
    for (const [tool, call] of Object.entries(perTool)) {
      for (const a of ALTITUDES) {
        const sc = (await call(a)).structuredContent;
        expect(
          sc.altitude,
          `${tool} did not echo the altitude that shaped this response (asked "${a}"). ` +
            `Without it a caller cannot tell a SHORT record from a CLIPPED one, and re-fetches.`
        ).toBe(a);
      }
    }
    // THE TAGS-ONLY BRANCH is a THIRD code path inside context_search (neither by-id nor
    // semantic) and has its own return site, so it gets its own assertion rather than being
    // assumed covered by the query branch above.
    const tagged = await viaTool('context_search', { tags: [ALT_TAG], altitude: 'headline' });
    expect(tagged.structuredContent.results.length).toBeGreaterThan(0);
    expect(tagged.structuredContent.altitude, 'the tags-only branch must echo too').toBe('headline');
  });

  test('the by-id echo reports the BY-ID default, not the list default', async () => {
    // The by-id path resolves its own default (`full`, because it is the explicit zoom
    // target). Echoing the LIST default here would be a lie about what shaped the response —
    // and a caller that trusted it would conclude a full record had been clipped.
    const sc = (await viaTool('context_search', { id: ctxId })).structuredContent;
    expect(sc.altitude).toBe('full');
    expect(sc.results[0].truncated).toBe(false);
    // …and an EXPLICIT altitude on a by-id call is honoured and reported as such.
    const head = (await viaTool('context_search', { id: ctxId, altitude: 'headline' }))
      .structuredContent;
    expect(head.altitude).toBe('headline');
    expect(head.results[0]).not.toHaveProperty('content');
  });

  test('a by-id fetch returns the FULL body regardless of the list default', async () => {
    const byId = await viaTool('context_search', { id: ctxId });
    const row = byId.structuredContent.results[0];
    expect(row.id).toBe(ctxId);
    expect(row.truncated).toBe(false);
    expect(row.content.length).toBeGreaterThan(4000);
    expect(row.content).not.toContain('[truncated;');
  });

  // ── 4. TRUST ON THE WIRE IS {band, score} ──────────────────────────────────
  test('every trust object on the LIST/RECALL surfaces carries exactly band + score', async () => {
    const responses = [
      await viaTool('context_search', { query: MARKER, limit: 5 }),
      await viaTool('context_get_recent', { limit: 5 }),
      await viaTool('smart_search', { query: MARKER, limit: 5 }),
      await viaTool('recall_thread', { anchor: ctxId, altitude: 'headline' }),
    ];
    let seen = 0;
    for (const resp of responses) {
      for (const t of everyTrustObject(resp.structuredContent)) {
        seen++;
        expect(Object.keys(t).sort(), `trust on the wire: ${JSON.stringify(t)}`).toEqual([
          'band',
          'score',
        ]);
        expect(t.score === null || typeof t.score === 'number').toBe(true);
      }
    }
    // GUARD THE GUARD: with zero trust objects the loop above is vacuous and this test would
    // pass on four empty responses — the silent-allow-list failure it exists to prevent.
    expect(seen, 'no trust objects were found at all — this assertion was vacuous').toBeGreaterThan(
      3
    );
  });

  /**
   * ★ THE TWO TRUST SHAPES CANNOT SILENTLY CONVERGE.
   *
   * an earlier Decision reduced trust to {band, score} and justified it by saying a consumer
   * that needs supersession or abstain "fetches the record by id, which returns full detail."
   * Round 1 applied the reduction to the by-id path too, which made that sentence FALSE and
   * left supersession/abstain machine-readable NOWHERE. This test is the fuse on both ends:
   * the LIST shape must stay exactly two fields (or the saving evaporates), and the BY-ID
   * shape must stay complete (or the rationale becomes false again).
   *
   * It asserts the by-id set as a SUPERSET-with-named-members rather than an exact key list,
   * because a future trust field should not fail this test merely for existing — but the
   * named members are the ones the rationale actually promises, so dropping any of them does.
   */
  const TRUST_FIELDS_ONLY_A_DIRECT_LOOKUP_CARRIES = [
    'outcome',
    'freshness',
    'superseded',
    'softSuperseded',
    'abstain',
    'supersession',
    'reason',
    'promotionRequirement',
  ] as const;

  test('a LIST row carries band+score ONLY; a BY-ID row carries the complete verdict', async () => {
    const listRow = (await viaTool('context_search', { query: MARKER, limit: 3 }))
      .structuredContent.results[0];
    expect(Object.keys(listRow.trust).sort()).toEqual(['band', 'score']);

    const byIdRow = (await viaTool('context_search', { id: ctxId })).structuredContent.results[0];
    expect(byIdRow.id).toBe(ctxId);
    for (const f of TRUST_FIELDS_ONLY_A_DIRECT_LOOKUP_CARRIES) {
      expect(
        byIdRow.trust,
        `a by-id fetch must carry trust.${f} — an earlier decision's rationale for dropping it ` +
          `from the list surfaces is that a by-id fetch "returns full detail". If it does ` +
          `not, that rationale is false and supersession/abstain are readable nowhere.`
      ).toHaveProperty(f);
    }
    // …and the two really are DIFFERENT shapes, not the same object twice.
    expect(Object.keys(byIdRow.trust).length).toBeGreaterThan(
      Object.keys(listRow.trust).length
    );
    // The headline score is still rounded on BOTH paths — the false-precision complaint was
    // independent of which shape ships.
    for (const t of [listRow.trust, byIdRow.trust]) {
      if (t.score === null) continue;
      expect(String(t.score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
    }
  });

  test('the wire score is ROUNDED, not a raw float', async () => {
    const resp = await viaTool('context_search', { query: MARKER, limit: 5 });
    for (const row of resp.structuredContent.results) {
      if (row.trust.score === null) continue;
      // Whatever the configured precision, the wire must not carry the raw blended float.
      // `0.9948746744592272` has 16 fractional digits; a rounded value has few.
      const digits = String(row.trust.score).split('.')[1]?.length ?? 0;
      expect(digits, `score ${row.trust.score} looks like an unrounded float`).toBeLessThanOrEqual(6);
    }
  });

  // ── BACKWARD COMPATIBILITY — proven by execution, not by inspection ────────
  test('`response_format` still works as a deprecated alias on the tools that shipped it', async () => {
    for (const tool of ALIAS_TOOLS) {
      const base: any = tool === 'context_search' ? { query: MARKER, limit: 10 } : { limit: 10 };
      for (const [alias, altitude] of Object.entries(RESPONSE_FORMAT_TO_ALTITUDE)) {
        const viaAlias = channels(await viaTool(tool, { ...base, response_format: alias }));
        const viaNew = channels(await viaTool(tool, { ...base, altitude }));
        expect(
          viaAlias,
          `${tool}: response_format:"${alias}" must answer identically to altitude:"${altitude}"`
        ).toEqual(viaNew);
      }
    }
  });

  test('`altitude` WINS when a caller passes both (explicit beats alias)', async () => {
    const both = channels(
      await viaTool('context_search', {
        query: MARKER,
        limit: 10,
        altitude: 'headline',
        response_format: 'detailed',
      })
    );
    const headline = channels(
      await viaTool('context_search', { query: MARKER, limit: 10, altitude: 'headline' })
    );
    expect(both).toEqual(headline);
  });

  test('`response_format` is ACCEPTED but no longer ADVERTISED (the name is retired)', () => {
    for (const tool of ALIAS_TOOLS) {
      const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === tool)!;
      const props = (def.inputSchema as any).properties;
      // Still accepted — removing it would break callers on shipped customer instances.
      expect(props.response_format, `${tool} must still ACCEPT response_format`).toBeTruthy();
      // …but carrying no description, so the surface teaches `altitude` and nothing else.
      expect(
        props.response_format.description,
        `${tool} still ADVERTISES response_format — the surface must teach one name, not two`
      ).toBeUndefined();
      expect(props.altitude.description, `${tool} must document altitude`).toBeTruthy();
    }
  });
});
