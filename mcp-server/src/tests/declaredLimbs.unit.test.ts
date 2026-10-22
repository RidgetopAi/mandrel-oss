/**
 * DECLARED LIMBS — the derivation's edge populations. BRANCH-1.
 *
 * The golden parity test proves the rule matches the one that was MEASURED, over the 192
 * records that were measured. That population had zero ambiguous prefixes, so it cannot
 * say anything about what happens when live resolution collides — and ambiguity is the one
 * behaviour that only appears at live scale (the eval resolved against 192 records; prod
 * resolves against ~14,000). This file probes the populations the golden file does not
 * contain: AMBIGUOUS, UNRESOLVED, NOT-A-LIMB-ROOT, and EMPTY.
 *
 * Pure: no database. The resolver is built from an explicit row list, which is the same
 * `buildId8Resolver` the write path and the backfill both use.
 */

import { describe, test, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  buildId8Resolver,
  deriveDeclaredLimbs,
  collectNamedId8s,
  composeLimbBody,
} from '../services/declaredLimbs.js';
import {
  DECLARED_LIMBS_CONFIG,
  declaredLimbsFlagSummary,
  parseBooleanFlag,
} from '../config/declaredLimbsConfig.js';

const TASK_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TASK_A_TWIN = 'aaaaaaaa-2222-4222-8222-222222222222'; // same first 8 hex as TASK_A
const DECISION_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const CONTEXT_C = 'cccccccc-1111-4111-8111-111111111111';
const SELF_CTX = 'dddddddd-1111-4111-8111-111111111111';
const SELF_TASK = 'eeeeeeee-1111-4111-8111-111111111111';

/** Universe WITHOUT the twin: every prefix resolves uniquely. */
const unique = buildId8Resolver([
  { id: TASK_A, type: 'task' },
  { id: DECISION_B, type: 'decision' },
  { id: CONTEXT_C, type: 'context' },
  { id: SELF_TASK, type: 'task' },
]);

/** Same universe PLUS a record sharing TASK_A's 8-hex prefix — the live collision case. */
const colliding = buildId8Resolver([
  { id: TASK_A, type: 'task' },
  { id: TASK_A_TWIN, type: 'task' },
  { id: DECISION_B, type: 'decision' },
  { id: CONTEXT_C, type: 'context' },
]);

describe('declared limbs — resolution outcomes', () => {
  test('a tag and a body mention both resolve to limb roots', () => {
    const out = deriveDeclaredLimbs(
      {
        id: SELF_CTX,
        type: 'context',
        body: `Shipped it. See decision ${DECISION_B.slice(0, 8)} for why.`,
        tags: [`task:${TASK_A.slice(0, 8)}`],
      },
      unique
    );
    expect(out.limbs).toEqual([TASK_A, DECISION_B].sort());
    expect(out.ambiguousDrops).toBe(0);
  });

  test('AMBIGUOUS prefix is DROPPED and COUNTED — never guessed', () => {
    const out = deriveDeclaredLimbs(
      {
        id: SELF_CTX,
        type: 'context',
        body: `mentions ${TASK_A.slice(0, 8)} once`,
        tags: [`task:${TASK_A.slice(0, 8)}`],
      },
      colliding
    );
    // Neither of the two colliding records is invented into the set.
    expect(out.limbs).toEqual([]);
    expect(out.limbs).not.toContain(TASK_A);
    expect(out.limbs).not.toContain(TASK_A_TWIN);
    // Two independent mentions (one tag, one body) → two counted drops. The count is what
    // makes the derivation's own error rate queryable instead of swallowed.
    expect(out.ambiguousDrops).toBe(2);
  });

  test('an id8 resolving to a CONTEXT is not a limb root — dropped, and NOT counted as ambiguous', () => {
    const out = deriveDeclaredLimbs(
      { id: SELF_CTX, type: 'context', body: `see ${CONTEXT_C.slice(0, 8)}`, tags: [] },
      unique
    );
    expect(out.limbs).toEqual([]);
    expect(out.ambiguousDrops).toBe(0);
  });

  test('an id8 matching NO record contributes nothing and is not an error', () => {
    const out = deriveDeclaredLimbs(
      { id: SELF_CTX, type: 'context', body: 'deadbeef and 0badf00d', tags: [] },
      unique
    );
    expect(out.limbs).toEqual([]);
    expect(out.ambiguousDrops).toBe(0);
  });
});

describe('declared limbs — the empty and self populations', () => {
  test('a context with no tags and no ids declares NOTHING (empty, not null)', () => {
    const out = deriveDeclaredLimbs({ id: SELF_CTX, type: 'context', body: '', tags: [] }, unique);
    expect(out.limbs).toEqual([]);
  });

  test('a task with no tags and no ids still declares ITSELF (a task IS a limb root)', () => {
    const out = deriveDeclaredLimbs({ id: SELF_TASK, type: 'task', body: '', tags: [] }, unique);
    expect(out.limbs).toEqual([SELF_TASK]);
  });

  test('a repeated mention yields ONE limb but is a set, not a multiset', () => {
    const id8 = TASK_A.slice(0, 8);
    const out = deriveDeclaredLimbs(
      { id: SELF_CTX, type: 'context', body: `${id8} ${id8} ${id8}`, tags: [`task:${id8}`] },
      unique
    );
    expect(out.limbs).toEqual([TASK_A]);
  });
});

describe('declared limbs — what must NOT be read as an id or a tag', () => {
  test('a 40-char commit sha does not yield an id8 (word-bounded pattern)', () => {
    const sha = '938a7e89a919ba3ffb326f49bb2e6579de369484';
    expect(collectNamedId8s({ id: SELF_CTX, type: 'context', body: sha, tags: [] }).bodyId8s).toEqual(
      []
    );
  });

  test('a non-limb tag prefix is ignored, and uppercase hex is not an id8', () => {
    const named = collectNamedId8s({
      id: SELF_CTX,
      type: 'context',
      body: 'AAAAAAAA is not an id8',
      tags: ['ref:branch-model', 'context:aaaaaaaa', `task:${TASK_A.slice(0, 8)}`],
    });
    expect(named.tagId8s).toEqual([TASK_A.slice(0, 8)]);
    expect(named.bodyId8s).toEqual([]);
  });
});

describe('declared limbs — body composition per record kind', () => {
  // The SQL equivalence of these expressions is asserted against a live Postgres in
  // declaredLimbsRederive.contract.test.ts; here we pin the JavaScript-side shape.
  test('a task body is title + newline + description, with NULLs as empty segments', () => {
    expect(composeLimbBody('task', { title: 'T', description: null })).toBe('T\n');
    expect(composeLimbBody('task', { title: null, description: 'D' })).toBe('\nD');
  });

  test('a decision body SKIPS null segments (concat_ws), it does not blank them', () => {
    expect(
      composeLimbBody('decision', {
        title: 'T',
        description: null,
        rationale: 'R',
        problem_statement: null,
        outcome_notes: null,
      })
    ).toBe('T\nR');
  });

  test('an empty-string segment is kept, unlike a null', () => {
    expect(
      composeLimbBody('decision', { title: 'T', description: '', rationale: null })
    ).toBe('T\n');
  });
});

describe('the kill switch can actually be pulled, and reads back', () => {
  // A kill switch is only a kill switch if an operator reaching for it mid-incident hits it.
  // The first version accepted ONLY exact lowercase `false`, so `FALSE`/`0`/`off` left the
  // feature ON with no warning. These are the spellings a human actually types.
  //
  // Asserted against the PARSER the config reads, not by reloading the config module:
  // vi.resetModules() tears down the module registry for every file that runs after this
  // one in the shared fork (measured — it broke the next contract file's database pool).
  test.each(['false', 'FALSE', 'False', '0', 'off', 'OFF', 'no', ' false '])(
    'MANDREL_LIMBS_WRITE_TIME_ENABLED=%j turns it OFF',
    raw => {
      expect(parseBooleanFlag(raw, true)).toBe(false);
    }
  );

  test.each(['true', 'TRUE', '1', 'on', 'yes', ' TRUE '])('%j turns it ON', raw => {
    expect(parseBooleanFlag(raw, false)).toBe(true);
  });

  test('unset, empty and garbage fall back to the default — in BOTH directions', () => {
    for (const raw of [undefined, '', 'maybe']) {
      expect(parseBooleanFlag(raw, true)).toBe(true);
      expect(parseBooleanFlag(raw, false)).toBe(false);
    }
  });

  test('the live flag IS the parser applied to the env var — no second reading', () => {
    // WHY A CHILD PROCESS AND NOT AN IN-PROCESS COMPARE. The obvious form of this test —
    //   expect(CONFIG.writeTimeDerivationEnabled).toBe(parseBooleanFlag(process.env.X, true))
    // — is VACUOUS in the environment it actually runs in. CI and every local run leave the
    // var UNSET, so both sides collapse to the same fallback `true` and the assertion compares
    // a value to itself. Measured: replacing the config line with a literal `true` (i.e.
    // deleting the wiring entirely) left that form 29/29 GREEN. The table above would then have
    // been true of a parser nothing calls — the exact thing the test claimed to prevent.
    //
    // The config is read once at module load, and vi.resetModules() is not an option here: it
    // was tried and it broke the next contract file's database pool in the shared fork. So the
    // only honest way to prove the env var reaches the live config is to start a process with
    // it set and ask that process what it got.
    const read = (env: Record<string, string>): string =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '-e',
         "import('./src/config/declaredLimbsConfig.ts').then(m => " +
         "process.stdout.write(String(m.DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled)))"],
        { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf-8' },
      ).trim();

    // An OFF spelling must actually reach the config — this is the leg that catches a deleted
    // or hardcoded wiring, and it cannot pass by coincidence with the default.
    expect(read({ MANDREL_LIMBS_WRITE_TIME_ENABLED: 'off' })).toBe('false');
    // ...and an ON spelling must too, so a config hardcoded to `false` fails as well.
    expect(read({ MANDREL_LIMBS_WRITE_TIME_ENABLED: 'yes' })).toBe('true');
    // Garbage falls back to the documented default rather than to `false`.
    expect(read({ MANDREL_LIMBS_WRITE_TIME_ENABLED: 'maybe' })).toBe('true');
  });

  test('the read-back string states the EFFECTIVE value', () => {
    expect(declaredLimbsFlagSummary()).toContain(
      DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled ? 'ON' : 'OFF'
    );
  });
});
