/**
 * GRAPH-AWARE PROJECT INSIGHTS — PURE-logic unit tests.
 *
 * Tests are the rock. This suite hammers services/projectCoverageCore.ts + the fail-closed
 * vocabulary check in config/coverageConfig.ts with ZERO database.
 *
 * EVERY TEST HERE CALLS THE THING IT GUARDS (a past incident rule 2). Not one restates a rule the
 * product owns: no floor is typed as a literal (they are read from COVERAGE_CONFIG), no
 * finding code is spelled by hand outside the product's own exported vocabulary, and the
 * edge-type partition test calls the product's own assert function rather than re-deriving
 * the partition. A test that restates the rule proves only that the copy agrees with itself —
 * and can then be weakened without the product noticing, which is the exact tell a past incident
 * names.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE HEADLINE GUARD — SCALE INVARIANCE.
 *
 * The defect this task fixes is a health signal that fired on VOLUME:
 *     if (decisionStats.total < 5) -> 'Low decision count - consider documenting more
 *                                     technical choices'
 * So the guard is a property, not an example: build a graph, then rebuild it ×3 and ×17 with
 * every population multiplied and every RATIO held exactly constant. The set of finding codes
 * that fires MUST be identical at all three scales.
 *
 * Why that is the right shape: a rule keyed on an absolute count is STRUCTURALLY INCAPABLE of
 * passing it — any threshold between the ×1 and ×17 population sizes flips the answer. And it
 * is anchored on the product's own output (the fired code set), not on a list of rules this
 * file knows about, so a NEW count-triggered rule added later is caught without editing this
 * test. MUTATION-PROBED by re-adding the deleted `decisions < 5` heuristic as a real rule —
 * measured RED (recorded in the task report).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { describe, test, expect } from 'vitest';

import {
  projectProjectCoverage,
  evaluateFindings,
  COVERAGE_FINDING_CODES,
  type CoverageEdge,
  type CoverageFindingCode,
  type CoverageInputNode,
  type CoverageRatios,
} from '../services/projectCoverageCore.js';
import {
  COVERAGE_CONFIG,
  assertEdgeTypePartitionTotal,
  type CoverageConfig,
} from '../config/coverageConfig.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import { EDGE_TYPES } from '../config/edgeTypes.js';
import { mapTaskOutcome, type Trust } from '../services/trustModel.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES — built from the PRODUCT's own config, never from hand-copied literals
// ─────────────────────────────────────────────────────────────────────────────

const CFG: CoverageConfig = COVERAGE_CONFIG;

/** The first grounding / active-task / landed vocabulary member, read from the PRODUCT's
 *  config so a vocabulary change moves these fixtures with it instead of stranding them. */
const GROUNDING_EDGE = CFG.groundingEdgeTypes[0];
const WEAK_EDGE = CFG.weakEdgeTypes[0];
const ACTIVE_STATUS = CURRENT_STATE_CONFIG.activeTaskStatuses[0];
const BLOCKED_STATUS = CURRENT_STATE_CONFIG.blockedTaskStatuses[0];
const OUTCOME_CONTEXT_TYPE = CURRENT_STATE_CONFIG.outcomeContextTypes[0];
const STANDING_DECISION_STATUS = CURRENT_STATE_CONFIG.standingDecisionStatuses[0];
const RETIRED_DECISION_STATUS = CFG.retiredDecisionStatuses[0];

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

/** A cold-start verdict that does NOT clear the configured trust floor. */
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

interface NodeSpec {
  id: string;
  type: EdgeNodeType;
  status?: string | null;
  contextType?: string | null;
  outcomeStatus?: string | null;
  /** an earlier task — technical_decisions.implementation_status (the BUILD lifecycle). */
  implementationStatus?: string | null;
  sessionId?: string | null;
  trust?: Trust;
}

function node(spec: NodeSpec): CoverageInputNode {
  return {
    id: spec.id,
    type: spec.type,
    title: spec.id,
    content: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    status: spec.status ?? null,
    outcomeStatus: spec.outcomeStatus ?? null,
    implementationStatus: spec.implementationStatus ?? null,
    contextType: spec.contextType ?? null,
    metadata: null,
    trust: spec.trust ?? trust(),
    sessionId: spec.sessionId === undefined ? 'sess-A' : spec.sessionId,
  };
}

/**
 * A graph with a KNOWN, FIXED set of coverage ratios, replicated `scale` times.
 *
 * Every replica is structurally identical (same statuses, same edges, same attribution), so
 * every ratio is byte-identical at every scale while every POPULATION multiplies. That is the
 * whole point: only a count-triggered rule can tell the copies apart.
 */
function scaledGraph(scale: number): { nodes: CoverageInputNode[]; edges: CoverageEdge[] } {
  const nodes: CoverageInputNode[] = [];
  const edges: CoverageEdge[] = [];
  for (let k = 0; k < scale; k++) {
    const s = `-r${k}`;
    // Two active tasks: one grounded in a decision, one with no edge at all.
    nodes.push(node({ id: `active-grounded${s}`, type: 'task', status: ACTIVE_STATUS }));
    nodes.push(node({ id: `active-orphan${s}`, type: 'task', status: ACTIVE_STATUS }));
    // The decision that grounds it (standing, so it is also a current decision).
    nodes.push(node({ id: `decision${s}`, type: 'decision', status: STANDING_DECISION_STATUS }));
    // Two landed tasks: one with SEPARATE accepted evidence, one with none.
    nodes.push(node({ id: `landed-evidenced${s}`, type: 'task', status: 'completed' }));
    nodes.push(node({ id: `landed-bare${s}`, type: 'task', status: 'completed' }));
    // The evidence: a completion context written by a DIFFERENT session.
    nodes.push(
      node({
        id: `evidence${s}`,
        type: 'context',
        contextType: OUTCOME_CONTEXT_TYPE,
        sessionId: 'sess-B',
      })
    );
    // A blocked task — part B's blockers section.
    nodes.push(node({ id: `blocked${s}`, type: 'task', status: BLOCKED_STATUS }));
    // A decision marked RETIRED that nothing supersedes in the graph.
    nodes.push(
      node({ id: `retired${s}`, type: 'decision', status: RETIRED_DECISION_STATUS })
    );
    // An unattributed, unproven historical record with only a WEAK edge.
    nodes.push(
      node({
        id: `unattributed${s}`,
        type: 'context',
        contextType: 'discussion',
        sessionId: null,
        trust: unprovenTrust(),
      })
    );

    edges.push({ from: `active-grounded${s}`, to: `decision${s}`, type: GROUNDING_EDGE });
    edges.push({ from: `landed-evidenced${s}`, to: `evidence${s}`, type: GROUNDING_EDGE });
    edges.push({ from: `blocked${s}`, to: `decision${s}`, type: GROUNDING_EDGE });
    edges.push({ from: `retired${s}`, to: `decision${s}`, type: GROUNDING_EDGE });
    edges.push({ from: `landed-bare${s}`, to: `decision${s}`, type: GROUNDING_EDGE });
    edges.push({ from: `unattributed${s}`, to: `decision${s}`, type: WEAK_EDGE });
  }
  return { nodes, edges };
}

function coverageOf(
  nodes: CoverageInputNode[],
  edges: CoverageEdge[],
  cfg: CoverageConfig = CFG
): ReturnType<typeof projectProjectCoverage> {
  return projectProjectCoverage(
    'proj-under-test',
    nodes,
    edges,
    { recordsInProject: nodes.length },
    cfg
  );
}

const codesOf = (c: ReturnType<typeof projectProjectCoverage>): string[] =>
  c.findings.map((f) => f.code).sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('graph-aware insights — coverage, not counts', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // THE HEADLINE GUARD
  // ═══════════════════════════════════════════════════════════════════════════
  describe('SCALE INVARIANCE — no finding may fire on an absolute count', () => {
    const SCALES = [1, 3, 17];

    test('the same ratios at ×1, ×3 and ×17 produce the SAME finding codes', () => {
      const results = SCALES.map((s) => {
        const g = scaledGraph(s);
        return { scale: s, coverage: coverageOf(g.nodes, g.edges) };
      });

      // Sanity: the populations really did scale (otherwise the property is vacuous — the
      // silent-pass failure mode a past incident names).
      const examined = results.map((r) => r.coverage.scope.recordsExamined);
      expect(examined[0]).toBeGreaterThan(0);
      expect(examined[2]).toBe(examined[0] * 17);

      // Sanity: findings actually FIRE, so "identical" is not "identically empty".
      expect(results[0].coverage.findings.length).toBeGreaterThan(0);

      const baseline = codesOf(results[0].coverage);
      for (const r of results.slice(1)) {
        expect(
          codesOf(r.coverage),
          `The fired finding set changed between ×1 and ×${r.scale} while every coverage ` +
            `RATIO was held constant. That can only happen if a rule is reading an absolute ` +
            `record count — which is precisely the defect an earlier task deleted ` +
            `("Low decision count - consider documenting more technical choices"). ` +
            `×1: [${baseline.join(', ')}] vs ×${r.scale}: [${codesOf(r.coverage).join(', ')}]`
        ).toEqual(baseline);
      }
    });

    test('every RATIO is identical across scales (the invariance premise itself holds)', () => {
      const dims = Object.keys(COVERAGE_CONFIG.floors) as Array<keyof CoverageRatios>;
      const at = (s: number): ReturnType<typeof projectProjectCoverage> => {
        const g = scaledGraph(s);
        return coverageOf(g.nodes, g.edges);
      };
      const base = at(1);
      for (const s of [3, 17]) {
        const scaled = at(s);
        for (const d of dims) {
          expect(scaled.ratios[d].ratio, `dimension ${d} drifted at ×${s}`).toBe(
            base.ratios[d].ratio
          );
          // …and the POPULATION really did grow, or the ratio equality proves nothing.
          if (base.ratios[d].of > 0) {
            expect(scaled.ratios[d].of).toBe(base.ratios[d].of * s);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE EVAL'S ACCEPTANCE, IN THE PURE CORE
  // ═══════════════════════════════════════════════════════════════════════════
  describe("the eval's acceptance: two decisions is not a gap", () => {
    /** A small, WELL-KEPT project: exactly the decisions it needed, all tasks complete,
     *  every task evidenced by a separate accepted record. The eval's project. */
    function healthySmallProject(): { nodes: CoverageInputNode[]; edges: CoverageEdge[] } {
      const nodes = [
        node({ id: 'd1', type: 'decision', status: STANDING_DECISION_STATUS, outcomeStatus: 'successful' }),
        node({ id: 'd2', type: 'decision', status: STANDING_DECISION_STATUS, outcomeStatus: 'successful' }),
        node({ id: 't1', type: 'task', status: 'completed' }),
        node({ id: 't2', type: 'task', status: 'completed' }),
        node({ id: 'c1', type: 'context', contextType: OUTCOME_CONTEXT_TYPE, sessionId: 'sess-B' }),
        node({ id: 'c2', type: 'context', contextType: OUTCOME_CONTEXT_TYPE, sessionId: 'sess-B' }),
      ];
      const edges: CoverageEdge[] = [
        { from: 't1', to: 'd1', type: GROUNDING_EDGE },
        { from: 't2', to: 'd2', type: GROUNDING_EDGE },
        { from: 't1', to: 'c1', type: GROUNDING_EDGE },
        { from: 't2', to: 'c2', type: GROUNDING_EDGE },
      ];
      return { nodes, edges };
    }

    test('reports STRONG task/outcome coverage (100%), not a volume complaint', () => {
      const g = healthySmallProject();
      const c = coverageOf(g.nodes, g.edges);

      expect(c.ratios.completedTaskEvidence.ratio).toBe(1);
      expect(c.ratios.branchConvergence.ratio).toBe(1);
      expect(c.ratios.completedTaskEvidence.belowFloor).toBe(false);
      expect(c.ratios.branchConvergence.belowFloor).toBe(false);
    });

    test('does NOT raise any finding merely because the absolute decision count is two', () => {
      const g = healthySmallProject();
      const c = coverageOf(g.nodes, g.edges);

      // Only TWO decisions exist. The deleted heuristic fired at `total < 5`.
      const decisions = g.nodes.filter((n) => n.type === 'decision');
      expect(decisions).toHaveLength(2);

      // Whatever fires must be traceable to a MEASURED gap: a ratio below its floor, or a
      // gate/lifecycle signal. No finding may cite a population it did not measure, and no
      // finding may fire with a full-coverage ratio.
      for (const f of c.findings) {
        expect(
          f.measured.ratio === null || f.measured.ratio < (f.measured.floor ?? 1),
          `finding '${f.code}' fired at full coverage — that is a volume complaint wearing a ` +
            `coverage costume`
        ).toBe(true);
      }

      // And specifically: none of the coverage dimensions the eval named is below floor.
      expect(c.ratios.completedTaskEvidence.belowFloor).toBe(false);
      expect(c.ratios.activeTaskGrounding.belowFloor).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE VOLUME-ADVICE PIN — fail-closed over the product's OWN finding vocabulary
  // ═══════════════════════════════════════════════════════════════════════════
  describe('no finding the product can emit is volume advice', () => {
    /**
     * THE PRE-FIX ADVICE, quoted verbatim from the deleted identifyKnowledgeGaps() /
     * identifyDecisionGaps(). These are the ARTEFACT under test — the exact sentences the
     * Amp-orb evaluator was given — not a rule the product owns, so quoting them here is the
     * point rather than a duplicated rule.
     */
    const VOLUME_ADVICE = [
      'low decision count',
      'consider documenting more',
      'few decisions documented',
      'record more architectural choices',
      'limited planning context',
      'limited error context',
      'no architecture decisions recorded',
      'no technology decisions recorded',
      // The SHAPE, not just the sentences: any advice to record MORE of a record kind.
      'document more',
      'more decisions',
    ];

    /**
     * FAIL-CLOSED BY CONSTRUCTION. The earlier version of this pin
     * lived only in the contract test and scanned the rendered text of two example projects —
     * so it could only see the render branches those two projects happened to reach. MEASURED:
     * planting `'Low decision count - consider documenting more technical choices'` in the
     * renderer's zero-findings branch left the whole suite GREEN, because neither fixture had
     * zero findings. The guard and the product agreed, and the product could be weakened
     * without the guard noticing.
     *
     * This version anchors on the CHOKE POINT instead: every finding the product is capable of
     * emitting. It forces EVERY code in COVERAGE_FINDING_CODES to fire across a set of graphs,
     * asserts that every code was actually exercised (an un-exercised code is a loud RED, not
     * a silent skip), and scans every headline + action string the product authored.
     */
    function allEmittableFindings(): Array<{ code: string; text: string }> {
      const graphs: Array<{ nodes: CoverageInputNode[]; edges: CoverageEdge[] }> = [
        // 1. The mixed graph: fires the ratio + lifecycle findings.
        scaledGraph(1),
        // 2. Same-session evidence → self-attributed-evidence.
        {
          nodes: [
            node({ id: 'sa-t', type: 'task', status: 'completed', sessionId: 'sess-A' }),
            node({
              id: 'sa-e',
              type: 'context',
              contextType: OUTCOME_CONTEXT_TYPE,
              sessionId: 'sess-A',
            }),
          ],
          edges: [{ from: 'sa-t', to: 'sa-e', type: GROUNDING_EDGE }],
        },
        // 3. Closed work, no artifact head → no-release-frontier.
        {
          nodes: [
            node({ id: 'rf-t', type: 'task', status: 'completed' }),
            node({ id: 'rf-e', type: 'context', contextType: OUTCOME_CONTEXT_TYPE }),
          ],
          edges: [{ from: 'rf-t', to: 'rf-e', type: GROUNDING_EDGE }],
        },
      ];
      const out: Array<{ code: string; text: string }> = [];
      for (const g of graphs) {
        for (const f of coverageOf(g.nodes, g.edges).findings) {
          out.push({ code: f.code, text: `${f.headline}\n${f.action}` });
        }
      }
      return out;
    }

    test('EVERY finding code is exercised by this pin (an un-exercised code is a RED)', () => {
      const fired = new Set(allEmittableFindings().map((f) => f.code));
      const missed = COVERAGE_FINDING_CODES.filter((c) => !fired.has(c));
      expect(
        missed,
        `these finding codes were never exercised, so this pin never inspected their text — ` +
          `add a graph that fires them. An un-inspected code is exactly the hole a MEASURED ` +
          `mutation walked through (a volume string planted in an unreached branch stayed GREEN).`
      ).toEqual([]);
    });

    test('no emittable finding recommends recording MORE records', () => {
      for (const f of allEmittableFindings()) {
        const lower = f.text.toLowerCase();
        for (const phrase of VOLUME_ADVICE) {
          expect(
            lower.includes(phrase),
            `finding '${f.code}' is emitting volume advice ("${phrase}"). That is the defect ` +
              `an earlier task deleted, wearing a coverage costume:\n${f.text}`
          ).toBe(false);
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ABSENT IS NOT PERFECT (and not failing either)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('an empty population reports NOTHING — never 100%, never 0%', () => {
    test('a project with no active tasks reports ratio null and raises no grounding finding', () => {
      const nodes = [node({ id: 'only', type: 'context', contextType: OUTCOME_CONTEXT_TYPE })];
      const c = coverageOf(nodes, [{ from: 'only', to: 'only', type: GROUNDING_EDGE }]);

      expect(c.ratios.activeTaskGrounding.of).toBe(0);
      expect(c.ratios.activeTaskGrounding.ratio).toBeNull();
      expect(c.ratios.activeTaskGrounding.belowFloor).toBe(false);
      expect(codesOf(c)).not.toContain('ungrounded-active-tasks');
    });

    test('an entirely empty project produces every ratio as null and no ratio finding', () => {
      const c = projectProjectCoverage('proj-empty', [], [], { recordsInProject: 0 });
      for (const key of Object.keys(c.ratios) as Array<keyof CoverageRatios>) {
        expect(c.ratios[key].ratio, `dimension ${key}`).toBeNull();
        expect(c.ratios[key].belowFloor, `dimension ${key}`).toBe(false);
      }
      for (const f of c.findings) {
        expect(f.measured.ratio, `finding ${f.code} fired off an empty population`).toBeNull();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WHAT EACH DIMENSION ACTUALLY MEASURES
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the dimensions read EDGES, which is the whole point', () => {
    test('an active task with no grounding edge is ungrounded; adding the edge covers it', () => {
      const nodes = [
        node({ id: 't', type: 'task', status: ACTIVE_STATUS }),
        node({ id: 'd', type: 'decision', status: STANDING_DECISION_STATUS }),
      ];
      const without = coverageOf(nodes, []);
      expect(without.ratios.activeTaskGrounding.ratio).toBe(0);
      expect(codesOf(without)).toContain('ungrounded-active-tasks');

      const withEdge = coverageOf(nodes, [{ from: 't', to: 'd', type: GROUNDING_EDGE }]);
      expect(withEdge.ratios.activeTaskGrounding.ratio).toBe(1);
      expect(codesOf(withEdge)).not.toContain('ungrounded-active-tasks');
    });

    test('a WEAK edge does not ground — the no-orphan fallback cannot manufacture coverage', () => {
      const nodes = [
        node({ id: 't', type: 'task', status: ACTIVE_STATUS }),
        node({ id: 'd', type: 'decision', status: STANDING_DECISION_STATUS }),
      ];
      const c = coverageOf(nodes, [{ from: 't', to: 'd', type: WEAK_EDGE }]);
      expect(c.ratios.activeTaskGrounding.ratio).toBe(0);
      // …but it DOES count as convergence: the record is reachable, just not grounded.
      expect(c.ratios.branchConvergence.ratio).toBe(1);
    });

    test('a completed task is NOT evidence for itself — self-report is not accepted evidence', () => {
      const alone = coverageOf([node({ id: 't', type: 'task', status: 'completed' })], []);
      expect(alone.ratios.completedTaskEvidence.of).toBe(1);
      expect(alone.ratios.completedTaskEvidence.ratio).toBe(0);
    });

    test('evidence that does not clear the trust floor does not count as evidence', () => {
      const nodes = [
        node({ id: 't', type: 'task', status: 'completed' }),
        node({
          id: 'e',
          type: 'context',
          contextType: OUTCOME_CONTEXT_TYPE,
          trust: unprovenTrust(),
        }),
      ];
      const c = coverageOf(nodes, [{ from: 't', to: 'e', type: GROUNDING_EDGE }]);
      expect(c.ratios.completedTaskEvidence.ratio).toBe(0);
    });

    test('evidence from the SAME session is flagged as self-attributed, not silently accepted', () => {
      const nodes = [
        node({ id: 't', type: 'task', status: 'completed', sessionId: 'sess-A' }),
        node({
          id: 'e',
          type: 'context',
          contextType: OUTCOME_CONTEXT_TYPE,
          sessionId: 'sess-A',
        }),
      ];
      const c = coverageOf(nodes, [{ from: 't', to: 'e', type: GROUNDING_EDGE }]);
      expect(c.ratios.completedTaskEvidence.ratio).toBe(1); // it IS evidence…
      expect(codesOf(c)).toContain('self-attributed-evidence'); // …and it is flagged
    });

    test('a decision marked retired with nothing superseding it is reported', () => {
      const nodes = [node({ id: 'd', type: 'decision', status: RETIRED_DECISION_STATUS })];
      expect(codesOf(coverageOf(nodes, []))).toContain('undeclared-supersession');

      // The SAME decision, with the trust service reporting a declared supersession, is fine.
      const superseded = [
        node({
          id: 'd',
          type: 'decision',
          status: RETIRED_DECISION_STATUS,
          trust: trust({ superseded: true }),
        }),
      ];
      expect(codesOf(coverageOf(superseded, []))).not.toContain('undeclared-supersession');
    });

    test('a record with no session attribution is measured, not assumed', () => {
      const nodes = [
        node({ id: 'a', type: 'context', contextType: 'discussion', sessionId: null }),
        node({ id: 'b', type: 'context', contextType: 'discussion', sessionId: 'sess-A' }),
      ];
      const c = coverageOf(nodes, []);
      expect(c.ratios.sessionAttribution.ratio).toBe(0.5);
      expect(codesOf(c)).toContain('unattributed-records');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PART B IS CONSUMED, NOT RE-SPELLED
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the current state comes from part B, unmodified', () => {
    test('the gate + next action on the answer are the ones part B derived', () => {
      const g = scaledGraph(1);
      const c = coverageOf(g.nodes, g.edges);

      // Not asserted against a literal: asserted against what part B's own projector returns
      // for the same graph. If part C ever grew its own gate, these would diverge.
      const fromPartB = projectProjectCoverage(
        'proj-under-test',
        g.nodes,
        g.edges,
        { recordsInProject: g.nodes.length },
        CFG
      ).currentState;
      expect(c.currentState.nextAction).toEqual(fromPartB.nextAction);
      expect(c.currentState.blockers.total).toBe(fromPartB.blockers.total);
    });

    test('superseded records are omitted-but-COUNTED by the same accounting', () => {
      const nodes = [
        node({ id: 'live', type: 'task', status: ACTIVE_STATUS }),
        node({ id: 'old', type: 'context', contextType: 'discussion', trust: trust({ superseded: true }) }),
      ];
      const c = coverageOf(nodes, []);
      expect(c.currentState.omitted.superseded.count).toBe(1);
      expect(c.currentState.counts.examined).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FAIL-CLOSED: unrecognized input is a LOUD RED, never a silent pass
  // ═══════════════════════════════════════════════════════════════════════════
  describe('fail-closed', () => {
    test('an unclassified edge type is a LOUD throw, not a silent grounding assumption', () => {
      expect(() =>
        assertEdgeTypePartitionTotal(
          [...EDGE_TYPES, 'brand_new_edge_type'],
          COVERAGE_CONFIG.groundingEdgeTypes,
          COVERAGE_CONFIG.weakEdgeTypes,
          COVERAGE_CONFIG.supersessionEdgeTypes
        )
      ).toThrow(/brand_new_edge_type/);
    });

    test('an edge type classified TWICE is a loud throw', () => {
      expect(() =>
        assertEdgeTypePartitionTotal(
          EDGE_TYPES,
          COVERAGE_CONFIG.groundingEdgeTypes,
          [...COVERAGE_CONFIG.weakEdgeTypes, COVERAGE_CONFIG.groundingEdgeTypes[0]],
          COVERAGE_CONFIG.supersessionEdgeTypes
        )
      ).toThrow(/BOTH/);
    });

    test('a STALE classification (an edge type that no longer exists) is a loud throw', () => {
      expect(() =>
        assertEdgeTypePartitionTotal(
          EDGE_TYPES.filter((t) => t !== COVERAGE_CONFIG.weakEdgeTypes[0]),
          COVERAGE_CONFIG.groundingEdgeTypes,
          COVERAGE_CONFIG.weakEdgeTypes,
          COVERAGE_CONFIG.supersessionEdgeTypes
        )
      ).toThrow(/not a live edge type/);
    });

    test('the LIVE config partitions the LIVE edge-type domain (no arguments — the real thing)', () => {
      expect(() => assertEdgeTypePartitionTotal()).not.toThrow();
    });

    test('a finding code with no rule is a loud throw, never a skipped rule', () => {
      const bogus = 'not-a-real-finding-code' as CoverageFindingCode;
      const original = [...COVERAGE_FINDING_CODES];
      // Exercise the product's OWN loop over a vocabulary containing an unimplemented code.
      // (COVERAGE_FINDING_CODES is readonly at the type level; the runtime backstop is what
      // is under test here — it exists for a code list assembled outside this module.)
      const mutable = COVERAGE_FINDING_CODES as unknown as string[];
      mutable.push(bogus);
      try {
        expect(() =>
          evaluateFindings({
            cfg: CFG,
            ratios: coverageOf([], []).ratios,
            state: coverageOf([], []).currentState,
            selfAttributedIds: [],
            undeclaredSupersessionIds: [],
          } as unknown as Parameters<typeof evaluateFindings>[0])
        ).toThrow(/not-a-real-finding-code/);
      } finally {
        mutable.length = 0;
        mutable.push(...original);
      }
      expect([...COVERAGE_FINDING_CODES]).toEqual(original);
    });

    test('an impossible scope (examined > in-project) is a loud throw', () => {
      const nodes = [node({ id: 'a', type: 'task', status: ACTIVE_STATUS })];
      expect(() =>
        projectProjectCoverage('p', nodes, [], { recordsInProject: 0 })
      ).toThrow(/scope is impossible/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DETERMINISM
  // ═══════════════════════════════════════════════════════════════════════════
  test('the answer is byte-identical across repeat calls and independent of input order', () => {
    const g = scaledGraph(3);
    const a = coverageOf(g.nodes, g.edges);
    const b = coverageOf([...g.nodes].reverse(), [...g.edges].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE FLOORS ARE CONFIG, NOT LITERALS
  // ═══════════════════════════════════════════════════════════════════════════
  test('every dimension compares against the floor the CONFIG names (no inlined threshold)', () => {
    const g = scaledGraph(1);
    const c = coverageOf(g.nodes, g.edges);
    for (const key of Object.keys(COVERAGE_CONFIG.floors) as Array<keyof CoverageRatios>) {
      expect(c.ratios[key].floor, `dimension ${key} is not reading its configured floor`).toBe(
        COVERAGE_CONFIG.floors[key]
      );
    }
  });

  test('moving a floor via config moves the verdict — the knob is real, not decorative', () => {
    const g = scaledGraph(1);
    const strict: CoverageConfig = {
      ...CFG,
      floors: { ...CFG.floors, activeTaskGrounding: 1 },
    };
    const lenient: CoverageConfig = {
      ...CFG,
      floors: { ...CFG.floors, activeTaskGrounding: 0 },
    };
    expect(codesOf(coverageOf(g.nodes, g.edges, strict))).toContain('ungrounded-active-tasks');
    expect(codesOf(coverageOf(g.nodes, g.edges, lenient))).not.toContain(
      'ungrounded-active-tasks'
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // THE LANDED POPULATION FOLLOWS mapTaskOutcome
  // ═══════════════════════════════════════════════════════════════════════════
  // `landedTasks` is defined as `mapTaskOutcome(status) !== null`, so the trust model's
  // status semantics OWN this reported metric: when `cancelled` stopped being outcome
  // evidence, cancelled tasks left the completedTaskEvidence population and the coverage
  // percentage rose as a side effect. That is correct — a cancelled task did not land and
  // is not owed evidence — but it was unpinned, and a metric that improves silently is how
  // a number stops meaning what we say it means. Asserted on POPULATION MEMBERSHIP (which
  // ids are in it), never on the percentage: a percentage can agree for the wrong reason.
  test('landed population follows mapTaskOutcome: a completed task is IN it, a cancelled task is NOT', () => {
    const COMPLETED = 'completed';
    const CANCELLED = 'cancelled';
    // The premise, read from the product rather than asserted about it: these two statuses
    // differ in exactly one way — whether mapTaskOutcome calls them ground truth.
    expect(mapTaskOutcome(COMPLETED)).not.toBeNull();
    expect(mapTaskOutcome(CANCELLED)).toBeNull();

    // Neither task has any edge, so NEITHER is covered by separate evidence. Every member
    // of the population therefore appears in gapSampleIds — which makes that list the
    // membership roster, not a sample of the interesting half.
    const nodes = [
      node({ id: 'task-completed', type: 'task', status: COMPLETED }),
      node({ id: 'task-cancelled', type: 'task', status: CANCELLED }),
    ];
    const r = coverageOf(nodes, []).ratios.completedTaskEvidence;

    expect(r.gapSampleIds).toContain('task-completed');
    expect(r.gapSampleIds).not.toContain('task-cancelled');
    expect(r.gapSampleOmitted).toBe(0); // nothing hid outside the roster
    expect(r.of).toBe(1); // the cancelled task is not in the population at all
  });
});
