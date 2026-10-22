/**
 * TRUST MODEL v1 — the service (Mandrel Core Redesign T2b). THE MOAT.
 *
 * Every recalled record gets a computed trust signal — ranked by DEMONSTRATED reliability
 * (the loop's ground-truth outcomes), not age. This is the differentiator: the STALE
 * benchmark shows the whole field scores <10% at detecting an invalid memory; nobody
 * scores memory by real outcomes. We can, because the builder→the reviewer→loop pipeline
 * manufactures ground-truth (technical_decisions.outcome_status, set by the GAP1
 * Evaluator), and the T2a typed-edge graph lets us propagate it.
 *
 * TWO LAYERS, on purpose (a past incident — one definition, testable in isolation):
 *   1. computeTrust()  — PURE math. Takes the gathered signals + an injected TrustConfig,
 *                        returns the Trust object. No DB, no clock-of-record-truth — the
 *                        caller passes `now`. This is what the unit tests hammer (outcome
 *                        aggregation, freshness decay at/again half-life, supersession
 *                        override, cold-start→unproven, abstain thresholds, band edges).
 *   2. trustForRecord()/trustForRecords() — gather the signals from the graph + the DB
 *                        (downstream outcomes via edges; created_at; supersession), then
 *                        call computeTrust(). Cheap: per returned result, not the whole DB.
 *
 * GROUND-TRUTH via EDGES (the moat path): a record's outcome is INHERITED from the
 * outcomes of the work it informed. We walk OUT edges of type `informs` / `decided_by` /
 * `learned_from` (the record → the decision/task it fed) and aggregate THEIR outcomes:
 *   - decision.outcome_status: successful=1, mixed=0.5, failed=0; too_early/unknown IGNORED.
 *   - task.status (secondary, when cleanly available): completed=1; every other status —
 *     INCLUDING cancelled — is IGNORED (no sample). See mapTaskOutcome for why a
 *     cancellation is absence of evidence, not evidence of failure.
 * decision.outcome_status is the PRIMARY, reliable signal (it's what the loop scores).
 *
 * AND IN REVERSE, FOR A DECISION (SK3): the OUT walk alone is
 * directional, and `decided_by` is stored task → decision — so a decision could never
 * inherit the outcomes of the tasks that implemented it. trustForRecord also walks IN
 * edges of OUTCOME_IN_EDGE_TYPES from tasks and folds their statuses in as task samples.
 * Read-time only: this computes a signal, it never writes outcome_status, and the
 * briefing's membership filter still reads that human-owned column.
 *
 * SECURITY: every query binds user-derived ids as PARAMETERS — never string-built.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
// The degraded-fallback warn (nit N3) — a silent degrade is a systemic failure nobody can see.
import { logger } from '../utils/logger.js';
import { TRUST_CONFIG, type TrustConfig } from '../config/trustConfig.js';
// The SINGLE source of the belief-adjudicator provenance label (a past incident — never
// re-literal 'auto:belief-adjudicator'). An auto-minted `supersedes` edge carries this in
// links.created_by; anything else on a `supersedes` edge is a DECLARED (human/link/write-time)
// supersession. Reused here to split supersession consequence by provenance (BL-4).
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import {
  computeTrust,
  emptySupersessionGuardAudit,
  mapDecisionOutcome,
  mapTaskOutcome,
  type BackwardSoftFinding,
  type OutcomeSample,
  type SupersessionGuardAudit,
  type Trust,
  type SupersessionReceipt,
} from './trustModel.js';
// BACKWARD-SOFT GUARD (P5.3 half B): the rule's knobs and its PURE decision
// procedure. This file supplies the only thing those two cannot have — the graph.
import {
  SUPERSESSION_GUARD_CONFIG,
  type SupersessionGuardConfig,
} from '../config/supersessionGuardConfig.js';
import { declaredReaches } from './declaredReachability.js';

// Re-export the pure-math surface so existing import sites (services/trust.js) keep working
// — the pure functions/types now LIVE in trustModel.ts (DB-free, unit-testable in isolation)
// and are re-exported here for ergonomics.
export {
  computeTrust,
  aggregateOutcome,
  freshnessFromAge,
  mapDecisionOutcome,
  mapTaskOutcome,
  supersessionReceiptHint,
  // TRUST EXPLAINABILITY: the ONE renderer every surface calls. It is
  // DEFINED next to supersessionReceiptHint() in trustModel.ts — the DB-free pure module,
  // so it stays unit-testable with zero Postgres — and re-exported here because
  // `services/trust.js` is the import path every render site already uses.
  explainTrust,
  TRUST_REASONS,
} from './trustModel.js';
export type {
  OutcomeSample,
  TrustSignals,
  Trust,
  SupersessionReceipt,
  TrustReason,
  TrustExplanation,
  // BACKWARD-SOFT GUARD (P5.3 half B): the audit shape, re-exported on the same import path
  // every render site already uses.
  BackwardSoftFinding,
  SupersessionGuardAudit,
} from './trustModel.js';
export { emptySupersessionGuardAudit } from './trustModel.js';

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL GATHERING (DB + graph) — cheap, per returned record.
// ─────────────────────────────────────────────────────────────────────────────

/** The OUT edge types that point a record at the downstream work whose ground-truth
 *  outcome it inherits (the moat path). A record that informs a decision/task, or that a
 *  decision was decided_by / learned_from, ladders up to that record's outcome.
 *
 *  EXPORTED so the trust-integrity contract test can assert its membership directly (the
 *  authoritative list, not a copy). */
export const OUTCOME_OUT_EDGE_TYPES = ['informs', 'decided_by', 'learned_from'] as const;

/** The IN edge types that point AT a DECISION from the work that IMPLEMENTED it (SK3,
 *  an earlier decision). The OUT walk above is DIRECTIONAL, and that is the gap it leaves:
 *  a task→decision `decided_by` edge points AT the decision, so a decision never inherited
 *  the outcomes of the tasks decided by it — the exact records the loop manufactures
 *  ground-truth for. Walking this list in reverse closes that, at READ time, with zero
 *  writes and no fabricated outcome_status.
 *
 *  `decided_by` is the ONLY member, and that is a measurement, not a guess: on prod, the
 *  task→decision edge population is 106 `decided_by` and nothing else
 *  (`SELECT from_type, edge_type, count(*) FROM links WHERE to_type='decision' GROUP BY 1,2`).
 *  A wider list would be speculative reach, and every extra type is a way to inherit an
 *  outcome the record did not earn.
 *
 *  EXPORTED so the trust-integrity contract test can assert its membership directly. */
export const OUTCOME_IN_EDGE_TYPES = ['decided_by'] as const;

// ── HARD TRUST INVARIANT (reliable-auto-threading, ST-1 / spec E2) ──────────────
// `related_to` is a WEAK, inferred, NON-EVIDENCE edge (edgeTypes.ts). It exists so a
// write is never a silent orphan — NOT to move trust. It must NEVER be an outcome edge:
// if it were, inferring a related_to to a `successful` decision would silently mint trust
// the record did not earn. This load-time assertion fails FAST (module import throws) if a
// future edit ever adds it to OUTCOME_OUT_EDGE_TYPES, so the invariant can't drift in
// silently. See trustExcludesRelatedTo.contract.test.ts.
if ((OUTCOME_OUT_EDGE_TYPES as readonly string[]).includes('related_to')) {
  throw new Error(
    "TRUST INVARIANT VIOLATION: 'related_to' must NOT be in OUTCOME_OUT_EDGE_TYPES — " +
      'it is a low-confidence inferred edge, not evidence. Minting it must move no trust.'
  );
}

// ── HARD TRUST INVARIANT (task-source edge minting, 86d56b8c Q2) ───────────────
// `depends_on` is task→task SCHEDULING STRUCTURE, not outcome evidence. Task A depending
// on task B says NOTHING about whether B's outcome is A's evidence — a task routinely
// depends on work that failed, was abandoned, or is not started. If it were an outcome
// edge, every task would silently inherit the outcome of its dependencies, and the
// backfill (which mints depends_on across 706 existing tasks) would move trust scores en
// masse on data that never earned it. Same fail-fast shape as the related_to guard above,
// so the invariant cannot drift in silently. Pinned literally by
// trustExcludesRelatedTo.contract.test.ts.
if ((OUTCOME_OUT_EDGE_TYPES as readonly string[]).includes('depends_on')) {
  throw new Error(
    "TRUST INVARIANT VIOLATION: 'depends_on' must NOT be in OUTCOME_OUT_EDGE_TYPES — " +
      'it is task scheduling structure, not evidence. A dependency must move no trust.'
  );
}

// ── HARD TRUST INVARIANT (positional membership PHASE 1) ────────
// `subtask_of` is task→task CONTAINMENT STRUCTURE (the parent edge minted at task_create
// from the declared `parentTaskId` param — migration 080). Containment is
// not evidence: a subtask says nothing about its parent's outcome, and vice versa. Same
// fail-fast shape as the related_to / depends_on guards above.
if ((OUTCOME_OUT_EDGE_TYPES as readonly string[]).includes('subtask_of')) {
  throw new Error(
    "TRUST INVARIANT VIOLATION: 'subtask_of' must NOT be in OUTCOME_OUT_EDGE_TYPES — " +
      'it is containment structure, not evidence. A parent edge must move no trust.'
  );
}

// ── HARD TRUST INVARIANT (SK3 IN-edge inheritance) ──────────
// The reverse walk inherits along the SAME evidence bar as the forward one, so the three
// non-evidence types guarded above (a weak inferred association, scheduling structure,
// containment structure) must never appear here either — a reverse walk over them would
// mint exactly the trust the forward guards exist to refuse. Same fail-fast shape, one
// block because the reasons are already written above. Pinned by
// trustExcludesRelatedTo.contract.test.ts.
for (const nonEvidence of ['related_to', 'depends_on', 'subtask_of'] as const) {
  if ((OUTCOME_IN_EDGE_TYPES as readonly string[]).includes(nonEvidence)) {
    throw new Error(
      `TRUST INVARIANT VIOLATION: '${nonEvidence}' must NOT be in OUTCOME_IN_EDGE_TYPES — ` +
        'it is not evidence, in either direction. Minting it must move no trust.'
    );
  }
}

/** A record reference (id + kind) the recall handlers already have in hand. */
export interface RecordRef {
  id: string;
  type: 'context' | 'decision' | 'task';
  /**
   * The record's own created/decision date (for freshness). OPTIONAL: when the caller
   * doesn't have it in hand (e.g. smart_search's generic result items), trustForRecord
   * self-fetches it (and a decision's own outcome_status/superseded_by) from the DB. The
   * recall handlers that already have the date SHOULD pass it (one fewer round-trip).
   */
  createdAt?: Date | string;
  /** For a decision record: its own superseded_by column (a direct supersession signal). */
  supersededBy?: string | null;
  /**
   * For a DECISION record: its OWN outcome_status. A decision IS scored directly by the
   * loop (the GAP1 Evaluator sets this), so its own outcome is the strongest ground-truth
   * sample for itself — folded in ALONGSIDE any downstream-inherited outcomes. Ignored
   * (too_early/unknown) values are dropped to null by the mapper, same as downstream.
   * Pass it when the handler already has it in hand (decision_search does); omit otherwise.
   */
  ownOutcomeStatus?: string | null;
}

/**
 * Gather the trust signals for ONE record from the graph + DB, then compute trust.
 *
 * Outcome (moat): walk this record's OUT edges of the outcome types → the downstream
 * decisions/tasks → aggregate THEIR ground-truth (decision.outcome_status primary,
 * task.status secondary). For a DECISION, ALSO walk IN edges from tasks (the tasks
 * decided_by it — the work that implemented it) and fold their statuses in the same way.
 * Supersession: a `supersedes` edge pointing AT this record (reverse), OR (for a decision)
 * its own superseded_by column.
 *
 * Round-trips: two for the outward outcomes (a join from links → the two outcome tables),
 * one more for the reverse task walk ON DECISIONS ONLY, and one for supersession; all
 * parameterized + project-agnostic by id (ids are globally unique).
 */
export async function trustForRecord(
  ref: RecordRef,
  config: TrustConfig = TRUST_CONFIG,
  pool: Pool = db,
  guardConfig: SupersessionGuardConfig = SUPERSESSION_GUARD_CONFIG
): Promise<Trust> {
  // SELF-FETCH the freshness date (and, for a decision, its own outcome/supersession)
  // when the caller didn't pass them in (smart_search's generic items). The recall
  // handlers that already have createdAt skip this round-trip.
  let createdAt = ref.createdAt;
  let ownOutcomeStatus = ref.ownOutcomeStatus;
  let supersededBy = ref.supersededBy;
  if (createdAt === undefined || (ref.type === 'decision' && ownOutcomeStatus === undefined)) {
    const meta = await fetchRecordMeta(ref.id, ref.type, pool);
    if (createdAt === undefined) createdAt = meta?.createdAt ?? new Date(0); // missing → maximally stale
    if (ref.type === 'decision') {
      if (ownOutcomeStatus === undefined) ownOutcomeStatus = meta?.outcomeStatus ?? null;
      if (supersededBy === undefined || supersededBy === null) supersededBy = meta?.supersededBy ?? null;
    }
  }
  const ageDays = ageInDays(createdAt);

  // ── OUTCOME: downstream decision outcomes (primary) ──────────────────────────
  // Edges: this record → (decision) via informs/decided_by/learned_from. Join to the
  // decision and read its outcome_status. Exclude archived downstream rows (a retired
  // decision is not live ground-truth).
  const decisionOutcomes = (
    await pool.query(
      `SELECT td.outcome_status AS status
         FROM links l
         JOIN technical_decisions td ON td.id = l.to_id
        WHERE l.from_id = $1
          AND l.to_type = 'decision'
          AND l.edge_type = ANY($2)
          AND td.archived_at IS NULL`,
      [ref.id, OUTCOME_OUT_EDGE_TYPES as unknown as string[]]
    )
  ).rows;

  // ── OUTCOME: downstream task completion (secondary) ──────────────────────────
  const taskOutcomes = (
    await pool.query(
      `SELECT t.status AS status
         FROM links l
         JOIN tasks t ON t.id = l.to_id
        WHERE l.from_id = $1
          AND l.to_type = 'task'
          AND l.edge_type = ANY($2)
          AND t.archived_at IS NULL`,
      [ref.id, OUTCOME_OUT_EDGE_TYPES as unknown as string[]]
    )
  ).rows;

  // ── OUTCOME: IMPLEMENTING tasks, walked in REVERSE (SK3) ───
  // Only for a DECISION, and only from a TASK: `decided_by` is stored task → decision, so
  // the tasks that implemented this decision are its from_id side. The JOIN to `tasks` is
  // what makes "only from a task" structural — an inbound context/decision id matches no
  // task row and is dropped there; the `from_type` predicate below narrows the same set
  // explicitly and on an indexed column, and is deliberately redundant with it (a mutation
  // probe removing it leaves behaviour unchanged, by design). Same evidence bar, same
  // archived exclusion, same single-hop shape as the two forward queries above — this is
  // the OUT walk's mirror, not a new mechanism, so it inherits its bounds by construction
  // (one hop, no recursion, therefore no cycle to be caught and no new depth/node knob).
  // A task's status maps through mapTaskOutcome, which counts ONLY `completed` — a
  // cancelled implementing task contributes no sample rather than a zero.
  const implementingTaskOutcomes =
    ref.type === 'decision'
      ? (
          await pool.query(
            `SELECT t.status AS status
               FROM links l
               JOIN tasks t ON t.id = l.from_id
              WHERE l.to_id = $1
                AND l.from_type = 'task'
                AND l.edge_type = ANY($2)
                AND t.archived_at IS NULL`,
            [ref.id, OUTCOME_IN_EDGE_TYPES as unknown as string[]]
          )
        ).rows
      : [];

  const outcomes: OutcomeSample[] = [
    ...decisionOutcomes.map((r) => ({ value: mapDecisionOutcome(r.status), source: 'decision' as const })),
    ...taskOutcomes.map((r) => ({ value: mapTaskOutcome(r.status), source: 'task' as const })),
    ...implementingTaskOutcomes.map((r) => ({ value: mapTaskOutcome(r.status), source: 'task' as const })),
  ];

  // A DECISION's OWN outcome_status is direct ground-truth for ITSELF (loop-scored) —
  // fold it in as an outcome sample (too_early/unknown → null → ignored by the mapper).
  if (ref.type === 'decision' && ownOutcomeStatus !== undefined) {
    outcomes.push({ value: mapDecisionOutcome(ownOutcomeStatus), source: 'decision' });
  }

  // ── SUPERSESSION (PROVENANCE-WEIGHTED, BL-4): edges pointing AT this record ──────
  // A newer record `supersedes`/`possibly_supersedes` THIS one → this is the to_id (reverse
  // walk). We split the CONSEQUENCE by provenance (one query returns edge_type + created_by):
  //   - DECLARED (hard cap → superseded/abstain): a `supersedes` edge whose created_by is NOT
  //     the belief adjudicator (a human / the `link` tool / a write-time declaration), OR a
  //     decision's own superseded_by column.
  //   - SOFT (demote, never abstain/drop): an AUTO `supersedes` edge (created_by = the belief
  //     adjudicator), OR ANY `possibly_supersedes` edge (BL-3 is auto-only by construction).
  // Declared WINS if both are present (the pure math enforces precedence).
  // BL-5: also pull the superseding record id (from_id) + the edge metadata (confidence /
  // reason[] / rationale / …) so we can build the RECEIPT. ORDER BY created_at DESC so, when
  // several edges of a tier collide, the FIRST one iterated is the most-recent (the tiebreak).
  const supRows = (
    await pool.query(
      `SELECT from_id, edge_type, created_by, metadata
         FROM links
        WHERE to_id = $1
          AND edge_type IN ('supersedes', 'possibly_supersedes')
        ORDER BY created_at DESC`,
      [ref.id]
    )
  ).rows;

  let supersededDeclared = false;
  let supersededSoft = false;
  // BL-5 RECEIPT candidates: the DECIDING edge per tier. For declared we keep the most-recent
  // declared edge; for soft we keep the highest-confidence auto edge (most-recent as tiebreak
  // — rows are DESC by created_at, so a strictly-greater test leaves the most-recent winner
  // in place among equal confidences).
  let declaredReceipt: SupersessionReceipt | null = null;
  let softReceipt: SupersessionReceipt | null = null;
  let bestSoftConfidence = -Infinity;
  // BACKWARD-SOFT GUARD (P5.3 half B): the soft candidates are COLLECTED first and adjudicated
  // against the declared subgraph BELOW, before any of them is allowed to set supersededSoft.
  // Deciding inline (as this loop used to) would mean the losing candidates had already moved
  // the flag by the time we knew they were contradicted.
  const softCandidates: { fromId: string; confidence: number | null; reason: string | null }[] = [];
  for (const r of supRows) {
    // EXACT-EQUALITY classification (locked by contract test): the auto label is the ONLY
    // thing that makes a `supersedes` edge soft. A `possibly_supersedes` edge is ALWAYS soft.
    const isSoftEdge =
      r.edge_type === 'possibly_supersedes' || r.created_by === BELIEF_EDGE_CREATED_BY;
    if (isSoftEdge) {
      softCandidates.push({
        fromId: r.from_id,
        confidence: readEdgeConfidence(r.metadata),
        reason: readEdgeReason(r.metadata),
      });
    } else {
      // a `supersedes` edge with a human/link-tool/write-time/NULL created_by → DECLARED.
      supersededDeclared = true;
      if (declaredReceipt === null) {
        declaredReceipt = {
          supersededBy: r.from_id,
          tier: 'declared',
          confidence: readEdgeConfidence(r.metadata),
          reason: readEdgeReason(r.metadata),
        };
      }
    }
  }
  // ── BACKWARD-SOFT GUARD (P5.3 half B) ────────────────────────────────────
  // A guessed supersession may not contradict a DECLARED chain running the other way. For
  // each soft candidate S, ask: does THIS record declared-supersede S, transitively, over the
  // DECLARED subgraph only? If yes, S's opinion is contradicted by a declaration and is
  // dropped. The walk is bounded, cycle-safe and TRI-STATE — see declaredReachability.ts.
  //
  // COST: the adjacency read below happens ONLY when there is at least one soft candidate.
  // A record with no soft supersession pays nothing.
  const guard = await adjudicateBackwardSoft(ref.id, softCandidates, guardConfig, pool);
  for (const survivor of guard.survivors) {
    supersededSoft = true;
    const c = survivor.confidence ?? -Infinity;
    if (c > bestSoftConfidence) {
      bestSoftConfidence = c;
      softReceipt = {
        supersededBy: survivor.fromId,
        tier: 'soft',
        confidence: survivor.confidence,
        reason: survivor.reason,
      };
    }
  }

  // A decision also carries its own superseded_by column — a DIRECT, DECLARED signal. When no
  // declared EDGE carried a receipt, the column IS the receipt (id only; no edge metadata).
  if (supersededBy) {
    supersededDeclared = true;
    if (declaredReceipt === null) {
      declaredReceipt = { supersededBy, tier: 'declared', confidence: null, reason: null };
    }
  }
  // Declared WINS (precedence): pass the declared receipt when hard, else the soft one, else
  // none. computeTrust forwards this verbatim onto Trust.supersession for the winning tier.
  const supersessionReceipt: SupersessionReceipt | null = supersededDeclared
    ? declaredReceipt
    : supersededSoft
    ? softReceipt
    : null;

  // Contradiction detection is deferred to T4 (self-curation). T2b honors the flag if a
  // future pass sets it; nothing sets it now, so it's always false here.
  const contradicted = false;

  return computeTrust(
    {
      outcomes,
      ageDays,
      supersededDeclared,
      supersededSoft,
      contradicted,
      supersessionReceipt,
      supersessionGuard: guard.audit,
    },
    config
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKWARD-SOFT GUARD (P5.3 half B)
// ─────────────────────────────────────────────────────────────────────────────

/** One soft supersession candidate, as read off the reverse edge walk. */
interface SoftCandidate {
  fromId: string;
  confidence: number | null;
  reason: string | null;
}

/** What the guard decided: who survives, and the receipt for everyone it touched. */
interface BackwardSoftOutcome {
  survivors: SoftCandidate[];
  audit: SupersessionGuardAudit;
}

/**
 * ADJUDICATE every soft supersession candidate against the DECLARED subgraph.
 *
 * THE RULE: a guessed (`tier:soft`) supersession may not contradict a DECLARED chain running
 * the other way. Concretely — candidate S claims it supersedes `recordId`. If `recordId`
 * DECLARED-supersedes S (directly or transitively), S's claim is contradicted by a human-grade
 * declaration and is dropped. A declaration outranks an opinion.
 *
 * ── WHY THIS IS A READ-TIME RULE AND NOT A MINT-TIME REFUSAL (the decision, with its reasons)
 *
 * The mint path was the other candidate site: refuse to WRITE a contradicting
 * `possibly_supersedes` edge at all. It was rejected on two grounds, and only the second is
 * about safety:
 *
 *  1. IT IS NOT SUFFICIENT, because the contradiction is TIME-DEPENDENT. Declared edges are
 *     minted CONTINUOUSLY and AFTER the fact — `handoffSupersession.ts` adds one declared link
 *     on every handoff write. The measured prod cycle is exactly that shape: the soft edge was
 *     an honest, uncontradicted opinion at the moment it was minted, and a LATER human-grade
 *     declaration is what turned it into a contradiction. A mint-time check cannot see a
 *     declaration that does not exist yet, so it would have let this exact defect through.
 *  2. IT IS NOT REVERSIBLE. An edge never written cannot be un-written. If this reachability
 *     check is ever wrong — and it is a walk over data an operator can corrupt by hand — a
 *     mint-time refusal has destroyed an adjudicator opinion we cannot recover: the belief
 *     layer dedups and bills per pair, so it will not re-offer it. A read-time suppression is
 *     a lens: the edge stays on disk, `MANDREL_BACKWARD_SOFT_GUARD=0` puts it back with no
 *     deploy and no data loss, and the audit below names exactly what was hidden.
 *
 * And read time is where the BLAST RADIUS is already covered: every consumer of trust —
 * recall_thread, the briefing, search, the current-state projection — goes through
 * `trustForRecord`. Fixing it here fixes all of them, including for the edges ALREADY on disk
 * on all 8 live instances, which is the population that actually has the defect today. A mint
 * guard would only ever have protected edges not yet written.
 *
 * So: READ TIME, here, and the mint path is deliberately NOT touched.
 */
async function adjudicateBackwardSoft(
  recordId: string,
  candidates: SoftCandidate[],
  guardConfig: SupersessionGuardConfig,
  pool: Pool
): Promise<BackwardSoftOutcome> {
  // NOTHING TO ADJUDICATE, or the guard is off: everyone survives, and the audit SAYS which
  // of those two it was (`enabled`), because "no suppressions" and "the guard did not run"
  // are different facts and must not render identically.
  if (!guardConfig.enabled || candidates.length === 0) {
    return {
      survivors: candidates,
      audit: { ...emptySupersessionGuardAudit(guardConfig.enabled), checked: candidates.length },
    };
  }

  const adjacency = await loadDeclaredSupersessionAdjacency(recordId, guardConfig.maxHops, pool);

  const survivors: SoftCandidate[] = [];
  const suppressed: BackwardSoftFinding[] = [];
  const undecided: BackwardSoftFinding[] = [];

  for (const c of candidates) {
    const reach = declaredReaches(recordId, c.fromId, adjacency, guardConfig.maxHops);
    if (reach.verdict === 'reached') {
      suppressed.push({
        candidate: c.fromId,
        confidence: c.confidence,
        verdict: reach.verdict,
        hops: reach.hops,
        undecidedCause: null,
        action: 'suppressed',
      });
      continue;
    }
    if (reach.verdict === 'undecided') {
      // C1's THIRD STATE, kept as its own state. It is neither folded into "suppress" nor
      // into "allow" — the configured policy decides the ACTION, the finding records that the
      // action was taken on an undecided check, and the count is separate from `suppressed`.
      const action = guardConfig.undecidedPolicy === 'suppress' ? 'suppressed' : 'honored';
      undecided.push({
        candidate: c.fromId,
        confidence: c.confidence,
        verdict: reach.verdict,
        hops: null,
        undecidedCause: reach.undecidedCause,
        action,
      });
      if (action === 'honored') survivors.push(c);
      continue;
    }
    // 'ended' — the declared subgraph was enumerated exhaustively and does not run the other
    // way. The opinion stands, and carries no finding (see BackwardSoftFinding's doc).
    survivors.push(c);
  }

  return {
    survivors,
    audit: { enabled: true, checked: candidates.length, suppressed, undecided },
  };
}

/**
 * Load the DECLARED supersession adjacency reachable from `seed`, as `from → [to, …]`.
 *
 * DECLARED-ONLY IS ENFORCED IN THIS QUERY, and this is the only place it can be enforced: the
 * pure walker has no notion of a tier (declaredReachability.ts header, requirement 1).
 *
 * IT READS THE DATABASE'S OWN CLASSIFIER, NOT A SECOND COPY OF ONE. `provenance_class` is a
 * STORED GENERATED column over `mint_via` (migration 085) and is the single source for
 * declared-vs-guessed; migration 087's CHECK constraint already holds
 * `edge_type <> 'supersedes' OR provenance_class = 'declared'`, so the two predicates below
 * are deliberately redundant — the class test states the rule this walk depends on, and the
 * constraint is what makes it true. A `created_by` test here would be a THIRD, weaker
 * spelling of the same classification (created_by is a mechanism stamp, not the classifier),
 * and re-deriving it is exactly the drift 085 exists to end.
 *
 * `possibly_supersedes` is excluded structurally by the edge_type test: a soft edge can never
 * be evidence for or against another soft edge.
 *
 * CYCLE SAFETY IS IN THE SQL TOO, not just in the walker. The recursion carries its own path
 * array and refuses to step onto a node already on that path — otherwise the measured prod
 * cycle makes this query itself non-terminating, and a hung query is a worse outcome than a
 * wrong answer. The closing edge of a cycle IS still emitted (the guard is on the RECURSION,
 * not on the row), so the walker can see it and report `undecided` rather than a confident
 * "no".
 *
 * DEPTH IS maxHops + 1 ON PURPOSE. The walker's budget is `maxHops`; fetching one level
 * further is what lets it distinguish "the subgraph ENDED inside the budget" (an exhaustive
 * no) from "I was STOPPED at the budget with a frontier still unexpanded" (undecided). Fetch
 * exactly maxHops and those two are indistinguishable, which is the third-state bug this
 * whole guard is written to avoid.
 */
async function loadDeclaredSupersessionAdjacency(
  seed: string,
  maxHops: number,
  pool: Pool
): Promise<Map<string, string[]>> {
  const rows = (
    await pool.query(
      `WITH RECURSIVE declared AS (
         SELECT l.from_id,
                l.to_id,
                1 AS depth,
                ARRAY[l.from_id, l.to_id] AS path,
                false AS closes_cycle
           FROM links l
          WHERE l.from_id = $1
            AND l.edge_type = 'supersedes'
            AND l.provenance_class = 'declared'
          UNION ALL
         SELECT l.from_id,
                l.to_id,
                d.depth + 1,
                d.path || l.to_id,
                (l.to_id = ANY(d.path))
           FROM declared d
           JOIN links l ON l.from_id = d.to_id
          WHERE l.edge_type = 'supersedes'
            AND l.provenance_class = 'declared'
            AND d.depth < $2
            AND NOT d.closes_cycle
       )
       SELECT DISTINCT from_id, to_id FROM declared`,
      [seed, maxHops + 1]
    )
  ).rows;

  const adjacency = new Map<string, string[]>();
  for (const r of rows) {
    const list = adjacency.get(r.from_id);
    if (list) list.push(r.to_id);
    else adjacency.set(r.from_id, [r.to_id]);
  }
  return adjacency;
}

/** Read the adjudicator `confidence` from a belief edge's jsonb metadata (pg returns it as a
 *  parsed object). Returns null when absent / not a finite number (declared/empty metadata). */
function readEdgeConfidence(metadata: unknown): number | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const c = (metadata as Record<string, unknown>).confidence;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/** Read the human-readable WHY from a belief edge's jsonb metadata: the adjudicator
 *  `rationale` (string) if present, else the joined soft `reason[]`; null when neither exists
 *  (a declared column-only supersession / an empty-metadata declared edge). */
function readEdgeReason(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const m = metadata as Record<string, unknown>;
    if (typeof m.rationale === 'string' && m.rationale.trim() !== '') return m.rationale;
    if (Array.isArray(m.reason)) {
      const joined = m.reason.filter((x): x is string => typeof x === 'string').join(', ');
      if (joined !== '') return joined;
    }
  }
  return null;
}

/**
 * Gather + compute trust for MANY records (a recall result page). Computed PER returned
 * result (cheap — not the whole DB), preserving input order so the caller can zip it back
 * onto its rows. Each record is independent; one failing must not sink the page — on an
 * unexpected error for a single record we fall back to a conservative cold-start `unproven`
 * (freshness-only) rather than throwing the whole search.
 */
export async function trustForRecords(
  refs: RecordRef[],
  config: TrustConfig = TRUST_CONFIG,
  pool: Pool = db,
  guardConfig: SupersessionGuardConfig = SUPERSESSION_GUARD_CONFIG
): Promise<Trust[]> {
  return Promise.all(
    refs.map(async (ref) => {
      try {
        return await trustForRecord(ref, config, pool, guardConfig);
      } catch (e) {
        // OBSERVABLE degrade (nit N3): the per-record wording is honest to the CLIENT, but a
        // bare swallow leaves OPERATORS blind — a systemic gather failure (bad pool, missing
        // index, schema drift) would hide behind correct-sounding per-record text, one row at
        // a time. Warn with the record id/type + the error message so a repeated failure is
        // greppable and countable. Never throws: logging must not turn a degrade into an
        // outage. No secrets — an id, a type, and the error string.
        logger.warn(
          `🔐 trust: signal gather FAILED for ${ref.type} ${ref.id} — degraded to a freshness-only verdict (recall unaffected). metric=trust_degraded_fallback`,
          { metadata: { error: (e as Error)?.message } }
        );
        // Defensive: trust is a SURFACED signal, never a reason to fail recall. Degrade to
        // a freshness-only verdict, not distrust. If we don't even have a date, treat as
        // maximally stale (epoch) — honest, not a crash.
        //
        // DEGRADED, and it SAYS so (nit N3): the gather threw, so this record's outcomes
        // were never READ. Without the flag the explanation would assert "no counted
        // downstream outcome yet — score is freshness alone", which is a confident
        // evidentiary claim about data we failed to query. `degraded: true` changes no
        // number; it makes the rendered reason tell the truth ("trust signals could not be
        // read … treat the record as unevaluated").
        return computeTrust(
          {
            outcomes: [],
            ageDays: ageInDays(ref.createdAt ?? new Date(0)),
            supersededDeclared: false,
            supersededSoft: false,
            contradicted: false,
            degraded: true,
          },
          config
        );
      }
    })
  );
}

/** Age of a record in days from its created/decision date to now (clamped >= 0). */
function ageInDays(createdAt: Date | string, now: Date = new Date()): number {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const ms = now.getTime() - created.getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

/** Per-entity metadata for self-fetch (freshness date + decision outcome/supersession). */
interface RecordMeta {
  createdAt: Date | null;
  outcomeStatus?: string | null;
  supersededBy?: string | null;
}

/**
 * Self-fetch a record's freshness date (and, for a decision, its own outcome_status +
 * superseded_by) when the caller didn't pass them. Parameterized; the date column differs
 * per entity (contexts/tasks: created_at; decisions: decision_date). Returns null on a
 * missing/unreadable row so the caller falls back to a conservative default.
 */
async function fetchRecordMeta(
  id: string,
  type: 'context' | 'decision' | 'task',
  pool: Pool
): Promise<RecordMeta | null> {
  try {
    if (type === 'decision') {
      const r = await pool.query(
        `SELECT decision_date AS created_at, outcome_status, superseded_by
           FROM technical_decisions WHERE id = $1`,
        [id]
      );
      if (r.rows.length === 0) return null;
      return {
        createdAt: r.rows[0].created_at ?? null,
        outcomeStatus: r.rows[0].outcome_status ?? null,
        supersededBy: r.rows[0].superseded_by ?? null,
      };
    }
    const table = type === 'task' ? 'tasks' : 'contexts';
    const r = await pool.query(`SELECT created_at FROM ${table} WHERE id = $1`, [id]);
    if (r.rows.length === 0) return null;
    return { createdAt: r.rows[0].created_at ?? null };
  } catch {
    return null;
  }
}
