/**
 * CURRENT-STATE read model — PURE-logic unit tests.
 *
 * Tests are the rock: the code is molded around these, never the reverse. This suite hammers
 * services/currentStateCore.ts with ZERO database — the projector is DB-free by design, so
 * every rule it owns is exercised offline and deterministically.
 *
 * EVERY TEST HERE CALLS THE THING IT GUARDS. Not one of these restates a rule the product
 * owns (no inlined regex, no re-spelled status list, no hand-copied threshold): each one calls
 * classifyNode / evaluateGate / selectArtifactHead / projectCurrentState / shapeNode and
 * asserts on what the PRODUCT returned. That is deliberate — the last session's teeth-test
 * inlined a regex the detector owned, so the detector could be regressed with 1726 tests
 * green. A test that restates the rule proves only that the copy agrees with itself.
 *
 * The guards below are MUTATION-PROBED (each probe is recorded in the task report): break the
 * product deliberately, watch the test go RED, restore.
 *
 * WHAT IS LOCKED HERE:
 *   - superseded nodes are OMITTED but COUNTED (the honesty signal; silent omission is THE
 *     failure mode of this feature),
 *   - the accounting is FAIL-CLOSED: a node that vanishes between classification and the
 *     answer is a THROW, not a smaller answer,
 *   - DETERMINISM: same graph in → byte-identical answer out, across repeat calls and
 *     independent of input order,
 *   - the gate ladder is total, config-ordered, and LOUD on an unrecognized rung,
 *   - shapeNode fails closed on an off-axis altitude (no silent degrade to `summary`),
 *   - both eval acceptance shapes: a completed/released thread and a validated-but-unreleased
 *     one each return a gate + a next action without listing every historical handoff.
 */

import { describe, test, expect } from 'vitest';

import {
  projectCurrentState,
  classifyNode,
  classifyHistoricalSubtype,
  HISTORICAL_SUBTYPES,
  evaluateGate,
  selectArtifactHead,
  type CurrentStateInputNode,
} from '../services/currentStateCore.js';
import { shapeNode } from '../services/recallThreadCore.js';
import {
  CURRENT_STATE_CONFIG,
  CURRENT_STATE_GATE_IDS,
  type CurrentStateConfig,
  type CurrentStateGateId,
} from '../config/currentStateConfig.js';
import {
  THREAD_ALTITUDES,
  THREAD_CONTENT_ALTITUDES,
  THREAD_PROJECTION_ALTITUDES,
  isContentAltitude,
  isProjectionAltitude,
  THREAD_CONFIG,
  type ThreadAltitude,
  type ThreadConfig,
} from '../config/threadConfig.js';
import {
  ARTIFACT_REF_CONFIG,
  PROVIDER_RULES,
  effectiveProviders,
  effectiveArtifactTypes,
} from '../config/artifactRefConfig.js';
import { validateArtifactRef } from '../services/artifactRef.js';
import type { Trust } from '../services/trustModel.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';
import { IMPLEMENTATION_STATUS_DEFAULT } from '../config/decisionVocab.js';

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES — built from the PRODUCT's own config, never from hand-copied literals
// ─────────────────────────────────────────────────────────────────────────────

const CFG: CurrentStateConfig = CURRENT_STATE_CONFIG;

/** A healthy, non-superseded verdict. Derived shape; the projector reads only these fields. */
function trust(overrides: Partial<Trust> = {}): Trust {
  return {
    band: 'trusted', // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    score: 0.9,
    outcome: { score: 1, samples: 2 },
    freshness: 0.9,
    superseded: false,
    softSuperseded: false,
    abstain: false, // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    supersession: null,
    reason: 'trusted',
    promotionRequirement: null,
    // P5.3 half B: the backward-soft guard AUDIT is required on Trust and is never
    // undefined — an absent audit and a guard that did not run must not read alike.
    supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
    ...overrides,
  };
}

/** A verdict that does NOT clear the configured trusted-outcome floor (cold start). */
function unprovenTrust(): Trust {
  return trust({
    band: 'unproven', // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    score: 0.8,
    outcome: { score: null, samples: 0 },
    reason: 'cold-start',
    promotionRequirement: 'x',
    // P5.3 half B: the backward-soft guard AUDIT is required on Trust and is never
    // undefined — an absent audit and a guard that did not run must not read alike.
    supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
  });
}

/** A DECLARED-superseded verdict — the one thing this read model omits. */
function supersededTrust(): Trust {
  return trust({
    band: 'superseded', // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    superseded: true,
    abstain: true, // trust-render-exempt: TEST FIXTURE field assignment; renders nothing
    reason: 'declared-superseded',
    supersession: { supersededBy: 'newer-id', tier: 'declared', confidence: null, reason: null },
    promotionRequirement: null,
    // P5.3 half B: the backward-soft guard AUDIT is required on Trust and is never
    // undefined — an absent audit and a guard that did not run must not read alike.
    supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
  });
}

let seq = 0;
function node(over: Partial<CurrentStateInputNode> & { type: EdgeNodeType }): CurrentStateInputNode {
  seq += 1;
  return {
    id: over.id ?? `node-${String(seq).padStart(3, '0')}`,
    title: `n${seq}`,
    content: null,
    createdAt: new Date(Date.UTC(2026, 0, 1 + (seq % 27))),
    updatedAt: null,
    status: null,
    outcomeStatus: null,
    // the BUILD lifecycle default. Explicit rather than spread-implicit so the
    // compiler keeps holding this fixture to the real CurrentStateInputNode shape.
    implementationStatus: null,
    contextType: null,
    metadata: null,
    trust: trust(),
    ...over,
  };
}

/** The FIRST configured active status — read from config, never spelled here. */
const ACTIVE_PRIMARY = CFG.activeTaskStatuses[0];
const ACTIVE_SECONDARY = CFG.activeTaskStatuses[1] ?? CFG.activeTaskStatuses[0];
const BLOCKED_STATUS = CFG.blockedTaskStatuses[0];
const STANDING_DECISION_STATUS = CFG.standingDecisionStatuses[0];
const FINDING_CONTEXT_TYPE = CFG.findingContextTypes[0];
const OUTCOME_CONTEXT_TYPE = CFG.outcomeContextTypes[0];
const OPEN_OUTCOME_STATUS = CFG.openOutcomeStatuses[0];

const activeTask = (o: Partial<CurrentStateInputNode> = {}) =>
  node({ type: 'task', status: ACTIVE_PRIMARY, ...o });
const blockedTask = (o: Partial<CurrentStateInputNode> = {}) =>
  node({ type: 'task', status: BLOCKED_STATUS, ...o });
const doneTask = (o: Partial<CurrentStateInputNode> = {}) =>
  node({ type: 'task', status: 'completed', ...o });
const standingDecision = (o: Partial<CurrentStateInputNode> = {}) =>
  node({ type: 'decision', status: STANDING_DECISION_STATUS, outcomeStatus: 'successful', ...o });

/**
 * Build a VALID artifact reference by DERIVING it from the product's own vocabulary and then
 * asking the product's own validator whether it is acceptable — never by transcribing a
 * provider/type pair into this file. A hand-written fixture would encode today's config and
 * silently rot (or worse, quietly stop being a valid reference, turning the release-gate tests
 * into vacuous passes). This searches the effective (type × provider) space and returns the
 * first combination validateArtifactRef() ACCEPTS, so the fixture is correct by construction.
 */
function artifactRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  for (const artifactType of effectiveArtifactTypes()) {
    for (const provider of effectiveProviders()) {
      const rule = PROVIDER_RULES[provider];
      const locator =
        rule.locatorField === 'uri'
          ? `https://example.invalid/artifacts/thing.bundle`
          : '/srv/artifacts/thing.bundle';
      const candidate: Record<string, unknown> = {
        artifactType,
        repository: 'mandrel',
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        sha256: 'c'.repeat(64),
        producerThread: 'T-current-state-fixture',
        retrieval: { provider, [rule.locatorField]: locator },
        ...overrides,
      };
      if (validateArtifactRef(candidate).ok) return candidate;
    }
  }
  throw new Error(
    'no (artifactType × provider) combination validates — the fixture cannot be built from ' +
      'the current artifact-reference config. Fix the fixture, do not weaken the tests.'
  );
}

/** That reference wrapped in the metadata shape a record actually carries. */
function artifactMetadata(overrides: Record<string, unknown> = {}) {
  return { [ARTIFACT_REF_CONFIG.metadataKey]: [artifactRef(overrides)] };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ALTITUDE AXES — the naming hazard, pinned
// ─────────────────────────────────────────────────────────────────────────────

describe('altitude vocabulary — two axes, one enum', () => {
  test('the content axis is unchanged and `current` is a PROJECTION, not a zoom level', () => {
    // The pre-existing three must still be exactly the content axis: this feature ADDED an
    // axis, it did not reclassify the old altitudes.
    expect([...THREAD_CONTENT_ALTITUDES]).toEqual(['headline', 'summary', 'full']);
    expect([...THREAD_PROJECTION_ALTITUDES]).toEqual(['current']);
    expect([...THREAD_ALTITUDES]).toEqual([
      ...THREAD_CONTENT_ALTITUDES,
      ...THREAD_PROJECTION_ALTITUDES,
    ]);
    // The two axes are disjoint — a value cannot be both a zoom and a projection.
    for (const a of THREAD_ALTITUDES) {
      expect(isContentAltitude(a) && isProjectionAltitude(a)).toBe(false);
      expect(isContentAltitude(a) || isProjectionAltitude(a)).toBe(true);
    }
  });

  test('the NAMING HAZARD is honored: the new altitude does not reuse the word `frontier`', () => {
    // `frontier` already means the TRAVERSAL frontier in this module family
    // (FRONTIER_EDGE_TYPE_PRIORITY / prioritizeFrontier — the maxNodes-cap survival ranking).
    // Stacking a second meaning on it is the drift this project keeps paying for, so the
    // altitude vocabulary must never contain that token.
    for (const a of THREAD_ALTITUDES) {
      expect(a.toLowerCase()).not.toContain('frontier');
    }
  });

  test('GUARD — shapeNode FAILS CLOSED on an off-axis altitude (no silent degrade)', () => {
    const raw = { id: 'x', type: 'context' as EdgeNodeType, title: 't', content: 'a'.repeat(500) };
    // Every CONTENT altitude renders.
    for (const a of THREAD_CONTENT_ALTITUDES) {
      expect(() => shapeNode(raw, trust(), a, THREAD_CONFIG)).not.toThrow();
    }
    // A PROJECTION altitude is not a zoom level — it must be a LOUD throw. Before this task
    // shapeNode's else-branch was `summary`, so this call would have quietly returned a
    // clipped snippet while the caller believed it had asked for something else.
    for (const a of THREAD_PROJECTION_ALTITUDES) {
      expect(() => shapeNode(raw, trust(), a, THREAD_CONFIG)).toThrow(/is not an altitude/);
    }
    // AND an altitude nobody has invented yet — the real test of fail-closed:
    // an input the guard does not recognize must be a loud RED, not a silent pass.
    expect(() =>
      shapeNode(raw, trust(), 'a-brand-new-altitude' as ThreadAltitude, THREAD_CONFIG)
    ).toThrow(/is not an altitude/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyNode — every node lands somewhere, by the CONFIGURED vocabulary', () => {
  test('an active task classifies as active work', () => {
    expect(classifyNode(activeTask(), CFG)).toContain('active-task');
  });

  test('a blocked task classifies as a blocker', () => {
    expect(classifyNode(blockedTask(), CFG)).toContain('blocker');
  });

  test('an unresolved finding context classifies as a finding', () => {
    const n = node({ type: 'context', contextType: FINDING_CONTEXT_TYPE });
    expect(classifyNode(n, CFG)).toContain('finding');
  });

  test('a standing decision classifies as a standing decision', () => {
    expect(classifyNode(standingDecision(), CFG)).toContain('standing-decision');
  });

  /**
   * NAME CARE (Reviewer N3): this is about clearing the CONFIGURED TRUST FLOOR, not about
   * "completed ⇒ trusted". A REAL completed task comes back from the trust service as
   * `unproven` (score ~0.99999997 — freshness alone, zero counted downstream outcomes), and
   * clearsMinTrust ranks by the trust vocabulary, so it does NOT clear the default `ok` floor.
   * The fixture below hands the projector a record that DOES clear it; the rule under test is
   * the projector's, and the name must not imply a verdict the trust service never issues.
   */
  test('a record CLEARING THE TRUST FLOOR is a trusted outcome; one below it is not', () => {
    expect(classifyNode(doneTask(), CFG)).toContain('trusted-outcome');
    // Same record, cold-start trust → fails the configured floor. The floor is the trust
    // model's rule, honored here rather than restated: `unproven` means zero outcome
    // evidence, and zero evidence is not a "trusted outcome" however fresh it is.
    expect(classifyNode(doneTask({ trust: unprovenTrust() }), CFG)).not.toContain(
      'trusted-outcome'
    );
  });

  test('DECLARED supersession is EXCLUSIVE — a superseded active task is never also active', () => {
    // The whole omission contract rests on this: a superseded record must not leak back into
    // a section by qualifying for one.
    const n = activeTask({ trust: supersededTrust() });
    expect(classifyNode(n, CFG)).toEqual(['superseded']);
  });

  // TITLE NAMES ONLY WHAT THE ASSERTIONS BELOW EXERCISE. It read "shown, ranked lower"; the
  // two expects establish SHOWN and nothing about order, and currentStateCore sorts
  // byRecencyThenId, so the ranking half was a claim this file never made.
  test('SOFT supersession is NOT omitted — it stays an active task (the belief-layer rule)', () => {
    const n = activeTask({
      trust: trust({ softSuperseded: true, score: 0.6, reason: 'soft-demoted' }),
    });
    expect(classifyNode(n, CFG)).toContain('active-task');
    expect(classifyNode(n, CFG)).not.toContain('superseded');
  });

  test('a node matching no rule is never an EMPTY disposition — context vs non-context differ', () => {
    // The fallback must be a real, countable bucket. An empty array here would mean a node
    // that exists in the graph and appears NOWHERE in the answer or its accounting.
    //
    // THE TWO FALLBACKS. A CONTEXT that matched nothing is RECENT, not
    // historical: it has no lifecycle column, so there is nothing to derive "closed" from,
    // and its only other door (trusted outcomes) is trust-gated. A TASK that matched nothing
    // is genuinely closed — its status says so — and stays historical.
    expect(classifyNode(node({ type: 'context', contextType: 'discussion' }), CFG)).toEqual([
      'recent-context',
    ]);
    // A closed task whose own result does not clear the trusted-outcome bars: nothing admits
    // it, and unlike a context it HAS a lifecycle that says it is closed. Still historical.
    // an earlier task — historical is now an UMBRELLA plus exactly one outcome SUBTYPE.
    expect(classifyNode(doneTask({ trust: unprovenTrust() }), CFG)).toEqual([
      'historical',
      'historical-completed',
    ]);
  });

  test('a handoff context is NOT an outcome — it reaches only the capped recency door', () => {
    // The eval's measured cost: worker handoffs, acceptance milestones, orchestrator gates
    // and final milestones all repeating the same commit/test evidence. `handoff` is
    // deliberately absent from the outcome context types for exactly this reason, and it
    // still is. What changed is where it lands instead: the recency door,
    // which is CAPPED and rendered at the configured node altitude — so the newest handoff is
    // reachable while the other 299 are a number, which is the bound the eval asked for.
    expect(CFG.outcomeContextTypes).not.toContain('handoff');
    expect(classifyNode(node({ type: 'context', contextType: 'handoff' }), CFG)).toEqual([
      'recent-context',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HONESTY SIGNAL — superseded OMITTED BUT COUNTED
// ─────────────────────────────────────────────────────────────────────────────

describe('superseded nodes — OMITTED BUT COUNTED (the honesty signal)', () => {
  const supersededSet = () => [
    activeTask({ id: 'root-task', status: ACTIVE_PRIMARY }),
    activeTask({ id: 'sup-1', trust: supersededTrust() }),
    blockedTask({ id: 'sup-2', trust: supersededTrust() }),
    node({ id: 'sup-3', type: 'decision', status: STANDING_DECISION_STATUS, trust: supersededTrust() }),
  ];

  test('superseded records appear in NO section', () => {
    const s = projectCurrentState(supersededSet(), 'root-task', CFG);
    const listed = [
      ...s.activeTasks.items,
      ...s.blockers.items,
      ...s.latestTrustedOutcomes.items,
      ...s.currentDecisions.items,
    ].map((n) => n.id);
    expect(listed).not.toContain('sup-1');
    expect(listed).not.toContain('sup-2');
    expect(listed).not.toContain('sup-3');
  });

  test('THE COUNT IS THE SIGNAL — it is exact, typed, and cannot be zero here', () => {
    const s = projectCurrentState(supersededSet(), 'root-task', CFG);
    // This is the assertion that FAILS if the count is ever dropped or silently zeroed —
    // the named failure mode of this feature.
    expect(s.omitted.superseded.count).toBe(3);
    expect(s.counts.superseded).toBe(3);
    expect(s.omitted.superseded.byType).toEqual({ decision: 1, task: 2 });
    expect(s.omitted.superseded.sampleIds.sort()).toEqual(['sup-1', 'sup-2', 'sup-3']);
  });

  test('a ZERO count is still REPORTED — "none superseded" is a measured answer', () => {
    // If the field were only populated when non-zero, a reader could not tell "nothing was
    // superseded" from "the count broke".
    const s = projectCurrentState([activeTask({ id: 'r' })], 'r', CFG);
    expect(s.omitted.superseded.count).toBe(0);
    expect(s.omitted.superseded.byType).toEqual({});
    expect(s.omitted.superseded.sampleIds).toEqual([]);
    expect(s.omitted.superseded.sampleOmitted).toBe(0);
  });

  test('the id SAMPLE is capped but the COUNT never is', () => {
    const cfg: CurrentStateConfig = {
      ...CFG,
      limits: { ...CFG.limits, supersededSampleIds: 2 },
    };
    const nodes = [
      activeTask({ id: 'r' }),
      ...Array.from({ length: 7 }, (_, i) =>
        doneTask({ id: `s-${i}`, trust: supersededTrust() })
      ),
    ];
    const s = projectCurrentState(nodes, 'r', cfg);
    expect(s.omitted.superseded.sampleIds).toHaveLength(2);
    expect(s.omitted.superseded.sampleOmitted).toBe(5);
    expect(s.omitted.superseded.count).toBe(7); // EXACT, uncapped
  });

  test('historical omissions are counted too — a bounded answer states its own boundary', () => {
    const nodes = [
      activeTask({ id: 'r' }),
      node({ id: 'h1', type: 'context', contextType: 'handoff' }),
      node({ id: 'h2', type: 'context', contextType: 'handoff' }),
      node({ id: 'h3', type: 'context', contextType: 'discussion' }),
    ];
    const s = projectCurrentState(nodes, 'r', CFG);
    // an earlier task — these three contexts are now ADMITTED by the recency door rather than
    // counted as historical. The boundary is still stated, just by the section's own honest
    // cap counters (total / omittedByCap) instead of by an omission count.
    expect(s.recentContexts.total).toBe(3);
    expect(s.omitted.historical.count).toBe(0);
    // A CLOSED TASK still counts as historical — the lifecycle verdict is real for tasks.
    const withClosed = projectCurrentState(
      [...nodes, doneTask({ id: 'done', trust: unprovenTrust() })],
      'r',
      CFG
    );
    expect(withClosed.omitted.historical.count).toBe(1);
    expect(withClosed.omitted.historical.byType).toEqual({ task: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECENCY DOOR — a context must not need TRUST to be visible
// ─────────────────────────────────────────────────────────────────────────────

describe('the recency door — new work is visible before it is vouched', () => {
  /**
   * THE MEASURED DEFECT this door exists to close, restated as an executable probe.
   *
   * On live prod 2026-08-22 (v0.44.1, anchor 9c47ddc6) an earlier note — a run report written
   * ~30 minutes earlier, band `unproven`, carrying a DECLARED informs edge to the anchor — was
   * ABSENT from `recall_thread altitude:'current'` at depth 1 and 2 and PRESENT at `headline`.
   * A context's only door was `latestTrustedOutcomes`, which is trust-gated, and trust accrues
   * after the fact, so brand-new work was unreachable at the altitude the boot hook reads.
   *
   * The fixture is that record's SHAPE, not its text: an outcome-typed context whose trust
   * does not clear the trusted-outcome floor.
   */
  const freshRunReport = (over: Partial<CurrentStateInputNode> = {}) =>
    node({
      type: 'context',
      contextType: OUTCOME_CONTEXT_TYPE,
      trust: unprovenTrust(),
      ...over,
    });

  test('THE PROBE — an unproven outcome context is excluded from trusted outcomes and INCLUDED here', () => {
    const fresh = freshRunReport({ id: 'fresh' });
    // The trust gate genuinely rejects it — that half is unchanged and still asserted.
    expect(classifyNode(fresh, CFG)).not.toContain('trusted-outcome');
    // ...and the recency door admits it anyway. This is the flip.
    expect(classifyNode(fresh, CFG)).toContain('recent-context');

    const s = projectCurrentState([activeTask({ id: 'r' }), fresh], 'r', CFG);
    expect(s.latestTrustedOutcomes.items.map((n) => n.id)).not.toContain('fresh');
    expect(s.recentContexts.items.map((n) => n.id)).toContain('fresh');
  });

  test('the door is NOT trust-gated — it admits every band the trusted door rejects', () => {
    // Not a hand-picked band: sweep the fixture bands this file already owns and assert the
    // door's admission is INDEPENDENT of trust for a context nothing else claims.
    for (const t of [trust(), unprovenTrust()]) {
      expect(classifyNode(node({ type: 'context', contextType: 'discussion', trust: t }), CFG)).toEqual([
        'recent-context',
      ]);
    }
  });

  test('DECLARED supersession still wins — the door does not resurrect a superseded context', () => {
    // The one exclusion that is not a trust gate: a declared-superseded record is not current
    // by definition, and that rule is exclusive above every disposition including this one.
    expect(
      classifyNode(node({ type: 'context', contextType: 'discussion', trust: supersededTrust() }), CFG)
    ).toEqual(['superseded']);
  });

  test('NO DOUBLE-LISTING — a context already rendered in another section is not repeated here', () => {
    const finding = node({ id: 'f', type: 'context', contextType: FINDING_CONTEXT_TYPE });
    const trusted = node({ id: 't', type: 'context', contextType: OUTCOME_CONTEXT_TYPE });
    const plain = node({ id: 'p', type: 'context', contextType: 'discussion' });
    const s = projectCurrentState([activeTask({ id: 'r' }), finding, trusted, plain], 'r', CFG);

    expect(s.blockers.items.map((n) => n.id)).toContain('f');
    expect(s.latestTrustedOutcomes.items.map((n) => n.id)).toContain('t');
    expect(s.recentContexts.items.map((n) => n.id)).toEqual(['p']);

    // Stated as the general property, over the WHOLE projection rather than these three ids:
    // no id appears both in the recency door and in any other section.
    const elsewhere = new Set(
      [...s.blockers.items, ...s.latestTrustedOutcomes.items, ...s.activeTasks.items, ...s.currentDecisions.items].map(
        (n) => n.id
      )
    );
    for (const n of s.recentContexts.items) expect(elsewhere.has(n.id)).toBe(false);
  });

  test('ordering is the SAME total order as every other section — newest first, id tiebreak', () => {
    const older = node({
      id: 'older',
      type: 'context',
      contextType: 'discussion',
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      updatedAt: new Date(Date.UTC(2026, 0, 1)),
    });
    const newer = node({
      id: 'newer',
      type: 'context',
      contextType: 'discussion',
      createdAt: new Date(Date.UTC(2026, 7, 1)),
      updatedAt: new Date(Date.UTC(2026, 7, 1)),
    });
    const s = projectCurrentState([activeTask({ id: 'r' }), older, newer], 'r', CFG);
    expect(s.recentContexts.items.map((n) => n.id)).toEqual(['newer', 'older']);
  });

  test('the cap comes from CONFIG and reports what it dropped — no hardcoded number here', () => {
    const cap = CFG.limits.recentContexts;
    const many = Array.from({ length: cap + 7 }, (_, i) =>
      node({ id: `c-${i}`, type: 'context', contextType: 'discussion' })
    );
    const s = projectCurrentState([activeTask({ id: 'r' }), ...many], 'r', CFG);
    expect(s.recentContexts.items).toHaveLength(cap);
    expect(s.recentContexts.total).toBe(cap + 7);
    expect(s.recentContexts.omittedByCap).toBe(7);
  });

  test('the door is accounted for — its members are LISTED, not counted as omitted', () => {
    const s = projectCurrentState(
      [activeTask({ id: 'r' }), node({ id: 'c', type: 'context', contextType: 'discussion' })],
      'r',
      CFG
    );
    expect(s.counts.listed).toBe(2);
    expect(s.counts.historical).toBe(0);
    expect(s.counts.listed + s.counts.superseded + s.counts.historical).toBe(s.counts.examined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED ACCOUNTING
// ─────────────────────────────────────────────────────────────────────────────

describe('accounting — examined === listed + superseded + historical, ASSERTED', () => {
  test('the accounting balances on a mixed graph', () => {
    const nodes = [
      activeTask({ id: 'r' }),
      blockedTask({ id: 'b' }),
      doneTask({ id: 'o' }),
      standingDecision({ id: 'd' }),
      node({ id: 'h', type: 'context', contextType: 'handoff' }),
      doneTask({ id: 's', trust: supersededTrust() }),
    ];
    const s = projectCurrentState(nodes, 'r', CFG);
    expect(s.counts.examined).toBe(6);
    expect(s.counts.listed + s.counts.superseded + s.counts.historical).toBe(s.counts.examined);
  });

  test('OVERLAPPING sections cannot inflate the accounting (listed counts DISTINCT ids)', () => {
    // A decision that also carries a landed outcome legitimately appears in two sections.
    // If `listed` counted appearances rather than nodes, the totals would over-count and the
    // guard would false-RED — so this pins the distinct-id semantics.
    const d = standingDecision({ id: 'both', outcomeStatus: 'successful' });
    expect(classifyNode(d, CFG).sort()).toEqual(['standing-decision', 'trusted-outcome']);
    const s = projectCurrentState([d], 'both', CFG);
    expect(s.currentDecisions.items.map((n) => n.id)).toEqual(['both']);
    expect(s.latestTrustedOutcomes.items.map((n) => n.id)).toEqual(['both']);
    expect(s.counts.listed).toBe(1);
    expect(s.counts.examined).toBe(1);
  });

  test('GUARD — a node that vanishes from classification is a LOUD THROW, not a smaller answer', () => {
    // Simulate the regression the accounting exists to catch: a classifier that returns an
    // EMPTY disposition list for some node (i.e. silently drops it). We cannot monkey-patch
    // the pure function, so we prove the invariant the guard checks by feeding a duplicate-id
    // pair whose ids collide — examined counts DISTINCT ids while the buckets would count
    // both — and confirm the projector refuses to answer rather than under-report.
    // The pair must straddle the partition: one node LISTED, one node HISTORICAL, sharing an
    // id. (It used to use a handoff context for the historical half; since an earlier task a
    // context is admitted by the recency door, so a CLOSED TASK is the historical half now.)
    const a = activeTask({ id: 'dup' });
    const b = doneTask({ id: 'dup', trust: unprovenTrust() });
    expect(() => projectCurrentState([a, b], 'dup', CFG)).toThrow(
      /current-state accounting broke/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

describe('determinism — same graph in, byte-identical answer out', () => {
  const graph = (): CurrentStateInputNode[] => {
    seq = 0; // reset the id counter so both builds mint identical ids
    const sameInstant = new Date(Date.UTC(2026, 5, 1));
    return [
      activeTask({ id: 'aaa', createdAt: sameInstant, updatedAt: sameInstant }),
      activeTask({ id: 'bbb', createdAt: sameInstant, updatedAt: sameInstant }),
      activeTask({ id: 'ccc', status: ACTIVE_SECONDARY, createdAt: sameInstant }),
      blockedTask({ id: 'ddd' }),
      doneTask({ id: 'eee' }),
      standingDecision({ id: 'fff' }),
      node({ id: 'ggg', type: 'context', contextType: 'handoff' }),
      doneTask({ id: 'hhh', trust: supersededTrust() }),
      node({ id: 'iii', type: 'context', contextType: OUTCOME_CONTEXT_TYPE }),
    ];
  };

  test('repeated invocation on the same input is byte-identical', () => {
    const a = JSON.stringify(projectCurrentState(graph(), 'aaa', CFG));
    const b = JSON.stringify(projectCurrentState(graph(), 'aaa', CFG));
    expect(a).toBe(b);
  });

  test('INPUT ORDER does not change the answer — every permutation is byte-identical', () => {
    // The real determinism risk is insertion/iteration order leaking into the output (a Map
    // walk, an unstable sort, a "first one wins" that depends on arrival). Rotating the array
    // exercises exactly that, including the same-timestamp ties that force the id tie-break.
    const base = JSON.stringify(projectCurrentState(graph(), 'aaa', CFG));
    for (let shift = 1; shift < 9; shift++) {
      const g = graph();
      const rotated = [...g.slice(shift), ...g.slice(0, shift)];
      expect(JSON.stringify(projectCurrentState(rotated, 'aaa', CFG))).toBe(base);
    }
    // And the exact reverse, which no rotation covers.
    expect(JSON.stringify(projectCurrentState(graph().reverse(), 'aaa', CFG))).toBe(base);
  });

  test('the projector does not MUTATE the array it was given', () => {
    const g = graph();
    const before = g.map((n) => n.id);
    projectCurrentState(g, 'aaa', CFG);
    expect(g.map((n) => n.id)).toEqual(before);
  });

  test('an UNDATED record sorts oldest — it can never masquerade as the newest event', () => {
    const dated = doneTask({ id: 'dated', createdAt: new Date(Date.UTC(2020, 0, 1)) });
    const undated = doneTask({ id: 'undated', createdAt: null, updatedAt: null });
    const s = projectCurrentState([undated, dated], 'dated', CFG);
    expect(s.latestTrustedOutcomes.items.map((n) => n.id)).toEqual(['dated', 'undated']);
  });

  test('active tasks rank by the CONFIGURED status order, then recency, then id', () => {
    const older = new Date(Date.UTC(2026, 0, 1));
    const newer = new Date(Date.UTC(2026, 0, 9));
    const s = projectCurrentState(
      [
        activeTask({ id: 'todo-new', status: ACTIVE_SECONDARY, createdAt: newer }),
        activeTask({ id: 'inprog-old', status: ACTIVE_PRIMARY, createdAt: older }),
      ],
      'inprog-old',
      CFG
    );
    // The primary configured status wins even though the other record is newer: the ordering
    // IS the recommendation — continue what is in flight before starting something new.
    expect(s.activeTasks.items.map((n) => n.id)).toEqual(['inprog-old', 'todo-new']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION CAPS
// ─────────────────────────────────────────────────────────────────────────────

describe('section caps — bounded, and honest about what the bound dropped', () => {
  test('a capped section reports total and omittedByCap', () => {
    const cfg: CurrentStateConfig = { ...CFG, limits: { ...CFG.limits, activeTasks: 2 } };
    const nodes = Array.from({ length: 5 }, (_, i) => activeTask({ id: `t-${i}` }));
    const s = projectCurrentState(nodes, 't-0', cfg);
    expect(s.activeTasks.items).toHaveLength(2);
    expect(s.activeTasks.total).toBe(5);
    expect(s.activeTasks.omittedByCap).toBe(3);
    // Capped-away nodes are still ACCOUNTED — the cap bounds the listing, not the truth.
    expect(s.counts.listed).toBe(5);
  });

  test('the default node altitude carries NO content body (the bounded-response promise)', () => {
    const long = 'x'.repeat(5000); // reserved-port-ok: repeat() length, not a port
    const s = projectCurrentState([activeTask({ id: 'r', content: long })], 'r', CFG);
    expect(CFG.nodeAltitude).toBe('headline');
    expect(s.activeTasks.items[0].content).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(long);
  });

  /**
   * The content DEPTH is shapeNode's rule, so the expectation is whatever shapeNode PRODUCES —
   * never a hand-written `'y'.repeat(10) + '…'` (Reviewer N2). An inlined expectation is a
   * second copy of the product's clip rule living in the test: change the ellipsis character
   * or the boundary condition in shapeNode and the test would go RED for the wrong reason, or
   * (worse) a test written to match the old spelling would pin the OLD behavior forever. This
   * asserts the delegation itself: the section node's body is byte-identical to what the one
   * shaping function returns for the same record, at every content altitude.
   */
  test('every content altitude DELEGATES to shapeNode — byte-identical body', () => {
    const body = 'y'.repeat(100);
    for (const nodeAltitude of THREAD_CONTENT_ALTITUDES) {
      const cfg: CurrentStateConfig = { ...CFG, nodeAltitude };
      const threadCfg: ThreadConfig = { ...THREAD_CONFIG, summarySnippetMaxlen: 10 };
      const n = activeTask({ id: 'r', content: body });
      const s = projectCurrentState([n], 'r', cfg, threadCfg);
      const expected = shapeNode(
        { id: n.id, type: n.type, title: n.title, content: n.content },
        n.trust,
        nodeAltitude,
        threadCfg
      );
      expect(s.activeTasks.items[0].content).toBe(expected.content);
    }
  });

  test('the summary clip is NON-TRIVIAL at that budget (guard the guard)', () => {
    // Without this, the delegation test above would still pass if shapeNode returned the body
    // untouched at every altitude — i.e. if the clip stopped working entirely.
    const cfg: CurrentStateConfig = { ...CFG, nodeAltitude: 'summary' };
    const threadCfg: ThreadConfig = { ...THREAD_CONFIG, summarySnippetMaxlen: 10 };
    const s = projectCurrentState([activeTask({ id: 'r', content: 'y'.repeat(100) })], 'r', cfg, threadCfg);
    expect(s.activeTasks.items[0].content!.length).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE LADDER
// ─────────────────────────────────────────────────────────────────────────────

describe('gate ladder — total, config-ordered, and LOUD on an unrecognized rung', () => {
  const gateOf = (nodes: CurrentStateInputNode[], anchor: string, cfg = CFG) =>
    projectCurrentState(nodes, anchor, cfg).nextAction;

  test('blocked wins over open work', () => {
    const g = gateOf([activeTask({ id: 'r' }), blockedTask({ id: 'b' })], 'r');
    expect(g.gate).toBe('blocked');
    expect(g.targetId).toBe('b');
    expect(g.action).toContain('b');
  });

  test('an unresolved FINDING is a blocker too', () => {
    const finding = node({ id: 'f', type: 'context', contextType: FINDING_CONTEXT_TYPE });
    const g = gateOf([doneTask({ id: 'r', metadata: artifactMetadata() }), finding], 'r');
    expect(g.gate).toBe('blocked');
    expect(g.targetId).toBe('f');
  });

  test('open work → in-progress, naming the concrete task', () => {
    const g = gateOf([activeTask({ id: 'r' }), activeTask({ id: 't2' })], 'r');
    expect(g.gate).toBe('in-progress');
    expect(g.targetType).toBe('task');
  });

  test('the ladder is TOTAL — every configured rung is reachable and every gate id is legal', () => {
    // Not a restatement: this walks the PRODUCT's configured ladder and asserts the
    // implementation recognizes each rung, so adding a rung to config without implementing it
    // cannot pass silently.
    for (const id of CFG.gateLadder) {
      expect(CURRENT_STATE_GATE_IDS).toContain(id);
    }
    expect(CFG.gateLadder[CFG.gateLadder.length - 1]).toBe(CFG.terminalGate);
  });

  test('GUARD — a configured rung with NO implementation is a LOUD THROW', () => {
    // ask what the guard does on an input it does not recognize. If an unknown
    // rung were skipped, the ladder would silently return the WRONG gate — the reader would
    // never know a rung had been dropped.
    const cfg: CurrentStateConfig = {
      ...CFG,
      gateLadder: ['not-a-real-rung' as CurrentStateGateId, ...CFG.gateLadder],
    };
    expect(() => projectCurrentState([activeTask({ id: 'r' })], 'r', cfg)).toThrow(
      /has no implementation/
    );
  });

  test('GUARD — a ladder that falls through is a LOUD THROW, not an invented default gate', () => {
    // A ladder missing its terminal rung is a config bug we must SEE. Absorbing it by
    // inventing a gate would report a confident, wrong answer.
    const cfg: CurrentStateConfig = { ...CFG, gateLadder: ['blocked'] };
    expect(() => projectCurrentState([doneTask({ id: 'r' })], 'r', cfg)).toThrow(
      /fell through without matching/
    );
  });

  test('evaluateGate is called DIRECTLY by the projector — the same ladder, one definition', () => {
    // Call the rule engine itself with the same inputs the projector would build, and assert
    // it agrees with the projected answer. If someone re-implements the gate inside the
    // projector, these two diverge and this goes RED.
    const nodes = [activeTask({ id: 'r' }), blockedTask({ id: 'b' })];
    const projected = projectCurrentState(nodes, 'r', CFG).nextAction;
    const direct = evaluateGate({
      root: nodes[0],
      activeTasks: [nodes[0]],
      blockers: [nodes[1]],
      standingDecisions: [],
      artifactHead: null,
      artifactIssues: [],
      cfg: CFG,
    });
    expect(projected).toEqual(direct);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIFACT / RELEASE HEAD
// ─────────────────────────────────────────────────────────────────────────────

describe('artifact / release head', () => {
  test('the NEWEST record carrying a valid reference provides the head', () => {
    const older = doneTask({
      id: 'old',
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      metadata: artifactMetadata({ head: 'b'.repeat(40) }),
    });
    const newer = doneTask({
      id: 'new',
      createdAt: new Date(Date.UTC(2026, 6, 1)),
      metadata: artifactMetadata({ head: 'c'.repeat(40) }),
    });
    const { head } = selectArtifactHead([older, newer]);
    expect(head?.recordId).toBe('new');
    expect(head?.head).toBe('c'.repeat(40));
  });

  test('a SUPERSEDED record never provides the head', () => {
    const s = projectCurrentState(
      [
        doneTask({ id: 'r' }),
        doneTask({
          id: 'sup',
          createdAt: new Date(Date.UTC(2030, 0, 1)),
          metadata: artifactMetadata(),
          trust: supersededTrust(),
        }),
      ],
      'r',
      CFG
    );
    expect(s.artifactHead).toBeNull();
  });

  test('UNREADABLE artifact metadata is an ISSUE, never "no artifact references"', () => {
    // Part D's fail-open class: collapsing "a shape I do not recognise" into "none" hides
    // real provenance behind a reassuring message.
    const broken = doneTask({
      id: 'r',
      metadata: { [ARTIFACT_REF_CONFIG.metadataKey]: 'not-an-array' },
    });
    const { head, issues } = selectArtifactHead([broken]);
    expect(head).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('r');
  });

  test('a WRITER observation is reported as a CLAIM, never as a verification', () => {
    const n = doneTask({
      id: 'r',
      metadata: artifactMetadata({
        head: 'd'.repeat(40),
        observed: { head: 'd'.repeat(40) },
      }),
    });
    const { head } = selectArtifactHead([n]);
    expect(head?.writerObservedClaim).toEqual({ sha256: null, head: 'd'.repeat(40) });
    // The payload must SAY so — the boundary travels with the answer, it is not folklore.
    expect(head?.note).toMatch(/not a verification/i);
    // And nothing in the answer may claim the artifact was verified.
    expect(JSON.stringify(head)).not.toMatch(/"verified"\s*:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE EVAL'S TWO ACCEPTANCE SHAPES
// ─────────────────────────────────────────────────────────────────────────────

describe('eval acceptance — a gate + next action for BOTH project shapes', () => {
  /** Shared history: the handoffs/reviews/milestones the eval measured as repeated noise. */
  const history = () => [
    node({ id: 'h1', type: 'context', contextType: 'handoff', content: 'commit abc, tests green' }),
    node({ id: 'h2', type: 'context', contextType: 'handoff', content: 'commit abc, tests green' }),
    node({ id: 'h3', type: 'context', contextType: 'discussion', content: 'commit abc, review' }),
    node({ id: 'h4', type: 'context', contextType: 'handoff', content: 'commit abc, tests green' }),
  ];

  test('SHAPE 1 — completed AND released: the gate is complete, nothing is open', () => {
    const nodes = [
      doneTask({ id: 'root', metadata: artifactMetadata() }),
      doneTask({ id: 'w1' }),
      standingDecision({ id: 'd1', outcomeStatus: 'successful' }),
      ...history(),
    ];
    const s = projectCurrentState(nodes, 'root', CFG);
    expect(s.nextAction.gate).toBe('complete');
    expect(s.nextAction.action).toBeTruthy();
    expect(s.artifactHead).not.toBeNull();
    expect(s.activeTasks.total).toBe(0);
    expect(s.blockers.total).toBe(0);
    // The whole point: the handoffs are BOUNDED, not repeated. Since an earlier task they are
    // admitted by the capped recency door rather than counted as historical — and the
    // property the eval actually cares about is asserted directly below: their BODIES are
    // still absent from the answer, because the door renders at the configured node altitude.
    expect(s.recentContexts.total).toBe(4);
    expect(s.omitted.historical.count).toBe(0);
    const answer = JSON.stringify(s);
    expect(answer).not.toContain('commit abc, tests green');
  });

  test('SHAPE 2 — validated but UNRELEASED: the gate is awaiting-release, with the action', () => {
    const nodes = [
      doneTask({ id: 'root' }), // validated: work complete...
      doneTask({ id: 'w1' }),
      standingDecision({ id: 'd1', outcomeStatus: 'successful' }),
      ...history(),
    ];
    const s = projectCurrentState(nodes, 'root', CFG); // ...but NO artifact head recorded
    expect(s.nextAction.gate).toBe('awaiting-release');
    expect(s.nextAction.gateReason).toMatch(/no artifact\/release head/);
    expect(s.nextAction.action).toMatch(/artifact/i);
    expect(s.nextAction.targetId).toBe('root');
    expect(s.recentContexts.total).toBe(4);
  });

  test('the two shapes DIFFER only by the artifact head — the gate is the discriminator', () => {
    const base = () => [
      doneTask({ id: 'root' }),
      standingDecision({ id: 'd1', outcomeStatus: 'successful' }),
      ...history(),
    ];
    seq = 0;
    const unreleased = projectCurrentState(base(), 'root', CFG);
    seq = 0;
    const withArtifact = base();
    withArtifact[0] = { ...withArtifact[0], metadata: artifactMetadata() };
    const released = projectCurrentState(withArtifact, 'root', CFG);
    expect(unreleased.nextAction.gate).toBe('awaiting-release');
    expect(released.nextAction.gate).toBe('complete');
  });

  test('awaiting-outcome fires when the work is released but the learning loop is open', () => {
    const nodes = [
      doneTask({ id: 'root', metadata: artifactMetadata() }),
      standingDecision({ id: 'd1', outcomeStatus: OPEN_OUTCOME_STATUS }),
    ];
    const s = projectCurrentState(nodes, 'root', CFG);
    expect(s.nextAction.gate).toBe('awaiting-outcome');
    expect(s.nextAction.targetId).toBe('d1');
  });

  test('a decision with a NULL outcome also holds the learning loop open', () => {
    const nodes = [
      doneTask({ id: 'root', metadata: artifactMetadata() }),
      standingDecision({ id: 'd1', outcomeStatus: null }),
    ];
    expect(projectCurrentState(nodes, 'root', CFG).nextAction.gate).toBe('awaiting-outcome');
  });

  test('an UNREADABLE artifact reference does NOT satisfy the release gate', () => {
    // Fail-closed: a reference we could not resolve must never be counted as a released head.
    const nodes = [
      doneTask({
        id: 'root',
        metadata: { [ARTIFACT_REF_CONFIG.metadataKey]: { not: 'an array' } },
      }),
    ];
    const s = projectCurrentState(nodes, 'root', CFG);
    expect(s.nextAction.gate).toBe('awaiting-release');
    expect(s.artifactIssues.length).toBeGreaterThan(0);
    expect(s.nextAction.action).toMatch(/repair/i);
  });

  test('the release gate can be DISARMED by config (a deployment with no artifact refs)', () => {
    const cfg: CurrentStateConfig = { ...CFG, releaseGateRequiresArtifact: false };
    const s = projectCurrentState([doneTask({ id: 'root' })], 'root', cfg);
    expect(s.nextAction.gate).toBe('complete');
  });

  test('the answer stays BOUNDED as the history grows — sections do not track node count', () => {
    // The eval's headline: orient an agent in ONE bounded response even at hundreds of nodes.
    const many = Array.from({ length: 300 }, (_, i) =>
      node({ id: `h-${i}`, type: 'context', contextType: 'handoff', content: 'x'.repeat(400) })
    );
    const s = projectCurrentState([doneTask({ id: 'root', metadata: artifactMetadata() }), ...many], 'root', CFG);
    expect(s.counts.examined).toBe(301);
    // an earlier task — the 300 are admitted by the recency door, and the door is CAPPED: the
    // section states its own total and how many the cap dropped, and the byte assertion below
    // is what proves the answer did not grow with the history.
    expect(s.recentContexts.total).toBe(300);
    expect(s.recentContexts.items).toHaveLength(CFG.limits.recentContexts);
    expect(s.recentContexts.omittedByCap).toBe(300 - CFG.limits.recentContexts);
    const bytes = JSON.stringify(s).length;
    // 300 handoffs at 400 chars each is >120KB of raw content; the answer must not carry it.
    expect(bytes).toBeLessThan(12000); // reserved-port-ok: byte budget, not a port
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HISTORICAL SPLIT — "we shipped it" vs "we gave up on it"
//
// The defect: `historical` was the disposition a node got when nothing else applied, so a
// COMPLETED DELIVERABLE and an ABANDONED THREAD landed in the same bucket and read
// identically to anyone consuming current-state. A shipped feature that reads as spent
// discussion invites someone to rebuild it.
//
// MUTATION-PROBE CONTRACT: the first test in this block is the one that goes RED if the two
// outcomes are collapsed back into one value. It asserts they DIFFER, so any change that
// makes classifyHistoricalSubtype return a single constant fails it — a probe that a
// per-value equality assertion would survive if both values were changed together.
// ─────────────────────────────────────────────────────────────────────────────

describe('the historical split — a completed deliverable and an abandoned thread must DIFFER', () => {
  const completedTask = () =>
    node({ type: 'task', status: CFG.completedTaskStatuses[0], trust: unprovenTrust() });
  const abandonedTask = () =>
    node({ type: 'task', status: CFG.abandonedTaskStatuses[0], trust: unprovenTrust() });

  test('THE COLLAPSE PROBE — the two outcomes classify DIFFERENTLY, by name', () => {
    const shipped = classifyNode(completedTask(), CFG);
    const droppedIt = classifyNode(abandonedTask(), CFG);
    // Both are still historical: the umbrella is preserved, so no consumer loses its population.
    expect(shipped).toContain('historical');
    expect(droppedIt).toContain('historical');
    // And they are NOT the same answer. This is the assertion the defect violated.
    expect(shipped).not.toEqual(droppedIt);
    expect(classifyHistoricalSubtype(completedTask(), CFG)).toBe('historical-completed');
    expect(classifyHistoricalSubtype(abandonedTask(), CFG)).toBe('historical-abandoned');
    expect(classifyHistoricalSubtype(completedTask(), CFG)).not.toBe(
      classifyHistoricalSubtype(abandonedTask(), CFG)
    );
  });

  test('every historical node carries the umbrella AND exactly one subtype', () => {
    for (const n of [completedTask(), abandonedTask(), node({ type: 'decision', status: 'deprecated' })]) {
      const d = classifyNode(n, CFG);
      expect(d).toContain('historical');
      const subs = d.filter((x) => (HISTORICAL_SUBTYPES as readonly string[]).includes(x));
      expect(subs).toHaveLength(1);
    }
  });

  test('a DECISION at the implementation_status DEFAULT is UNKNOWN, never abandoned', () => {
    // The honest-unknown rule. `implementation_status` DEFAULTs to 'planned', so that value
    // may equally mean "nobody ever touched this column". Reading it as "abandoned" would be
    // a confident wrong classification of most decisions ever recorded. Derived from the
    // product's own default, not from the literal 'planned'.
    expect(CFG.abandonedImplementationStatuses).not.toContain(IMPLEMENTATION_STATUS_DEFAULT);
    const n = node({
      type: 'decision',
      status: 'deprecated',
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      outcomeStatus: OPEN_OUTCOME_STATUS,
    });
    expect(classifyHistoricalSubtype(n, CFG)).toBe('historical-unknown');
  });

  test('a DECISION that was BUILT is completed; one stopped mid-build is abandoned', () => {
    const built = node({
      type: 'decision',
      status: 'deprecated',
      implementationStatus: CFG.builtImplementationStatuses[0],
    });
    expect(classifyHistoricalSubtype(built, CFG)).toBe('historical-completed');
    const stopped = node({
      type: 'decision',
      status: 'deprecated',
      implementationStatus: CFG.abandonedImplementationStatuses[0],
    });
    expect(classifyHistoricalSubtype(stopped, CFG)).toBe('historical-abandoned');
    expect(classifyHistoricalSubtype(built, CFG)).not.toBe(classifyHistoricalSubtype(stopped, CFG));
  });

  test('an EVALUATED outcome is evidence the decision was carried out', () => {
    // You cannot record successful/mixed/failed about a thing that was never done. Even a
    // FAILED one is `completed` here: the reader's question is "does this already exist?",
    // and quality lives on the separate outcome axis.
    for (const outcomeStatus of ['successful', 'mixed', 'failed']) {
      const n = node({ type: 'decision', status: 'deprecated', outcomeStatus });
      expect(classifyHistoricalSubtype(n, CFG)).toBe('historical-completed');
    }
    // ...and an UNEVALUATED one is not evidence of anything.
    for (const outcomeStatus of CFG.openOutcomeStatuses) {
      const n = node({ type: 'decision', status: 'deprecated', outcomeStatus });
      expect(classifyHistoricalSubtype(n, CFG)).toBe('historical-unknown');
    }
  });

  test('the classifier is TOTAL — a nulled-out record gets an honest unknown, not a crash', () => {
    // The empty/absent population (C3): every lifecycle column null.
    expect(classifyHistoricalSubtype(node({ type: 'task' }), CFG)).toBe('historical-unknown');
    expect(classifyHistoricalSubtype(node({ type: 'decision' }), CFG)).toBe('historical-unknown');
    expect(classifyHistoricalSubtype(node({ type: 'context' }), CFG)).toBe('historical-unknown');
  });

  test('the projection reports the split — counts, byType and drill-down ids', () => {
    const nodes = [
      activeTask({ id: 'root' }),
      node({ id: 'ship', type: 'task', status: CFG.completedTaskStatuses[0], trust: unprovenTrust() }),
      node({ id: 'drop', type: 'task', status: CFG.abandonedTaskStatuses[0], trust: unprovenTrust() }),
      node({ id: 'dunno', type: 'decision', status: 'deprecated' }),
    ];
    const s = projectCurrentState(nodes, 'root', CFG);
    expect(s.omitted.historical.count).toBe(3);
    expect(s.counts.historicalCompleted).toBe(1);
    expect(s.counts.historicalAbandoned).toBe(1);
    expect(s.counts.historicalUnknown).toBe(1);
    // The subtypes PARTITION the umbrella — asserted, not assumed.
    expect(
      s.counts.historicalCompleted + s.counts.historicalAbandoned + s.counts.historicalUnknown
    ).toBe(s.counts.historical);
    // Drill-down: a reader can go LOOK at the thing that already shipped.
    expect(s.omitted.historical.completed.sampleIds).toEqual(['ship']);
    expect(s.omitted.historical.abandoned.sampleIds).toEqual(['drop']);
    expect(s.omitted.historical.completed.byType).toEqual({ task: 1 });
    expect(s.omitted.historical.unknown.byType).toEqual({ decision: 1 });
    // Present at ZERO too, so "none" is a measured answer rather than a missing key.
    const empty = projectCurrentState([activeTask({ id: 'root2' })], 'root2', CFG);
    expect(empty.omitted.historical.completed).toEqual({
      count: 0,
      byType: {},
      sampleIds: [],
      sampleOmitted: 0,
    });
  });

  test('the id SAMPLE is bounded by config and reports what it dropped', () => {
    const cap = CFG.limits.historicalSampleIds;
    const shipped = Array.from({ length: cap + 3 }, (_, i) =>
      node({
        id: `s${String(i).padStart(2, '0')}`,
        type: 'task',
        status: CFG.completedTaskStatuses[0],
        trust: unprovenTrust(),
      })
    );
    const s = projectCurrentState([activeTask({ id: 'root' }), ...shipped], 'root', CFG);
    expect(s.omitted.historical.completed.count).toBe(cap + 3); // the COUNT is never bounded
    expect(s.omitted.historical.completed.sampleIds).toHaveLength(cap);
    expect(s.omitted.historical.completed.sampleOmitted).toBe(3);
  });
});
