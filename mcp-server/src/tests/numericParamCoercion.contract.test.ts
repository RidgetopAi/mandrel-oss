/**
 * NUMERIC PARAM COERCION.
 *
 * THE INVARIANT THIS GUARDS
 * -------------------------
 * An MCP client that serializes tool arguments as JSON can send a numeric param as the STRING
 * "100" rather than the number 100. Every numeric param this server DECLARES must therefore
 * accept its own stringified form — and must still reject garbage.
 *
 * WHY A NEW GUARD, GIVEN dda7cf02 ALREADY EXISTS
 * ----------------------------------------------
 * validateToolArguments() runs coerceArgsToDeclaredTypes(), which rescues a
 * stringified value by looking up its DECLARED type. That central seam is why most of the bare
 * z.number() params in this file were not, in fact, live bugs. But it has two structural limits,
 * and both were measured, not assumed:
 *
 *   1. It walks the TOP-LEVEL object shape only, and
 *   2. It is DENY-BY-DEFAULT for ambiguous types — ZodUnion in particular.
 *
 * So `minTrust: z.union([trustBandEnum, z.number()...])` on recall_thread was NOT rescued.
 * Measured against live prod v0.17.0 (commit f689121) on 2026-07-30:
 *      minTrust: 0.5   -> 200, 29 nodes
 *      minTrust: "0.5" -> -32602 "'minTrust': Invalid input"
 * That param is not named `offset` and does not match the shape `name: z.number()`, which is
 * precisely why three consecutive sweeps (1 tool -> 3 tools -> 11 params) all missed it.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE  (CLASSES.md C3)
 * ------------------------------------------------------------
 * The population is EVERY numeric leaf reachable from EVERY entry of `validationSchemas`, found
 * by walking the zod trees at runtime: through wrappers (optional/default/effects/...), into
 * nested ZodObject shapes, into ZodArray/ZodSet elements, into ZodRecord values, and into every
 * arm of every ZodUnion / ZodDiscriminatedUnion. It is deliberately NOT:
 *   - a list of param names   (`offset` alone would have missed 8 of the 11 known instances),
 *   - a regex over the file   (Coordinator's `^\s+name: z.number()` missed 3 real shapes: the two
 *                              shared consts baseLimit/baseRelevanceScore and the union above),
 *   - the top-level shape     (that is the very scope limit that let this survive dda7cf02).
 * `validationSchemas` is the single object that every tool call resolves its schema from
 * (validation.ts:1362 and :1553), so it is the choke point every instance must pass through.
 * A new numeric param is covered the moment it is declared; nobody has to remember this file.
 *
 * THE ESCAPE HATCH IS CO-LOCATED, NOT CENTRAL (C3 corollary)
 * ---------------------------------------------------------------------
 * A param that legitimately must NOT coerce marks itself, at its declaration site, with
 *     .describe('@no-coerce: <written reason>')
 * The reason travels with the declaration and is visible to anyone reading the schema, instead
 * of sitting in an allow-list here that nobody reads. Any such exception is REPORTED by the
 * vacuity test below so it cannot accumulate silently. As of an earlier task there are zero.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { validationSchemas, validateToolArguments } from '../middleware/validation.js';

/* ───────────────────────── walk every numeric leaf in the declared surface ───────────────────────── */

/** Co-located opt-out marker; see the header. */
const NO_COERCE_MARKER = '@no-coerce:';

const WRAPPERS = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
  'ZodCatch',
  'ZodReadonly',
  'ZodPromise',
  'ZodLazy',
]);

interface Leaf {
  /** `tool.a.b` — the path a human needs to find the declaration. */
  path: string;
  /** The declared schema AS DECLARED (wrappers intact) — what we actually parse against. */
  declared: any;
  /** True when the numeric leaf carries `.int()`. */
  isInt: boolean;
  /** The `@no-coerce:` reason found anywhere on this param's wrapper chain, if any. */
  noCoerceReason: string | null;
}

function descriptionsOf(s: any): string[] {
  const out: string[] = [];
  let cur = s;
  for (let i = 0; i < 30 && cur; i++) {
    if (typeof cur?._def?.description === 'string') out.push(cur._def.description);
    const t = cur?._def?.typeName;
    if (!t || !WRAPPERS.has(t)) break;
    cur = t === 'ZodEffects' ? cur._def.schema : (cur._def.innerType ?? cur._def.getter?.());
  }
  return out;
}

function strip(s: any): any {
  for (let i = 0; i < 30; i++) {
    const t = s?._def?.typeName;
    if (!t || !WRAPPERS.has(t)) break;
    const next =
      t === 'ZodEffects' ? s._def.schema : t === 'ZodLazy' ? s._def.getter?.() : s._def.innerType;
    if (!next) break;
    s = next;
  }
  return s;
}

/** Does this ZodNumber carry an `.int()` check? */
function hasIntCheck(num: any): boolean {
  return (num?._def?.checks ?? []).some((c: any) => c.kind === 'int');
}

/**
 * Recursively collect every numeric leaf under `node`. `declaredForParse` is the schema we will
 * actually feed the probe value to: for a plain object property that is the property itself; for
 * a union arm it stays the WHOLE union, because that is what a caller's value is parsed against
 * and therefore what must accept the string.
 */
function collect(
  node: any,
  path: string,
  out: Leaf[],
  seen: Set<any>,
  declaredForParse?: any,
): void {
  if (!node || seen.has(node)) return;
  seen.add(node);

  const target = declaredForParse ?? node;
  const reason =
    descriptionsOf(node)
      .concat(declaredForParse ? descriptionsOf(declaredForParse) : [])
      .find((d) => d.includes(NO_COERCE_MARKER)) ?? null;

  const base = strip(node);
  const t = base?._def?.typeName;

  switch (t) {
    case 'ZodNumber':
      out.push({
        path,
        declared: target,
        isInt: hasIntCheck(base),
        noCoerceReason: reason
          ? reason.slice(reason.indexOf(NO_COERCE_MARKER) + NO_COERCE_MARKER.length).trim()
          : null,
      });
      return;

    case 'ZodObject': {
      const shape = typeof base.shape === 'function' ? base.shape() : base.shape;
      for (const [k, v] of Object.entries<any>(shape ?? {})) {
        collect(v, `${path}.${k}`, out, seen);
      }
      return;
    }

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options: any[] = base._def.options
        ? Array.from(base._def.options.values ? base._def.options.values() : base._def.options)
        : [];
      // The whole union stays the parse target — a caller's value meets the union, not the arm.
      options.forEach((opt, i) => collect(opt, `${path}|arm${i}`, out, seen, target));
      return;
    }

    case 'ZodArray':
      collect(base._def.type, `${path}[]`, out, seen);
      return;
    case 'ZodSet':
      collect(base._def.valueType, `${path}{}`, out, seen);
      return;
    case 'ZodRecord':
      collect(base._def.valueType, `${path}[*]`, out, seen);
      return;
    case 'ZodTuple':
      (base._def.items ?? []).forEach((it: any, i: number) =>
        collect(it, `${path}[${i}]`, out, seen),
      );
      return;
    case 'ZodIntersection':
      collect(base._def.left, `${path}&L`, out, seen, target);
      collect(base._def.right, `${path}&R`, out, seen, target);
      return;
    default:
      return;
  }
}

/** THE POPULATION. Every numeric leaf in every declared tool schema. */
function numericLeaves(): Leaf[] {
  const out: Leaf[] = [];
  for (const [tool, schema] of Object.entries<any>(validationSchemas as any)) {
    // `seen` is per-tool: shared bases (baseLimit) are reachable from several tools and each
    // tool's own path must be reported, but a cycle inside ONE tool must still terminate.
    collect(schema, tool, out, new Set());
  }
  return out;
}

/** Parse `value` against a param's declared schema in isolation. */
function accepts(declared: any, value: unknown): { ok: boolean; parsed?: unknown } {
  const r = (declared as z.ZodTypeAny).safeParse(value);
  return r.success ? { ok: true, parsed: r.data } : { ok: false };
}

/* ───────────────────────── 1. the fail-closed sweep ───────────────────────── */

describe('every declared numeric param accepts its stringified form (whole-surface, fails closed)', () => {
  const leaves = numericLeaves();

  test('a numeric param declared anywhere in validationSchemas coerces "N" to N', () => {
    const failures: string[] = [];

    for (const leaf of leaves) {
      if (leaf.noCoerceReason !== null) continue; // co-located, reasoned opt-out

      // Probe with a value inside every bound we ship: 1 satisfies .positive()/.min(1) and is
      // under every .max(); it is also a legal member of the [0,1] float ranges.
      //
      // A leaf whose bounds EXCLUDE 1 (e.g. .min(2)) cannot be probed this way — but it must
      // NOT be skipped silently. This block used to `continue`, which meant such a param would
      // drop out of the sweep with no marker, no report and no RED: the "guard walks nothing"
      // failure scoped to a single leaf, inside the very guard built to prevent it (Reviewer
      // N1, 2026-07-30). Measured exposure when written: ZERO — all 25 leaves admit 1 — so this
      // is closing a latent hole, not a live one. An unprobeable leaf is now a FAILURE that
      // names itself and demands either a probe value or an explicit @no-coerce reason.
      const asNumber = accepts(leaf.declared, 1);
      if (!asNumber.ok) {
        failures.push(
          `${leaf.path} — UNPROBEABLE: the probe value 1 is outside this param's bounds, so ` +
            `its coercion was never actually asserted. Do not let it skip silently — give the ` +
            `sweep a probe value drawn from this leaf's own bounds, or mark the declaration ` +
            `with .describe('${NO_COERCE_MARKER} <reason>') if it must not coerce.`,
        );
        continue;
      }
      const asString = accepts(leaf.declared, '1');

      if (!asString.ok) {
        failures.push(
          `${leaf.path} — declared numeric REJECTS the string "1" that a JSON-serializing MCP ` +
            `client sends. Wrap it: ${leaf.isInt ? 'coercedInt' : 'coercedFloat'}(<the existing schema>). ` +
            `If it must NOT coerce, mark it at the declaration with .describe('${NO_COERCE_MARKER} <reason>').`,
        );
      } else if (asString.parsed !== asNumber.parsed) {
        failures.push(
          `${leaf.path} — "1" parsed to ${JSON.stringify(asString.parsed)} but 1 parsed to ` +
            `${JSON.stringify(asNumber.parsed)}; the string and number forms must agree.`,
        );
      }
    }

    expect(
      failures,
      `\nUNCOERCED NUMERIC PARAM(S) — each rejects a legitimate bridge/MCP client:\n  ${failures.join('\n  ')}\n`,
    ).toEqual([]);
  });

  /* ── VACUITY GUARDS: "found nothing" must be RED, not a silent pass (C3: probe the empty
     and zero populations — those are the values that slip through). ────────────────────── */

  test('the walk is not vacuous — it found numeric leaves across many tools', () => {
    // MEASURED on the surface as built (2026-07-30), by walking
    // validationSchemas: 25 numeric leaves across 16 of the 65 declared tools. These are
    // FLOORS, not equalities — adding a numeric param must never require editing this test,
    // but the walk silently returning nothing must be RED.
    expect(Object.keys(validationSchemas as any).length).toBeGreaterThanOrEqual(65);
    expect(leaves.length, 'the schema walk found no/too few numeric params — it is broken')
      .toBeGreaterThanOrEqual(25);
    expect(new Set(leaves.map((l) => l.path.split('.')[0])).size).toBeGreaterThanOrEqual(16);
  });

  test('the walk reaches the shapes that defeated the earlier sweeps', () => {
    const paths = leaves.map((l) => l.path);
    // A union arm — the shape coerceArgsToDeclaredTypes denies by default, and the one
    // instance that was genuinely live on prod.
    expect(paths.some((p) => p.startsWith('recall_thread.minTrust'))).toBe(true);
    // A param reached through a SHARED const (baseLimit), invisible to a per-line regex.
    expect(paths).toContain('task_list.limit');
    expect(paths).toContain('context_search.limit');
    // A .default()-wrapped one and a float one.
    expect(paths).toContain('context_get_recent.limit');
    expect(paths).toContain('context_search.minSimilarity');
  });

  test('every @no-coerce exception is surfaced with its written reason', () => {
    const exceptions = leaves.filter((l) => l.noCoerceReason !== null);
    // Not an assertion that there are none — it is a REPORT, so an exception cannot be added
    // without a reason, and the set is visible in the test output rather than buried.
    for (const e of exceptions) {
      expect(e.noCoerceReason, `${e.path} opts out of coercion with an EMPTY reason`).toBeTruthy();
    }
    expect(exceptions.map((e) => `${e.path}: ${e.noCoerceReason}`)).toEqual([]);
  });
});

/* ───────────────────────── 2. coercion did NOT become a bypass ───────────────────────── */

describe('coercion still REJECTS garbage — a validation fix must not become a validation hole', () => {
  const leaves = numericLeaves().filter((l) => l.noCoerceReason === null);

  test('"abc" and "" are rejected by every numeric param', () => {
    const failures: string[] = [];
    for (const leaf of leaves) {
      for (const junk of ['abc', '', '   ', 'NaN', '1e999999', '0x10', '1,000']) {
        if (accepts(leaf.declared, junk).ok) {
          failures.push(`${leaf.path} ACCEPTED junk ${JSON.stringify(junk)}`);
        }
      }
    }
    expect(failures, `\nCOERCION BECAME A HOLE:\n  ${failures.join('\n  ')}\n`).toEqual([]);
  });

  test('"1.5" is rejected by every INT param (coercion must not silently truncate)', () => {
    const failures: string[] = [];
    for (const leaf of leaves) {
      if (!leaf.isInt) continue;
      for (const junk of ['1.5', '1.0', ' 2.5 ']) {
        if (accepts(leaf.declared, junk).ok) {
          failures.push(`${leaf.path} (int) ACCEPTED ${JSON.stringify(junk)}`);
        }
      }
    }
    expect(failures, `\nINT PARAMS ACCEPTING DECIMALS:\n  ${failures.join('\n  ')}\n`).toEqual([]);
  });

  test('bounds still bind after coercion — out-of-range strings are rejected', () => {
    // Named cases, because a bound is per-param. Each is "the string form of a value the
    // number form also rejects" — coercion must change the TYPE, never the VERDICT.
    const cases: Array<[string, string, unknown]> = [
      ['task_list', 'offset', '-1'], // .min(0)
      ['context_search', 'offset', '-1'], // .min(0)
      ['context_search', 'minSimilarity', '101'], // .max(100)
      ['context_search', 'minSimilarity', '-0.5'], // .min(0)
      ['context_get_recent', 'limit', '0'], // .min(1)
      ['context_get_recent', 'limit', '21'], // .max(20)
      ['task_update', 'progress', '101'], // .max(100)
      ['task_update', 'progress', '-1'], // .min(0)
      ['task_claim', 'leaseSeconds', '0'], // .positive()
      ['task_claim', 'leaseSeconds', '-30'], // .positive()
      ['task_renew', 'leaseSeconds', '0'], // .positive()
      ['task_claim', 'expectedVersion', '-1'], // .min(0)
      ['session_list', 'offset', '-1'], // .min(0)
      ['session_list', 'limit', '0'], // .positive()
      ['context_artifact', 'index', '-1'], // .min(0)
      ['recall_thread', 'minTrust', '1.5'], // .max(1) on the numeric arm
    ];
    const byPath = new Map(numericLeaves().map((l) => [l.path, l]));
    const failures: string[] = [];
    for (const [tool, param, bad] of cases) {
      const leaf =
        byPath.get(`${tool}.${param}`) ??
        [...byPath.entries()].find(([p]) => p.startsWith(`${tool}.${param}|`))?.[1];
      if (!leaf) {
        failures.push(`${tool}.${param} — NOT FOUND by the walk (the guard lost a param)`);
        continue;
      }
      if (accepts(leaf.declared, bad).ok) {
        failures.push(`${tool}.${param} accepted out-of-bounds ${JSON.stringify(bad)}`);
      }
    }
    expect(failures, `\nBOUNDS NOT ENFORCED AFTER COERCION:\n  ${failures.join('\n  ')}\n`).toEqual(
      [],
    );
  });
});

/* ───────────────────────── 3. end-to-end through the real validator ───────────────────────── */

describe('the string form works end-to-end through validateToolArguments (the seam both surfaces cross)', () => {
  const TASK_ID = '11111111-1111-4111-8111-111111111111';
  const CLAIM_ID = '22222222-2222-4222-8222-222222222222';

  // (label, tool, base args, param, string sent, number sent)
  const cases: Array<[string, string, Record<string, unknown>, string, string, number]> = [
    ['task_list offset', 'task_list', {}, 'offset', '5', 5],
    ['task_list limit (shared baseLimit)', 'task_list', {}, 'limit', '25', 25],
    ['context_search minSimilarity (FLOAT)', 'context_search', { query: 'x' }, 'minSimilarity', '42.5', 42.5],
    ['context_search offset', 'context_search', { query: 'x' }, 'offset', '5', 5],
    ['context_get_recent limit (.default)', 'context_get_recent', {}, 'limit', '7', 7],
    ['context_artifact index', 'context_artifact', { id: TASK_ID }, 'index', '2', 2],
    ['session_list limit', 'session_list', {}, 'limit', '9', 9],
    ['session_list offset', 'session_list', {}, 'offset', '3', 3],
    ['task_update progress', 'task_update', { taskId: TASK_ID }, 'progress', '20', 20],
    ['task_claim expectedVersion', 'task_claim', { taskId: TASK_ID }, 'expectedVersion', '3', 3],
    ['task_claim leaseSeconds', 'task_claim', { taskId: TASK_ID }, 'leaseSeconds', '900', 900],
    ['task_renew leaseSeconds', 'task_renew', { taskId: TASK_ID, claimId: CLAIM_ID }, 'leaseSeconds', '900', 900],
    ['recall_thread minTrust (UNION — live on prod)', 'recall_thread', { anchor: 'ref:x' }, 'minTrust', '0.5', 0.5],
    ['context_store relevanceScore (shared base)', 'context_store', { content: 'x', type: 'code' }, 'relevanceScore', '7', 7],
  ];

  test.each(cases)('%s — string and number produce the same parsed value', (_l, tool, base, param, sent, num) => {
    const fromString = validateToolArguments(tool, { ...base, [param]: sent });
    const fromNumber = validateToolArguments(tool, { ...base, [param]: num });
    expect(fromString[param]).toBe(num);
    expect(fromString[param]).toBe(fromNumber[param]);
    expect(typeof fromString[param]).toBe('number');
  });

  test('recall_thread minTrust still accepts a BAND name — the union arm coercion must not eat', () => {
    const out = validateToolArguments('recall_thread', { anchor: 'ref:x', minTrust: 'trusted' });
    expect(out.minTrust).toBe('trusted');
  });

  test('garbage still fails LOUDLY at the seam, not silently', () => {
    for (const bad of ['abc', '1.5', '', '-1']) {
      expect(
        () => validateToolArguments('task_list', { offset: bad }),
        `task_list offset accepted ${JSON.stringify(bad)}`,
      ).toThrow(/Validation failed for task_list/);
    }
  });
});
