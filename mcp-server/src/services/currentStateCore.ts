/**
 * CURRENT-STATE read model — the PURE core.
 *
 * THE QUESTION IT ANSWERS: "where does this thread stand RIGHT NOW, and what should I do
 * next?" — in ONE bounded response, at hundreds of nodes. The Amp-orb eval (report lines
 * 524-554) measured the gap: a 42-node root recall stayed coherent but repeated the same
 * commit/test evidence across every worker handoff, acceptance milestone, orchestrator gate,
 * review and final milestone. Excellent for AUDIT, expensive for routine ORIENTATION.
 *
 * DETERMINISTIC — this is a graph QUERY and a projection, not summarization. Same graph in,
 * same answer out. There is NO model call anywhere in this path, and there must never be one:
 * Mandrel runs inside customer containers and cannot depend on an LLM/API key.
 *
 * DB-FREE ON PURPOSE (mirrors recallThreadCore.ts): this module holds the whole classification
 * + gate + ordering rule and imports no `pg`. The DB gather lives in services/currentState.ts.
 * That split is what lets the rules be hammered offline with zero database — and it is the
 * SEAM part C (graph-aware insights) consumes: call projectCurrentState() (or
 * buildCurrentState() for the DB-backed version) instead of growing a second current-state
 * query that drifts from this one.
 *
 * REUSE, never re-spell. Everything this module could have re-implemented, it
 * delegates instead:
 *   - supersession       → Trust.superseded, resolved by services/trust.ts (declared vs soft,
 *                          provenance-weighted). No second supersession query.
 *   - the trust floor    → clearsMinTrust() from recallThreadCore, the SAME predicate the
 *                          `minTrust` argument uses, with the same vocabulary.
 *   - outcome semantics  → mapDecisionOutcome/mapTaskOutcome from trustModel — the existing
 *                          definition of "what a status is worth as ground truth".
 *   - artifact refs      → readMetadataArtifactRefs/validateArtifactRef from artifactRef.ts
 *                          (part D). No second parser.
 *   - content shaping    → shapeNode() from recallThreadCore. The headline/summary/full
 *                          branches, the snippet clip AND the off-axis throw are ITS rule; a
 *                          current-state node is a shaped thread node plus a lifecycle stamp,
 *                          and only the stamp is written here. (This delegation was MISSING in
 *                          the first cut — the clip was re-implemented inline while this very
 *                          list claimed otherwise. Reviewer N2. If a future change genuinely
 *                          cannot delegate, say so HERE and list it as an exception rather
 *                          than letting this list quietly overclaim again.)
 *   - trust RENDERING    → not done here at all. The core returns the Trust object; the route
 *                          renders it through the single explainTrust() (part A).
 *
 * FAIL-CLOSED ACCOUNTING is the load-bearing property (a past incident + the task's own headline
 * risk): "superseded nodes OMITTED BUT COUNTED — the count is the honesty signal; silent
 * omission is THE failure mode". So every examined node MUST end up either in a section or in
 * a COUNTED omission bucket, and the projector asserts that the two sides balance. A node that
 * quietly disappears is a THROW, not a smaller answer.
 */

import type { Trust } from './trustModel.js';
import { mapDecisionOutcome, mapTaskOutcome } from './trustModel.js';
import { clearsMinTrust, shapeNode } from './recallThreadCore.js';
import { readMetadataArtifactRefs, validateArtifactRef } from './artifactRef.js';
import { ARTIFACT_REF_CONFIG, type ArtifactRefConfig } from '../config/artifactRefConfig.js';
import { THREAD_CONFIG, type ThreadConfig } from '../config/threadConfig.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';
import {
  CURRENT_STATE_CONFIG,
  type CurrentStateConfig,
  type CurrentStateGateId,
} from '../config/currentStateConfig.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES — what goes in, what comes out
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE gathered node, with the lifecycle fields the read model classifies by. The gatherer
 * (services/currentState.ts) hydrates these from the three entity tables; the projector never
 * reads a database.
 */
export interface CurrentStateInputNode {
  id: string;
  type: EdgeNodeType;
  title: string | null;
  content: string | null;
  createdAt: Date | null;
  /** Last-modified time where the table has one; falls back to createdAt in the gatherer. */
  updatedAt: Date | null;
  /** tasks.status | technical_decisions.status. null for a context (it has no lifecycle). */
  status: string | null;
  /** technical_decisions.outcome_status — the learning-loop result. null elsewhere. */
  outcomeStatus: string | null;
  /**
   * technical_decisions.implementation_status — the BUILD lifecycle. null elsewhere.
   * The third status a decision carries, and the one that answers "was it
   * actually DONE?" A standing decision stuck at `planned` is a half-executed decision;
   * before this reached the read model, no orienting surface could say so.
   */
  implementationStatus: string | null;
  /** contexts.context_type. null for a task/decision. */
  contextType: string | null;
  /** The record's jsonb metadata — where artifact references live (part D). */
  metadata: unknown;
  /** The computed trust verdict for this record (services/trust.ts). */
  trust: Trust;
}

/** A node as it appears inside a current-state section. */
export interface CurrentStateNode {
  id: string;
  type: EdgeNodeType;
  title: string | null;
  /**
   * The stored REVIEW CALL, inherited verbatim from the shared node shaper.
   * Declared here rather than left to `...shaped` spreading it in silently: this interface
   * is what a client codes against, and a field nobody can see in the type is a field
   * nobody renders.
   */
  reviewOutcome?: string;
  /**
   * The stored GATE RUN — code, label and ref — inherited verbatim from the
   * same shared node shaper, and declared here for the same reason `reviewOutcome` is: a
   * field nobody can see in the type is a field nobody renders.
   */
  gateOutcome?: string;
  /** Present only when the configured node altitude carries content (default: absent). */
  content?: string;
  /** The trust verdict, passed through verbatim for the RENDERER to explain (part A). */
  trust: Trust;
  status: string | null;
  outcomeStatus: string | null;
  /** technical_decisions.implementation_status — rendered in the lifecycle stamp. */
  implementationStatus: string | null;
  contextType: string | null;
}

/** A capped list that reports what the cap dropped — never a silently short section. */
export interface CurrentStateSection {
  items: CurrentStateNode[];
  /** How many qualified in total (before the cap). */
  total: number;
  /** How many qualified but were dropped by the per-section cap. */
  omittedByCap: number;
}

/**
 * The artifact/release HEAD: where the thing this thread produced actually lives.
 *
 * `writerObservedClaim` is reported for provenance and is explicitly NOT a verification —
 * part D established that a stored observation is the WRITER's claim and must
 * never feed a verdict. Verifying an artifact is `context_artifact`'s job, fail-closed. This
 * read model reports WHERE the head is; it never asserts that it was checked.
 */
export interface CurrentStateArtifactHead {
  recordId: string;
  recordType: EdgeNodeType;
  artifactType: string;
  repository: string | null;
  head: string | null;
  base: string | null;
  sha256: string | null;
  provider: string;
  locator: string;
  writerObservedClaim: { sha256: string | null; head: string | null } | null;
  /** The standing caveat, stated in the payload so the boundary travels with the answer. */
  note: string;
}

/** The gate + the one thing to do about it. Derived from the SAME ladder, so they agree. */
export interface CurrentStateNextAction {
  gate: CurrentStateGateId;
  /** Why this rung fired, in the model's own terms. */
  gateReason: string;
  /** The recommended next action, naming the concrete record where there is one. */
  action: string;
  targetId: string | null;
  targetType: EdgeNodeType | null;
}

/** Everything the projector deliberately left OUT, with exact counts (the honesty signal). */
export interface CurrentStateOmissions {
  /**
   * Records a newer record DECLARED-supersedes. Omitted from every section on purpose — they
   * are not current — but COUNTED exactly. `sampleIds` is a bounded drill-down handle; the
   * count is never bounded.
   */
  superseded: {
    count: number;
    byType: Record<string, number>;
    sampleIds: string[];
    /** How many superseded ids exist beyond `sampleIds` (count stays exact regardless). */
    sampleOmitted: number;
  };
  /**
   * Records that are current but not part of the CURRENT STATE — closed work and spent
   * discussion. Counted, not listed: repeating them is the cost this read model exists to
   * remove.
   *
   * SPLIT BY OUTCOME. `count`/`byType` are the UMBRELLA and are unchanged —
   * an existing consumer reads exactly the number it always did. The three sub-blocks below
   * are ADDITIVE and always present (including at zero, so "none" is a measured answer rather
   * than a missing key), and they SUM to `count`, which the projector asserts rather than
   * assumes. Each carries a bounded `sampleIds` so a reader can go look at the shipped things
   * instead of only learning how many there were — the whole reason this split exists is that
   * a delivered feature reading as spent discussion invites someone to rebuild it.
   */
  historical: {
    count: number;
    byType: Record<string, number>;
    /** The work was CARRIED OUT. Do not rebuild these. */
    completed: CurrentStateOmissionBucket;
    /** The work STOPPED without being carried out. */
    abandoned: CurrentStateOmissionBucket;
    /** Closed, but the record carries no signal saying which. An honest unknown. */
    unknown: CurrentStateOmissionBucket;
  };
}

/** A counted-and-sampled omission bucket: exact count, exact type tally, bounded id sample. */
export interface CurrentStateOmissionBucket {
  count: number;
  byType: Record<string, number>;
  /** A bounded drill-down handle. The count above is never bounded. */
  sampleIds: string[];
  /** How many ids exist beyond `sampleIds`. */
  sampleOmitted: number;
}

/** The full deterministic current-state answer. */
export interface CurrentState {
  anchor: string;
  /** The anchor record itself — the root whose status/gate this is. */
  root: CurrentStateNode | null;
  activeTasks: CurrentStateSection;
  /** Unresolved blockers AND unresolved findings — one section, both are "what is in the way". */
  blockers: CurrentStateSection;
  latestTrustedOutcomes: CurrentStateSection;
  /**
   * THE RECENCY DOOR: current contexts, newest first, with NO trust filter.
   *
   * A context has no lifecycle column, so before this existed the ONLY way one could reach a
   * section was `latestTrustedOutcomes` — which is trust-gated. Trust accrues AFTER the fact
   * (vouching), so a context written minutes ago is `unproven` BY CONSTRUCTION and fell to the
   * `historical` omission COUNT. Measured on live prod 2026-08-22, anchor: an earlier context
   * (a run report carrying a DECLARED informs edge to the anchor) was absent from
   * `current` at depth 1 and 2, and present at `headline`. `current` is the boot altitude, so
   * the one altitude an agent wakes up on was structurally biased to the settled past.
   *
   * This is a FILTER DELETION, not a second ranking system: the members are exactly the
   * contexts that used to be counted as `historical`, ordered by the SAME byRecencyThenId
   * total order every other section uses, capped by the SAME per-section cap mechanism. Trust
   * still travels with every node — as a LABEL on the line, not as a gate on the door.
   */
  recentContexts: CurrentStateSection;
  /** Decisions that still stand. */
  currentDecisions: CurrentStateSection;
  /**
   * HALF-EXECUTED DECISIONS: how many of the STANDING decisions above have an
   * implementation_status that means "not built yet"
   * (CURRENT_UNBUILT_IMPLEMENTATION_STATUSES; a NULL/absent value counts as unbuilt, because
   * "we do not know" must never render as "it shipped").
   *
   * This is the aggregate that project_insights had no way to report. `currentDecisions.total`
   * alone says "5 standing decisions" — indistinguishable from 5 decisions that are all DONE.
   * A COUNT rather than a section because insights is a counts surface; the per-decision stamp
   * lives on the recall_thread node lines (`impl:<status>`).
   */
  halfExecutedDecisions: number;
  artifactHead: CurrentStateArtifactHead | null;
  /**
   * Artifact metadata this projector could NOT read (part D's fail-open class: "carries an
   * unresolvable reference" must never render as "carries no references"). Non-empty here
   * means the artifact head is NOT trustworthy as a completeness claim.
   */
  artifactIssues: string[];
  nextAction: CurrentStateNextAction;
  omitted: CurrentStateOmissions;
  /** The accounting: examined === listed + superseded + historical, asserted, not assumed. */
  counts: {
    examined: number;
    /** Distinct nodes appearing in at least one section (a node may appear in two). */
    listed: number;
    superseded: number;
    /** The UMBRELLA count — unchanged by the split, and equal to the three below summed. */
    historical: number;
    /** Historical records whose lifecycle says the work was CARRIED OUT. */
    historicalCompleted: number;
    /** Historical records whose lifecycle says the work STOPPED without being carried out. */
    historicalAbandoned: number;
    /** Historical records whose lifecycle carries no signal either way. */
    historicalUnknown: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC ORDERING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recency key: last-modified where known, else creation, else the epoch (an undated record
 * sorts OLDEST — it can never masquerade as the newest thing that happened).
 */
function recencyOf(n: CurrentStateInputNode): number {
  const t = n.updatedAt ?? n.createdAt;
  return t ? t.getTime() : 0;
}

/**
 * TOTAL, deterministic order: newest first, ties broken by id. Every section uses this (some
 * with a rank prefix), so the answer is byte-identical across repeated invocation and
 * INDEPENDENT of insertion/iteration order — the property the read model is only useful if it
 * has (an orienting agent must be able to diff two reads and trust the difference).
 */
function byRecencyThenId(a: CurrentStateInputNode, b: CurrentStateInputNode): number {
  const ra = recencyOf(a);
  const rb = recencyOf(b);
  if (ra !== rb) return rb - ra; // newest first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Active tasks additionally rank by the CONFIGURED status order (in_progress before todo by
 * default): the ordering is also the recommendation, so "continue what is in flight" beats
 * "start something new" without a second rule stating it. An unlisted status sorts last.
 */
function byStatusRankThenRecency(
  cfg: CurrentStateConfig
): (a: CurrentStateInputNode, b: CurrentStateInputNode) => number {
  const rank = (n: CurrentStateInputNode): number => {
    const i = cfg.activeTaskStatuses.indexOf(n.status ?? '');
    return i === -1 ? cfg.activeTaskStatuses.length : i;
  };
  return (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return byRecencyThenId(a, b);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION — one node, one set of dispositions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The buckets a node can land in. A node may carry MORE THAN ONE (a decision that has a
 * recorded outcome is both a standing decision and an outcome) — the sections are a useful
 * projection, not a partition. What IS a partition, and what the accounting checks, is
 * "listed at least once" vs "superseded" vs "historical".
 */
export type CurrentStateDisposition =
  | 'superseded'
  | 'active-task'
  | 'blocker'
  | 'finding'
  | 'trusted-outcome'
  | 'recent-context'
  | 'standing-decision'
  | 'historical'
  | HistoricalSubtype;

/**
 * THE HISTORICAL SPLIT. `historical` is an UMBRELLA that is always emitted,
 * and every historical node ALSO carries exactly one of these — so "we shipped it" and "we
 * gave up on it" stop being the same word.
 *
 *   historical-completed — the work was CARRIED OUT. Do not rebuild this.
 *   historical-abandoned — the work STOPPED without being carried out.
 *   historical-unknown   — closed, but the record carries no signal saying which. An honest
 *                          unknown, never silently folded into either side.
 *
 * CARRIED OUT vs STOPPED, not good vs bad: a completed-but-failed thing is `completed` here,
 * because the reader's question is "does this already exist?". Quality lives on the separate
 * outcome axis (outcome_status / `trusted-outcome`).
 */
export type HistoricalSubtype =
  | 'historical-completed'
  | 'historical-abandoned'
  | 'historical-unknown';

/** The three subtypes in reporting order (carried out → stopped → cannot tell). */
export const HISTORICAL_SUBTYPES = [
  'historical-completed',
  'historical-abandoned',
  'historical-unknown',
] as const;

/**
 * Does this record's OWN status carry a result worth surfacing as a landed outcome? Delegates
 * to the trust model's existing status→value mappers (mapDecisionOutcome / mapTaskOutcome) so
 * "what a status is worth" has ONE definition in this codebase, not two. Returns the mapped
 * value, or null when the record carries no outcome yet.
 */
function ownOutcomeValue(n: CurrentStateInputNode): number | null {
  if (n.type === 'decision') return mapDecisionOutcome(n.outcomeStatus);
  if (n.type === 'task') return mapTaskOutcome(n.status);
  return null;
}

/**
 * Classify ONE node. Order inside the function is documentation, not precedence — every rule
 * that applies contributes its disposition, EXCEPT `superseded`, which is exclusive: a
 * declared-superseded record is not current by definition and must not also be reported as
 * active work.
 *
 * `historical` is the EXPLICIT fallback and is COUNTED. It is not a silent drop: the whole
 * point of the accounting below is that "we chose not to show this" is a number in the
 * response, which is what makes the answer's bounded size honest instead of lossy.
 */
export function classifyNode(
  n: CurrentStateInputNode,
  cfg: CurrentStateConfig = CURRENT_STATE_CONFIG
): CurrentStateDisposition[] {
  // DECLARED supersession is exclusive and wins outright. (Trust.superseded is the declared
  // consequence only — a SOFT/auto supersession sets softSuperseded and stays visible, ranked
  // lower, exactly as the belief layer intends. This read model honors that: soft-superseded
  // records are NOT omitted.)
  if (n.trust.superseded) return ['superseded'];

  const out: CurrentStateDisposition[] = [];

  if (n.type === 'task') {
    if (cfg.blockedTaskStatuses.includes(n.status ?? '')) out.push('blocker');
    if (cfg.activeTaskStatuses.includes(n.status ?? '')) out.push('active-task');
  }

  if (n.type === 'decision' && cfg.standingDecisionStatuses.includes(n.status ?? '')) {
    out.push('standing-decision');
  }

  // A FINDING is an `error` context that nothing newer has declared-superseded. Supersession
  // is the ONLY resolution signal the graph actually carries, so that is what "unresolved"
  // means here — stated plainly rather than inferred from something we do not store.
  if (n.type === 'context' && cfg.findingContextTypes.includes(n.contextType ?? '')) {
    out.push('finding');
  }

  // A TRUSTED OUTCOME must clear BOTH bars: the record's own result is good enough
  // (outcomeValueFloor, via the reused mappers) and the record itself is trustworthy enough
  // (trustedOutcomeFloor, via the reused clearsMinTrust). A cold-start `unproven` record is
  // not a trusted outcome no matter how fresh — that is the trust model's own rule, honored
  // here rather than restated.
  const value = ownOutcomeValue(n);
  const isOutcomeRecord =
    (value !== null && value >= cfg.outcomeValueFloor) ||
    (n.type === 'context' && cfg.outcomeContextTypes.includes(n.contextType ?? ''));
  if (isOutcomeRecord && clearsMinTrust(n.trust, cfg.trustedOutcomeFloor)) {
    out.push('trusted-outcome');
  }

  // THE RECENCY DOOR. A context that matched nothing above is NOT
  // "historical" — `historical` is a LIFECYCLE verdict, and a context has no lifecycle column
  // to derive one from. It was the default for contexts only because they had exactly one
  // door and that door was trust-gated. So: a current context that no other rule admitted is
  // admitted HERE, on recency alone. Tasks and decisions keep falling through to `historical`,
  // because for them the verdict IS derivable — a `completed`/`cancelled` task and a
  // `deprecated`/`superseded` decision really are closed.
  if (out.length === 0 && n.type === 'context') return ['recent-context'];

  // THE HISTORICAL SPLIT. The umbrella is kept — every consumer that asks
  // `is(n, 'historical')` keeps the exact population it had — and the SUBTYPE rides alongside
  // it, so the two opposite outcomes are separable by name instead of by inference.
  return out.length > 0 ? out : ['historical', classifyHistoricalSubtype(n, cfg)];
}

/**
 * Which HISTORICAL outcome does this record's own lifecycle carry? Total, pure, and derived
 * only from columns the writer already sets — there is no new field to remember, which is the
 * point: a distinction that depends on someone remembering to declare it is a distinction that
 * will be absent exactly when it matters.
 *
 * THE SIGNAL LADDER, per type:
 *   TASK      — status. `completed` and `cancelled` are both NON-DEFAULT (`tasks.status`
 *               DEFAULTs to 'todo'), so each is a deliberate statement by a writer.
 *   DECISION  — implementation_status FIRST (was it built?), then an EVALUATED outcome as a
 *               fallback witness: you cannot record successful/mixed/failed about a thing that
 *               was never carried out, so a non-null mapDecisionOutcome is evidence it was.
 *               `too_early`/`unknown`/null map to null there and are correctly NOT evidence.
 *               A decision at the 'planned' DEFAULT is `unknown`, not abandoned — see
 *               CURRENT_ABANDONED_IMPLEMENTATION_STATUSES for why.
 *   CONTEXT   — always `unknown`. A context has no lifecycle column, so there is nothing to
 *               derive a verdict from. (Contexts reach the recency door above and so do not
 *               reach here today; this arm exists so the function is TOTAL rather than relying
 *               on a caller-side invariant that a later change could quietly break.)
 */
export function classifyHistoricalSubtype(
  n: CurrentStateInputNode,
  cfg: CurrentStateConfig = CURRENT_STATE_CONFIG
): HistoricalSubtype {
  if (n.type === 'task') {
    if (cfg.completedTaskStatuses.includes(n.status ?? '')) return 'historical-completed';
    if (cfg.abandonedTaskStatuses.includes(n.status ?? '')) return 'historical-abandoned';
    return 'historical-unknown';
  }
  if (n.type === 'decision') {
    if (cfg.builtImplementationStatuses.includes(n.implementationStatus ?? '')) {
      return 'historical-completed';
    }
    // An EVALUATED outcome is second-hand evidence the thing was actually carried out.
    // Reuses the trust model's mapper rather than re-spelling which values count as evaluated.
    if (mapDecisionOutcome(n.outcomeStatus) !== null) return 'historical-completed';
    if (cfg.abandonedImplementationStatuses.includes(n.implementationStatus ?? '')) {
      return 'historical-abandoned';
    }
    return 'historical-unknown';
  }
  return 'historical-unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// ARTIFACT / RELEASE HEAD
// ─────────────────────────────────────────────────────────────────────────────

/** The standing boundary statement carried on every artifact head we report. */
const ARTIFACT_HEAD_NOTE =
  'Mandrel stores the REFERENCE, never the artifact bytes. Any observation recorded here is ' +
  'the writing agent CLAIM, not a verification — verify with context_artifact (fail-closed).';

/**
 * Find the artifact/release HEAD across the current (non-superseded) nodes: the newest record
 * carrying a VALID artifact reference wins, and within that record the FIRST valid reference
 * in stored order. Deterministic by the same recency-then-id total order everything else uses.
 *
 * Returns the head plus any ISSUES. An issue means a record's artifact metadata exists but is
 * unreadable — part D's fail-open class ("an unresolvable reference must never render as no
 * references"). We surface it rather than skipping it, and the release gate below treats an
 * issue as "cannot claim a head", never as "no head needed".
 */
export function selectArtifactHead(
  nodes: CurrentStateInputNode[],
  artifactCfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG
): { head: CurrentStateArtifactHead | null; issues: string[] } {
  const issues: string[] = [];
  let head: CurrentStateArtifactHead | null = null;

  // Sorted copy — never mutate the caller's array, and never depend on its order.
  for (const n of [...nodes].sort(byRecencyThenId)) {
    const read = readMetadataArtifactRefs(n.metadata, artifactCfg);
    if (!read.ok) {
      issues.push(`${n.type} ${n.id}: ${read.reason}`);
      continue;
    }
    if (read.refs.length === 0) continue;
    if (head !== null) continue; // a newer record already provided the head; keep scanning for issues

    for (const raw of read.refs) {
      const validated = validateArtifactRef(raw, artifactCfg);
      if (!validated.ok) {
        issues.push(
          `${n.type} ${n.id}: unusable artifact reference — ${validated.errors.join('; ')}`
        );
        continue;
      }
      const ref = validated.ref;
      const locator = ref.retrieval.path ?? ref.retrieval.uri ?? '';
      head = {
        recordId: n.id,
        recordType: n.type,
        artifactType: ref.artifactType,
        repository: ref.repository ?? null,
        head: ref.head ?? null,
        base: ref.base ?? null,
        sha256: ref.sha256 ?? null,
        provider: ref.retrieval.provider,
        locator,
        writerObservedClaim: ref.observed
          ? { sha256: ref.observed.sha256 ?? null, head: ref.observed.head ?? null }
          : null,
        note: ARTIFACT_HEAD_NOTE,
      };
      break;
    }
  }

  return { head, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE LADDER
// ─────────────────────────────────────────────────────────────────────────────

/** What a gate rung is handed to decide whether it fires. */
interface GateInput {
  root: CurrentStateInputNode | null;
  activeTasks: CurrentStateInputNode[];
  blockers: CurrentStateInputNode[];
  standingDecisions: CurrentStateInputNode[];
  artifactHead: CurrentStateArtifactHead | null;
  artifactIssues: string[];
  cfg: CurrentStateConfig;
}

/** A fired rung: why, what to do, and which record to do it to. */
interface GateVerdict {
  gateReason: string;
  action: string;
  targetId: string | null;
  targetType: EdgeNodeType | null;
}

/** A short, stable label for a record inside an action sentence. */
function label(n: CurrentStateInputNode): string {
  return `${n.type} ${n.id}${n.title ? ` — ${n.title}` : ''}`;
}

/**
 * THE RUNG IMPLEMENTATIONS, keyed by gate id. Each returns a verdict when it fires, or null.
 *
 * This map is the reason the ladder can be config-ORDERED without being config-INVENTED: the
 * config states the order and the terminal rung; the code states what each rung MEANS. A
 * configured id with no entry here is a LOUD throw in evaluateGate() — an unrecognized rung
 * must never be silently skipped, because a silently skipped rung is a silently wrong gate
 * (unrecognized → RED, not pass).
 */
const GATE_RULES: Record<CurrentStateGateId, (g: GateInput) => GateVerdict | null> = {
  blocked: (g) => {
    if (g.blockers.length === 0) return null;
    const first = g.blockers[0];
    return {
      gateReason: `${g.blockers.length} unresolved blocker/finding(s)`,
      action: `Unblock ${label(first)}`,
      targetId: first.id,
      targetType: first.type,
    };
  },
  'in-progress': (g) => {
    if (g.activeTasks.length === 0) return null;
    const first = g.activeTasks[0];
    const verb = first.status === g.cfg.activeTaskStatuses[0] ? 'Continue' : 'Start';
    return {
      gateReason: `${g.activeTasks.length} open task(s)`,
      action: `${verb} ${label(first)}`,
      targetId: first.id,
      targetType: first.type,
    };
  },
  'awaiting-release': (g) => {
    if (!g.cfg.releaseGateRequiresArtifact) return null;
    // An UNREADABLE reference is not a head. Treating it as one is the fail-open part D closed.
    if (g.artifactHead !== null && g.artifactIssues.length === 0) return null;
    const reason =
      g.artifactIssues.length > 0
        ? `work is closed but ${g.artifactIssues.length} artifact reference(s) are unreadable`
        : 'work is closed but no artifact/release head is recorded';
    const target = g.root;
    return {
      gateReason: reason,
      action:
        g.artifactIssues.length > 0
          ? `Repair the unreadable artifact reference(s), then re-read the current state`
          : `Record the release artifact reference${target ? ` on ${label(target)}` : ''} ` +
            `(context_store/task_update metadata.${ARTIFACT_REF_CONFIG.metadataKey})`,
      targetId: target?.id ?? null,
      targetType: target?.type ?? null,
    };
  },
  'awaiting-outcome': (g) => {
    const open = g.standingDecisions.filter(
      (d) => d.outcomeStatus === null || g.cfg.openOutcomeStatuses.includes(d.outcomeStatus)
    );
    if (open.length === 0) return null;
    const first = open[0];
    return {
      gateReason: `${open.length} standing decision(s) with no recorded outcome`,
      action: `Close the learning loop on ${label(first)} (decision_update outcomeStatus)`,
      targetId: first.id,
      targetType: first.type,
    };
  },
  complete: (g) => ({
    gateReason: 'no open work, no blockers, and every standing decision has a recorded outcome',
    action: g.root
      ? `Nothing open on ${label(g.root)} — pick up new work or archive the thread`
      : 'Nothing open — pick up new work',
    targetId: g.root?.id ?? null,
    targetType: g.root?.type ?? null,
  }),
};

/**
 * Walk the configured ladder, first match wins. FAIL-CLOSED in both directions:
 *   - a configured rung with no implementation THROWS (an unrecognized rung silently skipped
 *     is an unrecognized rung silently wrong),
 *   - a ladder that falls through without matching THROWS (the config's terminal rung is
 *     supposed to be total; if it is not, that is a config bug we must SEE, not absorb by
 *     inventing a default gate).
 */
export function evaluateGate(g: GateInput): CurrentStateNextAction {
  for (const id of g.cfg.gateLadder) {
    const rule = GATE_RULES[id];
    if (typeof rule !== 'function') {
      throw new Error(
        `current-state gate ladder names '${id}', which has no implementation. Implement it in ` +
          `GATE_RULES or remove it from CURRENT_STATE_CONFIG.gateLadder — an unrecognized rung ` +
          `must never be silently skipped.`
      );
    }
    const verdict = rule(g);
    if (verdict !== null) return { gate: id, ...verdict };
  }
  throw new Error(
    `current-state gate ladder [${g.cfg.gateLadder.join(', ')}] fell through without matching. ` +
      `The terminal rung ('${g.cfg.terminalGate}') must be present, last, and unconditional.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROJECTOR
// ─────────────────────────────────────────────────────────────────────────────

/** Shape one input node for a section, at the configured content depth. */
function toSectionNode(
  n: CurrentStateInputNode,
  cfg: CurrentStateConfig,
  threadCfg: ThreadConfig
): CurrentStateNode {
  // CONTENT DEPTH IS shapeNode'S JOB (Reviewer N2). This used to re-implement the
  // headline/summary/full branches AND the ellipsis clip inline — a sixth copy of a rule
  // recallThreadCore already owns, in the very module whose header claims it delegates
  // everything it could have re-implemented. It delegates now: the clip budget, the
  // no-body-at-headline rule and the off-axis THROW all come from the one definition.
  const shaped = shapeNode(
    // `metadata` too: the stored review call is derived in shapeNode, so
    // this projection inherits it by delegating rather than by re-reading the key here.
    { id: n.id, type: n.type, title: n.title, content: n.content, metadata: n.metadata },
    n.trust,
    cfg.nodeAltitude,
    threadCfg
  );
  // The lifecycle stamp is what a CURRENT-STATE node adds on top of a thread node — that
  // part is genuinely this module's own, and it is the only part written here.
  return {
    ...shaped,
    status: n.status,
    outcomeStatus: n.outcomeStatus,
    implementationStatus: n.implementationStatus,
    contextType: n.contextType,
  };
}

/** Apply a per-section cap, reporting exactly what the cap dropped. */
function section(
  nodes: CurrentStateInputNode[],
  cap: number,
  cfg: CurrentStateConfig,
  threadCfg: ThreadConfig
): CurrentStateSection {
  const items = nodes.slice(0, cap).map((n) => toSectionNode(n, cfg, threadCfg));
  return { items, total: nodes.length, omittedByCap: Math.max(0, nodes.length - cap) };
}

/**
 * How many of these decisions are NOT built yet.
 *
 * FAIL-OPEN ON UNKNOWN: a null/undefined implementation_status counts as UNBUILT. The
 * alternative — treating "we do not know" as "it shipped" — is precisely the direction the
 * an earlier change miss went, and an under-count here is the failure that has no
 * symptom. The policy list comes from config; nothing is spelled inline.
 */
function countUnbuilt(nodes: CurrentStateInputNode[], cfg: CurrentStateConfig): number {
  return nodes.filter((n) =>
    n.implementationStatus === null || n.implementationStatus === undefined
      ? true
      : cfg.unbuiltImplementationStatuses.includes(n.implementationStatus)
  ).length;
}

/** Tally a node list by record type, in a stable key order. */
function tallyByType(nodes: CurrentStateInputNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of [...nodes].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))) {
    out[n.type] = (out[n.type] ?? 0) + 1;
  }
  return out;
}

/**
 * PROJECT the gathered subgraph into the deterministic current state.
 *
 * PURE + TOTAL: no DB, no clock, no randomness, no model. The only inputs are the nodes, the
 * anchor id, and the injected config — so the same graph produces a byte-identical answer on
 * every call, in any input order.
 *
 * @param nodes    every node gathered for the thread, trust-annotated and hydrated.
 * @param anchorId the root record the caller asked about.
 */
export function projectCurrentState(
  nodes: CurrentStateInputNode[],
  anchorId: string,
  cfg: CurrentStateConfig = CURRENT_STATE_CONFIG,
  threadCfg: ThreadConfig = THREAD_CONFIG,
  artifactCfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG
): CurrentState {
  // ── CLASSIFY every node exactly once ────────────────────────────────────────
  const byDisposition = new Map<CurrentStateDisposition, CurrentStateInputNode[]>();
  for (const d of [
    'superseded',
    'active-task',
    'blocker',
    'finding',
    'trusted-outcome',
    'recent-context',
    'standing-decision',
    'historical',
    ...HISTORICAL_SUBTYPES,
  ] as CurrentStateDisposition[]) {
    byDisposition.set(d, []);
  }
  for (const n of nodes) {
    for (const d of classifyNode(n, cfg)) byDisposition.get(d)!.push(n);
  }
  const bucket = (d: CurrentStateDisposition): CurrentStateInputNode[] => byDisposition.get(d)!;

  // ── ORDER (deterministic, total, input-order independent) ───────────────────
  const supersededNodes = [...bucket('superseded')].sort(byRecencyThenId);
  const historicalNodes = [...bucket('historical')].sort(byRecencyThenId);
  // The historical SPLIT — same total order, so the samples are deterministic.
  const historicalCompleted = [...bucket('historical-completed')].sort(byRecencyThenId);
  const historicalAbandoned = [...bucket('historical-abandoned')].sort(byRecencyThenId);
  const historicalUnknown = [...bucket('historical-unknown')].sort(byRecencyThenId);
  const activeTaskNodes = [...bucket('active-task')].sort(byStatusRankThenRecency(cfg));
  // Blockers and findings are ONE section — both answer "what is in the way". Deduped by id
  // (a record cannot be both today, but the section must not double-count if that changes).
  const blockerNodes = dedupeById([...bucket('blocker'), ...bucket('finding')]).sort(
    byRecencyThenId
  );
  const outcomeNodes = [...bucket('trusted-outcome')].sort(byRecencyThenId);
  // The recency door. Same total order as every other section — no second ranking system.
  const recentContextNodes = [...bucket('recent-context')].sort(byRecencyThenId);
  const decisionNodes = [...bucket('standing-decision')].sort(byRecencyThenId);

  // ── ARTIFACT HEAD — scanned over the CURRENT nodes only (never a superseded head) ──
  const currentNodes = nodes.filter((n) => !n.trust.superseded);
  const { head: artifactHead, issues: artifactIssues } = selectArtifactHead(
    currentNodes,
    artifactCfg
  );

  const rootInput = nodes.find((n) => n.id === anchorId) ?? null;

  // ── THE GATE + NEXT ACTION ──────────────────────────────────────────────────
  const nextAction = evaluateGate({
    root: rootInput,
    activeTasks: activeTaskNodes,
    blockers: blockerNodes,
    standingDecisions: decisionNodes,
    artifactHead,
    artifactIssues,
    cfg,
  });

  // ── ACCOUNTING (fail-closed): examined === listed + superseded + historical ──
  // THE honesty property. `listed` counts DISTINCT nodes appearing in at least one section,
  // so overlapping sections (a decision that is also an outcome) cannot inflate it. If these
  // do not balance, a node vanished between classification and rendering — exactly the silent
  // omission this read model exists to make impossible — and we THROW rather than return a
  // quietly lossy answer that looks complete.
  const listedIds = new Set<string>();
  for (const n of [
    ...activeTaskNodes,
    ...blockerNodes,
    ...outcomeNodes,
    ...recentContextNodes,
    ...decisionNodes,
  ]) {
    listedIds.add(n.id);
  }
  const supersededIds = new Set(supersededNodes.map((n) => n.id));
  const historicalIds = new Set(historicalNodes.map((n) => n.id));
  const examined = new Set(nodes.map((n) => n.id)).size;
  const accounted = listedIds.size + supersededIds.size + historicalIds.size;
  if (accounted !== examined) {
    throw new Error(
      `current-state accounting broke: examined ${examined} node(s) but accounted for ` +
        `${accounted} (listed ${listedIds.size} + superseded ${supersededIds.size} + ` +
        `historical ${historicalIds.size}). Every gathered node must land in a section or a ` +
        `COUNTED omission bucket — a node that disappears silently is the exact failure this ` +
        `read model exists to prevent.`
    );
  }

  // THE SPLIT'S OWN ACCOUNTING, same fail-closed posture as the block above.
  // The three subtypes must partition the umbrella exactly. If they ever do not, a historical
  // record has either lost its outcome verdict or been counted under two of them — and either
  // way the split would be reporting a smaller or a doubled world than the umbrella it sits
  // under, which is the exact conflation this task removed. THROW rather than render it.
  const splitTotal = historicalCompleted.length + historicalAbandoned.length + historicalUnknown.length;
  if (splitTotal !== historicalNodes.length) {
    throw new Error(
      `current-state historical split broke: ${historicalNodes.length} historical node(s) but ` +
        `${splitTotal} accounted across completed ${historicalCompleted.length} + abandoned ` +
        `${historicalAbandoned.length} + unknown ${historicalUnknown.length}. Every historical ` +
        `record must carry exactly ONE outcome verdict — "shipped" and "abandoned" reading as ` +
        `the same word is the failure this split exists to prevent.`
    );
  }

  const sampleIds = supersededNodes.slice(0, cfg.limits.supersededSampleIds).map((n) => n.id);
  const historicalBucket = (ns: CurrentStateInputNode[]): CurrentStateOmissionBucket => {
    const ids = ns.slice(0, cfg.limits.historicalSampleIds).map((n) => n.id);
    return {
      count: ns.length,
      byType: tallyByType(ns),
      sampleIds: ids,
      sampleOmitted: Math.max(0, ns.length - ids.length),
    };
  };

  return {
    anchor: anchorId,
    root: rootInput ? toSectionNode(rootInput, cfg, threadCfg) : null,
    activeTasks: section(activeTaskNodes, cfg.limits.activeTasks, cfg, threadCfg),
    blockers: section(blockerNodes, cfg.limits.blockers, cfg, threadCfg),
    latestTrustedOutcomes: section(outcomeNodes, cfg.limits.trustedOutcomes, cfg, threadCfg),
    recentContexts: section(recentContextNodes, cfg.limits.recentContexts, cfg, threadCfg),
    currentDecisions: section(decisionNodes, cfg.limits.decisions, cfg, threadCfg),
    // Counted over the FULL standing-decision list, NOT the capped section — a per-section cap
    // must never make the half-executed count read lower than it is.
    halfExecutedDecisions: countUnbuilt(decisionNodes, cfg),
    artifactHead,
    artifactIssues,
    nextAction,
    omitted: {
      superseded: {
        count: supersededNodes.length,
        byType: tallyByType(supersededNodes),
        sampleIds,
        sampleOmitted: Math.max(0, supersededNodes.length - sampleIds.length),
      },
      historical: {
        count: historicalNodes.length,
        byType: tallyByType(historicalNodes),
        completed: historicalBucket(historicalCompleted),
        abandoned: historicalBucket(historicalAbandoned),
        unknown: historicalBucket(historicalUnknown),
      },
    },
    counts: {
      examined,
      listed: listedIds.size,
      superseded: supersededIds.size,
      historical: historicalIds.size,
      historicalCompleted: historicalCompleted.length,
      historicalAbandoned: historicalAbandoned.length,
      historicalUnknown: historicalUnknown.length,
    },
  };
}

/** Keep the FIRST occurrence of each id, preserving the given order. */
function dedupeById(nodes: CurrentStateInputNode[]): CurrentStateInputNode[] {
  const seen = new Set<string>();
  const out: CurrentStateInputNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}
