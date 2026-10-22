/**
 * PROJECT BRIEFING — the "living summary" renderer (WS2,  * spec/plan an earlier note).
 *
 * WHAT THIS IS: a DETERMINISTIC server-side renderer (no model anywhere in the path)
 * that assembles a NOTES.md-shaped markdown briefing of a project's CURRENT STATE:
 *   1. the latest non-superseded handoff — FULL text, never truncated;
 *   2. open tasks — status + FULL descriptions;
 *   3. non-superseded decisions — title + rationale (the WHY), grouped by decision_type
 *      (the one cheap deterministic topic grouping the schema already carries);
 *   4. convention/constraint contexts (tag vocabulary: config/briefingConfig.ts);
 *   5. DEAD-ENDS — paths not to re-walk, as one line each: "<basis>: X — Y". Intake is
 *      structural (a supersedes edge; a superseded/deprecated/failed decision) OR by
 *      author tag (vocabulary: config/briefingConfig.ts) — the plain `discussion` context
 *      that records a proven-impossible approach carries no structural signal. The label
 *      states WHICH of those signals admitted the record (see DeadEndBasis): only a
 *      loop-scored `failed` decision is rendered as "tried and rejected".
 * Superseded content appears ONLY in dead-ends, never in a body section. Trust rides
 * inline as explainTrust().signal (WS1's ONE machine-lean rendering — never re-spelled).
 *
 * THE SIZE-CAP RULE (eval-derived, non-negotiable): when the render exceeds
 * BRIEFING_MAX_CHARS, whole records are DROPPED, least-protected first (the protection
 * ladder in briefingConfig.ts), least-trusted-oldest within a band. Nothing is
 * ever truncated — a record is either complete or absent. The handoff is EXEMPT from
 * dropping: it is the resume point, the one record the briefing exists to deliver.
 *
 * ═══ SK5: THE READER'S BRANCH SELECTS; THE CAP IS THE BACKSTOP ═══════════
 *
 * TWO NUMBERS PER SECTION, ALWAYS — and `none` is a claim, not a default.
 * Measured on prod 2026-08-16: this renderer printed `## Open tasks (1)`, `## Decisions (0)
 * none` and `## Conventions (0) none` for a project with 190 open tasks, 156 live decisions
 * and 1 convention. Every one of them was fetched and then evicted by the char cap, and the
 * only trace was a GLOBAL footer that never said WHICH section it emptied. The served count
 * was printed in the position a reader reads as the population, so the renderer's silence
 * manufactured "there is no open work".
 * RULING 6 of e67bafb3 is the invariant: THE DISPLAY MAY ONLY ASSERT WHAT A RECORD CARRIES
 * IN A FIELD. So the population is now a FIELD — every section carries a SectionCensus, the
 * heading prints `(served of population)`, and `none` may be emitted ONLY when the census
 * says the population is genuinely zero. The census is a REQUIRED member of BriefingData
 * (never optional, never defaulted): delete it and the GREEN path stops compiling, which is
 * the property e67bafb3 RULING 4 says to select for in a guard.
 *
 * TWO INDEPENDENT NARROWINGS, NEVER CONFLATED. (1) the per-query `LIMIT sectionMaxRecords`
 * at fetch time — when it binds, the population is a FLOOR and renders `N+` with a note
 * naming MANDREL_BRIEFING_SECTION_MAX_RECORDS; (2) the global char-cap drop, which is what a
 * `served < population` note reports. A third narrowing is now DELIBERATE and also disclosed:
 * tasks tagged from BRIEFING_EXCLUDED_TASK_TAGS (`parked:*`) never enter selection at all.
 *
 * SELECTION STARTS FROM THE READER'S SPINE. When the caller has an open branch position, the
 * briefing gains an `## On this branch` section (the spine's STORED members — SK2 made
 * membership a fact in `branch_memberships`, read by one flat equality through the
 * `branch_membership` view, so there is no graph walk here), and every branch member becomes
 * DROP-PROTECTED: the cap evicts unrelated project-wide material before it touches the branch
 * the reader said they were resuming. Blocked tasks are protected on the same rank (the
 * always-surface floor). Unpositioned or at trunk: no branch section, no protection, today's
 * global behaviour.
 *
 * DEAD-ENDS ARE NOT IN THE GLOBAL DROP POOL. They get a reserved
 * sub-budget of their own — BRIEFING_DEADEND_RESERVED_CHARS — and compete only with each
 * other inside it, oldest dropped first. A dead end is valuable BECAUSE it failed: it
 * stops the next session re-walking a proven-impossible path, and it costs one line. The
 * shared pool used to evict them first (see fitDeadEndsToBudget for the mechanism), which
 * spent the highest-value-per-char content in the document for almost no cap relief.
 *
 * AUDIENCE: machine injection (SessionStart hooks, dispatch prompts). Markdown structure
 * yes; emoji banners / permalink URLs / decorative framing no (WS1 D2). Record CONTENT is
 * data and passes through verbatim — the lean rule binds the frame this module assembles.
 *
 * PURITY SPLIT: gatherBriefingData() does the queries; renderBriefing() is a PURE
 * function over (data, config) so the contract tests can attack the render/drop logic
 * with fabricated corpora.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  READ_BRIEFING_MAX_CHARS,
  READ_BRIEFING_CONVENTION_TAGS,
  READ_BRIEFING_OPEN_TASK_STATUSES,
  READ_BRIEFING_SECTION_MAX_RECORDS,
  READ_BRIEFING_DEADEND_RESERVED_CHARS,
  READ_BRIEFING_DEADEND_TAGS,
  READ_BRIEFING_EXCLUDED_TASK_TAGS,
  READ_BRIEFING_BRANCH_RESERVED_CHARS,
  READ_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES,
  READ_BRIEFING_BRANCH_SCOPE_ENABLED,
  READ_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER,
  READ_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE,
  READ_BRIEFING_PROTECTION_RANK_CONVENTION,
  READ_BRIEFING_PROTECTION_RANK_DECISION,
  READ_BRIEFING_PROTECTION_RANK_STALE_PRIORITY,
  READ_BRIEFING_PROTECTION_RANK_PRIORITY,
  READ_BRIEFING_PROTECTED_TASK_PRIORITIES,
  READ_BRIEFING_STALE_TASK_DAYS,
  READ_BRIEFING_BACKFILL_ENABLED,
  READ_BRIEFING_HANDOFF_STAMP_ENABLED,
  READ_BRIEFING_HANDOFF_STAMP_FORMAT,
  READ_BRIEFING_HANDOFF_STAMP_DELETED_LABEL,
  READ_BRIEFING_RECORDING_DIRECTIVE_ENABLED,
  READ_BRIEFING_RECORDING_DIRECTIVE,
  BRIEFING_PROTECTION_RANK_NONE,
} from '../config/briefingConfig.js';
import {
  READ_BRIEFING_ALTITUDE_ENABLED,
  READ_BRIEFING_SELECT_MAX_TASKS,
  READ_BRIEFING_SELECT_MAX_DECISIONS,
  READ_BRIEFING_SELECT_MAX_CONVENTIONS,
  READ_BRIEFING_SELECT_MAX_DEAD_ENDS,
  READ_BRIEFING_SELECT_MAX_BRANCH_MEMBERS,
  READ_BRIEFING_FULL_PROSE_SLOTS,
  READ_BRIEFING_FULL_PROSE_TYPES,
  READ_BRIEFING_FULL_PROSE_MAX_CHARS,
  READ_BRIEFING_FULL_PROSE_EXCLUDE_TAGS,
  BRIEFING_QUOTA_UNBOUNDED,
  BRIEFING_FULL_PROSE_ALL_KINDS,
  SELECTION_RULE,
  FULL_PROSE_DENIAL,
  type RenderAltitude,
  type FullProseDenial,
} from '../config/briefingAltitudeConfig.js';
import { HANDOFF_SUPERSESSION_CREATED_BY, TRUNK_CONTEXT_TYPE } from './handoffSupersession.js';
import {
  resolveHandoffHead,
  type HandoffHeadResolution,
  type HandoffHeadCandidate,
} from './handoffHead.js';
import {
  READ_HANDOFF_HEAD_MAX_HOPS,
  READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS,
  READ_HANDOFF_HEAD_REFUSAL_REMEDY,
  HANDOFF_HEAD_REFUSAL_EXPLANATION,
} from '../config/handoffHeadConfig.js';
import {
  applyHandoffStamps,
  resolveHandoffStamps,
  NO_HANDOFF_STAMPS,
  type HandoffStamps,
} from './handoffStamp.js';
import {
  readCarriedFields,
  resolveCarriedSpine,
  NO_CARRIED_FIELDS,
  type CarriedFields,
  type ResolvedSpine,
} from './handoffCarriedFields.js';
import {
  CARRIED_FIELDS_MODE_LABEL,
  CARRIED_FIELDS_NONE_RECORDED,
  CARRIED_FIELDS_PATH_LABEL,
  CARRIED_FIELDS_SOURCE_FORMAT,
  CARRIED_FIELDS_SPINE_LABEL,
  CARRIED_FIELDS_SPINE_TITLE_CHARS,
  CARRIED_FIELDS_SPINE_UNRESOLVED,
} from '../config/handoffCarriedFieldsConfig.js';
import { reviewOutcomeOf, gateOutcomeOf } from './recallThreadCore.js';
import { REVIEW_OUTCOME_LABEL } from '../config/reviewOutcomeConfig.js';
import { GATE_RC_LABEL } from '../config/gateExitCodeConfig.js';
import { trustForRecords, explainTrust, type RecordRef } from './trust.js';
import { readBranchMemberSummaries, type MemberType } from './branchMembership.js';
import {
  gatherWaitingOnHuman,
  type BriefingWaiting,
  type WaitingTask,
} from './waitingOnHuman.js';
import {
  READ_WAITING_SECTION_ENABLED,
  READ_WAITING_MAX_RECORDS,
  READ_WAITING_RESERVED_CHARS,
  READ_WAITING_FALLBACK_CAVEAT,
  READ_WAITING_DUE_HINT_CAVEAT,
  WAITING_SECTION_LABEL,
  WAITING_DUE_MARKER,
  WAITING_DUE_HINT_MARKER,
  BLOCKED_ON_MIGRATION,
  BLOCKED_ON_HUMAN,
} from '../config/blockedOnConfig.js';
import {
  MEMBERSHIP_SOURCE,
  APPROXIMATE_SOURCES,
  type MembershipSource,
} from '../config/membershipSourceConfig.js';

// ─────────────────────────────────────────────────────────────────────────────
// Data shapes (what gather produces, what render consumes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `metadata` column that arrived as a STRING rather than as a jsonb object.
 * `pg` normally hands jsonb back parsed, but a hand-built test row, an older driver, or a
 * column read through a cast can hand back text — and a JSON.parse throwing here would
 * take the whole briefing down over a metadata blob nobody has read yet. Returns an empty
 * object on anything unparseable, which the carried-fields reader treats as "no field",
 * falling through to the prose exactly as an untouched handoff does.
 */
function safeJsonObject(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export interface BriefingHandoff {
  id: string;
  /**
   * The handoff EXACTLY AS STORED. Never rewritten — the staleness stamp is applied at
   * render time (see `stamps`), so this field remains the archive of what the author wrote.
   */
  content: string;
  createdAt: Date;
  /** WS1's machine-lean trust signal (explainTrust().signal). */
  trustSignal: string;
  /**
   * THE STALENESS OVERLAY: task-id token -> that task's CURRENT status, as
   * measured at gather time. REQUIRED, never optional and never defaulted — same reason the
   * census is required (an earlier decision RULING 4): an optional field silently absent is a
   * silent regression to the exact defect this feature exists to close, whereas a required
   * one stops the GREEN path compiling. A handoff naming no resolvable ids carries
   * NO_HANDOFF_STAMPS, which is a claim ("nothing resolved"), not a default.
   */
  stamps: HandoffStamps;
  /**
   * THE CARRIED FIELDS (P5.4): MODE, PATH and SPINE — the three lines a resuming reader
   * acts on before anything else. REQUIRED, never optional and never defaulted, for the
   * same reason `stamps` is (an earlier decision RULING 4): an optional field silently
   * absent regresses to the exact defect this exists to close, whereas a required one
   * stops the GREEN path compiling. A handoff carrying nothing carries NO_CARRIED_FIELDS,
   * which is a CLAIM ("neither a field nor parseable prose"), not a default.
   */
  carried: CarriedFields;
  /**
   * What `carried.spine` actually names in THIS project, measured at gather time — or
   * `null` when it resolves to nothing (absent, archived, another project's, or an
   * ambiguous prefix the resolver refuses to first-match). Null is a MEASUREMENT and the
   * render says so in band; it is not "we did not look".
   */
  spineResolved: ResolvedSpine | null;
}

export interface BriefingTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: Date;
  trustSignal: string;
  /** Numeric trust score for drop ordering (null = unscored → drops first). */
  trustScore: number | null;
  /**
   * The record's own tags (P5.1). Carried so the FULL-PROSE GATE can read
   * BRIEFING_FULL_PROSE_EXCLUDE_TAGS off the record instead of a second query, and so a
   * denial states the tag it matched. Required, never optional: a silently-absent tag array
   * would make the exclude vocabulary a no-op that still reports as configured.
   */
  tags: string[];
  /**
   * The record's own jsonb metadata — carried so the ONE shape-line grammar can render the
   * structured facts stored on it (guard class `renderer-drops-structured-fact`).
   * REQUIRED, never optional, for the reason `tags` is: a silently-absent metadata bag makes
   * every stamp a no-op that still reports as implemented, which is this class exactly.
   */
  metadata: unknown;
}

export interface BriefingDecision {
  id: string;
  title: string;
  rationale: string;
  decisionType: string;
  createdAt: Date;
  trustSignal: string;
  trustScore: number | null;
  /** The record's own tags — see BriefingTask.tags (P5.1 full-prose gate). */
  tags: string[];
  /**
   * The record's own jsonb metadata — carried so the ONE shape-line grammar can render the
   * structured facts stored on it (guard class `renderer-drops-structured-fact`).
   * REQUIRED, never optional, for the reason `tags` is: a silently-absent metadata bag makes
   * every stamp a no-op that still reports as implemented, which is this class exactly.
   */
  metadata: unknown;
}

export interface BriefingConvention {
  id: string;
  content: string;
  tags: string[];
  createdAt: Date;
  trustSignal: string;
  trustScore: number | null;
  /**
   * The record's own jsonb metadata — carried so the ONE shape-line grammar can render the
   * structured facts stored on it (guard class `renderer-drops-structured-fact`).
   * REQUIRED, never optional, for the reason `tags` is: a silently-absent metadata bag makes
   * every stamp a no-op that still reports as implemented, which is this class exactly.
   */
  metadata: unknown;
}

/**
 * WHY a record is in the Dead ends section — the intake signal that admitted it, kept as
 * DATA so the rendered label can state what is true of THAT record (SK3 part 3).
 *
 * The section used to prefix every line `tried and rejected:`. That is a claim about how
 * the record ENDED, and for most of them it is false: a handoff replaced by its successor
 * is bookkeeping, not a rejected approach. Measured on the live riverbend briefing
 * 2026-08-15: all 8 rendered dead ends were superseded handoffs / build reports, zero
 * were refuted. The four bases below are exactly the four intake branches the gather
 * already computes — nothing new is inferred, the distinction was simply being discarded.
 */
export type DeadEndBasis =
  /** A decision the loop scored `outcome_status='failed'` — genuinely tried, genuinely rejected. */
  | 'refuted'
  /** Replaced by a named successor (a supersedes edge, or the superseded_by column). */
  | 'superseded'
  /** A decision retired via `status='deprecated'`, with a recorded reason, and no successor named. */
  | 'deprecated'
  /** A context whose AUTHOR tagged it a dead end (config vocabulary) — self-declared, no structural signal. */
  | 'recorded';

export interface BriefingDeadEnd {
  id: string;
  /** 'context' | 'decision' — where the corpse came from. */
  kind: 'context' | 'decision';
  /** WHICH intake signal admitted it — drives the rendered label (see DeadEndBasis). */
  basis: DeadEndBasis;
  /** The one-line headline (a decision's title; a context's first content line). */
  headline: string;
  /** The one-line WHY. */
  reason: string;
  createdAt: Date;
}

/** One member of the reader's open branch, reduced to a one-line index entry. */
export interface BriefingBranchMember {
  id: string;
  type: MemberType;
  /** The member's own headline (title / first content line); null when unresolvable. */
  headline: string | null;
  /**
   * HOW THIS MEMBERSHIP WAS OBTAINED (migration 086's `spine_source`): 'recorded' = from the
   * live position at mint time, a fact; 'legacy-approx' = derived by the 086 backfill from
   * where a pre-086 edge happened to attach. Carried as a FIELD and rendered from the field —
   * never recomputed at render time, never inferred from a date.
   *
   * WHY IT IS HERE AT ALL: measured on prod 2026-08-16, 107 of 130 membership rows fleet-wide
   * are 'legacy-approx', and the worked example is 8 of 8 approximate. A
   * section printing `(8 of 8)` over that set, with the field available and dropped, is the
   * `none`-over-a-population-of-156 defect this file exists to delete, one surface over.
   */
  spineSource: MembershipSource;
  createdAt: Date;
}

/**
 * The branch the reader is standing on, when there is one.
 *
 * NO `spineType` AND NO SPINE TITLE: the section labels the spine by id, because neither is
 * needed to select and neither is carried by the membership read. Rendering a kind or a
 * headline here would mean inferring one — the exact move e67bafb3 RULING 6 forbids.
 */
export interface BriefingBranch {
  spineId: string;
  members: BriefingBranchMember[];
}

/**
 * How many of a member list had their branch DERIVED rather than recorded — SK2's own
 * vocabulary (`approximateMembers`, branch_history / readBranchMembers), deliberately reused
 * rather than a third spelling of one idea.
 *
 * NOTE WHAT IS ABSENT: no `exact`. That claim is a conjunction over all THREE bands, and the
 * briefing's bounded read computes only band 2 — so it may report what IS approximate and may
 * not certify the remainder. branch_history answers `exact`; this does not pretend to.
 */
export function approximateMemberCount(members: readonly BriefingBranchMember[]): number {
  return members.filter((m) => APPROXIMATE_SOURCES.has(m.spineSource)).length;
}

/**
 * WHAT A SECTION'S QUERY ACTUALLY SAW — the FIELD that lets the heading state a population
 * instead of implying one (an earlier decision RULING 6: the display may only assert what a
 * record carries in a field).
 *
 * Before SK5 the renderer had exactly one number per section — how many it SERVED — and
 * printed it in the position a reader reads as "how many exist". There was no field for the
 * population, so there was no way to be honest; the fix is the field, not a better sentence.
 */
export interface SectionCensus {
  /**
   * How many rows this section's query RETURNED, after the deliberate exclusions below and
   * before any size-cap drop. A FLOOR rather than a total when `fetchBoundReached`.
   */
  fetched: number;
  /**
   * True iff the fetch stopped at `config.sectionMaxRecords`. THE FIRST OF THE TWO
   * NARROWINGS, and the one that was previously invisible in the output entirely: the
   * population is then "at least `fetched`", never "exactly `fetched`".
   */
  fetchBoundReached: boolean;
  /** Rows removed by a DELIBERATE pre-selection exclusion (not by the cap). */
  excluded: number;
  /** What excluded them, named so the reader can go look. Null iff `excluded` is 0. */
  excludedReason: string | null;
}

/** The census for every list section. Required — see the header's note on REQUIRED TOKENS. */
export interface BriefingCensus {
  tasks: SectionCensus;
  decisions: SectionCensus;
  conventions: SectionCensus;
  deadEnds: SectionCensus;
  branchMembers: SectionCensus;
}

/** A section whose query ran and returned nothing, with nothing deliberately excluded. */
export const EMPTY_CENSUS: SectionCensus = Object.freeze({
  fetched: 0,
  fetchBoundReached: false,
  excluded: 0,
  excludedReason: null,
});

export interface BriefingData {
  projectId: string;
  projectName: string;
  /**
   * THE HEAD RESOLUTION — which handoff is live, or why that could not be decided (P5.2).
   * REQUIRED. `handoff` is non-null IFF `handoffHead.status === 'resolved'`; on a refusal
   * the renderer shows `handoffHead.candidates` and the remedy instead of an empty section
   * (SCOPE §8.5 — we measured a 40-minute broken boot from a resolver that refused silently).
   */
  handoffHead: HandoffHeadResolution;
  handoff: BriefingHandoff | null;
  tasks: BriefingTask[];
  decisions: BriefingDecision[];
  conventions: BriefingConvention[];
  deadEnds: BriefingDeadEnd[];
  /**
   * The reader's open branch position, or null at trunk / unpositioned (SK5). Non-null
   * turns on the branch section AND drop protection for its members.
   */
  branch: BriefingBranch | null;
  /** REQUIRED. Every section's population; the renderer may not assert one without it. */
  census: BriefingCensus;
  /**
   * "WAITING ON A HUMAN" (P5.5) — or null when the section is switched OFF
   * (MANDREL_BRIEFING_WAITING_ENABLED=false), which renders NO SECTION AT ALL rather than an
   * empty one. Same shape as `branch` above and for the same reason: an absent section and a
   * section claiming zero are different claims, and only one of them is true when a feature
   * is disabled.
   *
   * REQUIRED-with-null rather than optional, per an earlier decision RULING 4: an optional
   * field silently absent regresses to the defect the field exists to close, whereas a
   * required one stops the GREEN path compiling until every caller has decided.
   *
   * This object carries its OWN census (`fetched` / `fetchBoundReached`) instead of joining
   * `BriefingCensus`. The section's population is inseparable from HOW it selected — the
   * fallback's population is a different question from the column's — so the two travel
   * together or the heading can state a number about the wrong predicate.
   */
  waiting: BriefingWaiting | null;
}

export interface BriefingConfig {
  maxChars: number;
  conventionTags: readonly string[];
  openTaskStatuses: readonly string[];
  sectionMaxRecords: number;
  /** The Dead ends section's reserved sub-budget, in chars (see briefingConfig.ts). */
  deadEndReservedChars: number;
  /** Tag vocabulary marking a context as a recorded dead end (no supersession needed). */
  deadEndTags: readonly string[];
  /** Tag vocabulary excluding a task from Open tasks BEFORE selection (SK5: `parked:*`). */
  excludedTaskTags: readonly string[];
  /** The "On this branch" section's reserved sub-budget, in chars (see briefingConfig.ts). */
  branchReservedChars: number;
  /** Task statuses the size cap evicts LAST — the always-surface floor (SK5 scope (b)). */
  alwaysSurfaceTaskStatuses: readonly string[];
  /**
   * THE SK5 SELECTION MASTER SWITCH (briefingConfig.ts). DEFAULT FALSE. False = pre-SK5
   * selection exactly, plus the honest census, which this flag deliberately does not gate.
   */
  branchScopeEnabled: boolean;
  /**
   * THE DROP-ORDER PROTECTION LADDER (briefingConfig.ts). Higher rank = evicted LATER.
   * Read as numbers here and nowhere else: the comparator writes no rank literal of its own.
   */
  protectionRankBranchMember: number;
  protectionRankAlwaysSurface: number;
  protectionRankConvention: number;
  /**
   * A non-superseded decision's band. SHIPPED DEFAULT IS THE FLOOR — see briefingConfig.ts:
   * this is the f176d8a5 measurement knob, not a ruling, and turning it up is the experiment.
   */
  protectionRankDecision: number;
  protectionRankStalePriority: number;
  protectionRankPriority: number;
  /** `tasks.priority` values that earn a protection band (empty = the two bands are off). */
  protectedTaskPriorities: readonly string[];
  /** How old (days, from `created_at`) an open task must be to count as STALE. */
  staleTaskDays: number;
  /** Spend the budget the drop loop left unused by re-admitting dropped candidates. */
  backfillEnabled: boolean;
  /** THE HANDOFF STALENESS STAMP's kill switch (briefingConfig.ts). Default TRUE. */
  handoffStampEnabled: boolean;
  /** The stamp's rendered form; `{status}` is substituted (briefingConfig.ts). */
  handoffStampFormat: string;
  /** The status word stamped for a task whose row is archived (briefingConfig.ts). */
  handoffStampDeletedLabel: string;
  /**
   * THE RECORDING DIRECTIVE's kill switch (briefingConfig.ts). Default TRUE. OFF renders the
   * document byte-identical to pre-cfd2ec6c — the block is the last thing assemble() pushes
   * and nothing else reads it, so `false` removes it and changes nothing else.
   */
  recordingDirectiveEnabled: boolean;
  /** The directive's text; surface-specific tool names, so it is a knob (briefingConfig.ts). */
  recordingDirective: string;
  /** The supersession-walk runaway bound (config/handoffHeadConfig.ts). */
  handoffHeadMaxHops: number;
  /** How much of a candidate handoff's first line a REFUSAL renders (handoffHeadConfig.ts). */
  handoffHeadCandidateHeadlineChars: number;
  /** The in-band repair instruction rendered under an ambiguous chain (handoffHeadConfig.ts). */
  handoffHeadRefusalRemedy: string;
  /** THE "WAITING ON A HUMAN" KILL SWITCH (config/blockedOnConfig.ts). Default TRUE. */
  waitingSectionEnabled: boolean;
  /** That section's reserved char sub-budget (config/blockedOnConfig.ts). */
  waitingReservedChars: number;
  /** That section's fetch bound — the number a `N+` floor marker names. */
  waitingMaxRecords: number;
  /** The `status='blocked'` fallback's precision caveat (config/blockedOnConfig.ts). */
  waitingFallbackCaveat: string;
  /** What a `due?` marker means (config/blockedOnConfig.ts). */
  waitingDueHintCaveat: string;

  // ── P5.1: RENDER ALTITUDE + THE STATED SELECTION RULE ──────────────────────────────
  // Every knob's rationale, and the measurement that sized it, lives in
  // config/briefingAltitudeConfig.ts. This interface only names them.

  /** THE P5.1 MASTER SWITCH. False = pre-P5.1 exactly (applyAltitudeFlag collapses the rest). */
  altitudeEnabled: boolean;
  /** How many open tasks the selection rule serves, best-first by the protection ladder. */
  selectMaxTasks: number;
  /** The same quota for live decisions. */
  selectMaxDecisions: number;
  /** The same quota for convention/constraint contexts. */
  selectMaxConventions: number;
  /** The same quota for the Dead ends section. */
  selectMaxDeadEnds: number;
  /** The same quota for the `On this branch` index. */
  selectMaxBranchMembers: number;
  /** How many RESERVED full-prose slots the document carries. Never reassigned. */
  fullProseSlots: number;
  /** Which record kinds a full-prose slot may be spent on (`task`|`decision`|`convention`). */
  fullProseTypes: readonly string[];
  /** The character bound on ONE full-prose body — the only place truncation is licensed. */
  fullProseMaxChars: number;
  /** Tag vocabulary barring a record from a slot. SHIPS EMPTY — the mechanism, not our words. */
  fullProseExcludeTags: readonly string[];
}

/**
 * THE FLAG'S ONE CHOKE POINT (the operator's ruling 2026-08-16). With `branchScopeEnabled` false,
 * the OFF path is not a second code path that has to be kept in step with the ON one — it is
 * the SAME code reading empty vocabularies and floor ranks.
 *
 * THE CRITERION IS REORDERING, NOT NOVELTY (restated 2026-08-24, after a knob was added
 * under the wrong one). A knob collapses here if it can change WHICH records survive the cap
 * or in what order. A knob is exempt only if it admits nothing new AND reorders nothing.
 * `backfillEnabled` is the one exemption today: it only stops the cap loop leaving budget
 * unspent. The census is exempt for the same reason — it is a correction, not a feature.
 *
 * WHY THIS PARAGRAPH IS NOT DECORATION. It used to read "every SK5 selection knob collapses
 * to its pre-SK5 value", which stopped being true the moment a rank was added without being
 * added here — and the sentence still read as a guarantee. It was: with the always-surface
 * and priority vocabularies emptied but the convention rank left standing, a convention
 * became the single most-protected record in the OFF-path briefing, above blocked tasks —
 * on instances that were, at the time, the majority of the live fleet. If you add a rank or
 * a vocabulary to BriefingConfig, either collapse it here or write down why it reorders
 * nothing.
 *
 * Applied at BOTH public entry points (gatherBriefingData and renderBriefing) rather than
 * once in buildProjectBriefing, because both are exported and a caller reaching either one
 * directly with a raw config must not be able to obtain branch-scoped behaviour from a
 * flag-off deployment. `branchScopeEnabled` is carried through unchanged so the render can
 * also drop a branch supplied on a hand-built BriefingData.
 */
export function applySelectionFlag(config: BriefingConfig): BriefingConfig {
  if (config.branchScopeEnabled) return config;
  // `protectedTaskPriorities: []` collapses BOTH priority bands to no-protection by the same
  // move the two existing knobs use — an empty vocabulary, not a second code path. The two
  // priority bands are a SELECTION change (they decide which records survive the cap), so
  // they belong under the same master switch as the always-surface floor they sit beneath.
  // `protectionRankConvention` has no vocabulary to empty, so it is collapsed to the floor
  // rank directly — same effect, and for the same reason: it decides which records survive.
  return {
    ...config,
    excludedTaskTags: [],
    alwaysSurfaceTaskStatuses: [],
    protectedTaskPriorities: [],
    protectionRankConvention: BRIEFING_PROTECTION_RANK_NONE,
    // Same move, same reason (f176d8a5): a decision band reorders which records survive the
    // cap, so it is collapsed to the floor with the master switch off. Its SHIPPED default is
    // already the floor, so today this line changes nothing — it is here so that an operator
    // running the f176d8a5 measurement cannot obtain a reordered document from a flag-off
    // deployment, which is the hole the comment above says to close or explain.
    protectionRankDecision: BRIEFING_PROTECTION_RANK_NONE,
  };
}

/** The live config (env-overridable via config/briefingConfig.ts). */
export function briefingConfig(): BriefingConfig {
  return {
    maxChars: READ_BRIEFING_MAX_CHARS(),
    conventionTags: READ_BRIEFING_CONVENTION_TAGS(),
    openTaskStatuses: READ_BRIEFING_OPEN_TASK_STATUSES(),
    sectionMaxRecords: READ_BRIEFING_SECTION_MAX_RECORDS(),
    deadEndReservedChars: READ_BRIEFING_DEADEND_RESERVED_CHARS(),
    deadEndTags: READ_BRIEFING_DEADEND_TAGS(),
    excludedTaskTags: READ_BRIEFING_EXCLUDED_TASK_TAGS(),
    branchReservedChars: READ_BRIEFING_BRANCH_RESERVED_CHARS(),
    alwaysSurfaceTaskStatuses: READ_BRIEFING_ALWAYS_SURFACE_TASK_STATUSES(),
    branchScopeEnabled: READ_BRIEFING_BRANCH_SCOPE_ENABLED(),
    protectionRankBranchMember: READ_BRIEFING_PROTECTION_RANK_BRANCH_MEMBER(),
    protectionRankAlwaysSurface: READ_BRIEFING_PROTECTION_RANK_ALWAYS_SURFACE(),
    protectionRankConvention: READ_BRIEFING_PROTECTION_RANK_CONVENTION(),
    protectionRankDecision: READ_BRIEFING_PROTECTION_RANK_DECISION(),
    protectionRankStalePriority: READ_BRIEFING_PROTECTION_RANK_STALE_PRIORITY(),
    protectionRankPriority: READ_BRIEFING_PROTECTION_RANK_PRIORITY(),
    protectedTaskPriorities: READ_BRIEFING_PROTECTED_TASK_PRIORITIES(),
    staleTaskDays: READ_BRIEFING_STALE_TASK_DAYS(),
    backfillEnabled: READ_BRIEFING_BACKFILL_ENABLED(),
    handoffStampEnabled: READ_BRIEFING_HANDOFF_STAMP_ENABLED(),
    handoffStampFormat: READ_BRIEFING_HANDOFF_STAMP_FORMAT(),
    handoffStampDeletedLabel: READ_BRIEFING_HANDOFF_STAMP_DELETED_LABEL(),
    recordingDirectiveEnabled: READ_BRIEFING_RECORDING_DIRECTIVE_ENABLED(),
    recordingDirective: READ_BRIEFING_RECORDING_DIRECTIVE(),
    handoffHeadMaxHops: READ_HANDOFF_HEAD_MAX_HOPS(),
    handoffHeadCandidateHeadlineChars: READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS(),
    handoffHeadRefusalRemedy: READ_HANDOFF_HEAD_REFUSAL_REMEDY(),
    waitingSectionEnabled: READ_WAITING_SECTION_ENABLED(),
    waitingReservedChars: READ_WAITING_RESERVED_CHARS(),
    waitingMaxRecords: READ_WAITING_MAX_RECORDS(),
    waitingFallbackCaveat: READ_WAITING_FALLBACK_CAVEAT(),
    waitingDueHintCaveat: READ_WAITING_DUE_HINT_CAVEAT(),
    altitudeEnabled: READ_BRIEFING_ALTITUDE_ENABLED(),
    selectMaxTasks: READ_BRIEFING_SELECT_MAX_TASKS(),
    selectMaxDecisions: READ_BRIEFING_SELECT_MAX_DECISIONS(),
    selectMaxConventions: READ_BRIEFING_SELECT_MAX_CONVENTIONS(),
    selectMaxDeadEnds: READ_BRIEFING_SELECT_MAX_DEAD_ENDS(),
    selectMaxBranchMembers: READ_BRIEFING_SELECT_MAX_BRANCH_MEMBERS(),
    fullProseSlots: READ_BRIEFING_FULL_PROSE_SLOTS(),
    fullProseTypes: READ_BRIEFING_FULL_PROSE_TYPES(),
    fullProseMaxChars: READ_BRIEFING_FULL_PROSE_MAX_CHARS(),
    fullProseExcludeTags: READ_BRIEFING_FULL_PROSE_EXCLUDE_TAGS(),
  };
}

/**
 * THE P5.1 FLAG'S ONE CHOKE POINT, and it is the SAME move applySelectionFlag makes: with
 * `altitudeEnabled` false, every quota collapses to unbounded and the full-prose slot count
 * collapses to unbounded too — so EVERY record is selected and EVERY record renders at full
 * altitude, which is pre-P5.1 byte for byte.
 *
 * WHY COLLAPSED CONFIG RATHER THAN AN `if`. An OFF path written as a second branch is a
 * second renderer that has to be kept in step with the ON one, and the first divergence is
 * invisible because nothing exercises OFF on a normal day. Reading the same code with empty
 * vocabularies and unbounded counts cannot drift from itself.
 *
 * Applied at BOTH exported entry points that consume a config (renderBriefing and, through
 * it, buildProjectBriefing) for the reason applySelectionFlag documents: a caller reaching an
 * exported function directly with a hand-built config must not be able to obtain the
 * behaviour from a flag-off deployment.
 */
export function applyAltitudeFlag(config: BriefingConfig): BriefingConfig {
  if (config.altitudeEnabled) return config;
  return {
    ...config,
    selectMaxTasks: BRIEFING_QUOTA_UNBOUNDED,
    selectMaxDecisions: BRIEFING_QUOTA_UNBOUNDED,
    selectMaxConventions: BRIEFING_QUOTA_UNBOUNDED,
    selectMaxDeadEnds: BRIEFING_QUOTA_UNBOUNDED,
    selectMaxBranchMembers: BRIEFING_QUOTA_UNBOUNDED,
    fullProseSlots: BRIEFING_QUOTA_UNBOUNDED,
    // THE GATE COLLAPSES TOO, and this is not belt-and-braces — it is required for
    // byte-identity. With unbounded slots but the shipped `task,decision` type list, every
    // CONVENTION would consume a slot and render a DENIAL line, so the OFF document would
    // differ from pre-P5.1 by one line per convention. Collapsing the vocabulary to "all
    // three kinds, no exclusions, no bound" is what makes OFF mean OFF.
    fullProseTypes: BRIEFING_FULL_PROSE_ALL_KINDS,
    fullProseExcludeTags: [],
    fullProseMaxChars: BRIEFING_QUOTA_UNBOUNDED,
  };
}

export interface BriefingRender {
  markdown: string;
  /** Whole records dropped to honor the size cap (never truncated). */
  droppedRecords: number;
  /** Included counts per section, post-drop. */
  included: {
    tasks: number;
    decisions: number;
    conventions: number;
    deadEnds: number;
    branchMembers: number;
    /** Rows served by the "Waiting on a human" section (P5.5). 0 when it is switched off. */
    waiting: number;
  };
  /**
   * The spine the selection was scoped to, or null (trunk / unpositioned). Reported so a
   * caller can assert WHICH branch produced this render rather than inferring it from prose.
   */
  spineId: string | null;

  /**
   * THE TWO KINDS OF ABSENCE, REPORTED SEPARATELY (P5.1, acceptance §8.2). `droppedRecords`
   * above is their SUM and is kept unchanged for callers that already read it.
   *
   * They are different facts and the difference is the whole point of this item:
   *   - `excludedBySelection` — a STATED RULE chose against the record. Legitimate, and the
   *     rule is named with a count, in `byRule` and in the section's own heading.
   *   - `evictedByCap` — the BUDGET ran out. Nobody chose; the record is simply lost. THIS
   *     IS THE NUMBER THAT MUST GO TO ~0, and a briefing where it does not is a briefing
   *     whose content is still being decided by its size.
   *
   * `byRule` keys on config/briefingAltitudeConfig.ts's SELECTION_RULE values, so a rule
   * cannot be reported under a name the code does not use.
   */
  excludedBySelection: { total: number; byRule: Record<string, number> };
  /**
   * Records lost to a BUDGET rather than to a rule — the global char cap AND the two
   * reserved sub-budgets (dead ends, branch members). All three are budgets; separating them
   * from each other here would suggest one of them is a choice, and none of them is.
   */
  evictedByCap: number;
  /**
   * How many full-prose slots were spent, and how many of those spends were DENIALS (the
   * record consumed its slot and rendered a reason instead of a body). A field, so a caller
   * can tell "no slots were denied" from "the renderer stopped emitting denials".
   */
  fullProse: { slots: number; granted: number; denied: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// GATHER — the queries (all project-scoped, all bounded)
// ─────────────────────────────────────────────────────────────────────────────

const short = (id: string): string => id.slice(0, 8);

/**
 * The tags of `tags` that match a configured vocabulary — the TS twin of the SQL
 * `tag = ANY(vocab) OR tag LIKE ANY(vocab || ':%')` predicate the tag queries use.
 * Order follows the record's own tag order, so the rendered line is deterministic.
 */
function matchedTags(tags: readonly string[], vocab: readonly string[]): string[] {
  return tags.filter((t) => vocab.some((v) => t === v || t.startsWith(`${v}:`)));
}

/**
 * Gather everything the renderer needs for one project. Bounded: each list section
 * fetches at most `sectionMaxRecords` newest rows; the size cap then drops from those.
 */
export async function gatherBriefingData(
  projectId: string,
  projectName: string,
  config: BriefingConfig = briefingConfig(),
  pool: Pool = db,
  /** The reader's open branch ROOT (branch_positions.spine_id), or null at trunk. */
  spineId: string | null = null,
): Promise<BriefingData> {
  config = applySelectionFlag(config);
  // FLAG OFF => NO SPINE, whatever the caller passed. The gather is where the branch enters
  // the data at all, so refusing it here is what makes the OFF document byte-identical to
  // pre-SK5 rather than merely looking like it.
  if (!config.branchScopeEnabled) spineId = null;
  const max = config.sectionMaxRecords;

  // 1. WHICH HANDOFF IS LIVE — a CHAIN WALK, from two seeds, that refuses rather than
  //    guessing (P5.2; services/handoffHead.ts carries the whole rationale).
  //
  //    THIS REPLACED A ONE-HOP `NOT EXISTS (… edge_type='supersedes')`. That predicate
  //    asked "does anything point at this row" — unscoped by project, indifferent to
  //    whether the pointer came from an archived record or from a record that is not a
  //    handoff, and with no third state. In a chain with a gap in it, poisoning the true
  //    head made it fall through to a DEAD handoff several generations back.
  //
  //    The resolver NEVER THROWS on graph shape: an unresolvable chain is a typed refusal
  //    carried in the data, because a repairable data condition must not take the whole
  //    briefing down.
  const handoffHead = await resolveHandoffHead(projectId, pool, config.handoffHeadMaxHops);

  //    The head's BODY is fetched separately and only when there IS a head. The resolver
  //    deals in ids and timestamps; the prose belongs to this section. Re-asserting
  //    `project_id` here is redundant with the resolver's own scoping and kept anyway —
  //    this is the query that puts bytes in front of a customer.
  const handoffRow = handoffHead.status === 'resolved'
    ? (
        await pool.query(
          `SELECT id, content, created_at, metadata
             FROM contexts c
            WHERE c.id = $1 AND c.project_id = $2 AND c.archived_at IS NULL`,
          [handoffHead.headId, projectId],
        )
      ).rows[0]
    : undefined;

  // 1b. THE STALENESS OVERLAY. Resolved HERE, not in the renderer, because
  //     it needs the pool and the renderer is a pure function of (data, config, now) — a
  //     property every existing briefing test depends on. The flag is checked at BOTH entry
  //     points (see renderBriefing); with it off this issues NO queries at all, so the OFF
  //     path is not merely equivalent, it is inert.
  const handoffStamps: HandoffStamps = handoffRow && config.handoffStampEnabled
    ? (
        await resolveHandoffStamps(
          handoffRow.content,
          projectId,
          config.handoffStampDeletedLabel,
          pool,
        )
      ).stamps
    // `.warnings` is dropped ON PURPOSE: every warning case already resolves to NO STAMP,
    // which is the safe outcome, and the briefing has no channel to render one into.
    : NO_HANDOFF_STAMPS;

  // 1c. THE CARRIED FIELDS (P5.4) — MODE / PATH / SPINE.
  //
  //     These three lines used to exist ONLY in our shell, recovered by a regex over the
  //     handoff's prose (riverbend/runtime/lib/handoff-fields.sh). Measured against a
  //     FOREIGN project on 2026-08-23 that regex found nothing, because no customer writes
  //     `MODE:` in prose — so the product's most load-bearing section rendered empty for
  //     everyone but us. The FIELD is the fix; the prose read is kept as a FALLBACK because
  //     our own entire corpus, and every already-stored customer handoff, is prose-only.
  //
  //     PURE at this point (no DB): field-vs-prose precedence is decided by
  //     readCarriedFields. Only the SPINE needs the pool, and only to answer "what does
  //     that id name TODAY" — deliberately measured here rather than at write time, so a
  //     renamed or archived spine reads as it actually is instead of as its author left it.
  const carried: CarriedFields = handoffRow
    ? readCarriedFields(
        typeof handoffRow.metadata === 'string'
          ? safeJsonObject(handoffRow.metadata)
          : handoffRow.metadata,
        handoffRow.content,
      )
    : NO_CARRIED_FIELDS;
  const spineResolved: ResolvedSpine | null = carried.spine
    ? await resolveCarriedSpine(carried.spine.ref, projectId, pool)
    : null;

  // 2. Open tasks (statuses from config), full descriptions — MINUS the deliberately-parked
  //    ones (SK5 / an earlier decision). `parked:*` is an honest not-served signal the author
  //    already wrote down; serving it competes for the cap with work that is actually live.
  //    The exclusion is COUNTED in the same predicate it is applied by, so the disclosed
  //    number cannot drift from the filter that produced it — one predicate, two readers.
  const excludedTaskPatterns = config.excludedTaskTags.map((t) => `${t}:%`);
  const taskRows = (
    await pool.query(
      // `tags` joins the projection for P5.1's full-prose gate — the record's own vocabulary,
      // read once here rather than re-queried per slot.
      `SELECT id, title, description, status, priority, tags, metadata, created_at
         FROM tasks
        WHERE project_id = $1 AND archived_at IS NULL AND status = ANY($2)
          AND NOT EXISTS (
                SELECT 1 FROM unnest(tags) tag
                 WHERE tag = ANY($4) OR tag LIKE ANY($5)
              )
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [projectId, config.openTaskStatuses as string[], max,
       config.excludedTaskTags as string[], excludedTaskPatterns],
    )
  ).rows;

  // The excluded population, counted UNBOUNDED (no LIMIT): it is a disclosure, not a
  // rendered list, so it must be a total rather than a fetch-bounded floor.
  const excludedTaskCount: number = (
    await pool.query(
      `SELECT count(*)::int AS n
         FROM tasks
        WHERE project_id = $1 AND archived_at IS NULL AND status = ANY($2)
          AND EXISTS (
                SELECT 1 FROM unnest(tags) tag
                 WHERE tag = ANY($3) OR tag LIKE ANY($4)
              )`,
      [projectId, config.openTaskStatuses as string[],
       config.excludedTaskTags as string[], excludedTaskPatterns],
    )
  ).rows[0].n;

  // 3. LIVE decisions only — the body is current guidance, so it excludes every
  //    rejected-record signal the schema carries (the reviewer R1 T1):
  //      - supersession: status='superseded' OR superseded_by named;
  //      - REFUTATION: outcome_status='failed' — the learning loop measured this
  //        decision as wrong; rendering its rationale as a live WHY is the exact
  //        re-try hazard dead-ends exist to prevent (trust.ts maps failed → 0);
  //      - deprecation: status='deprecated' leaves the body too (ruling: dead-ends
  //        only if it carries a reason; otherwise omitted entirely).
  const decisionRows = (
    await pool.query(
      `SELECT id, title, rationale, decision_type, superseded_by, outcome_status, tags,
              metadata, decision_date AS created_at
         FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL
          AND status NOT IN ('superseded', 'deprecated') AND superseded_by IS NULL
          AND outcome_status IS DISTINCT FROM 'failed'
        ORDER BY decision_date DESC, id DESC
        LIMIT $2`,
      [projectId, max],
    )
  ).rows;

  // 4. Convention/constraint contexts: a tag EQUAL to a configured value or PREFIXED
  //    `<value>:`. Non-superseded only (superseded content is dead-ends-only), and the
  //    handoff type is excluded (the trunk is section 1, not a convention record).
  const likePatterns = config.conventionTags.map((t) => `${t}:%`);
  const conventionRows = (
    await pool.query(
      `SELECT id, content, tags, metadata, created_at
         FROM contexts c
        WHERE c.project_id = $1 AND c.archived_at IS NULL AND c.context_type <> $2
          AND EXISTS (
                SELECT 1 FROM unnest(c.tags) tag
                 WHERE tag = ANY($3) OR tag LIKE ANY($4)
              )
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = c.id AND l.edge_type = 'supersedes')
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $5`,
      [projectId, TRUNK_CONTEXT_TYPE, config.conventionTags as string[], likePatterns, max],
    )
  ).rows;

  // 5a. Dead-end CONTEXTS: live rows with an incoming declared supersedes edge —
  //     EXCLUDING the routine handoff-timeline mints (an old handoff is history, not a
  //     rejected approach; including them would flood dead-ends with every handoff ever).
  const deadContextRows = (
    await pool.query(
      `SELECT d.id, d.content, d.created_at, d.superseded_by_id
         FROM (
           SELECT DISTINCT ON (c.id) c.id, c.content, c.created_at, l.from_id AS superseded_by_id
             FROM contexts c
             JOIN links l ON l.to_id = c.id AND l.edge_type = 'supersedes'
            WHERE c.project_id = $1 AND c.archived_at IS NULL
              AND l.created_by IS DISTINCT FROM $2
            ORDER BY c.id, l.created_at DESC
         ) d
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $3`,
      [projectId, HANDOFF_SUPERSESSION_CREATED_BY, max],
    )
  ).rows;

  // 5b. Dead-end DECISIONS — every rejected-record signal (the reviewer R1 T1):
  //     superseded lifecycle / named supersessor / REFUTED (outcome_status='failed') /
  //     deprecated. The deprecated-without-reason filter happens in TS below, at the
  //     reason computation, so the choice sits next to the chain it modifies.
  const deadDecisionRows = (
    await pool.query(
      `SELECT id, title, superseded_by, superseded_reason, outcome_status, outcome_notes,
              status, rationale, decision_date AS created_at
         FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL
          AND (status IN ('superseded', 'deprecated')
               OR superseded_by IS NOT NULL
               OR outcome_status = 'failed')
        ORDER BY decision_date DESC, id DESC
        LIMIT $2`,
      [projectId, max],
    )
  ).rows;

  // 5c. Dead-end TAGGED CONTEXTS: a context the AUTHOR marked as a rejected approach —
  //     tag EQUAL to a configured value or PREFIXED `<value>:`. Same matching shape as the
  //     convention query above (4), deliberately: one tag-vocabulary mechanism, not two.
  //     WHY this exists (an earlier task part B): 5a/5b only see STRUCTURAL death (a
  //     supersedes edge, a decision lifecycle column). The canonical dead end — four hours
  //     spent proving approach X impossible, written down as a plain `discussion`/`error`
  //     context — carries neither signal and never reached this section at any cap size.
  //     Superseded rows are excluded here so 5a stays the single source for those (no
  //     duplicate lines); the handoff type is excluded (the trunk is section 1).
  const deadEndLikePatterns = config.deadEndTags.map((t) => `${t}:%`);
  const deadTaggedRows = (
    await pool.query(
      `SELECT id, content, tags, created_at
         FROM contexts c
        WHERE c.project_id = $1 AND c.archived_at IS NULL AND c.context_type <> $2
          AND EXISTS (
                SELECT 1 FROM unnest(c.tags) tag
                 WHERE tag = ANY($3) OR tag LIKE ANY($4)
              )
          AND NOT EXISTS (SELECT 1 FROM links l WHERE l.to_id = c.id AND l.edge_type = 'supersedes')
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $5`,
      [projectId, TRUNK_CONTEXT_TYPE, config.deadEndTags as string[], deadEndLikePatterns, max],
    )
  ).rows;

  // 6. THE READER'S BRANCH (SK5). SK2 made membership a STORED FACT, so this is one flat
  //    equality through the `branch_membership` view — deliberately NOT a graph walk (that
  //    was rounds 1/2 of SK2, and both produced confidently wrong member sets; see migration
  //    086). The spine's own type comes from the membership rows' spine_type, so nothing is
  //    inferred here either. A spine with no recorded members yields an empty branch, which
  //    the census reports as a population of zero rather than as "no branch".
  const branchRead = spineId
    ? await readBranchMemberSummaries({ projectId, spineId, limit: max }, pool)
    : null;
  const branch: BriefingBranch | null =
    spineId && branchRead
      ? {
          spineId,
          members: branchRead.members.map((m) => ({
            id: m.id,
            type: m.type,
            headline: m.headline,
            spineSource: m.spineSource,
            createdAt: m.createdAt,
          })),
        }
      : null;

  // Trust: ONE batched pass over every annotated record (WS1's single rendering —
  // explainTrust().signal — is the only spelling used).
  const refs: RecordRef[] = [
    ...(handoffRow ? [{ id: handoffRow.id, type: 'context' as const, createdAt: handoffRow.created_at }] : []),
    ...taskRows.map((r: any) => ({ id: r.id, type: 'task' as const, createdAt: r.created_at })),
    ...decisionRows.map((r: any) => ({
      id: r.id,
      type: 'decision' as const,
      createdAt: r.created_at,
      supersededBy: r.superseded_by,
      ownOutcomeStatus: r.outcome_status,
    })),
    ...conventionRows.map((r: any) => ({ id: r.id, type: 'context' as const, createdAt: r.created_at })),
  ];
  const trusts = await trustForRecords(refs, undefined, pool);
  const signalById = new Map<string, { signal: string; score: number | null }>();
  refs.forEach((ref, i) => {
    const t = trusts[i];
    signalById.set(ref.id, { signal: explainTrust(t).signal, score: t.score });
  });
  // Total by construction: `refs` is built from EXACTLY the rows sig() is called on
  // (handoff/tasks/decisions/conventions), and trustForRecords maps 1:1 (its per-record
  // errors degrade internally, they never drop an entry). No fallback rendering here —
  // a second spelling of the trust signal is the drift WS1 exists to prevent; if the
  // populations ever diverge, fail LOUD in tests rather than fabricate a signal.
  const sig = (id: string): { signal: string; score: number | null } => {
    const s = signalById.get(id);
    if (!s) {
      throw new Error(
        `[projectBriefing] trust signal missing for record ${id} — the trust refs ` +
          `population drifted from the render population (they are built from the same rows)`,
      );
    }
    return s;
  };

  const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim().length > 0) ?? '').trim();

  // THE CENSUS. `fetched` is the length of what the query returned, read from the SAME array
  // the render consumes — not a re-derived number that can disagree with it. The fetch bound
  // is reported as reached iff the row count hit the LIMIT, which is the only observation
  // available without a second unbounded COUNT per section; it is therefore stated as a
  // FLOOR ("N+") and never as a total.
  const censusFor = (rowCount: number, excluded = 0, excludedReason: string | null = null): SectionCensus => ({
    fetched: rowCount,
    fetchBoundReached: rowCount >= max,
    excluded,
    excludedReason,
  });
  const deadEndList: BriefingDeadEnd[] = [
      ...deadDecisionRows.flatMap((r: any) => {
        const trimmed = (v: unknown): string | null => {
          const s = v == null ? '' : String(v).trim();
          return s.length > 0 ? s : null;
        };
        const notes = trimmed(r.outcome_notes);
        const supReason = trimmed(r.superseded_reason);
        let reason: string | null;
        // The basis is set on the SAME branch that computes the reason — one decision,
        // not two that can drift into labelling a record something the reason contradicts.
        let basis: DeadEndBasis;
        if (r.outcome_status === 'failed') {
          // REFUTED (ranked first — "why it failed" beats "what replaced it"):
          // chain outcome_notes → superseded_reason → rationale, first non-empty
          // (rationale is NOT NULL by schema, so a failed decision always renders).
          basis = 'refuted';
          reason = notes ?? supReason ?? trimmed(r.rationale);
        } else if (r.status === 'superseded' || r.superseded_by !== null) {
          basis = 'superseded';
          reason =
            supReason ??
            (r.superseded_by ? `superseded by decision ${short(r.superseded_by)}` : 'marked superseded');
        } else {
          basis = 'deprecated';
          // DEPRECATED, not failed/superseded (ruling, R1): a dead-end line needs a
          // recorded rejection reason — outcome_notes or superseded_reason. The
          // rationale deliberately does NOT count here: it is the live WHY (and
          // NOT NULL by schema, so it would make every deprecated decision render);
          // deprecated-without-reason is history, not a rejected approach → omit.
          reason = notes ?? supReason;
        }
        if (reason === null) return [];
        return [
          {
            id: r.id,
            kind: 'decision' as const,
            basis,
            headline: r.title,
            reason,
            createdAt: r.created_at,
          },
        ];
      }),
      ...deadContextRows.map((r: any) => ({
        id: r.id,
        kind: 'context' as const,
        basis: 'superseded' as const,
        headline: firstLine(r.content),
        reason: `superseded by ${short(r.superseded_by_id)}`,
        createdAt: r.created_at,
      })),
      // 5c rows. The reason states the SIGNAL that put the record here (the matched tags),
      // exactly as the 5a line states "superseded by <id>" — the section is one-liners, so
      // the headline carries the meaning and the id carries the reader to the full record.
      // No "why it failed" is fabricated from the body: nothing in the schema promises the
      // second line is a reason, and a made-up because is worse than an honest pointer.
      ...deadTaggedRows.map((r: any) => ({
        id: r.id,
        kind: 'context' as const,
        basis: 'recorded' as const,
        headline: firstLine(r.content),
        reason: `recorded as a dead end [tags: ${matchedTags(r.tags ?? [], config.deadEndTags).join(',')}]`,
        createdAt: r.created_at,
      })),
    ].sort(
      // Newest first, id as the deterministic tiebreak (mirrors the section queries).
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
  );

  // 6. WAITING ON A HUMAN (P5.5). LAST, and deliberately so: it is the only section whose
  //    read depends on a SCHEMA CAPABILITY rather than on data, and the whole briefing must
  //    survive an instance that has not had migration 093 applied. gatherWaitingOnHuman
  //    probes information_schema before it builds any SQL naming the new columns, so on a
  //    pre-093 database this issues no statement that could fail. See SCOPE §8.6.
  //    OFF (MANDREL_BRIEFING_WAITING_ENABLED=false) => null => no section at all, and no
  //    queries: the OFF path is inert, not merely equivalent.
  const waiting = config.waitingSectionEnabled
    ? await gatherWaitingOnHuman(projectId, config.openTaskStatuses, pool)
    : null;

  return {
    projectId,
    projectName,
    branch,
    waiting,
    census: {
      tasks: censusFor(
        taskRows.length,
        excludedTaskCount,
        excludedTaskCount > 0
          ? `deliberately parked (tags: ${config.excludedTaskTags.join(',')}, ` +
            `MANDREL_BRIEFING_EXCLUDED_TASK_TAGS)`
          : null,
      ),
      decisions: censusFor(decisionRows.length),
      conventions: censusFor(conventionRows.length),
      // The dead-ends population is assembled from THREE bounded queries, so the bound is
      // reached if ANY of them filled — the merged total is a floor whenever one is.
      deadEnds: {
        fetched: deadEndList.length,
        fetchBoundReached:
          deadDecisionRows.length >= max ||
          deadContextRows.length >= max ||
          deadTaggedRows.length >= max,
        excluded: 0,
        excludedReason: null,
      },
      branchMembers: branchRead
        ? censusFor(branchRead.members.length)
        : EMPTY_CENSUS,
    },
    // THE RESOLUTION ITSELF, ALWAYS — resolved, refused or absent. REQUIRED, never
    // optional and never defaulted, for the same reason `census` is (an earlier decision
    // RULING 4): the renderer must not be able to fall back to a silent default, and a
    // caller must be able to tell "resolved" from "refused" from a FIELD.
    handoffHead,
    handoff: handoffRow
      ? {
          id: handoffRow.id,
          // AS STORED. The stamps ride alongside; nothing here rewrites the archive.
          content: handoffRow.content,
          createdAt: handoffRow.created_at,
          trustSignal: sig(handoffRow.id).signal,
          stamps: handoffStamps,
          carried,
          spineResolved,
        }
      : null,
    tasks: taskRows.map((r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      createdAt: r.created_at,
      trustSignal: sig(r.id).signal,
      trustScore: sig(r.id).score,
      tags: r.tags ?? [],
      metadata: r.metadata ?? null,
    })),
    decisions: decisionRows.map((r: any) => ({
      id: r.id,
      title: r.title,
      rationale: r.rationale,
      decisionType: r.decision_type,
      createdAt: r.created_at,
      trustSignal: sig(r.id).signal,
      trustScore: sig(r.id).score,
      tags: r.tags ?? [],
      metadata: r.metadata ?? null,
    })),
    conventions: conventionRows.map((r: any) => ({
      id: r.id,
      content: r.content,
      tags: r.tags ?? [],
      createdAt: r.created_at,
      trustSignal: sig(r.id).signal,
      trustScore: sig(r.id).score,
      metadata: r.metadata ?? null,
    })),
    deadEnds: deadEndList,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — pure over (data, config)
// ─────────────────────────────────────────────────────────────────────────────

/** Indent every line of a (possibly multi-line) body under its list item. Never truncates. */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

/**
 * One droppable unit: a whole record's rendered block + its drop-ordering key.
 *
 * Dead-ends are NOT droppables. They are bounded by their own reserved sub-budget
 * (config.deadEndReservedChars) and never enter this pool — see fitDeadEndsToBudget().
 */
interface Droppable {
  section: 'tasks' | 'decisions' | 'conventions';
  /** Which of the three full-prose-eligible kinds this record is (BRIEFING_FULL_PROSE_TYPES). */
  kind: 'task' | 'decision' | 'convention';
  /** The record's own tags — read by the full-prose gate; never used for selection. */
  tags: readonly string[];
  id: string;
  createdAt: Date;
  /** Drop order key: least-trusted first (null/unscored counts as least). */
  trustScore: number | null;
  /**
   * THE PROTECTION LADDER — the band this record sits in, evicted in ASCENDING order, so a
   * higher rank is evicted LATER. Every value comes from config (briefingConfig.ts's
   * BRIEFING_PROTECTION_RANK_* knobs plus BRIEFING_PROTECTION_RANK_NONE); this file writes no
   * rank literal.
   *
   * The bands answer one question in degrees: how badly does a returning session need to see
   * this record if only a handful can fit? Branch members (the reader's declared position) >
   * always-surface statuses (blocked work) and conventions (standing constraints), which share
   * a band by default > stale high-priority work (the forgotten band) > fresh high-priority
   * work > everything else.
   *
   * Protection is a DROP ORDER, not an exemption: a protected record still enters the pool,
   * so the cap is still honored and `overCap` still reports honestly. That is exactly what
   * "the cap becomes the backstop" means — it stops being the primary selector without
   * stopping being a bound.
   */
  protectionRank: number;
}

/**
 * THE ONE ORDER — weakest first, i.e. the order the cap evicts in:
 *   (protectionRank asc) → (trustScore asc, nulls first) → (createdAt asc) → (id asc).
 *
 * EXTRACTED FROM THE CAP LOOP BY P5.1, unchanged, because the SELECTION RULE now reads the
 * same order BEST-first and two spellings of one ranking is two things to keep in step. That
 * is also the argument for the selection rule itself: it is not a new ranking, it is this one
 * promoted from a tiebreak to a stated rule (config/briefingAltitudeConfig.ts).
 *
 * A TOTAL order — the id tiebreak makes it one — so reversing it is deterministic and
 * `selectBest` can simply read it backwards rather than needing its own comparator.
 */
function dropOrder(a: Droppable, b: Droppable): number {
  if (a.protectionRank !== b.protectionRank) return a.protectionRank - b.protectionRank;
  const sa = a.trustScore ?? -1;
  const sb = b.trustScore ?? -1;
  if (sa !== sb) return sa - sb;
  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * THE SELECTION RULE, applied to one section: keep the `quota` best-ranked records, where
 * "best" is `dropOrder` read backwards — the records the cap would have evicted LAST.
 *
 * Returns the KEPT ids as a set, because the section renders in its own order (newest first)
 * and membership is what the render filters on. The excluded count is `pool.length - kept`,
 * derived by the caller from the same two numbers the heading prints, so a disclosed count
 * cannot drift from the filter that produced it.
 *
 * QUOTA 0 IS A LEGITIMATE VALUE — "serve none of this section" — and it is how this rule is
 * falsified from the outside with no code edit. QUOTA UNBOUNDED is what the flag-off path
 * collapses to, and it makes this function the identity.
 */
function selectBest(pool: readonly Droppable[], quota: number): Set<string> {
  return new Set(
    [...pool].sort((a, b) => dropOrder(b, a)).slice(0, quota).map((d) => d.id),
  );
}

/**
 * FULL ALTITUDE — the record's head line plus its whole body, bounded by
 * `maxChars` (P5.1). These three are byte-for-byte the pre-P5.1 renderers with the bound
 * added; that is what makes the flag-off path byte-identical, since the OFF config collapses
 * `maxChars` to unbounded and boundFullProse becomes the identity.
 */
/**
 * THE BODY of each full-prose record — ONE definition, read by the renderer AND by the
 * truncation count in the footer. Two spellings of "what the body is" would let the footer
 * report a different number of truncations than the document performed, which is the
 * count-that-disagrees-with-its-own-filter defect the census exists to prevent.
 */
const taskBody = (t: BriefingTask): string =>
  t.description && t.description.trim().length > 0 ? t.description : '';
const decisionBody = (d: BriefingDecision): string => `why: ${d.rationale}`;
const conventionBody = (c: BriefingConvention): string => c.content;

function renderTaskFull(t: BriefingTask, maxChars: number): string {
  const head = `- ${t.title} [status:${t.status}] [priority:${t.priority}] [id:${short(t.id)}${structuredStamps(t.metadata)}] [${t.trustSignal}]`;
  const body = taskBody(t);
  return body.length > 0 ? `${head}\n${indentBlock(boundFullProse(body, maxChars))}` : head;
}

function renderDecisionFull(d: BriefingDecision, maxChars: number): string {
  return `- ${d.title} [id:${short(d.id)}${structuredStamps(d.metadata)}] [${d.trustSignal}]\n${indentBlock(boundFullProse(decisionBody(d), maxChars))}`;
}

function renderConventionFull(c: BriefingConvention, maxChars: number): string {
  return `- [id:${short(c.id)}${structuredStamps(c.metadata)}] [tags:${c.tags.join(',')}] [${c.trustSignal}]\n${indentBlock(boundFullProse(conventionBody(c), maxChars))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// P5.1 — THE TWO RENDER ALTITUDES
//
// ★ BOTH ALTITUDES CARRY THE STRUCTURED STAMPS. Wiring only `shapeLine`
// would have left the fact missing from exactly the records a reader is MOST likely to act
// on: a full-prose slot goes to the TOP-RANKED records, so the shape-only version renders
// the gate code for every task except the three that matter most. Found by the detector
// rather than by reading — the briefing case in gateExitCodeRendered.contract.test.ts went
// RED on a task that had been granted a slot, which is the whole reason a detector asserts
// the DOCUMENT and not one function's return value.
//
// SHAPE is the default for everything: one line — when · type · id · title. FULL is a
// reserved slot: the record's whole head line plus its body, bounded by
// BRIEFING_FULL_PROSE_MAX_CHARS. See config/briefingAltitudeConfig.ts for why both exist and
// for the arithmetic that says shape-everything does not fit either.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONE SHAPE-LINE GRAMMAR — spelled here and nowhere else, for all four record kinds.
 *
 * WHEN comes first because it is the cheapest orientation in the document and the one a
 * returning reader scans for. The date is rendered as a DATE, not a timestamp: the time of
 * day costs 9 chars a line — 3700 chars across a 416-record population, a sixth of the whole
 * cap — and no reader of an index has ever needed it.
 *
 * THE TITLE IS NEVER TRUNCATED. That is deliberate and it is the line this feature was most
 * likely to cross: squeezing titles is how you make an impossible budget appear to fit while
 * silently degrading every entry. The budget is met by the SELECTION RULE choosing fewer
 * records, which is a decision a reader can see and a knob they can turn — not by quietly
 * making each record worse.
 */
function shapeLine(
  when: Date,
  type: string,
  id: string,
  title: string,
  metadata: unknown
): string {
  return `- [${when.toISOString().slice(0, 10)}] [${type}:${short(id)}${structuredStamps(metadata)}] ${title}`;
}

/**
 * THE STRUCTURED-FACT STAMPS, rendered inside the id bracket for all four record kinds.
 *
 * WHY THIS IS IN shapeLine AND NOT IN THE THREE CALLERS (guard class
 * `renderer-drops-structured-fact`, sibling d836f757): this function's own
 * header calls itself "THE ONE SHAPE-LINE GRAMMAR — spelled here and nowhere else, for all
 * four record kinds". A fact added per-caller is a fact three callers can each forget, which
 * is how the class recurs. One place, every population, present and future.
 *
 * THE DEFECT MEASURED, 2026-09-03: the recall renderers were fixed to carry the review call
 * (d836f757) and the gate's exit code (252200e1), and the OTHER half of the same boot package
 * — this briefing — rendered neither, for any record kind, because no Briefing* record type
 * carried `metadata` at all. The fact was not dropped at the render; it was never gathered.
 * Same reader outcome, one layer earlier: the fact is on the record and absent from the
 * document a cold session acts on.
 *
 * ★ POPULATION, MEASURED BEFORE BUILDING, because "add the stamp everywhere" needed to be
 * justified rather than assumed (prod, 2026-09-03):
 *     97 contexts and 5 tasks carry metadata.gate or metadata.verdict; 0 decisions do.
 *   Of the four populations THIS briefing renders, the count carrying the fact TODAY is ZERO:
 *     - open tasks     — the 5 carriers are all `completed`, outside openTaskStatuses
 *     - decisions      — 0 of 167
 *     - conventions    — 0 (there is exactly 1 convention in the project)
 *     - dead ends      — 0 of 4 fleet-wide
 * That zero is ACCIDENTAL, NOT STRUCTURAL, and the distinction is the whole argument: a task
 * in `in_progress` carrying a gate block renders here tomorrow, and five tasks prove the
 * shape is one people actually write. Commands are in the run report.
 *
 * IT COSTS NOTHING WHEN THE FACT IS ABSENT — the empty string, so a record with no metadata
 * renders byte-for-byte what it rendered before. That matters here more than on the recall
 * lines: this document is size-capped and MEASURED SATURATED (23,922 of 24,000 chars, 364
 * records dropped), so a field that cost every line would evict records to say nothing.
 */
function structuredStamps(metadata: unknown): string {
  // Read through the SAME two derivations the recall renderers use — never a second parser.
  // A briefing that read `metadata.gate` its own way is how the two halves of one boot
  // package start disagreeing about the same record.
  const verdict = reviewOutcomeOf(metadata);
  const gate = gateOutcomeOf(metadata);
  return (
    (verdict === null ? '' : ` ${REVIEW_OUTCOME_LABEL}:${verdict}`) +
    (gate === null ? '' : ` ${GATE_RC_LABEL}:${gate}`)
  );
}

function renderTaskShape(t: BriefingTask): string {
  // Status and priority ride along on a task's shape line because they are the two fields a
  // reader picks work by, and they are ~24 chars against a 155-char measured mean.
  return `${shapeLine(t.createdAt, 'task', t.id, t.title, t.metadata)} [status:${t.status}] [priority:${t.priority}]`;
}

function renderDecisionShape(d: BriefingDecision): string {
  return shapeLine(d.createdAt, 'decision', d.id, d.title, d.metadata);
}

function renderConventionShape(c: BriefingConvention): string {
  // A convention has no title column, so its headline is its first non-empty content line —
  // the same firstLine() rule the dead-ends intake uses for a context.
  const headline = (c.content.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return shapeLine(c.createdAt, 'context', c.id, headline, c.metadata);
}

/**
 * Bound one full-prose body, saying so ON THE LINE WHERE IT HAPPENS.
 *
 * The document's standing rule is "a record is complete or absent", and it still governs the
 * shape tier. A full-prose slot is the one licensed exception (config/briefingAltitudeConfig
 * .ts) — and an exception the reader cannot see is indistinguishable from a record that was
 * simply short, so the marker is not decoration. It states the knob, so the reader who wants
 * the rest knows what to turn as well as where to look.
 */
function boundFullProse(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n[…truncated at ${maxChars} chars (MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS) — the whole record is at id above]`;
}

/**
 * A record that CONSUMED a full-prose slot and was refused one — rendered IN-BAND, under its
 * own shape line.
 *
 * A SLOT IS NEVER REASSIGNED (config/briefingAltitudeConfig.ts). If a denial silently handed
 * the slot to the next record in line, the document's full-prose content would be decided by
 * the GATE rather than by the RANKING, and no reader would ever see that it happened — which
 * is the same class of silence as a cap that empties a section without saying which one.
 */
function renderSlotDenial(slotIndex: number, reason: FullProseDenial, detail: string): string {
  return `  [full-prose slot ${slotIndex + 1} DENIED: ${reason}${detail}] — rendered as shape; the slot is not reassigned`;
}

/**
 * A branch member as ONE line: kind, id, headline. No trust signal and no body — this
 * section is an INDEX of the branch the reader is resuming, and the records that also have
 * a body section render it there. A member whose headline could not be resolved says so
 * rather than rendering a blank (the record is still a member; see resolveMemberTitles).
 */
function renderBranchMember(m: BriefingBranchMember): string {
  // The marker is emitted FROM THE FIELD and only for the rows whose branch was derived —
  // a TRUSTED row (APPROXIMATE_SOURCES says which are not) is a fact and needs no caveat. The section's note states the convention
  // and the count whenever any approximate row is present, so an absent marker is never left
  // to be read as either "recorded" or "the renderer forgot".
  const approx = APPROXIMATE_SOURCES.has(m.spineSource) ? ` [spine-source:${m.spineSource}]` : '';
  return `- [${m.type}:${short(m.id)}]${approx} ${m.headline ?? '(no title available)'}`;
}

/**
 * The line label per intake basis — the SINGLE place the section's user-visible claim is
 * spelled. Each one states only what the admitting signal actually establishes:
 * `outcome_status='failed'` is the only basis that licenses "rejected"; a successor edge
 * establishes replacement and nothing about merit; a dead-end tag is the author's own
 * declaration. The old single prefix asserted rejection for all four.
 */
const DEAD_END_LABEL: Record<DeadEndBasis, string> = {
  refuted: 'tried and rejected',
  superseded: 'superseded',
  deprecated: 'deprecated',
  recorded: 'recorded dead end',
};

function renderDeadEnd(e: BriefingDeadEnd): string {
  // No "because": the reason is a cause only on the refuted/deprecated branches. On the
  // other two it is the signal itself ("superseded by 84ea8af0"), and "because superseded
  // by X" after a "superseded:" label is both redundant and reads as a justification the
  // record does not carry.
  return `- ${DEAD_END_LABEL[e.basis]}: ${e.headline} — ${e.reason} [${e.kind}:${short(e.id)}]`;
}

/**
 * A RESERVED-BUDGET BOUNDARY (an earlier task for dead-ends; SK5 reuses it for the branch
 * section). Returns the ids that fit inside the reserved sub-budget, walking `items` in
 * their incoming order and stopping at the budget — so what gets dropped is whatever sorts
 * LAST past the budget (oldest, for both of today's callers).
 *
 * This is the whole fix, and it is a BOUNDARY rather than a policy on purpose. Dead-ends
 * previously joined the global drop pool with a hardcoded `trustScore: null`, which the
 * pool's comparator floors to -1 while real trust scores live in 0..1 — so a dead-end
 * sorted below EVERY scored record and was evicted first whenever the cap bound. Making
 * dead-ends sort LAST in that pool would fix today's symptom and silently re-break the
 * first time someone re-sorts a shared list; a separate budget makes the bad state
 * unreachable instead of merely unlikely.
 *
 * Cost accounting is the record's own rendered line plus its newline separator; the
 * section header is frame, like every other section header.
 *
 * A record too big for the remaining budget is SKIPPED and the walk continues, rather
 * than ending the walk: a decision dead-end's reason can fall back to a long rationale,
 * and one oversized line must not be able to empty the section — that is the same
 * "one record starves the rest" failure this whole task is about. Still fully
 * deterministic: same input list, same kept set.
 */
function fitToReservedBudget<T extends { id: string }>(
  items: readonly T[],
  budgetChars: number,
  renderOne: (item: T) => string,
): Set<string> {
  const kept = new Set<string>();
  let used = 0;
  for (const e of items) {
    const cost = renderOne(e).length + 1; // + the '\n' that joins it to the section
    if (used + cost > budgetChars) continue; // past the budget: this one stays out
    used += cost;
    kept.add(e.id);
  }
  return kept;
}

/**
 * A SECTION'S HEADING PLUS ITS EPISTEMIC STATUS — the one place the briefing states how much
 * of a section the reader is looking at.
 *
 * The rule this encodes, and the only rule: `none` is an AFFIRMATIVE CLAIM that the
 * population is empty, so it is emitted ONLY when the census says nothing was found and
 * nothing was deliberately excluded. Every other case prints BOTH numbers — served and
 * population — plus a `note:` naming which of the three narrowings applies, because they are
 * different facts and a reader who cannot tell them apart cannot act on any of them:
 *   - the SIZE CAP / a reserved budget dropped what was fetched (`notServedReason`);
 *   - the FETCH BOUND stopped the query, so the population is a FLOOR (`N+`);
 *   - a DELIBERATE exclusion removed rows before selection ever ran.
 */
function renderSectionHeading(
  label: string,
  served: number,
  census: SectionCensus,
  notServedReason: string,
  sectionMaxRecords: number,
  /**
   * P5.1 — THE RECORDS A STATED RULE CHOSE AGAINST, with the rule's own name. Separate from
   * the budget reason above because they are DIFFERENT FACTS: one is a decision the reader
   * can inspect and re-tune, the other is the budget running out. Collapsing them into one
   * `not served` line is what made the pre-P5.1 document unreadable on this axis — it named
   * the cap for absences the cap did not cause, and it named nothing for the ones it did.
   */
  selectionExcluded: { count: number; rule: string } | null = null,
  /** Extra note clauses the SECTION owns (SK5: the branch's approximate-membership caveat). */
  extraNotes: readonly string[] = [],
): string[] {
  const population = census.fetched;
  if (population === 0 && census.excluded === 0 && !census.fetchBoundReached) {
    // THE ONLY LICENSED `none`: the query ran, was ALLOWED TO RUN TO COMPLETION, and
    // genuinely found nothing.
    //
    // `!fetchBoundReached` is load-bearing and was MISSING in the first cut of this function.
    // With the fetch bound at zero, `fetched` is 0 and the population is UNMEASURED — and the
    // renderer emitted the affirmative claim anyway, which is byte-for-byte the defect this
    // whole function exists to delete. Zero-because-nothing-exists and
    // zero-because-nothing-was-sought are the two states C1 says must never share a branch;
    // this is that rule inside a renderer.
    return [`## ${label} (0)`, 'none'];
  }
  // `floor` rides on EVERY number derived from the population, not just the heading: with
  // the fetch bound reached, "193 of 202 not served" would state as exact a figure that is
  // itself a lower bound. Same defect as the one this function exists to fix, one derivation
  // downstream — so the marker travels with the number rather than being explained beside it.
  const floor = census.fetchBoundReached ? '+' : '';
  const lines = [`## ${label} (${served} of ${population}${floor})`];
  const notes: string[] = [];
  // THE TWO ABSENCES, EACH WITH ITS OWN COUNT AND ITS OWN NAME. `notServed` is the total; the
  // selection share is given, so the budget share is what remains. Deriving the budget number
  // rather than passing it is what makes the two counts unable to disagree with the heading
  // or with each other — one subtraction, one source.
  const notServed = population - served;
  const bySelection = selectionExcluded && selectionExcluded.count > 0 ? selectionExcluded.count : 0;
  const byBudget = notServed - bySelection;
  if (bySelection > 0) {
    notes.push(`${bySelection}${floor} of ${population}${floor} not served — ${selectionExcluded!.rule}`);
  }
  if (byBudget > 0) {
    notes.push(`${byBudget}${floor} of ${population}${floor} not served — ${notServedReason}`);
  }
  if (census.fetchBoundReached) {
    notes.push(
      `the population is a FLOOR, not a total: the fetch stopped at ${sectionMaxRecords} ` +
        `(MANDREL_BRIEFING_SECTION_MAX_RECORDS)`,
    );
  }
  if (census.excluded > 0) {
    notes.push(`${census.excluded} excluded before selection — ${census.excludedReason}`);
  }
  notes.push(...extraNotes);
  if (notes.length > 0) lines.push(`note: ${notes.join('; ')}`);
  return lines;
}

/**
 * The `not served` reason for every section that is drained by the GLOBAL char cap. Spelled
 * once: the dead-ends and branch sections are drained by their own reserved budgets instead,
 * and a section that named the wrong narrowing would send the reader to the wrong knob.
 */

/**
 * The hop count to report for a RESOLVED head: the LONGEST of the concurring walks.
 *
 * The recency seed almost always terminates in 0 hops (the newest handoff usually IS the
 * head), so reporting the minimum would print `hops:0` for a resolution whose tag seed
 * walked eight generations — hiding the exact fact this number exists to show.
 */
function maxWalkHops(head: HandoffHeadResolution): number {
  return head.walks.reduce((n, w) => (w.hops !== null && w.hops > n ? w.hops : n), 0);
}

/** One candidate line under a refusal: id, ISO timestamp, and a bounded excerpt. */
/**
 * Cut a string to `max` chars with a trailing ellipsis. The ONE truncation primitive this
 * renderer has, so the two places licensed to truncate cannot drift in their ellipsis or
 * their off-by-one. Never used on a SERVED RECORD — see the two call sites for why each is
 * a label/disambiguator rather than content.
 */
function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderHandoffCandidate(c: HandoffHeadCandidate, excerptChars: number): string {
  // TRUNCATION IS LICENSED HERE, and at the SPINE LABEL (renderCarriedFields) — nowhere
  // else in this renderer. The document's rule is "a record is complete or absent" — but a
  // candidate line is not a served record, it is a DISAMBIGUATOR, and the whole point of
  // the refusal is that none of these is being served. The ellipsis is emitted so a reader
  // never mistakes a cut excerpt for a whole record.
  const shown = excerpt(c.excerpt, excerptChars);
  return `- [id:${short(c.id)}] [${c.createdAt.toISOString()}] ${shown || '(no content)'}`;
}

/**
 * THE AMBIGUOUS-CHAIN SECTION (SCOPE §8.5) — refuse to PICK, never refuse to SPEAK.
 *
 * Three things it must carry, and each is asserted by a fixture rather than trusted to
 * survive an edit: every candidate (id + timestamp), the reason stated plainly, and a
 * remedy the customer can perform through the public tool surface.
 */
/**
 * THE MODE / PATH / SPINE LINES (P5.4) — pure, three lines, always all three.
 *
 * ═══ WHY ALWAYS ALL THREE, INCLUDING "(none recorded)" ══════════════════════════════════
 * Same reasoning handoffStamp.ts's uniform stamping runs on: if a line appeared only when
 * it had a value, the reader would have to infer meaning from ABSENCE, and an absent MODE
 * would be indistinguishable from a MODE this render could not read. Present-and-empty is
 * a MEASUREMENT ("nothing was declared and nothing was parseable"); missing is ambiguous.
 *
 * ═══ WHY THE SOURCE IS ON EVERY LINE ════════════════════════════════════════════════════
 * `[source: field]` vs `[source: prose]` is the difference between a value the author
 * DECLARED through a typed parameter and a value a regex INFERRED from a sentence. The
 * precedence between them (field wins — see handoffCarriedFields.ts) is only defensible if
 * the reader can see which one they got; a silent precedence is folklore.
 *
 * ═══ WHY `PATH` AND `SPINE` ARE TWO LINES AND NOT ONE ═══════════════════════════════════
 * Our shell rendered one `PATH:` line carrying both a human narrative AND, sometimes, a
 * `(spine <id8>)` clause a machine could act on. Those are two different objects. The PATH
 * is a sentence a person wrote and has NO field equivalent — there is no structured input
 * that could produce it, and manufacturing one from a spine id would fabricate prose the
 * author never wrote, which is the exact failure P5.4 exists to remove. The SPINE is an id
 * a reader can `branch_open`. So: PATH renders from prose or not at all; SPINE renders
 * from the field, else from the prose PATH's clause, and states what it resolves to TODAY.
 */
function renderCarriedFields(handoff: BriefingHandoff): string[] {
  const src = (source: string): string => CARRIED_FIELDS_SOURCE_FORMAT.replace('%s', source);
  const out: string[] = [];

  out.push(
    handoff.carried.mode
      ? `${CARRIED_FIELDS_MODE_LABEL}: ${handoff.carried.mode.value}${src(handoff.carried.mode.source)}`
      : `${CARRIED_FIELDS_MODE_LABEL}: ${CARRIED_FIELDS_NONE_RECORDED}`,
  );

  out.push(
    handoff.carried.path
      ? `${CARRIED_FIELDS_PATH_LABEL}: ${handoff.carried.path.value}${src(handoff.carried.path.source)}`
      : `${CARRIED_FIELDS_PATH_LABEL}: ${CARRIED_FIELDS_NONE_RECORDED}`,
  );

  if (!handoff.carried.spine) {
    out.push(`${CARRIED_FIELDS_SPINE_LABEL}: ${CARRIED_FIELDS_NONE_RECORDED}`);
    return out;
  }
  // THE KIND IS THE MEASURED ONE WHEN WE HAVE IT. `spineResolved.kind` is what the record
  // IS; `carried.spine.kind` is only what the source CLAIMED (the field claims nothing at
  // all and carries the unknown-kind word). Preferring the measurement means a prose line
  // that mislabels its own spine renders the truth rather than the label.
  const kind = handoff.spineResolved?.kind ?? handoff.carried.spine.kind;
  const tail = handoff.spineResolved
    // Truncation is licensed here for the same reason renderHandoffCandidate licenses it:
    // this is a LABEL ON A REFERENCE, not a served record. A context spine's "title" is its
    // type plus its body, which is unbounded — and these chars land in the one section the
    // size cap cannot trim. The ellipsis is emitted so a cut label never reads as a whole one.
    ? ` — ${excerpt(handoff.spineResolved.title, CARRIED_FIELDS_SPINE_TITLE_CHARS)}`
    // An unresolvable spine is a FACT worth telling: the reader's `branch_open` will fail,
    // and saying so beats dropping the line (the `[now: deleted]` reasoning).
    : ` — ${CARRIED_FIELDS_SPINE_UNRESOLVED}`;
  out.push(
    `${CARRIED_FIELDS_SPINE_LABEL}: ${kind} ${handoff.carried.spine.ref}${tail}` +
      src(handoff.carried.spine.source),
  );
  return out;
}

function renderHandoffRefusal(head: HandoffHeadResolution, config: BriefingConfig): string[] {
  const reason = head.refusal as keyof typeof HANDOFF_HEAD_REFUSAL_EXPLANATION;
  const lines: string[] = [];
  lines.push(
    `[head:AMBIGUOUS] [reason:${reason}] [candidates:${head.candidates.length}] ` +
      `[seeds:${head.walks.map((w) => `${w.seed}=${w.seedId ? short(w.seedId) : 'none'}`).join(',')}]`,
  );
  lines.push('');
  lines.push(
    'NO HANDOFF IS SERVED HERE, and this is deliberate: the declared supersession chain ' +
      'is ambiguous, so serving one of these would be a guess about which one you are ' +
      `resuming. WHY: ${HANDOFF_HEAD_REFUSAL_EXPLANATION[reason]}.`,
  );
  lines.push('');
  lines.push(`Candidate handoffs, newest first (${head.candidates.length}):`);
  for (const c of head.candidates) {
    lines.push(renderHandoffCandidate(c, config.handoffHeadCandidateHeadlineChars));
  }
  lines.push('');
  // The remedy is substituted with the two NEWEST candidate ids so it is copy-pasteable.
  // Full ids, not the 8-char display form: this is a command, and a truncated id is not one.
  const newer = head.candidates[0]?.id ?? '<newer-handoff-id>';
  const older = head.candidates[1]?.id ?? '<older-handoff-id>';
  lines.push(config.handoffHeadRefusalRemedy.replace(/\{newer\}/g, newer).replace(/\{older\}/g, older));
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// "WAITING ON A HUMAN" (P5.5) — the section that selects by WHERE, not by convention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A DEADLINE as a date, in UTC. `due_at` is a `timestamptz`, so its instant is unambiguous;
 * the DAY it is rendered as is not, and this picks UTC and says so in the heading note
 * rather than silently using the server's zone. A briefing is read by machines in unknown
 * locales — a date whose meaning depends on where the renderer happened to run is the same
 * class of defect as the locale-ambiguous prose dates WAITING_DUE_HINT_RE refuses to parse.
 */
function renderDueDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ONE waiting task, one line — and the two deadline tiers are two DIFFERENT MARKERS.
 *
 * `[due:…]` is the `due_at` column: authoritative, and it is what sortWaitingTasks ordered
 * this list by. `[due?:…]` is an ISO date scraped out of the task's own prose: it is not a
 * field, it did not affect the order, and the section's note says it may not be a deadline
 * at all. They are never both emitted for one row — a structured deadline makes the hint
 * redundant, and printing both would invite a reader to compare them as if the disagreement
 * meant something.
 *
 * `[blocked-on:…]` is emitted ONLY from the column. On the fallback paths the row carries no
 * such value and the marker is ABSENT — never `[blocked-on:unknown]`, which would be the
 * renderer asserting a claim no record made (an earlier decision RULING 6).
 */
function renderWaitingTask(t: WaitingTask): string {
  const blockedOn = t.blockedOn ? ` [blocked-on:${t.blockedOn}]` : '';
  const due = t.dueAt
    ? ` [${WAITING_DUE_MARKER}:${renderDueDate(t.dueAt)}]`
    : t.dueHint
      ? ` [${WAITING_DUE_HINT_MARKER}:${t.dueHint}]`
      : '';
  return `- ${t.title} [status:${t.status}] [priority:${t.priority}] [id:${short(t.id)}]` +
    `${blockedOn}${due}`;
}

/**
 * THE SECTION'S EPISTEMIC NOTE — one sentence per `source`, because the five states have
 * five different remedies and a reader who cannot tell them apart cannot act on any of them.
 *
 * This is the whole reason `source` is a field rather than a boolean: "the column says so",
 * "the column says nothing is waiting", "nobody has populated the column", "this database
 * has no such column" and "we could not find out whether it does" are five different things
 * to do next, and four of them are not "read the list below and trust it".
 */
function waitingSourceNotes(w: BriefingWaiting, config: BriefingConfig): string[] {
  switch (w.source) {
    case 'column':
      return [
        `selected by \`WHERE tasks.blocked_on = '${BLOCKED_ON_HUMAN}'\` — a FIELD, not a tag ` +
          `convention. Ordered by the \`due_at\` deadline (soonest first, UTC), then newest`,
      ];
    case 'column-empty':
      return [
        `selected by \`WHERE tasks.blocked_on = '${BLOCKED_ON_HUMAN}'\`; the column IS ` +
          `populated in this project and nothing currently names a human. This zero is a ` +
          `measurement, not an absence of data`,
      ];
    case 'fallback-unpopulated':
      return [
        `INTERIM FALLBACK — \`tasks.blocked_on\` exists here but NO task in this project ` +
          `carries a value, so the question has never been answered. ${config.waitingFallbackCaveat}`,
        ...precisionNote(w),
      ];
    case 'fallback-absent-column':
      return [
        `INTERIM FALLBACK — \`tasks.blocked_on\` does NOT EXIST in this database ` +
          `(migration ${BLOCKED_ON_MIGRATION} has not been applied here). The section still ` +
          `renders rather than failing; apply the migration and it selects exactly. ` +
          `${config.waitingFallbackCaveat}`,
      ];
    case 'fallback-unknown-column':
      return [
        `INTERIM FALLBACK — the schema probe COULD NOT MEASURE whether \`tasks.blocked_on\` ` +
          `exists, which is not the same as knowing it does not` +
          (w.capability.probeError ? ` (${w.capability.probeError})` : '') +
          `. ${config.waitingFallbackCaveat}`,
      ];
  }
}

/**
 * THE READER'S OWN PRECISION, when it is computable — a derived number beats a borrowed one
 * (CLASSES.md C2: state the result no wider than your sample; this states it exactly as
 * wide as the reader's own rows).
 */
function precisionNote(w: BriefingWaiting): string[] {
  if (!w.precision) return [];
  const { fallbackPopulation, trulyHuman } = w.precision;
  if (fallbackPopulation === 0) return [];
  return [
    `measured HERE, on your own rows: ${trulyHuman} of ${fallbackPopulation} tasks matched ` +
      `by this fallback actually carry blocked_on='${BLOCKED_ON_HUMAN}'`,
  ];
}

/**
 * THE DATA-QUALITY FINDING (SCOPE §2 P5.5 item 6) — REPORT the collision, never normalise it.
 *
 * Two tags that differ only in their separators are one concept spelled two ways, and any
 * consumer that picks one spelling sees a fraction of the truth. Folding them silently would
 * hide the defect one layer down and leave the stored rows still split; the surfacing IS the
 * feature. The scanned population is NAMED rather than implied, so a reader knows what the
 * absence of a finding does and does not cover.
 */
function renderWaitingFindings(w: BriefingWaiting): string[] {
  const f = w.findings;
  if (f.scannedPopulation === null || f.collisionGroupsTotal === 0) return [];
  const shown = f.collisions.length;
  const more = f.collisionGroupsTotal > shown
    ? ` (showing ${shown} of ${f.collisionGroupsTotal}; MANDREL_BRIEFING_TAG_COLLISION_MAX_GROUPS)`
    : '';
  const lines = [
    `finding: ${f.collisionGroupsTotal} tag concept(s) are SPELLED MORE THAN ONE WAY in ` +
      `${f.scannedPopulation}${more}. These are stored as distinct tags, so any filter that ` +
      `picks one spelling sees a fraction of the truth. Nothing here has been normalised — ` +
      `re-tag them to one spelling, or the split is permanent:`,
  ];
  for (const c of f.collisions) lines.push(`  - ${c.spellings.join('  ≡  ')}`);
  return lines;
}

const CAP_REASON = 'the size cap (see the omitted line below)';

/**
 * Render the briefing markdown, enforcing the size cap by DROPPING whole records —
 * least-protected first, least-trusted-oldest within a protection band (see the Droppable
 * type's ladder) — never by truncating anything that remains. The handoff is
 * exempt (it is the record the briefing exists to deliver); a briefing whose frame +
 * handoff alone exceed the cap renders over-cap rather than mutilated, and reports it.
 */
export function renderBriefing(
  data: BriefingData,
  config: BriefingConfig = briefingConfig(),
  /**
   * THE CLOCK, INJECTED. The staleness band is the only thing in this renderer that is not a
   * function of (data, config), and a renderer that reads the wall clock directly is a
   * renderer no test can pin. Callers get today; a test gets whatever instant it needs.
   */
  now: Date = new Date(),
): BriefingRender {
  config = applyAltitudeFlag(applySelectionFlag(config));
  // The gather already refuses the spine when the flag is off; this is the second half of
  // the same choke point, for a BriefingData assembled by hand (tests, future callers).
  const branch = config.branchScopeEnabled ? data.branch : null;
  // P5.5's kill switch, re-checked HERE as well as in the gather — the same two-choke-point
  // discipline `branchScopeEnabled` uses, so a hand-built BriefingData carrying a `waiting`
  // object cannot obtain the section from a flag-off deployment.
  const waiting = config.waitingSectionEnabled ? data.waiting : null;
  // Set when every droppable is gone and the render is STILL over cap (frame + exempt
  // handoff exceed it) — flips the omitted line to the honest over-cap wording.
  let overCap = false;

  /**
   * THE BRANCH-MEMBER SET — the top band of the ladder. `data.branch === null` (trunk /
   * unpositioned) leaves it empty, which is the deliberate fallback: no branch, no branch
   * scoping. Membership is by id, so a task that is ALSO a branch member takes the branch
   * band rather than its own task band (the ladder is first-match, top down).
   */
  const branchMemberIds = new Set<string>((branch?.members ?? []).map((m) => m.id));

  /**
   * STALE = created more than `config.staleTaskDays` days ago. Computed from the INJECTED
   * clock and the record's immutable `created_at`; see briefingConfig.ts for why `updated_at`
   * is not the instrument (measured: it reads 0 stale of 184 on the project this was built
   * for, because unrelated background writes reset it).
   */
  const staleBeforeMs = now.getTime() - config.staleTaskDays * 24 * 60 * 60 * 1000;
  const isStale = (createdAt: Date): boolean => createdAt.getTime() < staleBeforeMs;

  /**
   * THE LADDER, EVALUATED TOP DOWN — the ONE place a record's band is decided. Returns a
   * config value on every branch; `BRIEFING_PROTECTION_RANK_NONE` is the floor and is itself
   * a named constant, so no rank number is written here.
   */
  const taskProtectionRank = (t: BriefingTask): number => {
    if (branchMemberIds.has(t.id)) return config.protectionRankBranchMember;
    if (config.alwaysSurfaceTaskStatuses.includes(t.status)) return config.protectionRankAlwaysSurface;
    if (!config.protectedTaskPriorities.includes(t.priority)) return BRIEFING_PROTECTION_RANK_NONE;
    return isStale(t.createdAt) ? config.protectionRankStalePriority : config.protectionRankPriority;
  };
  /**
   * A DECISION has neither a status nor a priority column the briefing reads, so the two
   * bands available to it are branch membership and its own kind band. `protectionRankDecision`
   * SHIPS AT THE FLOOR, which makes this line behave exactly as it did before f176d8a5 — it is
   * the measurement knob for "the package serves 0 of 162 decisions", not a ruling that they
   * should be protected. See briefingConfig.ts. (Conventions used to share this function; they
   * have their own band, below.)
   */
  const nonTaskProtectionRank = (id: string): number =>
    branchMemberIds.has(id) ? config.protectionRankBranchMember : config.protectionRankDecision;
  /**
   * A CONVENTION HAS ITS OWN BAND (2026-08-24). Same first-match, top-down shape as the task
   * ladder: branch membership still wins, otherwise the record takes the convention band
   * rather than falling to the floor. Setting the band to BRIEFING_PROTECTION_RANK_NONE
   * restores the pre-2026-08-24 order exactly, with no code edit — which is how this band is
   * falsified from the outside (see envRank in briefingConfig.ts). That knob governs the
   * branch-scope-ON path only; with the switch OFF applySelectionFlag has already collapsed
   * this band to the floor, so the OFF document is the pre-2026-08-24 one regardless.
   *
   * WHY CONVENTIONS AND NOT DECISIONS. A decision is a record OF a past choice; a convention
   * is a STANDING CONSTRAINT the reader must obey while working. Measured on prod
   * `riverbend` 2026-08-24, the floor band meant `## Conventions (0 of 1)` on every render.
   */
  const conventionProtectionRank = (id: string): number =>
    branchMemberIds.has(id) ? config.protectionRankBranchMember : config.protectionRankConvention;

  // ═══ P5.1 — SELECTION RUNS BEFORE THE BUDGET IS EVER CONSULTED ══════════════════════
  //
  // This is the item, stated as code: the records that render are chosen by a NAMED RULE,
  // and the cap is what it was always supposed to be — a backstop. The ranking is
  // `dropOrder` read backwards, which is the SAME order the cap has evicted in since SK5;
  // nothing new is invented here, a tiebreak is promoted to a rule.
  //
  // ONE POOL, BUILT ONCE, USED THREE TIMES: for the quota, for the full-prose slots, and for
  // the cap loop. Building it three times is three chances for the three to disagree about
  // what a record's rank is.
  const pool: Droppable[] = [
    ...data.tasks.map((t) => ({
      section: 'tasks' as const, kind: 'task' as const, tags: t.tags,
      id: t.id, createdAt: t.createdAt, trustScore: t.trustScore, protectionRank: taskProtectionRank(t),
    })),
    ...data.decisions.map((d) => ({
      section: 'decisions' as const, kind: 'decision' as const, tags: d.tags,
      id: d.id, createdAt: d.createdAt, trustScore: d.trustScore, protectionRank: nonTaskProtectionRank(d.id),
    })),
    ...data.conventions.map((c) => ({
      section: 'conventions' as const, kind: 'convention' as const, tags: c.tags,
      id: c.id, createdAt: c.createdAt, trustScore: c.trustScore, protectionRank: conventionProtectionRank(c.id),
    })),
  ];
  const bySection = (s: Droppable['section']): Droppable[] => pool.filter((d) => d.section === s);

  const selectedIds = {
    tasks: selectBest(bySection('tasks'), config.selectMaxTasks),
    decisions: selectBest(bySection('decisions'), config.selectMaxDecisions),
    conventions: selectBest(bySection('conventions'), config.selectMaxConventions),
  };
  // Dead ends and branch members carry no trust score and no protection band — nothing to
  // rank them by that is not already their order — so their quota is the head of the list
  // they arrive in, which is newest-first for both. Stated rather than inferred: a quota
  // that silently reordered a section would be a second ranking after all.
  const selectedDeadEnds = data.deadEnds.slice(0, config.selectMaxDeadEnds);
  const selectedBranchMembers = (branch?.members ?? []).slice(0, config.selectMaxBranchMembers);

  /** What a stated rule chose against, per section — a count under a NAME, never a silence. */
  const excludedBySelection = {
    tasks: data.tasks.length - selectedIds.tasks.size,
    decisions: data.decisions.length - selectedIds.decisions.size,
    conventions: data.conventions.length - selectedIds.conventions.size,
    deadEnds: data.deadEnds.length - selectedDeadEnds.length,
    branchMembers: (branch?.members.length ?? 0) - selectedBranchMembers.length,
  };

  // ═══ THE FULL-PROSE SLOTS ═══════════════════════════════════════════════════════════
  //
  // Offered to the SELECTED records in the same best-first order the quotas used, across all
  // three sections at once — the slots are a document-level budget, not a per-section one, so
  // a project whose most important records are all decisions gets decisions in them.
  //
  // A SLOT IS NEVER REASSIGNED. A record that misses the gate CONSUMES its slot and renders
  // the denial in-band (renderSlotDenial). See config/briefingAltitudeConfig.ts for why:
  // reassigning would let the GATE decide the document's full-prose content instead of the
  // RANKING, invisibly.
  const slotOrder = pool
    .filter((d) => selectedIds[d.section].has(d.id))
    .sort((a, b) => dropOrder(b, a))
    .slice(0, config.fullProseSlots);
  /** id -> 'full' for a granted slot. Absent = SHAPE, which is the default for everything. */
  const altitudeById = new Map<string, RenderAltitude>();
  /** id -> the in-band denial line for a record that spent its slot and was refused. */
  const denialById = new Map<string, string>();
  slotOrder.forEach((d, i) => {
    const excludedTag = matchedTags(d.tags, config.fullProseExcludeTags)[0];
    if (excludedTag !== undefined) {
      denialById.set(d.id, renderSlotDenial(i, FULL_PROSE_DENIAL.excludedByTag, `: ${excludedTag}`));
      return;
    }
    if (!config.fullProseTypes.includes(d.kind)) {
      denialById.set(d.id, renderSlotDenial(i, FULL_PROSE_DENIAL.typeNotEligible, `: ${d.kind}`));
      return;
    }
    altitudeById.set(d.id, 'full');
  });
  const altitudeOf = (id: string): RenderAltitude => altitudeById.get(id) ?? 'shape';

  // Membership sets — a cap drop removes the id from its set; assembly re-renders from sets.
  // THEY START FROM THE SELECTION, not from the whole population: a record a rule chose
  // against never enters the cap loop, which is what makes `evictedByCap` mean "the budget
  // ran out" rather than "something did not fit, somehow".
  const included = {
    tasks: new Set(selectedIds.tasks),
    decisions: new Set(selectedIds.decisions),
    conventions: new Set(selectedIds.conventions),
    // Dead-ends are admitted by their OWN reserved budget, once, up front — and are then
    // immune to the global cap loop below (they are not in `candidates`).
    deadEnds: fitToReservedBudget(selectedDeadEnds, config.deadEndReservedChars, renderDeadEnd),
    // The branch section gets the same treatment for the same reason: the records the
    // reader explicitly said they are resuming must not compete with project-wide newest.
    branchMembers: fitToReservedBudget(
      selectedBranchMembers,
      config.branchReservedChars,
      renderBranchMember,
    ),
    // P5.5, carried across the P5.1 merge. Same reserved-budget boundary as dead-ends and
    // the branch, for the same reason: this is the OPERATOR'S ACTION LIST, and a section
    // that competes with project-wide newest for the global cap is a section that empties
    // itself on a busy project (one section over). It is therefore NOT
    // in `candidates` and the global drop loop cannot touch it.
    // NOTE it is deliberately NOT quota-selected either: P5.1's quotas govern the sections
    // that compete for the GLOBAL budget. This one has its own, so `waiting?.items` is the
    // full fetched set, exactly as P5.5 built it.
    waiting: fitToReservedBudget(
      waiting?.items ?? [],
      config.waitingReservedChars,
      renderWaitingTask,
    ),
  };

  /**
   * THE SELECTION TOTAL, computed ONCE and read by both the footer and the returned fields.
   * Two sums over the same five numbers is two places for them to disagree.
   */
  const selectionTotalForFooter =
    excludedBySelection.tasks + excludedBySelection.decisions + excludedBySelection.conventions +
    excludedBySelection.deadEnds + excludedBySelection.branchMembers;

  const assemble = (): string => {
    const lines: string[] = [];
    /**
     * How many full-prose bodies this pass actually CUT. Counted during assembly rather than
     * pre-computed, so it describes the document that was rendered — a granted slot whose
     * record the cap later evicted must not be counted as a truncation the reader can see.
     */
    let truncatedProseCount = 0;
    const countIfCut = (body: string): void => {
      if (body.length > config.fullProseMaxChars) truncatedProseCount += 1;
    };
    lines.push(`# Project briefing: ${data.projectName}`);
    lines.push(`project:${short(data.projectId)} current-state briefing (deterministic render)`);
    lines.push('');

    lines.push('## Handoff');
    if (data.handoff && data.handoffHead.status === 'resolved') {
      // HOW THE HEAD WAS PICKED, in the same position the trust signal already occupies —
      // so a reader can see that this record was WALKED to, not merely found. The seeds and
      // the hop count are also fields on `handoffHead` for a machine reader.
      lines.push(
        `[id:${short(data.handoff.id)}] [${data.handoff.trustSignal}] ` +
          `[head:chain-walk] [seeds:${data.handoffHead.concurringSeeds.join('+')}] ` +
          `[hops:${maxWalkHops(data.handoffHead)}]`,
      );
      // THE CARRIED FIELDS (P5.4), immediately under the head line and above the body:
      // the three things a resuming reader acts on BEFORE reading the prose. Deliberately
      // LOCALISED to this section — P5.1 restructures record ALTITUDE, and the handoff is
      // the one record that is cap-exempt and rendered whole, so these lines sit in the
      // part of the section P5.1 does not reshape.
      lines.push(...renderCarriedFields(data.handoff));
      lines.push('');
      // FULL text — never truncated, never dropped. Stamped in place at RENDER time with
      // each named task's CURRENT status; `data.handoff.content` is the
      // stored bytes and stays that way. The flag is re-checked here — the second of the two
      // choke points — so a hand-built BriefingData carrying stamps cannot obtain the
      // behaviour from a flag-off deployment.
      lines.push(
        config.handoffStampEnabled
          ? applyHandoffStamps(
              data.handoff.content,
              data.handoff.stamps,
              config.handoffStampFormat,
            )
          : data.handoff.content,
      );
    } else if (data.handoffHead.status === 'refused') {
      // ═══ REFUSE TO PICK, BUT NEVER RENDER NOTHING (SCOPE §8.5) ══════════════════════
      // Our shell resolver refuses and emits nothing, because the coordinator is present to repair the
      // graph. On a customer boot surface that is the dangerous option: we measured a
      // 40-MINUTE BROKEN BOOT from exactly that silence, and a fork arises from an ordinary
      // mishap (a handoff misfiled into the wrong project — SCOPE §3.2). A customer has no
      // operator and no hand-edit remedy we would endorse, so the section shows the
      // candidates, says why it will not choose, and hands over a repair they can perform
      // through the public tool surface.
      lines.push(...renderHandoffRefusal(data.handoffHead, config));
    } else {
      lines.push('none recorded');
    }
    lines.push('');

    // THE BRANCH SECTION (SK5). Present ONLY when the reader has an open branch position:
    // at trunk / unpositioned the document is byte-identical to the pre-SK5 fallback here.
    if (branch) {
      const members = branch.members.filter((m) => included.branchMembers.has(m.id));
      // THE APPROXIMATE BAND, from the FIELD on each member (migration 086 `spine_source`),
      // in SK2's vocabulary. It deliberately does NOT claim the remainder is `exact`: that
      // conjunction needs bands 2b and 3, which this bounded read does not compute, and
      // branch_history is where it is answered. Counted over the SERVED lines, because the
      // caveat has to describe what the reader is actually looking at.
      const approx = approximateMemberCount(members);
      const approxNote =
        approx > 0
          ? [
              `${approx} of ${members.length} shown are APPROXIMATE members ` +
                `[spine-source:${MEMBERSHIP_SOURCE.legacyApprox}] — migration 086 derived the ` +
                `branch from where a pre-086 edge attached; it was never recorded. This ` +
                `section does not claim the rest is exact — branch_history answers that`,
            ]
          : [];
      lines.push(
        ...renderSectionHeading(
          `On this branch [spine:${short(branch.spineId)}]`,
          members.length,
          data.census.branchMembers,
          `the branch reserved budget (${config.branchReservedChars} chars, ` +
            `MANDREL_BRIEFING_BRANCH_RESERVED_CHARS)`,
          config.sectionMaxRecords,
          { count: excludedBySelection.branchMembers, rule: SELECTION_RULE.branchMemberQuota },
          approxNote,
        ),
      );
      for (const m of members) lines.push(renderBranchMember(m));
      lines.push('');
    }

    // ═══ WAITING ON A HUMAN (P5.5) ═════════════════════════════════════════════════
    // FIRST among the task sections, because it is the one a human operator acts on. Absent
    // entirely when the section is switched off — an absent section and a section claiming
    // zero are different claims, and only one of them is true when a feature is disabled.
    if (waiting) {
      const items = waiting.items.filter((t) => included.waiting.has(t.id));
      // The heading's population comes from the section's OWN census, which travels with
      // `source`: the fallback's population answers a different predicate than the column's,
      // and a heading that mixed them would state a number about the wrong question.
      lines.push(
        ...renderSectionHeading(
          WAITING_SECTION_LABEL,
          items.length,
          {
            fetched: waiting.fetched,
            fetchBoundReached: waiting.fetchBoundReached,
            excluded: 0,
            excludedReason: null,
          },
          `the waiting reserved budget (${config.waitingReservedChars} chars, ` +
            `MANDREL_BRIEFING_WAITING_RESERVED_CHARS)`,
          config.waitingMaxRecords,
          // P5.1 merge: this section is NOT quota-selected. It carries its own reserved
          // budget and is absent from `candidates`, so no stated selection rule ever
          // excludes a record from it — `null` is the honest value, not a placeholder.
          // Passing the notes array here (the pre-merge positional slot) is what tsc caught.
          null,
          [
            ...waitingSourceNotes(waiting, config),
            // The HINT tier's caveat is emitted only when a hint is actually on screen.
            // Explaining a marker nobody can see is frame nobody asked for.
            ...(items.some((t) => !t.dueAt && t.dueHint) ? [config.waitingDueHintCaveat] : []),
          ],
        ),
      );
      for (const t of items) lines.push(renderWaitingTask(t));
      lines.push(...renderWaitingFindings(waiting));
      lines.push('');
    }

    const tasks = data.tasks.filter((t) => included.tasks.has(t.id));
    lines.push(
      ...renderSectionHeading(
        'Open tasks', tasks.length, data.census.tasks, CAP_REASON, config.sectionMaxRecords,
        { count: excludedBySelection.tasks, rule: SELECTION_RULE.taskQuota },
      ),
    );
    // ALTITUDE, at the one place a task becomes text (P5.1). SHAPE is the default; `full` is
    // a granted reserved slot; a denial is a shape line plus the reason it was refused one.
    for (const t of tasks) {
      if (altitudeOf(t.id) === 'full') {
        countIfCut(taskBody(t));
        lines.push(renderTaskFull(t, config.fullProseMaxChars));
      } else {
        lines.push(renderTaskShape(t));
        const denial = denialById.get(t.id);
        if (denial !== undefined) lines.push(denial);
      }
    }
    lines.push('');

    const decisions = data.decisions.filter((d) => included.decisions.has(d.id));
    lines.push(
      ...renderSectionHeading(
        'Decisions', decisions.length, data.census.decisions, CAP_REASON, config.sectionMaxRecords,
        { count: excludedBySelection.decisions, rule: SELECTION_RULE.decisionQuota },
      ),
    );
    // Grouped by decision_type — the schema's own closed enum: cheap + deterministic.
    // Groups in first-seen order of the (already newest-first) decision list.
    const groups = new Map<string, BriefingDecision[]>();
    for (const d of decisions) {
      if (!groups.has(d.decisionType)) groups.set(d.decisionType, []);
      groups.get(d.decisionType)!.push(d);
    }
    for (const [type, ds] of groups) {
      lines.push(`### ${type}`);
      for (const d of ds) {
        if (altitudeOf(d.id) === 'full') {
          countIfCut(decisionBody(d));
          lines.push(renderDecisionFull(d, config.fullProseMaxChars));
        } else {
          lines.push(renderDecisionShape(d));
          const denial = denialById.get(d.id);
          if (denial !== undefined) lines.push(denial);
        }
      }
    }
    lines.push('');

    const conventions = data.conventions.filter((c) => included.conventions.has(c.id));
    lines.push(
      ...renderSectionHeading(
        'Conventions', conventions.length, data.census.conventions, CAP_REASON, config.sectionMaxRecords,
        { count: excludedBySelection.conventions, rule: SELECTION_RULE.conventionQuota },
      ),
    );
    for (const c of conventions) {
      if (altitudeOf(c.id) === 'full') {
        countIfCut(conventionBody(c));
        lines.push(renderConventionFull(c, config.fullProseMaxChars));
      } else {
        lines.push(renderConventionShape(c));
        const denial = denialById.get(c.id);
        if (denial !== undefined) lines.push(denial);
      }
    }
    lines.push('');

    const deadEnds = data.deadEnds.filter((e) => included.deadEnds.has(e.id));
    lines.push(
      ...renderSectionHeading(
        'Dead ends',
        deadEnds.length,
        data.census.deadEnds,
        `the dead-ends reserved budget (${config.deadEndReservedChars} chars, ` +
          `MANDREL_BRIEFING_DEADEND_RESERVED_CHARS)`,
        config.sectionMaxRecords,
        { count: excludedBySelection.deadEnds, rule: SELECTION_RULE.deadEndQuota },
      ),
    );
    for (const e of deadEnds) lines.push(renderDeadEnd(e));

    const dropped = droppedCount();
    if (overCap) {
      // HONESTY (the reviewer R1 nit 1): every droppable is gone and the output is STILL
      // over cap — the frame + exempt handoff alone exceed it. Say that, instead of
      // claiming the cap was honored.
      lines.push('');
      lines.push(
        // The two absences are named here too: `dropped` is their sum, and quoting it alone
        // under the word "cap" would attribute a rule's choices to the budget.
        `size cap exceeded: the handoff + frame alone exceed the cap ` +
          `(${config.maxChars} chars, MANDREL_BRIEFING_MAX_CHARS); ` +
          `${dropped - selectionTotalForFooter} records evicted by the cap and ` +
          `${selectionTotalForFooter} excluded by a stated selection rule ` +
          `(MANDREL_BRIEFING_SELECT_MAX_*); output is over cap — the handoff is never truncated`,
      );
    } else if (dropped > 0) {
      lines.push('');
      // ═══ THE FOOTER NAMES THE TWO ABSENCES SEPARATELY, WITH THEIR OWN COUNTS ═════════
      //
      // IT USED TO SAY "N whole records dropped to honor the size cap … nothing was
      // truncated", and after P5.1 both halves of that would be FALSE. Measured on prod
      // riverbend 2026-08-24 with the shipped defaults: 339 records did not render and the
      // cap evicted ZERO of them — a stated rule chose against all 339. A footer that
      // attributed them to the cap would send every reader to MANDREL_BRIEFING_MAX_CHARS,
      // which is the one knob that would not have helped. And "nothing was truncated" would
      // be false the moment a full-prose slot binds.
      //
      // This is the same defect as the `## Decisions (0) none` the census exists to retract,
      // one line further down the document — a claim wider than what the renderer knows.
      const cappedHere = dropped - selectionTotalForFooter;
      if (selectionTotalForFooter > 0) {
        lines.push(
          `not served by RULE: ${selectionTotalForFooter} records were excluded by a stated ` +
            `selection rule before the size cap was consulted — each section's own note names ` +
            `the rule and its count (MANDREL_BRIEFING_SELECT_MAX_*). These are choices, not ` +
            `losses: widen the quota to see more.`,
        );
      }
      if (cappedHere > 0) {
        lines.push(
          // THE ORDER THIS SENTENCE NAMES MUST BE THE ORDER THE COMPARATOR PERFORMS. It read
          // "oldest-least-trusted first" while protection had already been the primary key
          // since SK5, and the ladder makes that gap wider — a footer that misnames the rule
          // sends a reader to tune the wrong thing.
          `omitted: ${cappedHere} whole records dropped to honor the size cap ` +
            `(${config.maxChars} chars, MANDREL_BRIEFING_MAX_CHARS) — least-protected first ` +
            // Says "within a rank", not "within a band": `band` is the trust model's word, and
            // the single-renderer guard rightly treats a loose one in product text as a trust
            // band being rendered outside explainTrust. These are PROTECTION RANKS; using the
            // other subsystem's noun here would be wrong for the reader as well as the guard.
            `(MANDREL_BRIEFING_PROTECTION_RANK_*), least-trusted-oldest within a rank; ` +
            `dead ends drop only against their own reserved budget ` +
            `(${config.deadEndReservedChars} chars, MANDREL_BRIEFING_DEADEND_RESERVED_CHARS), oldest first; ` +
            // THE THIRD NARROWING. `dropped` has counted branch members since SK5 gave that
            // section its own budget, so a footer naming only two knobs sends the reader to the
            // wrong one — the standard CAP_REASON states two functions above.
            `branch members drop only against theirs ` +
            `(${config.branchReservedChars} chars, MANDREL_BRIEFING_BRANCH_RESERVED_CHARS), oldest first; ` +
            // THE CLAUSE IS CHOSEN BY THE FACT, NOT BY THE FLAG. `nothing was truncated` was
            // an unconditional sentence and it is now conditional on something the renderer
            // actually holds. Keeping the exact old words for the zero case is not nostalgia:
            // it is what makes the flag-OFF document BYTE-IDENTICAL to pre-P5.1, which is a
            // property a test can assert and a diff can show.
            (truncatedProseCount === 0
              ? 'nothing was truncated'
              : 'shape lines are never truncated — see the truncated line below'),
        );
      }
      // THE TRUNCATION DISCLOSURE. `nothing was truncated` was an unconditional claim and it
      // is now conditional on a fact the renderer holds, so it is stated from the fact. Each
      // truncated body ALSO says so on its own line; this is the document-level count, for a
      // reader who is deciding whether to trust the excerpt they just read.
      if (truncatedProseCount > 0) {
        lines.push(
          `truncated: ${truncatedProseCount} of ${altitudeById.size} full-prose bodies were cut ` +
            `at ${config.fullProseMaxChars} chars (MANDREL_BRIEFING_FULL_PROSE_MAX_CHARS) — the cut ` +
            `is marked in place. Shape lines are never truncated and the handoff is never touched`,
        );
      }
    }

    // ═══ THE RECORDING DIRECTIVE — LAST, AND LAST FOR A REASON ═════════
    //
    // MEASURED: injecting this briefing cut a session's Mandrel tool calls ~5x against an
    // arm that fetched its own state (44/45/57 -> 9/10/17, and one replicate to 0 for all
    // eight sessions). The loss is not the boot READS the injection was meant to replace —
    // it took the WRITES with them, because the frame an injected document necessarily
    // arrives in is a READ-side prohibition that is unqualified over the word "Mandrel".
    // The counter-instruction lived only in a CLAUDE.md the operator has to write, and lost
    // to a block that arrives in-session, at the top, every session.
    //
    // So it ships HERE, in our own text, and it is the LAST thing in the document: the
    // final lines a reader passes before starting work. See briefingConfig.ts for the
    // measurement, and for why "inject less" is refuted rather than untried — the zero-call
    // replicate was being handed a 214-byte briefing.
    //
    // IT IS FRAME, NOT A RECORD: assemble() runs on every pass of the cap loop, so the cap
    // is still honoured and this block is paid for by evicting records on a saturated
    // project. That cost is real; the default is short for that reason.
    if (config.recordingDirectiveEnabled && config.recordingDirective.length > 0) {
      lines.push('');
      lines.push(config.recordingDirective);
    }
    return lines.join('\n');
  };

  // `droppedRecords` counts the GLOBAL-CAP and RESERVED-BUDGET drops across every section,
  // branch members included — the branch section is budgeted, so its unserved members are
  // dropped records exactly as unserved dead-ends are.
  const totalRecords = () =>
    included.tasks.size + included.decisions.size + included.conventions.size +
    included.deadEnds.size + included.branchMembers.size + included.waiting.size;
  const initialTotal =
    data.tasks.length + data.decisions.length + data.conventions.length + data.deadEnds.length +
    (branch?.members.length ?? 0) + (waiting?.items.length ?? 0);
  const droppedCount = () => initialTotal - totalRecords();

  // Drop candidates. Deterministic total order, PROTECTION FIRST:
  // (protectionRank asc) → (score asc, nulls first) → (createdAt asc) → (id asc).
  //
  // WHY protectionRank IS THE PRIMARY KEY. The pre-SK5 order was purely (trust, createdAt),
  // so on a saturated project the cap served whatever that order happened to favour,
  // regardless of what the reader said they were resuming or how urgent the work was.
  // Ranking BELOW protection rather than replacing it is deliberate: within each band the
  // old comparator is untouched, so a config with every band at RANK_NONE is bit-identical
  // to the pre-ladder order.
  //
  // TRUST IS A REAL KEY HERE, NOT A COSTUME — and this comment used to claim the opposite
  // ("92.9% of records sit at cold-start trust, so this is createdAt in a costume"). That
  // figure is about `contexts.relevance_score`; the score in this pool is `trust.score`, a
  // freshness-blended continuous value. Measured on project riverbend 2026-08-20 over the
  // real gather (reports/artifacts/briefing-drop-order-2026-08-20/): 320 candidates, 320
  // DISTINCT trust scores, and sorting by trust does NOT reproduce sorting by createdAt.
  // Stated no wider than the sample: one project, one instant.
  //
  // DEAD-ENDS ARE ABSENT FROM THIS POOL BY CONSTRUCTION — they are bounded
  // by config.deadEndReservedChars in fitToReservedBudget() instead, as is the branch
  // section by config.branchReservedChars. The Droppable type has no section name for
  // either, so re-adding them here does not compile.
  //
  // P5.1: THE POOL IS BUILT ONCE, ABOVE, and the cap loop walks the SELECTED subset of it in
  // `dropOrder`. Feeding the whole population here again would put records a stated rule
  // already excluded back into the budget's hands — which is the defect, re-entered by the
  // back door — and it would make `evictedByCap` count them.
  const candidates: Droppable[] = pool
    .filter((d) => selectedIds[d.section].has(d.id))
    .sort(dropOrder);

  let markdown = assemble();
  /** Candidates the cap loop removed, in the order it removed them (weakest first). */
  const evicted: Droppable[] = [];
  for (const c of candidates) {
    if (markdown.length <= config.maxChars) break;
    included[c.section].delete(c.id);
    evicted.push(c);
    markdown = assemble();
  }

  // THE BACKFILL. The loop above stops at the FIRST render that fits, so the budget freed by
  // its last drop is never spent — measured on project riverbend 2026-08-20: 3233 of 24000
  // chars unused while 314 records were dropped, some of them 159 chars long.
  //
  // First fit, walking the evicted list BACKWARDS: that is the drop order reversed, i.e. the
  // strongest candidate the cap took is the first one offered back. A record that still does
  // not fit is SKIPPED and the walk continues (the same rule fitToReservedBudget uses, for the
  // same reason: one oversized record must not be able to end the walk). Fully deterministic —
  // same inputs, same kept set — and it can only ADD records that were already in the pool.
  //
  // IT CANNOT TOUCH THE HANDOFF: `evicted` holds only tasks/decisions/conventions, the
  // handoff is not a droppable and is rendered in full by assemble() on every pass, so this
  // walk neither truncates nor drops it. The handoff's unbounded body is a separate, real
  // budget problem and is deliberately left exactly as it is.
  if (config.backfillEnabled && markdown.length <= config.maxChars) {
    for (let i = evicted.length - 1; i >= 0; i--) {
      const c = evicted[i];
      included[c.section].add(c.id);
      const candidateMd = assemble();
      if (candidateMd.length > config.maxChars) {
        included[c.section].delete(c.id); // did not fit: put it back out, keep walking
      } else {
        markdown = candidateMd;
      }
    }
  }

  if (markdown.length > config.maxChars) {
    // Nothing left to drop and still over cap: re-assemble once with the honest
    // over-cap line (see the overCap branch in assemble()).
    overCap = true;
    markdown = assemble();
  }

  // THE TWO ABSENCES, decomposed from ONE subtraction so they cannot disagree with each other
  // or with `droppedRecords`. Selection is counted from the quotas; everything else that did
  // not render is a BUDGET loss — the global cap loop or one of the two reserved sub-budgets.
  // Deriving the budget number rather than summing three separate tallies is deliberate: a
  // sum can miss a path, a remainder cannot.
  const selectionTotal = selectionTotalForFooter;
  const dropped = droppedCount();

  return {
    markdown,
    droppedRecords: dropped,
    included: {
      tasks: included.tasks.size,
      decisions: included.decisions.size,
      conventions: included.conventions.size,
      deadEnds: included.deadEnds.size,
      branchMembers: included.branchMembers.size,
      waiting: included.waiting.size,
    },
    spineId: branch?.spineId ?? null,
    excludedBySelection: {
      total: selectionTotal,
      byRule: {
        [SELECTION_RULE.taskQuota]: excludedBySelection.tasks,
        [SELECTION_RULE.decisionQuota]: excludedBySelection.decisions,
        [SELECTION_RULE.conventionQuota]: excludedBySelection.conventions,
        [SELECTION_RULE.deadEndQuota]: excludedBySelection.deadEnds,
        [SELECTION_RULE.branchMemberQuota]: excludedBySelection.branchMembers,
      },
    },
    evictedByCap: dropped - selectionTotal,
    fullProse: {
      slots: slotOrder.length,
      granted: altitudeById.size,
      denied: denialById.size,
    },
  };
}

/** The one-call orchestrator the route uses: gather + render. */
export async function buildProjectBriefing(
  projectId: string,
  projectName: string,
  pool: Pool = db,
  config: BriefingConfig = briefingConfig(),
  /** The reader's open branch ROOT, or null at trunk / unpositioned (SK5). */
  spineId: string | null = null,
): Promise<BriefingRender & { data: BriefingData }> {
  const data = await gatherBriefingData(projectId, projectName, config, pool, spineId);
  const render = renderBriefing(data, config);
  return { ...render, data };
}
