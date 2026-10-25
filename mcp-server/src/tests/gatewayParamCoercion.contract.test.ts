/**
 * GATEWAY PARAM COERCION — an earlier task (P0).
 *
 * THE BUG THIS GUARDS. On the gateway surface the lazy inputSchema advertises only `action`
 * plus the branch's required params; every optional param rides `additionalProperties: true`.
 * An MCP client types its arguments against that advertised schema and STRINGIFIES anything
 * it has no declared type for — legitimate client behaviour. The server's rescue layer was a
 * hardcoded NAME ALLOW-LIST (`deserializeParameters`: arrayParams=[tags,…] / numberParams=
 * [limit,…]) whose default for an unrecognized name was a SILENT PASS-THROUGH.
 *
 * WHY THE OLD PARITY SUITE MISSED IT (the hole this file closes). an earlier Milestone's
 * first-call parity suite covered READS and STRING params. A string param is exactly the case
 * that behaves identically whether or not coercion works, so the suite was structurally
 * incapable of seeing this bug. The severity is also ASYMMETRIC, which is the crux:
 *   - an unrescued NUMBER fails LOUD  — z.number() rejects the string, you see an error;
 *   - an unrescued ARRAY fails SILENT — the JSON string is not an array, the filter is
 *     quietly dropped, and the caller gets WRONG RESULTS with no error at all.
 * So a numeric-only test would still have missed the dangerous half. Every sweep below
 * therefore covers the ARRAY and OBJECT arms, not just the numeric one.
 *
 * FAIL-CLOSED BY CONSTRUCTION. The sweep does not hand-list params. It walks the
 * REGISTRY → every gateway → every action → every declared param, and asserts coercion for
 * each one whose declared type is number/boolean/array/record. A newly-added typed param is
 * covered the moment it is declared; nobody has to remember to add it here. The vacuity
 * guards at the end make "the sweep found nothing" a RED rather than a silent pass — which
 * is the exact failure mode (an allow-list masquerading as a guard) that produced this bug.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { GATEWAY_ORDER } from '../config/gatewayConfig.js';
import { resolveGatewayAction, actionsForGateway } from '../config/gatewayResolver.js';
import {
  validationSchemas,
  validateToolArguments,
  coerceArgsToDeclaredTypes,
} from '../middleware/validation.js';

/* ───────────────────────── schema introspection (mirrors the product's own unwrap) ───────────────────────── */

const WRAPPERS = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
  'ZodCatch',
  'ZodReadonly',
]);

function unwrap(s: any): any {
  for (let i = 0; i < 20; i++) {
    const t = s?._def?.typeName;
    if (!t || !WRAPPERS.has(t)) break;
    const next = t === 'ZodEffects' ? s._def.schema : s._def.innerType;
    if (!next) break;
    s = next;
  }
  return s;
}

/** The declared param shape for a flat opId, or null if it is not an object schema. */
function shapeOf(opId: string): Record<string, any> | null {
  const schema: any = (validationSchemas as any)[opId];
  if (!schema) return null;
  const obj = unwrap(schema);
  if (obj?._def?.typeName !== 'ZodObject' || !obj.shape) return null;
  return obj.shape;
}

/** Every (gateway, action, opId) triple on the gateway surface, `discover` excluded (meta-actions). */
function gatewayOps(): Array<{ gateway: string; action: string; opId: string }> {
  const out: Array<{ gateway: string; action: string; opId: string }> = [];
  for (const gateway of GATEWAY_ORDER) {
    if (gateway === 'discover') continue;
    for (const action of actionsForGateway(gateway)) {
      const res = resolveGatewayAction(gateway, action);
      if (res) out.push({ gateway, action, opId: res.opId });
    }
  }
  return out;
}

/**
 * The four coercible categories, each with the string form a stringifying client sends and the
 * real value it must become. `false` is included deliberately: it is the case z.coerce.boolean()
 * gets WRONG (JS truthiness makes the non-empty string "false" → true), so it is a real guard.
 */
const COERCIBLE: Record<string, { sent: string; expected: unknown }> = {
  ZodNumber: { sent: '7', expected: 7 },
  ZodBoolean: { sent: 'false', expected: false },
  ZodArray: { sent: '["alpha","beta"]', expected: ['alpha', 'beta'] },
  ZodTuple: { sent: '["alpha","beta"]', expected: ['alpha', 'beta'] },
  ZodRecord: { sent: '{"k":"v"}', expected: { k: 'v' } },
  ZodObject: { sent: '{"k":"v"}', expected: { k: 'v' } },
};

/* ───────────────────────── 1. the fail-closed surface sweep ───────────────────────── */

describe('schema-driven coercion covers the WHOLE gateway surface (registry-driven, fails closed)', () => {
  const ops = gatewayOps();

  // Tally what the sweep actually exercised, so the vacuity guards below can prove it ran.
  const covered: Record<string, number> = {};
  const perGateway: Record<string, Set<string>> = {};

  test('every declared number/boolean/array/object param coerces from its stringified form', () => {
    const failures: string[] = [];

    for (const { gateway, action, opId } of ops) {
      const shape = shapeOf(opId);
      if (!shape) continue;

      for (const [name, declared] of Object.entries<any>(shape)) {
        const typeName = unwrap(declared)?._def?.typeName;
        const probe = COERCIBLE[typeName];
        if (!probe) continue; // strings/enums/unions are intentionally NOT coerced

        const out = coerceArgsToDeclaredTypes(
          (validationSchemas as any)[opId],
          { [name]: probe.sent },
        );

        try {
          expect(out[name]).toEqual(probe.expected);
        } catch {
          failures.push(
            `${gateway}.${action} [${opId}] param '${name}' (${typeName}): ` +
              `sent ${JSON.stringify(probe.sent)}, got ${JSON.stringify(out[name])}, ` +
              `expected ${JSON.stringify(probe.expected)}`,
          );
        }

        covered[typeName] = (covered[typeName] ?? 0) + 1;
        (perGateway[gateway] ??= new Set()).add(typeName);
      }
    }

    expect(failures, `\nUNCOERCED PARAMS (each is a live wrong-answer/loud-error bug):\n${failures.join('\n')}\n`)
      .toEqual([]);
  });

  // ── VACUITY GUARDS: make "found nothing" impossible to pass silently ──────────────────
  // Without these the sweep above degrades into exactly the allow-list disease it replaced:
  // if the registry walk broke, or every param stopped being recognized, the loop would run
  // zero assertions and report GREEN. These turn that into a loud RED.

  test('the sweep is not vacuous — it exercised every coercible category', () => {
    expect(covered.ZodNumber ?? 0).toBeGreaterThan(0);
    expect(covered.ZodBoolean ?? 0).toBeGreaterThan(0);
    expect(covered.ZodArray ?? 0).toBeGreaterThan(0);
    expect(covered.ZodRecord ?? 0).toBeGreaterThan(0);

    // Measured on the surface as built (18 array / 15 number / 10 record / 8 boolean).
    // A floor, not an equality — new params must not require editing this test.
    const total = Object.values(covered).reduce((a, b) => a + b, 0);
    expect(total, `sweep covered only ${total} typed params — the registry walk is likely broken`)
      .toBeGreaterThanOrEqual(40);
  });

  test('the ARRAY arm — the SILENT-failure case — is covered on every gateway that has one', () => {
    // The task's explicit ask: per gateway, at least one strictly-typed optional param, and
    // BOTH a numeric and an array case. Asserted from the registry rather than a hand-list.
    const withArray = Object.entries(perGateway)
      .filter(([, types]) => types.has('ZodArray'))
      .map(([gw]) => gw);
    const withNumber = Object.entries(perGateway)
      .filter(([, types]) => types.has('ZodNumber'))
      .map(([gw]) => gw);

    expect(withArray).toEqual(
      expect.arrayContaining(['context', 'task', 'decision', 'graph']),
    );
    expect(withNumber).toEqual(
      expect.arrayContaining(['context', 'task', 'project']),
    );
  });
});

/* ───────────────────────── 2. end-to-end through the real validator ───────────────────────── */

describe('the known blast radius validates end-to-end through validateToolArguments', () => {
  // These are the exact params the root-cause analysis named. The sweep above proves the
  // MECHANISM across the surface; these prove the WHOLE seam (synonyms → strict-key →
  // coercion → .parse) accepts the stringified form a real gateway client sends.

  test('task.update progress — the originally-reported LOUD failure', () => {
    const out = validateToolArguments('task_update', {
      taskId: '11111111-1111-4111-8111-111111111111',
      progress: '20',
    });
    expect(out.progress).toBe(20);
    expect(typeof out.progress).toBe('number');
  });

  test('task.list statuses — an ARRAY filter (the SILENT failure)', () => {
    const out = validateToolArguments('task_list', { statuses: '["todo","in_progress"]' });
    expect(out.statuses).toEqual(['todo', 'in_progress']);
  });

  test('context.search minSimilarity + offset — decimal and integer together', () => {
    // `query` is present because context_search refines "at least one of id/query/tags", and
    // it doubles as an END-TO-END proof that a declared STRING rides through the full seam
    // byte-identical while its numeric siblings are coerced around it.
    const query = 'id-shaped: ["not","an","array"] 071';
    const out = validateToolArguments('context_search', {
      query,
      minSimilarity: '0.42',
      offset: '10',
      limit: '5',
    });
    expect(out.minSimilarity).toBe(0.42);
    expect(out.offset).toBe(10);
    expect(out.limit).toBe(5);
    expect(out.query).toBe(query);
  });

  test('context.store metadata — the OBJECT arm, which had no branch at all before', () => {
    const out = validateToolArguments('context_store', {
      content: 'coercion probe',
      type: 'completion',
      metadata: '{"source":"gateway","n":1}',
      tags: '["alpha"]',
    });
    expect(out.metadata).toEqual({ source: 'gateway', n: 1 });
    expect(out.tags).toEqual(['alpha']);
  });

  test('graph.links edgeTypes — an array filter on the graph gateway', () => {
    const links = validateToolArguments('get_links', {
      id: '22222222-2222-4222-8222-222222222222',
      edgeTypes: '["informs"]',
    });
    expect(links.edgeTypes).toEqual(['informs']);
  });

  test('task.bulk_update task_ids — a REQUIRED array param', () => {
    const out = validateToolArguments('task_bulk_update', {
      task_ids: '["33333333-3333-4333-8333-333333333333"]',
      metadata: '{"batch":true}',
    });
    expect(out.task_ids).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(out.metadata).toEqual({ batch: true });
  });

  /* ── the safety-critical one ───────────────────────────────────────────────────────── */

  test('project.delete confirm — a BROKEN CONFIRM GATE is a safety issue, both ways', () => {
    // "true" must actually arm the gate…
    const armed = validateToolArguments('project_delete', {
      project: 'some-project',
      confirm: 'true',
    });
    expect(armed.confirm).toBe(true);

    // …and "false" must DISARM it. This is the case JS truthiness gets catastrophically
    // wrong: the non-empty string "false" is truthy, so a naive z.coerce.boolean() (or any
    // Boolean(v) rescue) would turn an explicit REFUSAL to confirm into a CONFIRMED DELETE.
    const disarmed = validateToolArguments('project_delete', {
      project: 'some-project',
      confirm: 'false',
    });
    expect(disarmed.confirm).toBe(false);
  });
});

/* ───────────────────────── 3. deny by default ───────────────────────── */

describe('DENY BY DEFAULT — a non-convertible value errors LOUDLY, never silently degrades', () => {
  // The governing rule. A value that cannot be converted without guessing must reach the
  // strict validator as the ORIGINAL STRING and be rejected. It must never be replaced by a
  // wrong-but-plausible stand-in — NaN, 0, [], {} or `true` — because that is precisely how a
  // loud error becomes a silent wrong answer.

  test('"abc" for a number ERRORS — it does not become NaN or 0', () => {
    expect(() => validateToolArguments('task_list', { limit: 'abc' })).toThrow();

    // Prove the mechanism, not just the throw: coercion left it strictly alone.
    const out = coerceArgsToDeclaredTypes((validationSchemas as any).task_list, { limit: 'abc' });
    expect(out.limit).toBe('abc');
    expect(Number.isNaN(out.limit as any)).toBe(false);
  });

  test('malformed JSON for an array ERRORS — it does not become [] (the dropped-filter bug)', () => {
    expect(() => validateToolArguments('task_list', { statuses: '[not json' })).toThrow();

    const out = coerceArgsToDeclaredTypes((validationSchemas as any).task_list, {
      statuses: '[not json',
    });
    expect(out.statuses).toBe('[not json');
    expect(Array.isArray(out.statuses)).toBe(false);
  });

  test('a JSON SCALAR for an array param stays a string — parsing succeeded but the shape is wrong', () => {
    // JSON.parse('"todo"') succeeds and yields a string. Accepting a successful parse alone
    // would silently hand z.array() a non-array; the shape check is what makes this loud.
    const out = coerceArgsToDeclaredTypes((validationSchemas as any).task_list, {
      statuses: '"todo"',
    });
    expect(out.statuses).toBe('"todo"');
    expect(() => validateToolArguments('task_list', { statuses: '"todo"' })).toThrow();
  });

  test('a JSON ARRAY for an object param stays a string — an array is not a record', () => {
    const out = coerceArgsToDeclaredTypes((validationSchemas as any).context_store, {
      metadata: '["a","b"]',
    });
    expect(out.metadata).toBe('["a","b"]');
  });

  test('"maybe" for a boolean ERRORS — it does not become true', () => {
    expect(() =>
      validateToolArguments('project_delete', { project: 'p', confirm: 'maybe' }),
    ).toThrow();

    const out = coerceArgsToDeclaredTypes((validationSchemas as any).project_delete, {
      confirm: 'maybe',
    });
    expect(out.confirm).toBe('maybe');
    expect(out.confirm).not.toBe(true);
  });

  test('a decimal for an INTEGER param errors loudly rather than being silently truncated', () => {
    // Coercion converts "1.5" to the number 1.5 (honest), then z.number().int() rejects it.
    // The value the caller sent is never rounded/floored into a different request.
    expect(() => validateToolArguments('task_list', { limit: '1.5' })).toThrow();
  });
});

/* ───────────────────────── 4. declared strings are never touched ───────────────────────── */

describe('a DECLARED STRING param is returned byte-identical (cross-branch contract)', () => {
  // Coercion keys on the DECLARED type, so a string param is structurally out of scope.
  // `query` depends on this: it must reach the reserved-prefix guard exactly as typed —
  // no trim, no re-encode, no retype. Branch fix/id-notation-bug asserts the same property
  // at the (now-removed) transport seam; this is the equivalent assertion at the seam that
  // replaced it.

  const adversarial = [
    '["ref:resume"]', // looks like an array — must NOT be parsed, `query` is a string
    '[1,2,3]',
    '12345678', // looks like a number
    '071', // leading zero must survive
    'true', // looks like a boolean
    '{"k":"v"}', // looks like an object
    'id:071df00d-640a-485b-a1c8-7df2c783a67e',
    'tags:["ref:cp-gaps"]',
    '  id:071df00d  ', // whitespace must NOT be trimmed in transit
    'ref:resume — naïve ünïcode',
  ];

  test('context.search `query` survives every adversarial form untouched', () => {
    for (const q of adversarial) {
      const out = coerceArgsToDeclaredTypes((validationSchemas as any).context_search, {
        query: q,
      });
      expect(out.query, `coercion altered the query ${JSON.stringify(q)}`).toBe(q);
      expect(typeof out.query, `coercion retyped the query ${JSON.stringify(q)}`).toBe('string');
    }
  });

  test('GUARD THE GUARD — the same probe strings DO transform under a typed param', () => {
    // If these stop transforming, the assertions above have gone inert and prove nothing
    // (a check whose inputs cannot trigger the transform is not a guard).
    // Each probe is routed to a param whose DECLARED type matches its shape.
    const t = (op: string, args: any) => coerceArgsToDeclaredTypes((validationSchemas as any)[op], args);

    expect(t('context_search', { tags: '["ref:resume"]' }).tags).toEqual(['ref:resume']);
    expect(t('task_list', { limit: '12345678' }).limit).toBe(12345678);
    expect(t('task_list', { limit: '071' }).limit).toBe(71);
    expect(t('context_search', { includeArchived: 'true' }).includeArchived).toBe(true);
    expect(t('context_store', { metadata: '{"k":"v"}' }).metadata).toEqual({ k: 'v' });
  });

  test('an undeclared key is left entirely alone (coercion has no opinion on strict-key rejection)', () => {
    const out = coerceArgsToDeclaredTypes((validationSchemas as any).task_list, {
      notAParam: '["x"]',
    });
    expect(out.notAParam).toBe('["x"]');
  });
});

/* ───────────────────────── 5. the walker's own edges ───────────────────────── */

describe('coerceArgsToDeclaredTypes — structural edges', () => {
  test('a UNION param is deliberately NOT coerced (ambiguous target type)', () => {
    const schema = z.object({ mixed: z.union([z.string(), z.number()]).optional() });
    const out = coerceArgsToDeclaredTypes(schema, { mixed: '5' });
    expect(out.mixed).toBe('5');
  });

  test('an already-correctly-typed value is passed through untouched', () => {
    const schema = z.object({ n: z.number().optional(), a: z.array(z.string()).optional() });
    const arr = ['x'];
    const out = coerceArgsToDeclaredTypes(schema, { n: 3, a: arr });
    expect(out.n).toBe(3);
    expect(out.a).toBe(arr); // same reference — not re-created
  });

  test('non-object args and non-object schemas are returned unchanged', () => {
    expect(coerceArgsToDeclaredTypes(z.object({}), null)).toBe(null);
    expect(coerceArgsToDeclaredTypes(z.string(), { a: '1' })).toEqual({ a: '1' });
  });

  test('coercion reaches through .optional()/.default()/.refine() wrappers', () => {
    const schema = z.object({
      opt: z.number().optional(),
      def: z.number().default(5),
      ref: z
        .array(z.string())
        .refine((v) => v.length >= 0)
        .optional(),
    });
    const out = coerceArgsToDeclaredTypes(schema, { opt: '1', def: '2', ref: '["a"]' });
    expect(out.opt).toBe(1);
    expect(out.def).toBe(2);
    expect(out.ref).toEqual(['a']);
  });
});
