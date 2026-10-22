/**
 * THE AGENT CAPTURE CONTRACT — the guard. P4 L1.
 *
 * =============================================================================
 * WHAT IS BEING GUARDED, AND WHY EACH HALF NEEDS A DIFFERENT KIND OF ASSERTION
 * =============================================================================
 * L1 ships two things, and they fail in two different ways:
 *
 *   §1 THE FIELD SHAPE — `metadata.capture` must mean the same thing everywhere, and
 *      `verified` must not be free. The failure mode is a HOLE: one write boundary that
 *      does not run the rule, so a label with no citation gets stored and then reads as
 *      proof of having checked. So §1's population is EVERY op whose schema accepts
 *      `metadata`, DERIVED by introspecting the schemas rather than listed by hand.
 *
 *   §2 THE ADVERTISED CONTRACT — `discover({action:'contract'})`. The failure mode here is
 *      ROT: a hand-written description of an op drifts from the op. This repo can prove the
 *      class — its own agent-facing doc advertised a stale tool count and an unauthenticated
 *      curl for months. So §2 asserts the rendered content is IDENTICAL to what OP_REGISTRY
 *      and config/captureVocab.ts say, which is the only form of "generated" that a test can
 *      check: not "it was generated", but "it equals the source".
 *
 * =============================================================================
 * THE POPULATION §1 ENUMERATES, AND WHY IT IS THE WHOLE ONE
 * =============================================================================
 * ENUMERATES: every opId in ALL_OP_IDS whose zod schema declares a `metadata` property,
 * discovered by walking the schema (unwrapping ZodEffects/ZodOptional), never by a list in
 * this file. The choke point every instance of the defect must pass through is the SCHEMA
 * a caller's metadata is parsed by — a boundary cannot accept metadata without one.
 *
 * This matters because the rule is implemented ONCE, on the shared `baseMetadata`
 * definition. That is what makes the coverage real; the test's job is to prove the sharing
 * actually holds rather than to trust that it does. If someone later hand-rolls a
 * `z.record(z.any())` for one boundary instead of reusing baseMetadata, that boundary
 * appears in this population and goes RED.
 *
 * NOT ENUMERATED, stated so the bound is honest: metadata written by any path that does NOT
 * pass through the MCP tool schemas — raw SQL, a migration, the Command UI's own writers.
 * Nothing in this layer defends those, and this test does not claim to.
 *
 * Pure over the schemas + two config modules: no DB, no network, deterministic.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';

import { validationSchemas, validateToolArguments } from '../middleware/validation.js';
import { ALL_OP_IDS, OP_BY_ID } from '../config/opRegistry.js';
import { navigationHandler } from '../handlers/navigation.js';
import { dispatchDiscover } from '../handlers/discover.js';
import {
  CAPTURE_ABSENT_MEANING,
  CAPTURE_EVIDENCE_KEY,
  CAPTURE_EVIDENCE_MIN_CHARS,
  CAPTURE_METADATA_KEY,
  CAPTURE_RECORD_SHAPES,
  CAPTURE_STATUSES,
  CAPTURE_STATUS_KEY,
  CAPTURE_STATUS_MEANING,
  REJECTED_STATUS_VALUES,
  validateMetadataCapture,
} from '../config/captureVocab.js';

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * Population discovery — derived from the schemas, never listed.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/** Peel ZodEffects / ZodOptional / ZodDefault wrappers off until an object schema (or not). */
function unwrap(schema: unknown): any {
  let s: any = schema;
  for (let i = 0; i < 10 && s; i++) {
    if (s instanceof z.ZodObject) return s;
    const inner = s?._def?.schema ?? s?._def?.innerType;
    if (!inner) return s;
    s = inner;
  }
  return s;
}

/** The metadata sub-schema an op parses caller metadata with, or undefined if it accepts none. */
function metadataSchemaFor(opId: string): z.ZodTypeAny | undefined {
  const obj = unwrap(validationSchemas[opId as keyof typeof validationSchemas]);
  if (!(obj instanceof z.ZodObject)) return undefined;
  const field = (obj.shape as Record<string, z.ZodTypeAny>)['metadata'];
  return field;
}

const METADATA_OPS: string[] = ALL_OP_IDS.filter((opId) => metadataSchemaFor(opId) !== undefined);

/** Parse a metadata VALUE through the op's own metadata schema. */
function parseMetadata(opId: string, metadata: unknown): z.SafeParseReturnType<any, any> {
  return metadataSchemaFor(opId)!.safeParse(metadata);
}

function issueText(result: z.SafeParseReturnType<any, any>): string {
  return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §1 — THE FIELD SHAPE, at every boundary that accepts metadata
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§1 metadata.capture — the shape, on every metadata-accepting op', () => {
  test('the population is non-trivial and includes the boundaries agents actually write through', () => {
    // Guard the guard: an empty or tiny population would make every assertion below vacuous.
    // The floor is stated as a MINIMUM, not an exact count, because pinning the exact number
    // here would make an unrelated new write boundary RED for no reason — the reconciliation
    // that DOES belong to a count lives in toolSurfaceGolden's registry test.
    expect(METADATA_OPS.length).toBeGreaterThanOrEqual(8);
    for (const opId of ['context_store', 'context_update', 'decision_record', 'decision_update', 'task_create', 'task_update']) {
      expect(METADATA_OPS, `${opId} must be in the guarded population`).toContain(opId);
    }
  });

  test("T1 'verified' with NO evidence is REJECTED — on every one of them", () => {
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, { [CAPTURE_METADATA_KEY]: { [CAPTURE_STATUS_KEY]: 'verified' } });
      expect(r.success, `${opId} accepted an unevidenced 'verified'`).toBe(false);
      expect(issueText(r)).toContain(CAPTURE_EVIDENCE_KEY);
    }
  });

  test("T2 CONTROL — 'verified' WITH a citation is accepted on every one of them", () => {
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, {
        [CAPTURE_METADATA_KEY]: {
          [CAPTURE_STATUS_KEY]: 'verified',
          [CAPTURE_EVIDENCE_KEY]: 'npx tsc --noEmit -> exit 0',
        },
      });
      expect(r.success, `${opId} rejected a properly evidenced 'verified': ${issueText(r)}`).toBe(true);
    }
  });

  test('T3 the other states are FREE — a belief is not required to cite anything', () => {
    for (const status of CAPTURE_STATUSES.filter((s) => s !== 'verified')) {
      for (const opId of METADATA_OPS) {
        const r = parseMetadata(opId, { [CAPTURE_METADATA_KEY]: { [CAPTURE_STATUS_KEY]: status } });
        expect(r.success, `${opId} rejected a bare '${status}': ${issueText(r)}`).toBe(true);
      }
    }
  });

  test('T4 ★ ABSENT NEVER COLLIDES WITH BELIEVED — absence cannot be written as a value', () => {
    // The whole reason the vocabulary is three values and not four. A stored 'absent' would
    // be indistinguishable from a claim, and the moment one exists someone will read it as
    // one. So every spelling of "nobody said" is refused, and the refusal TEACHES the remedy.
    for (const spelling of Object.keys(REJECTED_STATUS_VALUES)) {
      const r = parseMetadata('context_store', {
        [CAPTURE_METADATA_KEY]: { [CAPTURE_STATUS_KEY]: spelling },
      });
      expect(r.success, `'${spelling}' was accepted as a capture status`).toBe(false);
      expect(issueText(r).toLowerCase(), `the refusal for '${spelling}' must state the remedy`).toContain('omit');
    }
    // …and it is not merely absent from the enum by accident: it is absent from the vocabulary.
    expect(CAPTURE_STATUSES as readonly string[]).not.toContain('absent');
  });

  test('T5 ABSENCE IS FREE AND STAYS ABSENT — no block in, no block out, no default', () => {
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, { anythingElse: 'x' });
      expect(r.success, `${opId} rejected metadata with no capture block: ${issueText(r)}`).toBe(true);
      // The load-bearing half: nothing MATERIALISES. A default would collapse "nobody said"
      // into a claim, which is precisely the 078_declared_limbs failure the vocabulary cites.
      expect(Object.prototype.hasOwnProperty.call(r.data ?? {}, CAPTURE_METADATA_KEY)).toBe(false);
    }
    // Metadata omitted entirely is likewise fine (the param is optional).
    expect(parseMetadata('context_store', undefined).success).toBe(true);
  });

  test('T6 the merge-delete sentinel is not a malformed block', () => {
    const r = parseMetadata('context_update', { [CAPTURE_METADATA_KEY]: null });
    expect(r.success, issueText(r)).toBe(true);
  });

  test('T7 a PLACEHOLDER citation does not satisfy the rule', () => {
    const tooShort = 'x'.repeat(CAPTURE_EVIDENCE_MIN_CHARS - 1);
    for (const evidence of ['', '   ', tooShort, {}, [], 0, false, null]) {
      const r = parseMetadata('context_store', {
        [CAPTURE_METADATA_KEY]: { [CAPTURE_STATUS_KEY]: 'verified', [CAPTURE_EVIDENCE_KEY]: evidence },
      });
      expect(r.success, `evidence ${JSON.stringify(evidence)} was accepted as a citation`).toBe(false);
    }
    // An ARTIFACT REFERENCE is a citation: the evidence lives outside and is resolvable.
    const withRef = parseMetadata('context_store', {
      [CAPTURE_METADATA_KEY]: {
        [CAPTURE_STATUS_KEY]: 'verified',
        [CAPTURE_EVIDENCE_KEY]: { artifact: 'gate-1e474867.log' },
      },
    });
    expect(withRef.success, issueText(withRef)).toBe(true);
  });

  test('T8 a present-but-malformed block is REJECTED, not silently ignored', () => {
    for (const block of ['verified', 42, ['verified'], true]) {
      const r = parseMetadata('context_store', { [CAPTURE_METADATA_KEY]: block });
      expect(r.success, `capture=${JSON.stringify(block)} was accepted`).toBe(false);
    }
    // A block with no status at all is a half-written claim, and it names the vocabulary.
    const noStatus = parseMetadata('context_store', {
      [CAPTURE_METADATA_KEY]: { [CAPTURE_EVIDENCE_KEY]: 'some command -> some output' },
    });
    expect(noStatus.success).toBe(false);
    expect(issueText(noStatus)).toContain(CAPTURE_STATUS_KEY);
  });

  test('T9 the rule fires at the REAL caller surface, not only on the sub-schema', () => {
    // The consumer calls validateToolArguments(opId, args) — the surface the gateway
    // dispatcher and the flat route both go through. Exercising the sub-schema alone would
    // be a convenient proxy (CLASSES.md C2), so the same two cases run end-to-end here.
    expect(() =>
      validateToolArguments('context_store', {
        content: 'a run report',
        type: 'completion',
        metadata: { [CAPTURE_METADATA_KEY]: { [CAPTURE_STATUS_KEY]: 'verified' } },
      }),
    ).toThrow(/evidence/i);

    const ok = validateToolArguments('context_store', {
      content: 'a run report',
      type: 'completion',
      metadata: {
        [CAPTURE_METADATA_KEY]: {
          [CAPTURE_STATUS_KEY]: 'verified',
          [CAPTURE_EVIDENCE_KEY]: 'npx vitest run -> exit 0',
        },
      },
    });
    expect(ok.metadata[CAPTURE_METADATA_KEY][CAPTURE_STATUS_KEY]).toBe('verified');
  });

  test('T10 the validator itself is inert on everything that is not a capture block', () => {
    for (const input of [undefined, null, 'string', 42, [], {}, { artifacts: [] }, { kind: 'dispatch-proof' }]) {
      expect(validateMetadataCapture(input), `unexpectedly complained about ${JSON.stringify(input)}`).toEqual([]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §2 — THE ADVERTISED CONTRACT IS GENERATED, NOT WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§2 discover({action:\'contract\'}) — generated from the registry', () => {
  test('T11 every op the contract names EXISTS, and every contextType it names is accepted', () => {
    // This is the anti-rot assertion. A hand-written contract can name a tool that was
    // renamed two releases ago and nothing notices; this cannot.
    const contextTypeEnum = (unwrap(validationSchemas.context_store).shape.type as z.ZodEnum<any>).options as string[];
    expect(CAPTURE_RECORD_SHAPES.length).toBeGreaterThan(0);
    for (const shape of CAPTURE_RECORD_SHAPES) {
      expect(OP_BY_ID.has(shape.opId), `capture contract names a non-existent op '${shape.opId}'`).toBe(true);
      if (shape.contextType !== undefined) {
        expect(contextTypeEnum, `contract advertises context type '${shape.contextType}'`).toContain(shape.contextType);
      }
    }
  });

  test('T12 the rendered op descriptions are the REGISTRY strings, character for character', async () => {
    const res: any = await navigationHandler.getCaptureContract();
    expect(res.structuredContent.ok).toBe(true);
    for (const rendered of res.structuredContent.recordShapes) {
      expect(rendered.opDescription).toBe(OP_BY_ID.get(rendered.opId)!.description);
      // …and non-empty, or "equals the source" would pass on two empty strings.
      expect(rendered.opDescription.length).toBeGreaterThan(0);
    }
    // The human channel names each op too, so a reader of the text gets the same answer.
    for (const shape of CAPTURE_RECORD_SHAPES) {
      expect(res.content[0].text).toContain(shape.opId);
    }
  });

  test('T13 the rendered vocabulary IS the vocabulary — same values, same meanings, absent stated apart', async () => {
    const res: any = await navigationHandler.getCaptureContract();
    const sc = res.structuredContent;
    expect(sc.statuses.map((s: any) => s.status)).toEqual([...CAPTURE_STATUSES]);
    for (const s of sc.statuses) {
      expect(s.meaning).toBe(CAPTURE_STATUS_MEANING[s.status as keyof typeof CAPTURE_STATUS_MEANING]);
    }
    expect(sc.statuses.filter((s: any) => s.requiresEvidence).map((s: any) => s.status)).toEqual(['verified']);
    // absent is rendered, and it is rendered OUTSIDE the status list — the whole point.
    expect(sc.absent).toBe(CAPTURE_ABSENT_MEANING);
    expect(sc.statuses.map((s: any) => s.status)).not.toContain('absent');
    expect(sc.metadataKey).toBe(CAPTURE_METADATA_KEY);
  });

  test('T14 the example the contract hands out is itself VALID under the rule it teaches', async () => {
    // A contract whose own example would be rejected is worse than no example. This also
    // means the example cannot rot away from the validator without going RED.
    const res: any = await navigationHandler.getCaptureContract();
    const r = parseMetadata('context_store', res.structuredContent.example);
    expect(r.success, issueText(r)).toBe(true);
  });

  test('T15 the gateway action and the flat op are ONE renderer', async () => {
    const viaGateway: any = await dispatchDiscover({ action: 'contract' });
    const direct: any = await navigationHandler.getCaptureContract();
    expect(viaGateway.structuredContent).toEqual(direct.structuredContent);
    expect(viaGateway.content[0].text).toBe(direct.content[0].text);
  });

  test('T16 an unknown discover action names contract among the valid ones (derived list)', async () => {
    const res: any = await dispatchDiscover({ action: 'nonsense' });
    const text = res.content.map((c: any) => c.text).join(' ');
    expect(text).toContain('contract');
    // Derived, so it lists every action the registry actually has — not a stale literal.
    for (const a of ['catalog', 'explain', 'examples', 'ping', 'status']) expect(text).toContain(a);
  });
});
