/**
 * THE `metadata.gate` WRITE CONTRACT — the guard. an earlier Task.
 *
 * =============================================================================
 * WHAT IS BEING GUARDED
 * =============================================================================
 * `metadata.gate` was specced by captureVocab's REVIEW VERDICT shape and never validated,
 * and the corpus drifted to five spellings of the exit code with prose sitting in the numeric
 * field. The read side (config/gateExitCodeConfig.ts) copes by recognizing the
 * spellings it knows. This guards the other end: that a NEW write cannot put the wrong TYPE in
 * one of the three reserved fields, and cannot re-use one of the eight mis-spellings the
 * corpus or the reader already carries. It is a deny-list, NOT a closed key set — §2 executes
 * that limit rather than claiming otherwise.
 *
 * THE FAILURE MODE IT IS WRITTEN AGAINST IS A HOLE, not a wrong answer — one write boundary
 * that does not run the rule, or a rule that is never wired at all. A validator that exists
 * and is not reached is the most common way this class hides, so §1's population is EVERY op
 * whose schema accepts `metadata`, DERIVED by introspecting the shipped schemas, and §3
 * drives `validateToolArguments` — the single function the flat transport, the gateway
 * dispatcher and discover's branch dispatch all cross (validation.ts:2066, routes/gateway.ts,
 * handlers/discover.ts). Nothing here calls validateMetadataGate directly except §4, whose
 * whole job is the absent/empty distinction at unit granularity.
 *
 * =============================================================================
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE
 * =============================================================================
 * ENUMERATES: every opId in ALL_OP_IDS whose zod schema declares a `metadata` property,
 * discovered by walking the schema, never by a list in this file. The choke point every
 * instance of the defect must pass through is the SCHEMA a caller's metadata is parsed by —
 * a boundary cannot accept metadata without one. If someone later hand-rolls a
 * `z.record(z.any())` for one boundary instead of reusing baseMetadata, that boundary appears
 * here and goes RED.
 *
 * NOT ENUMERATED, so the bound is honest: any writer that does not cross the MCP tool schemas
 * — raw SQL, a migration, the Command UI's own writers. Nothing in this layer defends those.
 *
 * Pure over the schemas + two config modules: no DB, no network, deterministic.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';

import { validationSchemas, validateToolArguments } from '../middleware/validation.js';
import { ALL_OP_IDS } from '../config/opRegistry.js';
import {
  GATE_EXIT_CODE_KEYS,
  GATE_REF_KEYS,
  GATE_RUN_KEY,
  GATE_METADATA_KEY,
} from '../config/gateExitCodeConfig.js';
import { navigationHandler } from '../handlers/navigation.js';
import {
  GATE_ABSENT_MEANING,
  GATE_CONTRACT_EXAMPLE,
  GATE_FIELD_SPECS,
  GATE_CANONICAL_EXIT_CODE_KEY,
  GATE_CANONICAL_REF_KEY,
  GATE_CANONICAL_RUN_KEY,
  GATE_EXIT_CODE_ALIASES,
  GATE_REF_ALIASES,
  GATE_ECHO_MAX_CHARS,
  GATE_REF_MIN_CHARS,
  validateMetadataGate,
} from '../config/gateMetadataVocab.js';

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

function metadataSchemaFor(opId: string): z.ZodTypeAny | undefined {
  const obj = unwrap(validationSchemas[opId as keyof typeof validationSchemas]);
  if (!(obj instanceof z.ZodObject)) return undefined;
  return (obj.shape as Record<string, z.ZodTypeAny>)['metadata'];
}

const METADATA_OPS: string[] = ALL_OP_IDS.filter((opId) => metadataSchemaFor(opId) !== undefined);

function parseMetadata(opId: string, metadata: unknown): z.SafeParseReturnType<any, any> {
  return metadataSchemaFor(opId)!.safeParse(metadata);
}

function issueText(result: z.SafeParseReturnType<any, any>): string {
  return result.success ? '' : result.error.issues.map((i) => i.message).join(' | ');
}

/** A gate block wrapped as a metadata bag. */
const gate = (block: unknown) => ({ [GATE_METADATA_KEY]: block });

/** A block that is valid today and must STAY valid — the control for every rejection below. */
const GOOD_BLOCK = {
  [GATE_CANONICAL_RUN_KEY]: true,
  [GATE_CANONICAL_EXIT_CODE_KEY]: 0,
  [GATE_CANONICAL_REF_KEY]: '1594229d',
  name: 'scripts/ci-clean-gate.sh',
  reason: 'free-form sibling keys are deliberately still free-form',
};

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §1 — THE RULE RUNS ON EVERY BOUNDARY THAT ACCEPTS metadata
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§1 metadata.gate — enforced on every metadata-accepting op', () => {
  test('the population is non-trivial and includes the boundaries agents actually write through', () => {
    // Guard the guard: an empty or tiny population makes every assertion below vacuous. A
    // MINIMUM, not an exact count — pinning the number would make an unrelated new write
    // boundary RED for no reason.
    expect(METADATA_OPS.length).toBeGreaterThanOrEqual(8);
    for (const opId of [
      'context_store',
      'context_update',
      'decision_record',
      'decision_update',
      'task_create',
      'task_update',
    ]) {
      expect(METADATA_OPS, `${opId} must be in the guarded population`).toContain(opId);
    }
  });

  test('a free-prose STRING gate block is REJECTED — on every one of them', () => {
    // The dominant malformed shape on prod: 14 contexts + 5/5 tasks store a sentence here.
    const prose = 'CLEAN GATE GREEN on 648b328, exit 0, zero FAIL lines, all twelve stages';
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, gate(prose));
      expect(r.success, `${opId} accepted a free-prose gate block`).toBe(false);
      expect(issueText(r)).toContain('must be an OBJECT');
    }
  });

  test('prose in the numeric exit-code field is REJECTED — on every one of them', () => {
    // Verbatim from prod: two records store this sentence in an exit-code field.
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(
        opId,
        gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: "NOT RUN - outstanding, Coordinator's" }),
      );
      expect(r.success, `${opId} accepted prose in ${GATE_CANONICAL_EXIT_CODE_KEY}`).toBe(false);
      expect(issueText(r)).toContain('must be an INTEGER');
    }
  });

  test('a well-formed gate block is ACCEPTED — on every one of them (the control)', () => {
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, gate(GOOD_BLOCK));
      expect(r.success, `${opId} rejected a well-formed gate block: ${issueText(r)}`).toBe(true);
    }
  });

  test('metadata with NO gate block is untouched — on every one of them', () => {
    for (const opId of METADATA_OPS) {
      const r = parseMetadata(opId, { somethingElse: 'unrelated' });
      expect(r.success, `${opId} rejected metadata with no gate block: ${issueText(r)}`).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §2 — THE SPELLINGS. Read broadly, write narrowly.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§2 the measured mis-spellings are refused — a deny-list, not a closed key set', () => {
  test('the canonical spellings ARE the read side’s preferred keys — no second copy', () => {
    expect(GATE_CANONICAL_EXIT_CODE_KEY).toBe(GATE_EXIT_CODE_KEYS[0]);
    expect(GATE_CANONICAL_REF_KEY).toBe(GATE_REF_KEYS[0]);
    expect(GATE_CANONICAL_RUN_KEY).toBe(GATE_RUN_KEY);
  });

  test('every non-preferred spelling the READER knows is REFUSED at the write', () => {
    // Derivation, not a list: if someone widens the reader's alias table tomorrow, the new
    // alias is refused here automatically and this test needs no edit.
    for (const alias of GATE_EXIT_CODE_KEYS.slice(1)) {
      expect(GATE_EXIT_CODE_ALIASES, `reader alias ${alias} must be write-refused`).toContain(
        alias,
      );
    }
    for (const alias of GATE_REF_KEYS.slice(1)) {
      expect(GATE_REF_ALIASES, `reader alias ${alias} must be write-refused`).toContain(alias);
    }
  });

  test('the five measured exit-code spellings: one accepted, four rejected', () => {
    // MEASURED on prod 2026-09-05 (query in gateMetadataVocab.ts's header):
    //   exitCode 14 · exit 3 · exit_code 2 · rc 1 · static_subset_exit 1.
    // The last two are spellings the READER does not know — a value no renderer can see.
    const measured = ['exitCode', 'exit', 'exit_code', 'rc', 'static_subset_exit'];
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const key of measured) {
      const r = parseMetadata('context_store', gate({ [key]: 0 }));
      (r.success ? accepted : rejected).push(key);
    }
    expect(accepted).toEqual([GATE_CANONICAL_EXIT_CODE_KEY]);
    expect(rejected.sort()).toEqual(['exit', 'exit_code', 'rc', 'static_subset_exit']);
  });

  test('the ref spellings: `ref` accepted, `refReported`/`refMeasured` rejected', () => {
    expect(parseMetadata('context_store', gate({ ref: '1594229d' })).success).toBe(true);
    for (const alias of ['refReported', 'refMeasured']) {
      const r = parseMetadata('context_store', gate({ [alias]: '1594229d' }));
      expect(r.success, `${alias} was accepted`).toBe(false);
      expect(issueText(r)).toContain(GATE_CANONICAL_REF_KEY);
    }
  });

  test('`refToGate` and `refChecked` are NOT treated as refs and are NOT rejected', () => {
    // They answer different questions — an intention and a boolean. Folding either into `ref`
    // is the exact substitution an earlier task exists to stop, so the write side must not
    // "helpfully" rename them.
    const r = parseMetadata(
      'context_store',
      gate({ refToGate: 'merge of batch10/belief-failopen@9305a39a into main', refChecked: true }),
    );
    expect(r.success, `a legitimate refToGate/refChecked block was rejected: ${issueText(r)}`).toBe(
      true,
    );
  });

  test('THE LIMIT, EXECUTED: an unmeasured spelling IS accepted today', () => {
    // Reviewer wrote nine shapes that pass, and this is the honest record of four of them.
    // The rule refuses the eight spellings on GATE_EXIT_CODE_ALIASES / GATE_REF_ALIASES by
    // name; it does not refuse a key nobody has written yet. Stated as an executed assertion
    // because a limits sentence in a comment cannot be checked, and this one would have been
    // false — the describe above used to promise "the corpus cannot gain a sixth spelling".
    //
    // ⚠️ If you are here because you want to widen the deny-list: that is the move that never
    // ends (CLASSES.md C3). The reason these are tolerable is that the canonical key is named
    // in the rejection message and in the generated contract, so an agent has to ignore both.
    for (const shape of [
      { EXIT_CODE: 0 },
      { 'exit-code': 0 },
      { gateExitCode: 0 },
      { status: 'GREEN' },
    ]) {
      const r = parseMetadata('context_store', gate(shape));
      expect(r.success, `${JSON.stringify(shape)} — update this test, not just the deny-list`).toBe(
        true,
      );
    }
  });

  test('sibling descriptive keys stay free-form — the guard does not close the key set', () => {
    // A closed key set would reject `name`/`reason`/`stagesRan`/`owner` and 50 more measured
    // keys, be inconvenient within a week, and be deleted. Stated as an assertion so a future
    // tightening has to argue with a RED test rather than with a comment.
    const r = parseMetadata(
      'context_store',
      gate({ ...GOOD_BLOCK, stagesRan: 12, owner: 'reviewer', authoritative: true, note: 'x' }),
    );
    expect(r.success, `free-form sibling keys were rejected: ${issueText(r)}`).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §3 — DRIVEN THROUGH THE FUNCTION EVERY TRANSPORT CROSSES
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§3 validateToolArguments — the production configuration, not just the code path', () => {
  const args = (metadata: unknown) => ({
    content: 'a run report long enough to satisfy the content floor on context_store',
    type: 'completion',
    metadata,
  });

  test('a malformed gate block is REJECTED at the shipped entry point', () => {
    expect(() => validateToolArguments('context_store', args(gate('CLEAN GATE GREEN')))).toThrow(
      /must be an OBJECT/,
    );
    expect(() =>
      validateToolArguments('context_store', args(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: '0' }))),
    ).toThrow(/must be an INTEGER/);
  });

  test('a well-formed gate block SURVIVES the shipped entry point unchanged', () => {
    const out = validateToolArguments('context_store', args(gate(GOOD_BLOCK)));
    expect(out.metadata[GATE_METADATA_KEY][GATE_CANONICAL_EXIT_CODE_KEY]).toBe(0);
    expect(out.metadata[GATE_METADATA_KEY][GATE_CANONICAL_REF_KEY]).toBe('1594229d');
    // Nothing was coerced or renamed on the way through.
    expect(out.metadata[GATE_METADATA_KEY]).toEqual(GOOD_BLOCK);
  });

  test('a task_create carrying a malformed gate block is REJECTED too', () => {
    // 5 of the 5 task-side gate blocks on prod are prose; the task boundary is not a footnote.
    expect(() =>
      validateToolArguments('task_create', {
        title: 'a task whose gate block is prose',
        metadata: gate('operator-GO'),
      }),
    ).toThrow(/must be an OBJECT/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §4 — THE ABSENCES, WHICH ARE NOT THE SAME ABSENCE
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§4 absent · empty · declared-not-run — three states, three answers', () => {
  test('ABSENT: no gate key at all says nothing and is accepted silently', () => {
    expect(validateMetadataGate({})).toEqual([]);
    expect(validateMetadataGate({ capture: { status: 'believed' } })).toEqual([]);
    expect(validateMetadataGate(undefined)).toEqual([]);
    expect(validateMetadataGate('not even an object')).toEqual([]);
  });

  test('EMPTY: `gate:{}` is NOT the same as absent and is REJECTED', () => {
    // The distinction this test exists for: a record that never claimed a gate must not
    // validate the same as one that claims a gate and records nothing (CLASSES.md C1 — an
    // instrument has three states and "could not measure" never shares a value with "no").
    const absent = validateMetadataGate({ other: 1 });
    const empty = validateMetadataGate(gate({}));
    expect(absent).toEqual([]);
    expect(empty.length).toBe(1);
    expect(empty[0]).toContain('EMPTY');
    expect(empty).not.toEqual(absent);
  });

  test('DELETE sentinel: `gate:null` removes the key and is not a malformed block', () => {
    // metadata merges shallow and an explicit null deletes a key (utils/metadataMerge.ts).
    // Rejecting null would make a malformed historical block impossible to REMOVE.
    expect(validateMetadataGate(gate(null))).toEqual([]);
  });

  test('DECLARED NOT RUN: `run:false` is a fact and stays writable, with or without a null code', () => {
    // 30 prod records carry run:false — the dominant live state. A validator that rejected it
    // would have measured nothing except how many writers it annoyed.
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_RUN_KEY]: false }))).toEqual([]);
    expect(
      validateMetadataGate(
        gate({ [GATE_CANONICAL_RUN_KEY]: false, [GATE_CANONICAL_EXIT_CODE_KEY]: null }),
      ),
    ).toEqual([]);
  });

  test('SELF-CONTRADICTION: run:false with a reported exit code is REJECTED', () => {
    const msgs = validateMetadataGate(
      gate({ [GATE_CANONICAL_RUN_KEY]: false, [GATE_CANONICAL_EXIT_CODE_KEY]: 0 }),
    );
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('contradicts itself');
    // …and the honest version of the same record is accepted.
    expect(
      validateMetadataGate(
        gate({ [GATE_CANONICAL_RUN_KEY]: true, [GATE_CANONICAL_EXIT_CODE_KEY]: 0 }),
      ),
    ).toEqual([]);
  });

  test('an ARRAY gate block is rejected as a non-object, not silently indexed', () => {
    const msgs = validateMetadataGate(gate([{ exitCode: 0 }]));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('array');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §5 — THE VALUES THEMSELVES
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§5 exit code, ref and run — the typed reserved fields', () => {
  test('every code in the published namespace is writable, including 40', () => {
    // 0 GREEN · 1 RED · 2 HARNESS ERROR · 3 SKIP · 40 STATIC GREEN. A
    // validator that only knew 0 and 1 would refuse the two states that matter most.
    for (const rc of [0, 1, 2, 3, 40]) {
      expect(validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: rc })), `rc=${rc}`).toEqual(
        [],
      );
    }
  });

  test('an UNRECOGNISED integer code is still writable — the namespace is not an allow-list', () => {
    // The reader renders an unknown code as itself marked UNRECOGNISED rather than folding it
    // into a verdict. The writer must therefore be able to record it: refusing rc=127 would
    // push a real measurement out of the structured field and back into prose, which is the
    // defect. The type is the contract here, not the value.
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: 127 }))).toEqual([]);
  });

  test('a numeric STRING is rejected rather than coerced', () => {
    const msgs = validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: '0' }));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('"0" is not 0');
  });

  test('a non-integer number is rejected', () => {
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: 0.5 })).length).toBe(1);
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: NaN })).length).toBe(1);
  });

  test('`exitCode:null` means "no code recorded" and is accepted', () => {
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_EXIT_CODE_KEY]: null }))).toEqual([]);
  });

  test('an empty or too-short ref is rejected; a real one is accepted', () => {
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_REF_KEY]: '' })).length).toBe(1);
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_REF_KEY]: '   ' })).length).toBe(1);
    expect(validateMetadataGate(gate({ [GATE_CANONICAL_REF_KEY]: 42 })).length).toBe(1);
    expect(
      validateMetadataGate(gate({ [GATE_CANONICAL_REF_KEY]: 'a'.repeat(GATE_REF_MIN_CHARS) })),
    ).toEqual([]);
    expect(
      validateMetadataGate(
        gate({ [GATE_CANONICAL_REF_KEY]: 'merge of batch15/c-gatemeta into main @ 1594229d' }),
      ),
    ).toEqual([]);
  });

  test('`run` must be a boolean, and the bridge’s string "false" is NOT quietly accepted', () => {
    // metadata is a free-form jsonb bag: it does NOT go through coercedBoolean(), so a string
    // here would be stored as-is and read back as truthy by every consumer.
    const msgs = validateMetadataGate(gate({ [GATE_CANONICAL_RUN_KEY]: 'false' }));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('must be a BOOLEAN');
  });

  test('a rejected value is ECHOED CLIPPED — the message also lands in the server log', () => {
    const huge = 'x'.repeat(4096);
    // Both echo paths, with values that are actually REJECTED — a long WELL-FORMED ref is
    // accepted and never echoed, so the reachable ref case is a short one padded to length.
    // (Found by this test failing on my first draft, which asserted on a value the rule
    // rightly accepted.)
    for (const block of [
      { [GATE_CANONICAL_EXIT_CODE_KEY]: huge },
      { [GATE_CANONICAL_REF_KEY]: 'ab' + ' '.repeat(4096) },
      { [GATE_CANONICAL_REF_KEY]: ' '.repeat(4096) },
    ]) {
      const msgs = validateMetadataGate(gate(block));
      expect(msgs.length).toBe(1);
      // The bound is the whole message, so it holds however the echo is composed.
      expect(msgs[0].length).toBeLessThan(GATE_ECHO_MAX_CHARS + 400);
      expect(msgs[0]).not.toContain(huge.slice(0, GATE_ECHO_MAX_CHARS + 1));
    }
  });

  test('multiple defects in one block are ALL reported, not just the first', () => {
    const msgs = validateMetadataGate(
      gate({ exit: 0, refMeasured: 'abc1234', [GATE_CANONICAL_RUN_KEY]: 'yes' }),
    );
    expect(msgs.length).toBe(3);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * §6 — THE ADVERTISED SHAPE (an earlier task fold-in N5)
 *
 * An agent is told by the REVIEW VERDICT shape to record "the gate and its exit code" and is
 * then refused by §1 if it guesses wrong. discover({action:'contract'}) now states the shape.
 * Two ways that could be worse than saying nothing, and both are asserted here: the contract
 * could advertise an example the validator REJECTS, or advertise a field nothing ENFORCES.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

describe('§6 discover({action:\'contract\'}) advertises the shape, generated from config', () => {
  test('the advertised fields ARE the config, character for character', async () => {
    const sc: any = (await navigationHandler.getCaptureContract()).structuredContent;
    expect(sc.gate.metadataKey).toBe(GATE_METADATA_KEY);
    expect(sc.gate.fields).toEqual(
      GATE_FIELD_SPECS.map((f) => ({ key: f.key, type: f.type, meaning: f.meaning })),
    );
    expect(sc.gate.absent).toBe(GATE_ABSENT_MEANING);
    expect(sc.gate.fields.length).toBeGreaterThan(0);
    for (const f of sc.gate.fields) expect(f.meaning.length).toBeGreaterThan(0);
  });

  test('the example it hands out is ACCEPTED by the rule it teaches', async () => {
    // A contract whose own example would be rejected is worse than no example, and this is
    // the assertion that stops the two drifting apart (the same guard captureContract's T14
    // puts on the capture example).
    const sc: any = (await navigationHandler.getCaptureContract()).structuredContent;
    expect(validateMetadataGate(sc.gate.example)).toEqual([]);
    expect(parseMetadata('context_store', GATE_CONTRACT_EXAMPLE).success).toBe(true);
  });

  test('every advertised field is one the validator actually ENFORCES', async () => {
    // The anti-rot direction nobody checks: advertising a field that is not typed would teach
    // a shape the boundary does not keep. Each spec key is fed a value of the wrong type and
    // must be refused BY NAME.
    const sc: any = (await navigationHandler.getCaptureContract()).structuredContent;
    for (const f of sc.gate.fields) {
      const msgs = validateMetadataGate(gate({ [f.key]: { wrong: 'type' } }));
      expect(msgs.length, `${f.key} is advertised but unenforced`).toBe(1);
      expect(msgs[0]).toContain(f.key);
    }
  });

  test('the human channel names the canonical keys and the refused spellings', async () => {
    const res: any = await navigationHandler.getCaptureContract();
    const text: string = res.content[0].text;
    for (const f of GATE_FIELD_SPECS) expect(text).toContain(f.key);
    for (const alias of [...GATE_EXIT_CODE_ALIASES, ...GATE_REF_ALIASES]) {
      expect(text, `refused spelling ${alias} is not advertised as refused`).toContain(alias);
    }
    // The reader is told the rule is a deny-list, not a closed key set — the same limit §2
    // executes. A contract that implied otherwise would re-tell the story N2 removed.
    expect(text).toContain('free-form');
  });
});
