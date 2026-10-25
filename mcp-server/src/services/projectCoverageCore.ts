/**
 * GRAPH-AWARE PROJECT INSIGHTS — the PURE core (part C of
 * the read model; Amp-orb eval Lane B P2, report lines 558-581).
 *
 * THE QUESTION IT ANSWERS: "is this project's graph COMPLETE and EVIDENCED?" — not "does this
 * project have enough records?". The eval measured the difference: `project.insights` told a
 * project with exactly the decisions it needed, all tasks complete and strong graph evidence
 * to "document more decisions" and "record more architectural choices", while `recall_thread`
 * on the same graph was substantially more accurate. The old heuristics read three COUNTS and
 * ZERO edges. This module reads edges and reads nothing else as a trigger.
 *
 * THE INVARIANT, stated so it can be tested: NO FINDING HERE FIRES ON AN ABSOLUTE COUNT.
 * Every rule triggers on a RATIO against a config floor, or on a signal the current-state
 * read model already derived. projectCoverage.unit.test.ts holds the ratios constant and
 * scales the whole graph ×1/×3/×17, requiring the fired finding-code set to be identical — a
 * count-triggered rule cannot survive that, which is what makes this a guard rather than a
 * comment.
 *
 * DB-FREE ON PURPOSE (mirrors currentStateCore.ts / recallThreadCore.ts): the whole rule set
 * lives here and imports no `pg`, so it can be hammered offline with zero database. The gather
 * lives in services/projectCoverage.ts.
 *
 * CONSUMES PART B, NEVER RE-SPELLS IT (the design constraint on this task). "Where does this
 * stand / is there a trusted frontier" belongs to an earlier task and is asked exactly once, by
 * calling projectCurrentState(). This module writes NO frontier query, NO supersession query,
 * NO trust-floor predicate and NO outcome mapping of its own:
 *   - current state / frontier / gate → projectCurrentState() (currentStateCore)
 *   - what a node IS                  → classifyNode() (currentStateCore) — the same
 *                                       active/blocker/outcome/historical dispositions the
 *                                       `current` altitude reports
 *   - supersession                    → Trust.superseded (services/trust.ts)
 *   - the trust floor                 → clearsMinTrust() (recallThreadCore) — the same
 *                                       predicate `minTrust` uses
 *   - outcome semantics               → mapTaskOutcome() (trustModel)
 *   - trust RENDERING                 → not done here at all; the core returns counts and the
 *                                       route renders through the single explainTrust().
 * A second definition of any of those is the drift this workstream exists to prevent
 * (the four drifted trust renders an earlier task had to collapse).
 *
 * ABSENT IS NOT PERFECT (an earlier task's class, re-applied here). A dimension with an EMPTY
 * population reports `ratio: null`, never 1.0 and never 0. A project with no active tasks does
 * not have "100% active-task grounding", and it does not have a grounding failure either — it
 * has nothing to say. A null ratio can never produce a finding.
 */

import { mapTaskOutcome } from './trustModel.js';
import { clearsMinTrust } from './recallThreadCore.js';
import {
  projectCurrentState,
  classifyNode,
  type CurrentState,
  type CurrentStateInputNode,
} from './currentStateCore.js';
import {
  CURRENT_STATE_CONFIG,
  type CurrentStateConfig,
  type CurrentStateGateId,
} from '../config/currentStateConfig.js';
import { THREAD_CONFIG, type ThreadConfig } from '../config/threadConfig.js';
import { ARTIFACT_REF_CONFIG, type ArtifactRefConfig } from '../config/artifactRefConfig.js';
import { COVERAGE_CONFIG, type CoverageConfig } from '../config/coverageConfig.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — what goes in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One examined record: everything the current-state read model classifies by, PLUS the
 * authoring attribution. The attribution is the only field this module adds to B's input
 * shape, and it is added because the eval's acceptance names it explicitly ("flags session
 * attribution"): a record nobody can be traced back to is a real gap in the graph, and it is
 * invisible to a count.
 */
export interface CoverageInputNode extends CurrentStateInputNode {
  /** contexts/tasks/technical_decisions .session_id — null when the record carries none. */
  sessionId: string | null;
}

/** One typed edge, in canonical from→to orientation. */
export interface CoverageEdge {
  from: string;
  to: string;
  type: string;
  /**
   * The declared/guessed provenance class from the `link_provenance` VIEW (migration 079,
   * an earlier task). This module never computes the class — the SQL view is the single
   * source; the gather reads it back. OPTIONAL for older/synthetic callers, and an absent
   * value is counted as 'unclassified' — fail-closed: an edge whose provenance nobody
   * stated must never inflate the declared bucket.
   */
  provenance?: 'declared' | 'guessed' | 'unclassified';
}

/**
 * The provenance split over the examined edges — reported BESIDE the coverage ratios, never
 * folded into them. WHY (the graph audit): edge COVERAGE held 97-98% for 15 days while
 * the declared minting mechanism was dead, because a guess-edge and a declared-edge count
 * identically. The split is what makes a guess quietly replacing a fact visible.
 */
export interface CoverageProvenanceSplit {
  /** Edges whose target was explicitly NAMED (tags / links arg / body ids / positional). */
  declared: number;
  /** Edges the system inferred (similarity guess, anchor, adjudicator, backfill). */
  guessed: number;
  /** Edges with an unrecognized or absent provenance stamp — surfaced, never absorbed. */
  unclassified: number;
  total: number;
  /** declared/total, or null when no edges were examined (absent is not perfect). */
  declaredRatio: number | null;
}

/** What the read actually looked at — stated exactly, so a capped answer is never mistaken
 *  for a complete one. */
export interface CoverageScope {
  /** Records that EXIST in the project (counted before any cap). */
  recordsInProject: number;
  /** Records hydrated + trust-annotated + classified for this answer. */
  recordsExamined: number;
  /** True when the cap bit: MORE records exist than this answer examined. */
  truncated: boolean;
  /** Edges read across the examined records (both directions). */
  edgesExamined: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — what comes out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE coverage dimension: a covered/of ratio against its configured floor.
 *
 * `ratio` is null when `of` is 0 (absent is not perfect, and not failing either), and
 * `belowFloor` is then false BY CONSTRUCTION — an empty population can never raise a finding.
 */
export interface CoverageRatio {
  /** How many of the population satisfy the dimension. */
  covered: number;
  /** The population size the ratio is OF. */
  of: number;
  /** covered/of, or null when the population is empty. */
  ratio: number | null;
  /** The configured floor this ratio is compared against. */
  floor: number;
  /** ratio !== null && ratio < floor. */
  belowFloor: boolean;
  /** Ids of the population members that are NOT covered (bounded sample; count is exact). */
  gapSampleIds: string[];
  /** How many uncovered ids exist beyond `gapSampleIds`. */
  gapSampleOmitted: number;
}

/** Every coverage dimension this module measures. */
export interface CoverageRatios {
  /** Active tasks carrying ≥1 GROUNDING edge — "linked to plans/decisions/outcomes". */
  activeTaskGrounding: CoverageRatio;
  /** Landed tasks backed by a SEPARATE trust-clearing outcome record — not self-report. */
  completedTaskEvidence: CoverageRatio;
  /** Records carrying ≥1 edge of any type — "does every branch converge". */
  branchConvergence: CoverageRatio;
  /** Records carrying a session attribution. */
  sessionAttribution: CoverageRatio;
  /** Historical records that clear the trust floor — "unproven historical nodes". */
  historicalTrust: CoverageRatio;
}

/**
 * THE FINDING CODES — the total, ordered vocabulary. A union type, so the rule table below is
 * checked for totality by the COMPILER (preferred over a test), with a runtime
 * throw as the backstop for a caller the type system cannot see.
 */
export const COVERAGE_FINDING_CODES = [
  'unresolved-blockers',
  'ungrounded-active-tasks',
  'unevidenced-completed-tasks',
  'self-attributed-evidence',
  'undeclared-supersession',
  'orphan-records',
  'untrusted-historical-records',
  'unattributed-records',
  'no-release-frontier',
] as const;
export type CoverageFindingCode = (typeof COVERAGE_FINDING_CODES)[number];

export type CoverageSeverity = 'attention' | 'note';

/**
 * WHAT A FINDING'S `of` COUNTS. Stated explicitly because the two units are not
 * interchangeable and conflating them produces an impossible number:
 *   - `records` — `of` is a population of examined RECORDS. It can never exceed the examined
 *                 set, and the projector asserts exactly that.
 *   - `signals` — `of` counts something that is not a record (unreadable artifact references,
 *                 for instance). It is NOT bounded by the record count and must not be
 *                 checked against it.
 * A union type rather than a convention, so a new finding has to SAY which it is (the
 * compiler asks) instead of silently inheriting the wrong check.
 */
export type CoverageMeasureUnit = 'records' | 'signals';

/** One thing the graph is missing, with the measurement that produced it. */
export interface CoverageFinding {
  code: CoverageFindingCode;
  severity: CoverageSeverity;
  /** One line, naming what is missing — never "consider documenting more X". */
  headline: string;
  /** What to do about it, in tool terms. */
  action: string;
  /** The exact measurement behind the headline. */
  measured: {
    covered: number;
    of: number;
    ratio: number | null;
    floor: number | null;
    unit: CoverageMeasureUnit;
  };
  /** Bounded drill-down handle. Counts in `measured` are exact regardless. */
  sampleIds: string[];
  sampleOmitted: number;
}

/** The full graph-aware insight answer. */
export interface ProjectCoverage {
  projectId: string;
  /**
   * The current-state projection over the project's examined records — computed by part B's
   * projector, not by this module. The frontier, the gate and the next action all come from
   * here, which is why there is exactly one definition of them in the codebase.
   */
  currentState: CurrentState;
  ratios: CoverageRatios;
  findings: CoverageFinding[];
  scope: CoverageScope;
  /** Declared vs guessed split over the examined edges — beside, never
   *  inside, the ratios: coverage says HOW CONNECTED, provenance says HOW TRUSTWORTHY. */
  provenance: CoverageProvenanceSplit;
}

// ─────────────────────────────────────────────────────────────────────────────
// RATIO CONSTRUCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a ratio from a population and the predicate that covers it.
 *
 * THE EMPTY-POPULATION RULE lives HERE, once: `of === 0` → `ratio: null`, `belowFloor: false`.
 * Every dimension inherits it, so no rule can accidentally read 0/0 as a perfect score (the
 * "absent rendered as perfect" class that shipped a fabricated 100/100 for ten months) or as
 * a failure.
 */
function ratioOf(
  population: CoverageInputNode[],
  covered: (n: CoverageInputNode) => boolean,
  floor: number,
  cfg: CoverageConfig
): CoverageRatio {
  const gaps = population.filter((n) => !covered(n)).map((n) => n.id);
  gaps.sort(); // deterministic sample, independent of input order
  const of = population.length;
  const coveredCount = of - gaps.length;
  const ratio = of === 0 ? null : coveredCount / of;
  const sample = gaps.slice(0, cfg.maxSampleIds);
  return {
    covered: coveredCount,
    of,
    ratio,
    floor,
    belowFloor: ratio !== null && ratio < floor,
    gapSampleIds: sample,
    gapSampleOmitted: Math.max(0, gaps.length - sample.length),
  };
}

/** A finding derived from a ratio dimension. Never called when the ratio is null. */
function fromRatio(
  code: CoverageFindingCode,
  severity: CoverageSeverity,
  r: CoverageRatio,
  headline: string,
  action: string
): CoverageFinding {
  return {
    code,
    severity,
    headline,
    action,
    measured: { covered: r.covered, of: r.of, ratio: r.ratio, floor: r.floor, unit: 'records' },
    sampleIds: r.gapSampleIds,
    sampleOmitted: r.gapSampleOmitted,
  };
}

/** A finding derived from a SET of records rather than a ratio (count > 0 → fires; scale
 *  invariant by construction, since 0 stays 0 and n scales to k·n). */
function fromSet(
  code: CoverageFindingCode,
  severity: CoverageSeverity,
  ids: string[],
  cfg: CoverageConfig,
  headline: string,
  action: string
): CoverageFinding {
  const sorted = [...ids].sort();
  const sample = sorted.slice(0, cfg.maxSampleIds);
  return {
    code,
    severity,
    headline,
    action,
    measured: { covered: 0, of: sorted.length, ratio: null, floor: null, unit: 'records' },
    sampleIds: sample,
    sampleOmitted: Math.max(0, sorted.length - sample.length),
  };
}

const pct = (r: number | null): string => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);

// ─────────────────────────────────────────────────────────────────────────────
// THE RULE TABLE
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a rule may look at. Deliberately does NOT include a raw record total. */
interface RuleInput {
  cfg: CoverageConfig;
  ratios: CoverageRatios;
  state: CurrentState;
  /** Landed tasks whose only evidence was written in the SAME session as the task itself. */
  selfAttributedIds: string[];
  /** Decisions whose status says RETIRED but which nothing supersedes in the graph. */
  undeclaredSupersessionIds: string[];
}

/**
 * The gate rung that means "finished, but there is nothing a consumer can be pointed at".
 * Typed as CurrentStateGateId, so renaming the rung in part B's config is a COMPILE error
 * here rather than a rule that silently stops firing (prefer the compiler).
 */
const RELEASE_FRONTIER_GATE: CurrentStateGateId = 'awaiting-release';

/**
 * ONE rule per finding code. `Record<CoverageFindingCode, …>` makes totality a COMPILER
 * obligation: adding a code without a rule does not build.
 */
const COVERAGE_RULES: Record<CoverageFindingCode, (g: RuleInput) => CoverageFinding | null> = {
  'unresolved-blockers': (g) => {
    const total = g.state.blockers.total;
    if (total === 0) return null;
    return {
      code: 'unresolved-blockers',
      severity: 'attention',
      headline: `${total} unresolved blocker/finding record(s) are still open`,
      action:
        'Resolve or supersede them — supersession is the only resolution signal the graph ' +
        'carries, so an unsuperseded error context reads as still-open forever.',
      measured: { covered: 0, of: total, ratio: null, floor: null, unit: 'records' },
      sampleIds: g.state.blockers.items.slice(0, g.cfg.maxSampleIds).map((n) => n.id),
      sampleOmitted: Math.max(0, total - Math.min(total, g.cfg.maxSampleIds)),
    };
  },

  'ungrounded-active-tasks': (g) => {
    const r = g.ratios.activeTaskGrounding;
    if (!r.belowFloor) return null;
    return fromRatio(
      'ungrounded-active-tasks',
      'attention',
      r,
      `${r.of - r.covered} of ${r.of} active task(s) carry no link to a plan, decision or ` +
        `outcome (${pct(r.ratio)} grounded, floor ${pct(r.floor)})`,
      'Link them with `link` (decided_by / proposed_by / informs) so an orienting agent can ' +
        'see WHY the work is open.'
    );
  },

  'unevidenced-completed-tasks': (g) => {
    const r = g.ratios.completedTaskEvidence;
    if (!r.belowFloor) return null;
    return fromRatio(
      'unevidenced-completed-tasks',
      'attention',
      r,
      `${r.of - r.covered} of ${r.of} landed task(s) are backed only by their own status — ` +
        `no separate trust-clearing outcome record vouches for them (${pct(r.ratio)} ` +
        `evidenced, floor ${pct(r.floor)})`,
      'Record the completion/milestone that proves it and link it (produced_outcome / caused) ' +
        '— a task marking itself done is self-report, not evidence.'
    );
  },

  'self-attributed-evidence': (g) =>
    g.selfAttributedIds.length === 0
      ? null
      : fromSet(
          'self-attributed-evidence',
          'note',
          g.selfAttributedIds,
          g.cfg,
          `${g.selfAttributedIds.length} landed task(s) are evidenced only by records written ` +
            `in the SAME session that did the work`,
          'Attribution is intact, but the evidence is self-attested. An acceptance recorded by ' +
            'a different session (a reviewer/gate) is the stronger signal.'
        ),

  'undeclared-supersession': (g) =>
    g.undeclaredSupersessionIds.length === 0
      ? null
      : fromSet(
          'undeclared-supersession',
          'attention',
          g.undeclaredSupersessionIds,
          g.cfg,
          `${g.undeclaredSupersessionIds.length} decision(s) are marked retired but nothing ` +
            `supersedes them in the graph`,
          'Mint the `supersedes` edge from the replacement (or set superseded_by) so a reader ' +
            'lands on what replaced it instead of a dead end.'
        ),

  'orphan-records': (g) => {
    const r = g.ratios.branchConvergence;
    if (!r.belowFloor) return null;
    return fromRatio(
      'orphan-records',
      'attention',
      r,
      `${r.of - r.covered} of ${r.of} examined record(s) carry NO edge at all — those branches ` +
        `never converge (${pct(r.ratio)} connected, floor ${pct(r.floor)})`,
      'Link them, or accept them as intentionally standalone. A disconnected record is ' +
        'unreachable by recall_thread and invisible to every downstream read.'
    );
  },

  'untrusted-historical-records': (g) => {
    const r = g.ratios.historicalTrust;
    if (!r.belowFloor) return null;
    return fromRatio(
      'untrusted-historical-records',
      'note',
      r,
      `${r.of - r.covered} of ${r.of} historical record(s) do not clear the trust floor — ` +
        `they are still cited by the graph but nothing downstream has proven them ` +
        `(${pct(r.ratio)} proven, floor ${pct(r.floor)})`,
      'Close the loop on the work that used them (decision_update outcomeStatus / a linked ' +
        'outcome record) — that is what promotes a record out of unproven.'
    );
  },

  'unattributed-records': (g) => {
    const r = g.ratios.sessionAttribution;
    if (!r.belowFloor) return null;
    return fromRatio(
      'unattributed-records',
      'note',
      r,
      `${r.of - r.covered} of ${r.of} examined record(s) carry no session attribution — ` +
        `there is no way to trace who wrote them (${pct(r.ratio)} attributed, floor ` +
        `${pct(r.floor)})`,
      'Records written outside a tracked session lose their provenance. Prefer writing ' +
        'through a live session so attribution is captured at write time.'
    );
  },

  'no-release-frontier': (g) => {
    if (g.state.nextAction.gate !== RELEASE_FRONTIER_GATE) return null;
    return {
      code: 'no-release-frontier',
      severity: 'attention',
      headline: `No trusted release frontier: ${g.state.nextAction.gateReason}`,
      action: g.state.nextAction.action,
      // UNIT 'signals', not 'records': this rung measures whether ONE release frontier
      // exists, plus how many artifact references were unreadable. Neither is a record
      // population, and checking it as one produced an impossible "population of 1 out of 0
      // examined records" on an empty project — caught by the accounting assert below, which
      // is why the unit is now part of the type rather than a convention.
      measured: {
        covered: g.state.artifactHead === null ? 0 : 1,
        of: 1 + g.state.artifactIssues.length,
        ratio: null,
        floor: null,
        unit: 'signals',
      },
      sampleIds: g.state.nextAction.targetId ? [g.state.nextAction.targetId] : [],
      sampleOmitted: 0,
    };
  },
};

/**
 * Walk the finding vocabulary in order, collecting whatever fires.
 *
 * FAIL-CLOSED: a code with no implementation THROWS. The Record type above
 * already makes that a compile error for in-tree code; this is the backstop for a code list
 * assembled elsewhere, and it is a loud RED rather than a silently skipped rule — a skipped
 * rule is a health signal that quietly stops noticing something.
 */
export function evaluateFindings(g: RuleInput): CoverageFinding[] {
  const out: CoverageFinding[] = [];
  for (const code of COVERAGE_FINDING_CODES) {
    const rule = COVERAGE_RULES[code];
    if (typeof rule !== 'function') {
      throw new Error(
        `coverage finding vocabulary names '${code}', which has no rule. Implement it in ` +
          `COVERAGE_RULES or remove it from COVERAGE_FINDING_CODES — an unrecognized finding ` +
          `code must never be silently skipped.`
      );
    }
    const finding = rule(g);
    if (finding !== null) {
      if (finding.code !== code) {
        throw new Error(
          `coverage rule for '${code}' returned a finding labelled '${finding.code}'. A rule ` +
            `must not mislabel its own finding — the code is what every consumer keys on.`
        );
      }
      out.push(finding);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROJECTOR
// ─────────────────────────────────────────────────────────────────────────────

/** Adjacency built once: id → the ids reachable by a GROUNDING edge, either direction. */
function buildGroundingAdjacency(
  edges: CoverageEdge[],
  cfg: CoverageConfig
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => {
    let s = adj.get(a);
    if (s === undefined) {
      s = new Set<string>();
      adj.set(a, s);
    }
    s.add(b);
  };
  for (const e of edges) {
    if (!cfg.groundingEdgeTypes.includes(e.type)) continue;
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

/** id → how many edges of ANY type touch it (the convergence signal). */
function buildDegree(edges: CoverageEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  const bump = (id: string): void => {
    deg.set(id, (deg.get(id) ?? 0) + 1);
  };
  for (const e of edges) {
    bump(e.from);
    bump(e.to);
  }
  return deg;
}

/**
 * PROJECT the project's examined subgraph into the graph-aware insight.
 *
 * PURE + TOTAL: no DB, no clock, no randomness, no model. Same graph in, same answer out, in
 * any input order.
 *
 * @param projectId the project this answer is about. It is also handed to part B's projector
 *                  as the anchor id: a PROJECT has no single root record, so `root` comes back
 *                  null and the gate ladder evaluates over the whole examined graph. That is
 *                  the honest shape — inventing a root would be a second definition of
 *                  "the thing this thread is about".
 */
export function projectProjectCoverage(
  projectId: string,
  nodes: CoverageInputNode[],
  edges: CoverageEdge[],
  scopeCounts: { recordsInProject: number },
  cfg: CoverageConfig = COVERAGE_CONFIG,
  csCfg: CurrentStateConfig = CURRENT_STATE_CONFIG,
  threadCfg: ThreadConfig = THREAD_CONFIG,
  artifactCfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG
): ProjectCoverage {
  if (scopeCounts.recordsInProject < nodes.length) {
    throw new Error(
      `project coverage scope is impossible: examined ${nodes.length} record(s) but the ` +
        `project reportedly holds only ${scopeCounts.recordsInProject}. A scope that cannot ` +
        `be true would make every ratio below unreadable.`
    );
  }

  // ── PART B DOES THE CURRENT STATE. This module asks once and never re-derives it. ──
  const currentState = projectCurrentState(nodes, projectId, csCfg, threadCfg, artifactCfg);

  const byId = new Map<string, CoverageInputNode>(nodes.map((n) => [n.id, n]));
  const grounding = buildGroundingAdjacency(edges, cfg);
  const degree = buildDegree(edges);

  // ── POPULATIONS, each defined by a REUSED predicate ────────────────────────
  const dispositions = new Map<string, ReturnType<typeof classifyNode>>(
    nodes.map((n) => [n.id, classifyNode(n, csCfg)])
  );
  const is = (n: CoverageInputNode, d: string): boolean =>
    (dispositions.get(n.id) ?? []).includes(d as never);

  const activeTasks = nodes.filter((n) => is(n, 'active-task'));
  // A LANDED task is one whose own status carries ground truth — mapTaskOutcome is the
  // existing definition of that, reused rather than re-spelled as a status list. Superseded
  // records are excluded: they are not current, so they are not owed current evidence.
  const landedTasks = nodes.filter(
    (n) => n.type === 'task' && !n.trust.superseded && mapTaskOutcome(n.status) !== null
  );
  // POPULATION HELD CONSTANT ACROSS an earlier task. `historicalTrust` asks "are the records
  // the graph still cites, but is no longer acting on, actually proven?" Before the recency
  // door existed, every context that matched no other rule classified as `historical`, so it
  // was in this population. The door renamed where those contexts LAND in the current-state
  // read model; it did not change what this dimension is measuring. Taking the UNION keeps
  // this metric measuring the same records it always did — a bucket rename must never
  // silently shrink an unrelated coverage population (that shrink reads as "coverage
  // improved", which is the most dangerous direction for a metric to move by accident).
  const historical = nodes.filter((n) => is(n, 'historical') || is(n, 'recent-context'));

  /** Does a SEPARATE record vouch for this one? (a trusted outcome, reached by a grounding
   *  edge — never the record itself, which would be self-report). */
  const evidenceFor = (n: CoverageInputNode): CoverageInputNode[] => {
    const neighbours = grounding.get(n.id);
    if (neighbours === undefined) return [];
    const out: CoverageInputNode[] = [];
    for (const id of neighbours) {
      if (id === n.id) continue;
      const other = byId.get(id);
      if (other === undefined) continue; // outside the examined window — cannot judge it
      if (is(other, 'trusted-outcome')) out.push(other);
    }
    return out;
  };

  const ratios: CoverageRatios = {
    activeTaskGrounding: ratioOf(
      activeTasks,
      (n) => (grounding.get(n.id)?.size ?? 0) > 0,
      cfg.floors.activeTaskGrounding,
      cfg
    ),
    completedTaskEvidence: ratioOf(
      landedTasks,
      (n) => evidenceFor(n).length > 0,
      cfg.floors.completedTaskEvidence,
      cfg
    ),
    branchConvergence: ratioOf(
      nodes,
      (n) => (degree.get(n.id) ?? 0) > 0,
      cfg.floors.branchConvergence,
      cfg
    ),
    sessionAttribution: ratioOf(
      nodes,
      (n) => n.sessionId !== null,
      cfg.floors.sessionAttribution,
      cfg
    ),
    historicalTrust: ratioOf(
      historical,
      (n) => clearsMinTrust(n.trust, cfg.trustFloor),
      cfg.floors.historicalTrust,
      cfg
    ),
  };

  // ── SELF-ATTRIBUTED EVIDENCE: attribution exists, but only from the same session ──
  // Both sides must carry an attribution for the comparison to mean anything; a null on
  // either side is an ATTRIBUTION gap (its own dimension), not a self-report claim.
  const selfAttributedIds = landedTasks
    .filter((n) => {
      if (n.sessionId === null) return false;
      const evidence = evidenceFor(n);
      if (evidence.length === 0) return false; // that is the unevidenced dimension, not this one
      return evidence.every((e) => e.sessionId === n.sessionId);
    })
    .map((n) => n.id);

  // ── RETIRED BY STATUS, BUT NOT IN THE GRAPH ────────────────────────────────
  // `trust.superseded` is services/trust.ts's DECLARED supersession verdict (a `supersedes`
  // edge or the decision's own superseded_by column). Reused, never re-queried.
  const undeclaredSupersessionIds = nodes
    .filter(
      (n) =>
        n.type === 'decision' &&
        cfg.retiredDecisionStatuses.includes(n.status ?? '') &&
        !n.trust.superseded
    )
    .map((n) => n.id);

  const findings = evaluateFindings({
    cfg,
    ratios,
    state: currentState,
    selfAttributedIds,
    undeclaredSupersessionIds,
  });

  // ── FAIL-CLOSED ACCOUNTING: a finding must never out-claim its population ──
  // A rule that reports a bigger gap than the population it measured has mis-derived its
  // measurement, and a health signal with an impossible number in it is worse than none.
  for (const f of findings) {
    if (f.measured.unit === 'records' && f.measured.of > nodes.length) {
      throw new Error(
        `coverage finding '${f.code}' reports a population of ${f.measured.of} but only ` +
          `${nodes.length} record(s) were examined. A finding may never out-claim the graph ` +
          `it was measured on.`
      );
    }
    if (f.measured.ratio !== null && f.measured.floor !== null && f.measured.ratio >= f.measured.floor) {
      throw new Error(
        `coverage finding '${f.code}' fired at ratio ${f.measured.ratio} against floor ` +
          `${f.measured.floor} — a ratio at or above its floor must not raise a finding.`
      );
    }
  }

  // ── PROVENANCE SPLIT — pure aggregation of the class the SQL view
  // assigned; the rule itself lives in migration 079, nowhere here. An edge with no
  // provenance field counts as unclassified (fail-closed; it can never inflate declared).
  const provenance: CoverageProvenanceSplit = {
    declared: 0,
    guessed: 0,
    unclassified: 0,
    total: edges.length,
    declaredRatio: null,
  };
  for (const e of edges) {
    if (e.provenance === 'declared') provenance.declared++;
    else if (e.provenance === 'guessed') provenance.guessed++;
    else provenance.unclassified++;
  }
  if (provenance.total > 0) provenance.declaredRatio = provenance.declared / provenance.total;

  return {
    projectId,
    currentState,
    ratios,
    findings,
    scope: {
      recordsInProject: scopeCounts.recordsInProject,
      recordsExamined: nodes.length,
      truncated: scopeCounts.recordsInProject > nodes.length,
      edgesExamined: edges.length,
    },
    provenance,
  };
}

/** Re-exported so callers building a coverage node do not need two imports. */
export type { EdgeNodeType };
