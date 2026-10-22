/**
 * THREAD TERMINALITY — the PURE rule + its flag (BRANCH-2).
 *
 * The BEHAVIOUR (does the walk actually stop at a shared record) is asserted end-to-end in
 * threadTerminality.contract.test.ts against a real database. THIS file covers the two
 * things that cannot be reached from there: the exact decision table of the rule —
 * including its EMPTY and NEVER-DERIVED populations — and the flag parse, including that
 * the env var reaches the live config rather than a parser nothing calls.
 */

import { describe, test, expect } from 'vitest';
import { execFileSync } from 'child_process';
import {
  buildAnchorCone,
  decideExpansion,
  limbOverlapFraction,
  newTerminalityTelemetry,
  recordTerminalityDecision,
} from '../services/threadTerminality.js';
import {
  THREAD_TERMINALITY_CONFIG,
  THREAD_TERMINALITY_DEFAULT,
  THREAD_TERMINALITY_ENV,
  THREAD_TERMINALITY_THETA_DEFAULT,
  readOverlapThreshold,
  readThreadTerminalityFlag,
  threadTerminalityFlagSummary,
  type ThreadTerminalityConfig,
} from '../config/threadTerminalityConfig.js';

/** The shipped rule's parameters, as a config object the pure rule accepts. */
const ON: ThreadTerminalityConfig = {
  mode: 'on',
  modeSource: 'explicit',
  transitOverlapThreshold: THREAD_TERMINALITY_THETA_DEFAULT,
  unassignableTerminal: true,
  notDerivedTerminal: false,
};

const A = '11111111-1111-4111-8111-111111111111'; // the anchor
const B = '22222222-2222-4222-8222-222222222222'; // a limb root the anchor names
const X = '33333333-3333-4333-8333-333333333333'; // a limb root elsewhere
const N = '44444444-4444-4444-8444-444444444444'; // some node being judged

describe('terminality — the cone', () => {
  test('cone(anchor) = {anchor} ∪ the limb roots the anchor names', () => {
    expect([...buildAnchorCone(A, [B, X])].sort()).toEqual([A, B, X].sort());
  });

  test('an anchor that declares nothing still yields the degenerate cone {anchor}', () => {
    // Both "derived, names nothing" and "never derived" collapse to the same cone here —
    // which is correct: neither tells us about any OTHER limb. What they must not do is
    // make the ANCHOR itself terminal; that is asserted in the decision table below.
    expect([...buildAnchorCone(A, [])]).toEqual([A]);
    expect([...buildAnchorCone(A, null)]).toEqual([A]);
  });
});

describe('terminality — the overlap fraction', () => {
  const cone = buildAnchorCone(A, [B]);

  test('overlap is a RATIO of what the record names, not a count', () => {
    expect(limbOverlapFraction([B], cone)).toBe(1);
    expect(limbOverlapFraction([B, X], cone)).toBe(0.5);
    expect(limbOverlapFraction([X], cone)).toBe(0);
    // Four limbs, one of them the branch: the shape that separates 772b810b (labeled IN)
    // from ab1f2f06 (labeled OUT) — a count cannot, a fraction can.
    expect(limbOverlapFraction([B, X, N, A], cone)).toBe(0.5);
  });

  test('a repeated limb does not inflate the denominator', () => {
    expect(limbOverlapFraction([X, X, X, B], cone)).toBe(0.5);
  });

  test('an EMPTY limb set throws rather than scoring 0 — it is a different state', () => {
    // Scoring [] as 0 would silently fold "declares nothing" into "declares elsewhere".
    // They get different reasons in the telemetry and different config knobs, so the
    // arithmetic path must refuse the input outright.
    expect(() => limbOverlapFraction([], cone)).toThrow(/unassignable/);
  });
});

describe('terminality — the decision table', () => {
  const cone = buildAnchorCone(A, [B]);

  test('the ANCHOR is always expandable', () => {
    // Refusing the anchor returns a one-node thread, which measures nothing.
    for (const limbs of [null, [], [X]]) {
      expect(decideExpansion(A, A, limbs, cone, ON)).toMatchObject({
        canExpand: true,
        reason: 'anchor',
      });
    }
  });

  test('a record naming the branch is a CORRIDOR', () => {
    expect(decideExpansion(N, A, [B], cone, ON)).toMatchObject({
      canExpand: true,
      reason: 'expandable',
      overlap: 1,
    });
  });

  test('a record naming mostly OTHER work is a DESTINATION, not a corridor', () => {
    expect(decideExpansion(N, A, [X], cone, ON)).toMatchObject({
      canExpand: false,
      reason: 'below-threshold',
      overlap: 0,
    });
  });

  test('at the shipped threshold, ANY overlap is enough to transit', () => {
    // The measured rule (C4) is effectively "any overlap at all": 0.25 must pass at 0.01.
    expect(decideExpansion(N, A, [B, X, N, A], cone, ON).canExpand).toBe(true);
    // ...and the same node is terminal once the threshold is raised past that fraction,
    // which is what proves the threshold is READ rather than decorative.
    expect(
      decideExpansion(N, A, [B, X, N, A], cone, { ...ON, transitOverlapThreshold: 0.7 })
        .canExpand
    ).toBe(false);
  });

  // ── THE POPULATIONS THAT SLIP THROUGH: empty and never-derived ──────────────
  test('EMPTY (derived, declares nothing) is UNASSIGNABLE and terminal by default', () => {
    // 57% of the live corpus is this population. It is the clause that does most of the
    // work: a record that says nothing about where it belongs cannot vouch for the walk.
    expect(decideExpansion(N, A, [], cone, ON)).toMatchObject({
      canExpand: false,
      reason: 'unassignable',
      overlap: null,
    });
    expect(
      decideExpansion(N, A, [], cone, { ...ON, unassignableTerminal: false }).canExpand
    ).toBe(true);
  });

  test('NULL (never derived) is NOT the same state as empty, and is permissive', () => {
    // C1's third state. NULL means the column was never derived — a row written while
    // BRANCH-1's hook was off, or one the backfill has not reached. Pruning on it would
    // act on a fact we do not have, so the default keeps it expandable and COUNTS it.
    expect(decideExpansion(N, A, null, cone, ON)).toMatchObject({
      canExpand: true,
      reason: 'not-derived',
      overlap: null,
    });
    expect(
      decideExpansion(N, A, null, cone, { ...ON, notDerivedTerminal: true }).canExpand
    ).toBe(false);
  });

  test('the two undecidable states get DIFFERENT reasons, so telemetry can tell them apart', () => {
    expect(decideExpansion(N, A, [], cone, ON).reason).not.toBe(
      decideExpansion(N, A, null, cone, ON).reason
    );
  });
});

describe('terminality — telemetry (the stranger-cliff instrument)', () => {
  test('counts every reason and reports declared-limb coverage of the traversed set', () => {
    const cone = buildAnchorCone(A, [B]);
    const t = newTerminalityTelemetry(cone.size);
    const judge = (id: string, limbs: readonly string[] | null) =>
      recordTerminalityDecision(t, id, limbs, decideExpansion(id, A, limbs, cone, ON));

    judge(A, [B]); // anchor
    judge('n1', [B]); // expandable
    judge('n2', [X]); // below-threshold
    judge('n3', []); // unassignable
    judge('n4', null); // not-derived

    expect(t.judged).toBe(5);
    expect(t.expanded).toBe(3); // anchor + expandable + not-derived(permissive)
    expect(t.terminal).toBe(2);
    expect(t.byReason).toEqual({
      anchor: 1,
      expandable: 1,
      'below-threshold': 1,
      unassignable: 1,
      'not-derived': 1,
    });
    // COVERAGE: this is the number that says whether live data looks like the eval data.
    expect(t.coverage).toEqual({ derived: 3, notDerived: 1, unassignable: 1 });
    // WHY each node was terminal, per node — the required guard, not an aggregate.
    expect(t.terminalNodes).toEqual([
      { id: 'n2', reason: 'below-threshold', overlap: 0 },
      { id: 'n3', reason: 'unassignable', overlap: null },
    ]);
  });

  test('a thread where NOTHING declares a limb reports 100% unassignable coverage', () => {
    // The EMPTY POPULATION end to end through the telemetry: every node terminal, and the
    // coverage number says so rather than the walk quietly returning a stub.
    const cone = buildAnchorCone(A, []);
    const t = newTerminalityTelemetry(cone.size);
    for (const id of [A, 'n1', 'n2', 'n3']) {
      recordTerminalityDecision(t, id, [], decideExpansion(id, A, [], cone, ON));
    }
    expect(t.coverage).toEqual({ derived: 0, notDerived: 0, unassignable: 4 });
    expect(t.expanded).toBe(1); // the anchor, and nothing else
    expect(t.terminal).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FLAG
// ─────────────────────────────────────────────────────────────────────────────

describe('terminality flag — polarity and parse', () => {
  test('the CODE DEFAULT is OFF', () => {
    expect(THREAD_TERMINALITY_DEFAULT).toBe('off');
  });

  test('ABSENT resolves to the default, and says it was absent', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(readThreadTerminalityFlag(raw)).toEqual({ mode: 'off', source: 'absent' });
    }
  });

  test('GARBAGE resolves to OFF and reports WHICH value was rejected', () => {
    // An operator who typed `treu` mid-revert must be able to see from the read-back that
    // their value was thrown away, not believe they turned something on.
    expect(readThreadTerminalityFlag('treu')).toEqual({
      mode: 'off',
      source: 'unparseable',
      rejectedValue: 'treu',
    });
    expect(readThreadTerminalityFlag('maybe').mode).toBe('off');
    expect(readThreadTerminalityFlag('2').mode).toBe('off');
  });

  // BRANCH-1's kill switch shipped accepting only exact lowercase `false` and Reviewer
  // caught it failing OPEN. These are the spellings a human actually types.
  test.each(['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', ' true '])(
    '%j turns terminality ON',
    (raw) => {
      expect(readThreadTerminalityFlag(raw)).toEqual({ mode: 'on', source: 'explicit' });
    }
  );

  test.each(['0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF', ' OFF '])(
    '%j turns terminality OFF explicitly',
    (raw) => {
      expect(readThreadTerminalityFlag(raw)).toEqual({ mode: 'off', source: 'explicit' });
    }
  );

  test('the threshold falls back on garbage AND on out-of-range — never clamps', () => {
    expect(readOverlapThreshold(undefined)).toBe(THREAD_TERMINALITY_THETA_DEFAULT);
    expect(readOverlapThreshold('0.7')).toBe(0.7);
    expect(readOverlapThreshold('0')).toBe(0);
    expect(readOverlapThreshold('1')).toBe(1);
    // A `theta` of 5 is a typo. Clamping it to 1 would silently run the strictest
    // possible rule; falling back runs the measured one.
    expect(readOverlapThreshold('5')).toBe(THREAD_TERMINALITY_THETA_DEFAULT);
    expect(readOverlapThreshold('-1')).toBe(THREAD_TERMINALITY_THETA_DEFAULT);
    expect(readOverlapThreshold('lots')).toBe(THREAD_TERMINALITY_THETA_DEFAULT);
  });

  test('the live config IS the parser applied to the env var — no second reading', () => {
    // WHY A CHILD PROCESS (the BRANCH-1 pattern, and its reason applies unchanged): the
    // in-process form of this assertion is VACUOUS, because the suite leaves the var unset
    // and both sides collapse to the same default. A config line replaced by a literal
    // `'off'` would pass it. The config is read once at module load and vi.resetModules()
    // is not usable here (measured: it broke the next contract file's pool), so the only
    // honest proof is to start a process with the var set and ask it what it got.
    const read = (env: Record<string, string>): string =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          "import('./src/config/threadTerminalityConfig.ts').then(m => " +
            'process.stdout.write(m.THREAD_TERMINALITY_CONFIG.mode + ":" + ' +
            'm.THREAD_TERMINALITY_CONFIG.modeSource + ":" + ' +
            'String(m.THREAD_TERMINALITY_CONFIG.transitOverlapThreshold)))',
        ],
        { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf-8' }
      ).trim();

    // The ON leg catches a wiring that was deleted or hardcoded to 'off'.
    expect(read({ [THREAD_TERMINALITY_ENV]: 'yes' })).toBe('on:explicit:0.01');
    // The explicit-OFF leg catches a wiring hardcoded to 'on'.
    expect(read({ [THREAD_TERMINALITY_ENV]: 'OFF' })).toBe('off:explicit:0.01');
    // Garbage lands OFF, and the process can say it was garbage rather than merely unset.
    expect(read({ [THREAD_TERMINALITY_ENV]: 'treu' })).toBe('off:unparseable:0.01');
    // The threshold reaches the live config too — a literal here would fail this leg.
    expect(
      read({ [THREAD_TERMINALITY_ENV]: 'on', MANDREL_THREAD_TERMINALITY_TRANSIT_THETA: '0.7' })
    ).toBe('on:explicit:0.7');
  });
});

describe('terminality flag — READ-BACK', () => {
  test('the summary states the EFFECTIVE mode and why it is that', () => {
    // A revert you cannot read back is a revert you cannot claim (an earlier decision §4).
    expect(threadTerminalityFlagSummary()).toContain(
      THREAD_TERMINALITY_CONFIG.mode.toUpperCase()
    );
    expect(threadTerminalityFlagSummary()).toContain(THREAD_TERMINALITY_ENV);
  });

  test('the summary distinguishes off-because-unset from off-because-rejected', () => {
    const base: ThreadTerminalityConfig = { ...ON, mode: 'off' };
    const unset = threadTerminalityFlagSummary({ ...base, modeSource: 'absent' });
    const rejected = threadTerminalityFlagSummary({
      ...base,
      modeSource: 'unparseable',
      rejectedValue: 'treu',
    });
    expect(unset).toContain('unset');
    expect(rejected).toContain('REJECTED');
    expect(rejected).toContain('treu');
    expect(unset).not.toBe(rejected);
  });

  test('the summary reports the knobs that change the rule, not just the switch', () => {
    const s = threadTerminalityFlagSummary({ ...ON, transitOverlapThreshold: 0.7 });
    expect(s).toContain('transit-overlap>=0.7');
    expect(s).toContain('unassignable-terminal=true');
    expect(s).toContain('not-derived-terminal=false');
  });
});
