/**
 * POSITIONAL MEMBERSHIP — the write-path integration (PHASE 1,  * an earlier task). ONE service all three write paths call (context_store, decision_record,
 * task_create), so the membership rule cannot drift per-route (a past incident / C3).
 *
 * THE MODEL (the operator's ruling 2026-08-13): membership = POSITION, like git. A session stands
 * on a branch (services/branchPosition.ts); every record written while standing there gets
 * a DECLARED `informs` edge (created_by 'auto:positional' — the 079 meter's DECLARED
 * bucket) to the branch spine. NAMING ≠ MEMBERSHIP; STANDING THERE = MEMBERSHIP.
 *
 * THE MULTI-NAME POLICY (spec item f, an earlier decision §2; E3 caveat from 56c64134):
 *   - a record naming ≥2 REAL task ids in its body is TRUNK material: NO single-branch
 *     membership edge (even when positioned), and a declared weak reference edge
 *     (`related_to`, created_by 'auto:positional') to EACH named task so every touched
 *     branch still sees it on recall;
 *   - a POSITIONED record naming exactly 1 foreign task id stays a member of its position
 *     (membership edge) and gets ONE weak reference edge to the named task;
 *   - the matcher accepts id8 AND full-uuid forms and NEVER first-matches: every candidate
 *     is resolved project-scoped against the tasks table; an AMBIGUOUS id8 mints nothing
 *     and is surfaced as a warning.
 *
 * THE OFFER (spec item b, the D2 make-it-a-byproduct principle): a CAPTURE with NO branch
 * open gets a response line naming the record's OWN id8 and offering `branch_open <id8>` —
 * the identifier is ambient, copying is free. A CREATE no longer offers: it auto-opens (R1
 * below), because the offer assumed a reader and the measured session had none.
 *
 * ── AUTO-OPEN POSITIONS (design 9420ed2d) ─────────────
 *
 * THE MEASURED GAP: rivet — a small model with zero house habits, first customer-shaped
 * session — did the RIGHT first acts (task_create, decision_record, contexts) and its
 * decision and task each ended with ZERO inbound edges, because it never read the offer
 * prose and the system demanded a SECOND, separate act to make the first one count.
 * Auto-open makes the first right act sufficient.
 *
 * THE RULE SET — "breadth reverts to trunk, depth extends the branch". All of it lives in
 * applyAutoOpenRules() below, ONE function, so a rule cannot drift per-route (C3):
 *
 *   R0 DECLARED positions (branch_open / task_claim / task_update in_progress) are
 *      UNCHANGED from P1 — byte-identical. Explicit intent outranks every byproduct. This
 *      is the single most important invariant in the change: it is why the auto-open
 *      branches below are guarded on origin, why openPosition() resets origin/tip/counter,
 *      and why migration 082 carries a CHECK making a declared position with a tip
 *      unreachable rather than merely unwritten.
 *   R1 A CREATE by an UNPOSITIONED session auto-opens a position ON THE RECORD IT JUST
 *      MADE (origin='auto'), and the response says so visibly.
 *   R2 A SECOND SAME-TYPE create on a still-VIRGIN auto position is fan-out (a coordinator
 *      batching siblings): mint NOTHING and revert the session to TRUNK for the rest of its
 *      life; only a declared act exits. Fires BEFORE any mint — wrong edges never come into
 *      existence, so nothing has to be cleaned up.
 *   R3 Any other create on an auto position EXTENDS the branch: mint `informs` to the ROOT
 *      (NOT the tip — measured: minting to the tip pushes recall past
 *      threadConfig defaultDepth, so a deep branch stops being recallable in one call), and
 *      the new record becomes the TIP.
 *   R4 A capture (context_store) informs the TIP; tip = root when null, which is exactly
 *      what keeps declared positions byte-identical. Captures count as member writes.
 *   R5 TRUNK: no membership mints, no auto-open. The multi-name trunk rule and the
 *      inference floor are untouched.
 *   R6 Keying/isolation unchanged (per project+session; reconnect = fresh eligibility) —
 *      inherited free, because every branch here reads the SAME resolvePositionKeys choke
 *      point P1 used.
 *
 * All auto-open edges keep created_by='auto:positional', so they land in the DECLARED
 * bucket of the 079 meter exactly as P1's do. NO new config, NO env var, NO TTL.
 *
 * THE ACCEPTED RISK (design 9420ed2d, do not redesign around it): R2 misclassifies a worker
 * that fans out two sibling records back-to-back before any other write. That session lands
 * at trunk and its later writes get floor-only edges. Bounded and accepted — the failure
 * direction is MISSING edges, never WRONG ones; one declared act recovers; and the Q3 meter
 * (migration 082, zero_declared_inbound_weekly) is the instrument that shows whether the
 * shape occurs at a rate that matters.
 *
 * ROBUSTNESS: mintPositional NEVER throws — the record is already persisted; a failed edge
 * mint is reported in the returned warnings, it must not break or roll back the write.
 */

import type { Pool } from 'pg';
import {
  BYPRODUCT_CONTESTED_BY_ORIGINS,
  positionContentionTrunks,
} from '../config/positionContentionConfig.js';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { scanNamedIdTokens, MAX_NAMED_ID_CANDIDATES } from '../utils/namedIdScan.js';
import { mintEdge } from './links.js';
import { recordMembership } from './branchMembership.js';
import type { EdgeNodeType } from '../config/edgeTypes.js';
import {
  openPositionAny,
  readPositionAny,
  revertToTrunk,
  noteMemberWrite,
  positionTarget,
  type BranchPosition,
  type SpineType,
} from './branchPosition.js';
import { projectHandler } from '../handlers/project.js';
import { MEMBERSHIP_SPINE_MISSING, danglingSpineRefused } from '../config/danglingSpineConfig.js';
import { spineRecordExists } from './spineResolver.js';
import {
  resolveMintEndpoint,
  AmbiguousIdError,
  IdNotFoundError,
} from '../utils/idResolver.js';
import {
  POSITIONAL_BODY_FIELDS,
  POSITIONAL_BODY_SEPARATOR,
  BYPRODUCT_YIELDS_TO_ORIGINS,
} from '../config/positionalMembershipConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { TRUNK_CONTEXT_TYPE } from './handoffSupersession.js';
import { positionAgeNotice } from '../config/positionAgeNoticeConfig.js';

/**
 * THE ONE BODY-COMPOSITION CALL (SK1). Every write path hands this layer its
 * record's fields and this function decides which of them are scanned — instead of three
 * route files each building the string inline and agreeing only by coincidence. The field
 * lists and the reasoning are in config/positionalMembershipConfig.ts.
 *
 * Missing / null / undefined fields contribute an EMPTY segment, not the string "undefined":
 * an absent description must not be able to introduce characters the writer never typed.
 */
export function composePositionalBody(
  recordType: keyof typeof POSITIONAL_BODY_FIELDS,
  fields: Readonly<Record<string, unknown>>
): string {
  return (POSITIONAL_BODY_FIELDS[recordType] as readonly string[])
    .map((f) => {
      const v = fields[f];
      return v === null || v === undefined ? '' : String(v);
    })
    .join(POSITIONAL_BODY_SEPARATOR);
}

/**
 * THE ID SHAPES ARE NOT DEFINED HERE. They moved to utils/namedIdScan.ts
 * when the handoff staleness stamp became a second reader of ids-in-free-text; keeping a
 * private copy here would let this rule and that one disagree about the same sentence.
 * Shape is shared; POLICY stays here — this path resolves for MINTING, so it uses
 * resolveMintEndpoint (existence- and project-checked) and refuses ambiguity.
 */

/**
 * The per-write resolution bound moved to utils/namedIdScan.ts alongside the shapes it
 * bounds: the handoff stamper resolves the same tokens from the same scan
 * and must not be able to pick a different ceiling. Re-exported so this module's existing
 * name still resolves for any reader who comes looking for it here.
 */
export { MAX_NAMED_ID_CANDIDATES } from '../utils/namedIdScan.js';

/** One edge this service minted-or-deduped, labeled with WHY it exists. */
export interface PositionalEdge {
  /** 'position' = membership to the spine · 'named-ref' = single-name weak reference ·
   *  'trunk-ref' = multi-name trunk reference. */
  via: 'position' | 'named-ref' | 'trunk-ref';
  edgeType: string;
  toType: EdgeNodeType;
  toId: string;
  /** True iff a NEW edge row was inserted (false on dedup). */
  created: boolean;
}

/**
 * WHY THIS WRITE DID OR DID NOT BECOME A MEMBER (SK1 item c).
 *
 * The acceptance is "a positioned write always mints DECLARED membership — never a silent
 * no-op; a positioned write that mints nothing must surface a reason." Before SK1 the report
 * carried the FACTS (position, edges, trunk, atTrunk, …) and left the reader to reconstruct
 * the reason from them — which works for the cases that have a flag (atTrunk,
 * revertedToTrunk) and NOT for the two that never had one: an explicit `noAutoThread`
 * opt-out, and the record that IS the spine. Both minted nothing, both looked identical to a
 * failure, and neither said anything.
 *
 * So the reason is now a CLOSED SET computed at the one membership decision, and it is
 * always populated. A closed set rather than a free-string because this is the field a test
 * and a caller both branch on; a sentence cannot be asserted on without pinning its prose.
 */
export const MEMBERSHIP_OUTCOMES = [
  /** A declared `via:position` membership edge was minted (or deduped — it exists). */
  'minted',
  /** No active project, so nothing could be keyed or scoped. */
  'no-project',
  /** Strict keying refused an unidentified caller (see keyRefusal for the text). */
  'key-refused',
  /** No branch open — the `branch_open <id8>` offer is in `offer`. */
  'no-position',
  /** The caller passed the explicit opt-out flag for this write. */
  'opted-out',
  /**
   * This record is TRUNK material — attached to what it names, member of nothing. Two
   * independent rules reach it: a context whose type is TRUNK_CONTEXT_TYPE ('handoff'),
   * decided by type alone; or the multi-name rule (>=2 named tasks, and no deliberately
   * opened position).
   */
  'trunk-record',
  /** R5 — the session was already at trunk. */
  'at-trunk',
  /** R2 — this write was fan-out; the session reverted to trunk and nothing minted. */
  'reverted-to-trunk',
  /** The record IS the spine (R1 auto-open, or a write onto its own branch root). */
  'record-is-spine',
  /**
   * The position's spine RESOLVES TO NO RECORD — it was deleted out from under the open
   * position (`branch_positions.spine_id` is a soft reference; migration 080). Nothing is
   * minted, because the alternative measured on this exact path was an `informs` edge with
   * created_by 'auto:positional' pointing at a record that does not exist — declared,
   * trust-bearing membership of nothing. Rule + measurement: config/danglingSpineConfig.ts.
   */
  MEMBERSHIP_SPINE_MISSING,
  /** The mint threw. The record is persisted; see `warnings`. */
  'mint-failed',
  /**
   * A membership is ALREADY on file for this record, naming a DIFFERENT branch. The
   * branch_memberships PK (record_id) encodes "a write happens at one position", so the
   * first one wins and this one is refused — reported rather than merged, because claiming
   * membership of the branch the caller asked about would be a confident wrong answer. See
   * `warnings` for which branch actually holds it.
   */
  'already-member-elsewhere',
] as const;
export type MembershipOutcome = (typeof MEMBERSHIP_OUTCOMES)[number];

/** The full, honest report of what the positional layer did for one write. */
export interface PositionalReport {
  /** SK1 item c: whether this write became a member, and — always — WHY. */
  membership: { minted: boolean; reason: MembershipOutcome };
  /** The session's current position (null = none open, or keying refused). */
  position: BranchPosition | null;
  /** Strict-keying refusal reason when the session could not be keyed (else null). */
  keyRefusal: string | null;
  /**
   * True when the record NAMES >=2 tasks — the multi-topic FACT. Always drives the
   * `trunk-ref` edge to each named task; only SOMETIMES demotes membership (see `trunk`).
   */
  multiName: boolean;
  /**
   * True when the multi-name rule DEMOTED this record to trunk material: attached to each
   * named task, member of nothing. Deliberately NOT the same thing as `multiName` — a write
   * made while standing on a DELIBERATELY opened position keeps its membership (see the
   * precedence gate at the trunk decision below).
   */
  trunk: boolean;
  /** Resolved task UUIDs named in the body (foreign — own id + spine excluded). */
  namedTaskIds: string[];
  /** Every edge minted-or-deduped by this layer. */
  edges: PositionalEdge[];
  /** The `branch_open <id8>` offer line (null when a position is open / trunk / refused). */
  offer: string | null;
  /** Ambiguity + failure surfacing (never thrown). */
  warnings: string[];
  /** R1 fired: this create auto-opened a position on ITSELF (origin='auto'). */
  autoOpened: boolean;
  /** R2 fired: this create was fan-out; the session reverted to TRUNK and nothing minted. */
  revertedToTrunk: boolean;
  /** R5: the session was ALREADY at trunk when this write arrived. */
  atTrunk: boolean;
}

/** An empty report (the never-throw fallback shape). */
function emptyReport(): PositionalReport {
  return {
    // The fallback reason is the one that is true before anything has been read: no project
    // means no keying, no scan and no mint. Every later branch overwrites it.
    membership: { minted: false, reason: 'no-project' },
    position: null,
    keyRefusal: null,
    multiName: false,
    trunk: false,
    namedTaskIds: [],
    edges: [],
    offer: null,
    warnings: [],
    autoOpened: false,
    revertedToTrunk: false,
    atTrunk: false,
  };
}

/**
 * Is this write a CREATE (task_create / decision_record) or a CAPTURE (context_store)?
 *
 * DERIVED FROM recordType, not passed in by the route, deliberately: recordType is the
 * choke point every write already passes through, so a future route cannot hand this layer
 * the wrong write kind and get create semantics by accident (C3 — anchor on the choke point,
 * not on a parameter each caller re-decides). The three write paths are exactly
 * task_create -> 'task', decision_record -> 'decision', context_store -> 'context'.
 */
function isCreateWrite(recordType: EdgeNodeType): boolean {
  return recordType !== 'context';
}

/**
 * A record type IS a spine type. NO CAST, deliberately: this is a STRUCTURAL property, so
 * the instrument is the compiler (C3 — do not write a runtime check for something the type
 * system decides). The body below fails to typecheck the moment EdgeNodeType and SpineType
 * diverge, which is the only way a position row could ever be stamped with a kind the
 * spine_type CHECK rejects.
 */
function asSpineType(recordType: EdgeNodeType): SpineType {
  return recordType;
}

/**
 * Extract + resolve every task id NAMED in `body` (id8 and full-uuid forms), project-scoped,
 * NEVER first-match: each distinct candidate is resolved individually; an ambiguous id8
 * yields a warning and no reference; a token that resolves to no task is silently ignored
 * (prose is full of 8-hex words that are not ids — resolution against the tasks table is
 * the gate). `exclude` removes the record's own id and the spine id from the result
 * ("naming your own branch" is not a cross-reference).
 */
export async function extractNamedTaskIds(
  body: string,
  projectId: string,
  exclude: ReadonlySet<string>,
  pool: Pool = db
): Promise<{ named: string[]; warnings: string[] }> {
  const text = body ?? '';
  const candidates = scanNamedIdTokens(text);

  const warnings: string[] = [];
  const named = new Set<string>();
  let resolvedCount = 0;
  for (const candidate of candidates) {
    if (resolvedCount >= MAX_NAMED_ID_CANDIDATES) {
      warnings.push(
        `named-id scan stopped at ${MAX_NAMED_ID_CANDIDATES} candidates (body unusually id-dense)`
      );
      break;
    }
    resolvedCount++;
    try {
      // resolveMintEndpoint, not resolveEntityId: this path MINTS edges, so a pasted full
      // UUID must be existence- AND project-checked (no dangling / cross-project refs).
      const id = await resolveMintEndpoint('task', candidate, projectId, pool);
      if (!exclude.has(id)) named.add(id);
    } catch (e) {
      if (e instanceof AmbiguousIdError) {
        // The E3 caveat: NEVER first-match. An ambiguous prefix mints
        // nothing and says so.
        warnings.push(
          `named id '${candidate}' is AMBIGUOUS (${e.candidates.length} tasks match) — no reference minted (never first-match)`
        );
      } else if (!(e instanceof IdNotFoundError)) {
        warnings.push(`named-id resolution failed for '${candidate}': ${(e as Error).message}`);
      }
      // IdNotFoundError → not a task id; ordinary prose hex. Ignore silently.
    }
  }
  return { named: [...named], warnings };
}

/**
 * BYPRODUCT POSITION SETTING (spec item b): explicit work-start on a task — task_claim, or
 * task_update flipping status to in_progress — sets the session's position to that task,
 * with no separate ceremony. Never throws (work-start must not fail on positioning);
 * returns what happened so the route can SAY it (a silent position move is the anchor's
 * mistake all over again).
 */
export async function setPositionByproduct(input: {
  sessionId: string;
  projectId: string | undefined;
  spineId: string;
  spineType: SpineType;
  pool?: Pool;
}): Promise<{
  position: BranchPosition | null;
  refusal: string | null;
  /**
   * SK1 item d: the byproduct DECLINED to move because the session is deliberately standing
   * somewhere (`origin='declared'`). `position` is the position that was KEPT, so the caller
   * still reports where the session is — it just is not where this call would have put it.
   */
  yieldedTo: BranchPosition | null;
  /**
   * a SECOND live claim arrived on a slot that already held a byproduct
   * position on a different spine, so the slot went to TRUNK rather than moving. This is
   * the position that was CONTESTED (the one that was already there), so the caller can
   * name both spines in the line it prints. `position` is then the trunk row.
   */
  contested: BranchPosition | null;
}> {
  const pool = input.pool ?? db;
  try {
    if (!input.projectId) return { position: null, refusal: 'no active project to key a position against', yieldedTo: null, contested: null };
    const keying = projectHandler.resolvePositionKeys(input.sessionId);
    if (keying.refusal !== undefined) return { position: null, refusal: keying.refusal, yieldedTo: null, contested: null };

    // BYPRODUCT YIELDS TO A DECLARED POSITION (SK1 item d). Rule + the
    // measured shape it fixes + why yielding is the right direction:
    // config/positionalMembershipConfig.ts BYPRODUCT_YIELDS_TO_ORIGINS. Read BEFORE the
    // open, because openPosition is an UPSERT — once it runs the previous origin is gone and
    // there is nothing left to yield to.
    //
    // GATED ON ORIGIN, NOT ON SPINE IDENTITY. The first version of this guard also required
    // `existing.spineId !== input.spineId`, which meant a byproduct aimed at the SAME spine
    // the session had already declared fell straight through to the upsert below — and
    // `openPosition` does `origin = EXCLUDED.origin`, so it silently rewrote 'declared' as
    // 'byproduct' (and reset member_writes with it). One downgraded row then disarmed BOTH
    // rules this build ships: the next byproduct on a merely-dispatched task no longer
    // yielded (the position dragged, and every following write minted a confidently WRONG
    // declared via:position edge), and `origin !== 'declared'` made the multi-name gate
    // demote deliberate writes again. Measured through routeExecutor on the sequence
    // branch_open(X) -> task_update(X, in_progress).
    //
    // SAME SPINE IS THE CASE WHERE NOTHING NEEDS TO HAPPEN. The session is already standing
    // exactly where this byproduct would put it, so the correct action is to touch nothing
    // and report the row as it is: `yieldedTo` stays null because nothing was declined and
    // nothing moved, which is also what keeps byproductPositionLines from announcing a move
    // that did not occur.
    const existing = await readPositionAny(input.projectId, keying.keys, pool);
    if (existing && (BYPRODUCT_YIELDS_TO_ORIGINS as readonly string[]).includes(existing.origin)) {
      return {
        position: existing,
        refusal: null,
        yieldedTo: existing.spineId !== input.spineId ? existing : null,
        contested: null,
      };
    }

    // ONE SLOT CANNOT HOLD TWO LIVE CLAIMS. A second work-start on a
    // DIFFERENT spine, while this slot already holds a byproduct claim, is not one agent
    // moving — on a shared transport it is two agents arriving, and the slot cannot say
    // which. Go to TRUNK (R5: mints nothing, auto-opens nothing, until a DECLARED act)
    // instead of overwriting, and RETURN WHAT WAS CONTESTED so the caller can say so.
    // The rule, its population, its price and its residual: config/positionContentionConfig.ts.
    //
    // ORDER MATTERS AND IS NOT ARBITRARY: this sits AFTER the declared-yield check above,
    // because a stated stance outranks a byproduct and a yield is the better outcome — the
    // caller keeps a real position. It sits BEFORE the upsert for the same reason R2's
    // revert does: once openPosition has run the previous origin is gone and there is
    // nothing left to detect.
    if (
      positionContentionTrunks() &&
      existing &&
      (BYPRODUCT_CONTESTED_BY_ORIGINS as readonly string[]).includes(existing.origin) &&
      existing.spineId !== input.spineId
    ) {
      const reverted = await revertToTrunk(input.projectId, existing.sessionKey, pool);
      return { position: reverted ?? existing, refusal: null, yieldedTo: null, contested: existing };
    }

    // STAMP THE ORIGIN (migration 084). Omitting it defaulted to 'declared', which is what
    // made a byproduct indistinguishable from a stated stance in the stored row — the reason
    // the yield rule above could not have been written before 084.
    const position = await openPositionAny(
      {
        projectId: input.projectId,
        keys: keying.keys,
        spineId: input.spineId,
        spineType: input.spineType,
        origin: 'byproduct',
      },
      pool
    );
    return { position, refusal: null, yieldedTo: null, contested: null };
  } catch (error) {
    logger.error('❌ byproduct position set failed (work-start not broken)', error as Error);
    return { position: null, refusal: `position set failed: ${(error as Error).message}`, yieldedTo: null, contested: null };
  }
}

/**
 * THE ONE RENDERER for what a byproduct open did — task_claim and task_update(in_progress)
 * had two hand-written copies of these lines, which is two chances to drift on the message a
 * yield depends on being read (SK1 item d; same collapse the positional serializer made).
 *
 * The yield line names BOTH spines and the exact command to override, because a yield that
 * is not said is the silent-position failure in the other direction.
 */
export function byproductPositionLines(
  result: {
    position: BranchPosition | null;
    refusal: string | null;
    yieldedTo: BranchPosition | null;
    contested?: BranchPosition | null;
  },
  requestedSpineId: string
): string {
  // CONTESTED FIRST — it is the only outcome where the slot ended up somewhere the caller
  // did not ask for AND did not previously hold, so saying nothing here is the silent-move
  // failure this whole area exists to prevent. It names both spines and the way out.
  if (result.contested) {
    return (
      `\nTwo live claims arrived at ONE position slot — this one (${requestedSpineId.substring(0, 8)}) ` +
      `and ${result.contested.spineType} ${result.contested.spineId.substring(0, 8)}, which was already ` +
      `held. A slot cannot say which agent it belongs to, so it has been moved to TRUNK: writes ` +
      `stamp NO declared membership until someone takes a position deliberately. ` +
      `To work this one: branch_open ${requestedSpineId.substring(0, 8)}.`
    );
  }
  if (result.yieldedTo) {
    return (
      `\nBranch position KEPT on ${result.yieldedTo.spineType} ${result.yieldedTo.spineId.substring(0, 8)} ` +
      `(you opened it deliberately) — a status change does not move a declared position. ` +
      `To work this one instead: branch_open ${requestedSpineId.substring(0, 8)}.`
    );
  }
  if (result.position) {
    return '\nBranch position opened on this task — writes now stamp declared edges to it (branch_close to step off).';
  }
  return result.refusal ? `\nPosition not set: ${result.refusal}` : '';
}

export interface MintPositionalInput {
  /** The just-persisted record. */
  recordId: string;
  recordType: EdgeNodeType;
  /** The record's body text the multi-name matcher scans (content / description+rationale / title+description). */
  body: string;
  projectId: string | undefined;
  /** The connection id (RouteContext.connectionId falls back upstream to 'default-session'). */
  sessionId: string;
  /**
   * The record's `context_type`, for a context write ONLY (undefined for a task or a
   * decision, so those paths are unaffected by construction).
   *
   * It exists for ONE rule: a context of type TRUNK_CONTEXT_TYPE is TRUNK MATERIAL BY TYPE.
   * A handoff is the project's resume point — it is addressed to whoever boots next, not to
   * the branch its author happened to be standing on — so what it is decides where it lands,
   * and where the author stood must not enter the decision at all.
   */
  contextType?: string;
  /** The caller opted out of auto-threading for this write (noAutoThread) — position is
   *  consulted for REPORTING but no membership edge is minted. Named refs still mint:
   *  they are the writer's own explicit naming, not an auto-thread. */
  optedOut?: boolean;
  pool?: Pool;
}

/**
 * THE ONE SERIALIZER for the positional report in structuredContent.
 *
 * task_create, decision_record and context_store each carried a hand-copied literal of this
 * object. Three copies of one rule is two chances to drift (a past incident / C5) — and the
 * concrete cost here is that a route which forgets a field reports a position that ISN'T
 * what the service did, silently. Auto-open adds three fields, so the copies are collapsed
 * into this function rather than becoming three copies of a longer literal.
 */
export function serializePositionalReport(report: PositionalReport) {
  return {
    // SK1 item c — first, because it is the answer to the question every caller is asking.
    membership: report.membership,
    position: report.position
      ? {
          spineId: report.position.spineId,
          spineType: report.position.spineType,
          // AUTO-OPEN: how this position came to exist, and where the
          // branch tip is — the state a caller needs to explain the edges it just got.
          origin: report.position.origin,
          tipId: report.position.tipId,
          tipType: report.position.tipType,
          memberWrites: report.position.memberWrites,
        }
      : null,
    multiName: report.multiName,
    trunk: report.trunk,
    namedTaskIds: report.namedTaskIds,
    edges: report.edges,
    offer: report.offer,
    keyRefusal: report.keyRefusal,
    warnings: report.warnings,
    autoOpened: report.autoOpened,
    revertedToTrunk: report.revertedToTrunk,
    atTrunk: report.atTrunk,
    // DERIVED from the position at serialization time, never stored on the
    // report — the position can be replaced mid-mint (R1 opens one, R2 reverts to trunk),
    // and a stored string would describe the position the write STARTED on, not the one it
    // ended on. Null below the configured threshold.
    ageNotice: positionAgeNoticeLine(report),
  };
}

/**
 * THE ONE SENTENCE for a stale position — visibility only, no auto-close.
 * Shared for the same reason as multiNameLine: context_store composes its own response
 * text, so a literal in positionalResponseLines would be the first of two copies.
 */
export function positionAgeNoticeLine(report: PositionalReport): string | null {
  return positionAgeNotice(report.position);
}

/**
 * THE ONE RENDERER for the positional text lines every write path appends.
 *
 * R1's requirement is that the response SAYS the position was opened, VISIBLY — the whole
 * measured failure was an agent not acting on response prose, so the line that replaces the
 * offer has to exist on every create path and cannot be left to three hand-written copies.
 */
export function positionalResponseLines(report: PositionalReport, recordId: string): string {
  const out: string[] = [];
  if (report.edges.length > 0) {
    out.push('\nPositional:');
    for (const e of report.edges) {
      out.push(
        `\n   - ${e.edgeType} → ${e.toType} ${e.toId}${e.created ? '' : ' (already linked)'} (via ${e.via})`
      );
    }
  }
  const nameLine = multiNameLine(report);
  if (nameLine) out.push(`\n${nameLine}`);
  // R1 — replaces the offer on creates. Named imperatively and with the id, so the next act
  // needs no reading comprehension: the branch already exists.
  if (report.autoOpened) {
    out.push(
      `\nBranch OPENED on this record (${recordId.substring(0, 8)}) — your following writes ` +
        `attach to it automatically. branch_close to step off; branch_open <id> to move.`
    );
  }
  // R2 — say the revert out loud. A silent position move is the anchor's mistake.
  if (report.revertedToTrunk) {
    out.push(
      '\nSecond same-type record in a row — treating this session as COORDINATION, not ' +
        'branch work: reverted to trunk, no membership edge minted. branch_open <id> to ' +
        'stand on one deliberately.'
    );
  } else if (report.atTrunk) {
    out.push('\nAt trunk — no membership edge minted. branch_open <id> to stand on a branch.');
  }
  const reasonLine = membershipReasonLine(report);
  if (reasonLine) out.push(`\n${reasonLine}`);
  const ageLine = positionAgeNoticeLine(report);
  if (ageLine) out.push(`\n${ageLine}`);
  if (report.warnings.length > 0) {
    out.push('\nPositional notes:');
    for (const w of report.warnings) out.push(`\n   - ${w}`);
  }
  if (report.offer) {
    out.push(`\nNo branch open — to start one on this record: ${report.offer}`);
  }
  return out.join('');
}

/**
 * THE ONE SENTENCE for the multi-name policy — which of the two things it did.
 *
 * Shared rather than inlined because context_store composes its own response text (its lines
 * interleave with the inference and supersession lines), so a literal here would be the
 * second hand-written copy of a rule that just grew a third state. Returns null when the
 * record names fewer than two tasks.
 */
export function multiNameLine(report: PositionalReport): string | null {
  if (!report.multiName) return null;
  return report.trunk
    ? `TRUNK record: names ${report.namedTaskIds.length} tasks — attached to each, member of none`
    : `Names ${report.namedTaskIds.length} tasks — attached to each, AND still a member of the ` +
      `branch you opened deliberately (an explicit position outranks the multi-name rule).`;
}

/**
 * THE ONE SENTENCE for a no-mint outcome that has no line of its own (SK1 item c).
 *
 * Returns null when the outcome is already explained elsewhere in the response: 'trunk-record'
 * has the TRUNK line, 'at-trunk' and 'reverted-to-trunk' have theirs, 'no-position' has the
 * OFFER, 'mint-failed' and 'key-refused' surface through warnings / keyRefusal, and
 * 'record-is-spine' is already stated when R1 just announced the branch it opened. What is
 * left is exactly the two cases that used to mint nothing and say nothing.
 *
 * A FUNCTION rather than a literal at each call site because context_store composes its
 * response text itself (its lines interleave with the inference + supersession lines, so it
 * cannot simply call positionalResponseLines) — and a sentence hand-copied into two renderers
 * is the same drift the serializer was collapsed to remove.
 */
export function membershipReasonLine(report: PositionalReport): string | null {
  if (report.membership.minted) return null;
  switch (report.membership.reason) {
    case 'opted-out':
      return 'No membership edge: auto-threading was opted out for this write.';
    case 'record-is-spine':
      return report.autoOpened
        ? null
        : 'No membership edge: this record IS the branch root — a spine does not link to itself.';
    case 'trunk-record':
      // multiNameLine() already says it when the record names >=2 tasks — but it returns
      // null when it does not, and a by-type handoff usually names none. Without this arm
      // that record mints nothing AND says nothing: the exact silent no-op SK1 item c
      // exists to forbid.
      return report.multiName
        ? null
        : 'TRUNK record: a handoff is the project timeline\'s own record — attached to the ' +
          'trunk, member of no branch, whatever branch was open when it was written.';
    default:
      return null;
  }
}

/**
 * THE AUTO-OPEN RULE SET — R1/R2/R3/R5, in ONE function, minting NOTHING.
 *
 * It runs AFTER the named-id scan (which mints nothing either) and BEFORE every mint, which
 * is what makes R2's "wrong edges never come into existence" literally true rather than a
 * clean-up promise. Its only side effects are on the POSITION row.
 *
 * Returns 'proceed' (the caller mints as normal) or 'mint-nothing' (R2 fired).
 *
 * WHY THE MULTI-NAME RECORD IS EXCLUDED ENTIRELY: R5 says the multi-name trunk rule is
 * untouched, and R0's principle — explicit intent outranks every byproduct — says a writer
 * who NAMED two tasks has stated where this record belongs. So a multi-name record neither
 * auto-opens a position (it is not a spine) nor triggers fan-out detection (its edges are
 * declared by the writer, not guessed by us), and it is not a member write.
 */
async function applyAutoOpenRules(
  input: MintPositionalInput,
  report: PositionalReport,
  keys: readonly string[] | null,
  pool: Pool
): Promise<'proceed' | 'mint-nothing'> {
  // Not eligible at all: no project to key against, an unidentified caller (keying refusal),
  // an explicit opt-out, or a multi-name trunk record.
  if (!input.projectId || keys === null || input.optedOut || report.trunk) return 'proceed';

  const isCreate = isCreateWrite(input.recordType);
  const position = report.position;

  // R5 — already at trunk. Nothing auto-opens, nothing becomes a member. Only an explicit
  // act leaves: branch_open (origin='declared'), or a work-start byproduct — task_claim /
  // task_update(in_progress) — which since migration 084 stamps origin='byproduct'.
  if (position?.origin === 'trunk') {
    report.atTrunk = true;
    return 'proceed';
  }

  // R1 — an UNPOSITIONED session's create opens a position on the record it just made.
  // This is the whole fix: the first right act is now sufficient, with no second act and no
  // prose for anyone to read. Mints nothing — the record IS the spine, and a spine does not
  // link to itself.
  if (!position && isCreate) {
    report.position = await openPositionAny(
      {
        projectId: input.projectId,
        keys,
        spineId: input.recordId,
        spineType: asSpineType(input.recordType),
        origin: 'auto',
      },
      pool
    );
    report.autoOpened = true;
    return 'proceed';
  }

  // R2 — fan-out on a still-VIRGIN auto position: a SECOND create of the SAME type before
  // any member write is a coordinator batching siblings, not someone working a branch.
  // Revert to trunk and mint nothing. (Same-type is compared against the branch ROOT: the
  // root is the record the session's first act created, so "another one of those" is
  // exactly the breadth signal.)
  if (position?.origin === 'auto' && isCreate) {
    const virgin = position.memberWrites === 0;
    const sameType = asSpineType(input.recordType) === position.spineType;
    if (virgin && sameType) {
      const reverted = await revertToTrunk(position.projectId, position.sessionKey, pool);
      report.position = reverted ?? position;
      report.revertedToTrunk = true;
      report.atTrunk = true;
      return 'mint-nothing';
    }
  }

  // R3/R4 fall through to the ordinary membership mint below; the ROOT-vs-TIP choice and
  // the member-write bookkeeping are made there, next to the mint they describe.
  return 'proceed';
}

/**
 * The one write-path entry point: read the session's position, apply the multi-name policy
 * and the auto-open rules, mint the membership / reference / parent edges, and build the
 * no-branch offer.
 */
export async function mintPositional(input: MintPositionalInput): Promise<PositionalReport> {
  const pool = input.pool ?? db;
  const report = emptyReport();
  try {
    // 1. Where is this session standing? (Same keying choke point as every session-scoped
    //    surface — strict-mode refusal surfaces as a reason, never as a silent "no branch".)
    //    R6 is inherited free here: the keys ARE the per-project+session isolation, so a
    //    reconnect gets a fresh key set and therefore fresh auto-open eligibility, with no
    //    code in this file aware of reconnects at all.
    let keys: readonly string[] | null = null;
    if (input.projectId) {
      const keying = projectHandler.resolvePositionKeys(input.sessionId);
      if (keying.refusal !== undefined) {
        report.keyRefusal = keying.refusal;
      } else {
        keys = keying.keys;
        report.position = await readPositionAny(input.projectId, keying.keys, pool);
      }
    }

    // 2. The multi-name matcher (id8 + uuid, never first-match).
    if (input.projectId) {
      const exclude = new Set<string>([input.recordId]);
      // The spine is excluded because "naming your own branch" is not a cross-reference.
      // NOT AT TRUNK, though (SK1 fix): on an origin='trunk' row spine_id is
      // documented — in branchPosition.ts and in migration 082 — as the record the session
      // reverted FROM, provenance rather than somewhere it is standing. Excluding it there
      // silently deleted a real cross-reference: MEASURED, a session that had fanned out and
      // then wrote a record naming that task plus one other saw the first name vanish, so a
      // 2-name TRUNK record was reclassified as a 1-name record and the reference edge to
      // the reverted-from task was never minted at all. Read `origin` before treating
      // spine_id as a position — the exact instruction that comment carries.
      if (report.position && report.position.origin !== 'trunk') {
        exclude.add(report.position.spineId);
      }
      const { named, warnings } = await extractNamedTaskIds(
        input.body,
        input.projectId,
        exclude,
        pool
      );
      report.namedTaskIds = named;
      report.warnings.push(...warnings);
    }

    // 3. Policy: ≥2 named tasks is TRUNK material — attached to each named task, member of
    //    nothing — UNLESS the writer is standing on a DELIBERATELY opened position.
    //
    //    THE PRECEDENCE GATE (SK1 fold-in). R0, three hundred lines above,
    //    states the contract: "explicit intent outranks every byproduct." A `branch_open` is
    //    the most explicit statement of position the system has — and until this gate, it
    //    lost to a heuristic read out of the record's own prose. That is the file
    //    contradicting its own documented rule, which makes this a correctness fix and not a
    //    preference.
    //
    //    THE ASYMMETRY, identical to the one the byproduct-yield rule turns on: demoting a
    //    deliberately-positioned write DISCARDS a declared fact about where its author stood,
    //    and discards it unrecoverably — nothing downstream can tell the membership ever
    //    existed. Keeping it costs a little precision (a coordination note citing several
    //    tasks is also a member of the branch its author opened), and that is recoverable by
    //    one explicit act. Measured 2026-08-15: an earlier decision were both
    //    written while standing on the strong-bones spine and both were demoted to weak
    //    trunk-refs for citing other ids in prose — exactly the records a later reader most
    //    needs to find on that branch.
    //
    //    NOTHING IS LOST: the `trunk-ref` edge to each named task still mints below, because
    //    it is gated on multiName rather than on the demotion. This is additive, not a swap.
    //
    //    ONLY 'declared' is protected — the same single-case rule as BYPRODUCT_YIELDS_TO_ORIGINS,
    //    for the same reason. 'auto' and 'byproduct' are inferred positions, so a prose signal
    //    is not outranked by them; 'trunk' is not a position at all.
    report.multiName = report.namedTaskIds.length >= 2;
    //    THE BY-TYPE ARM (P1). A `handoff` is trunk
    //    material because of WHAT IT IS, never because of where its author stood. It is
    //    ORed in ahead of the multi-name heuristic and consults no position at all —
    //    measured on prod 2026-08-21, 31 of 33 handoffs reached the trunk only BY ACCIDENT
    //    (their ANCHORS section happened to name >=2 task ids), and the only 2 that were
    //    trapped as branch members were trapped precisely BECAUSE their author had opened a
    //    position deliberately. The mechanism was exactly inverted from the intent.
    //
    //    THIS LINE ALONE DOES NOT IMPLEMENT THE RULE, and a review that stops here has been
    //    fooled: the `if (report.trunk) return report` below lives INSIDE `if
    //    (report.multiName)`, so a handoff naming 0 or 1 task ids — which is both of the
    //    records actually broken — falls straight through to the membership mint regardless
    //    of this flag. The terminal arm in the `blocked` ladder (step 4) is what makes the
    //    rule true; probe 2 in handoffIsAlwaysTrunk.contract.test.ts exists to catch a fix
    //    that was made here and nowhere else.
    report.trunk =
      input.contextType === TRUNK_CONTEXT_TYPE ||
      (report.multiName && report.position?.origin !== 'declared');

    // 3b. THE AUTO-OPEN RULES (R1/R2/R5) — after the scan, before every mint. See
    //     applyAutoOpenRules; R2's revert happens here so no wrong edge is ever written.
    if ((await applyAutoOpenRules(input, report, keys, pool)) === 'mint-nothing') {
      report.membership = { minted: false, reason: 'reverted-to-trunk' };
      return report;
    }

    if (report.multiName) {
      if (report.trunk) report.membership = { minted: false, reason: 'trunk-record' };
      for (const taskId of report.namedTaskIds) {
        const r = await mintEdge(
          {
            fromId: input.recordId,
            fromType: input.recordType,
            toId: taskId,
            toType: 'task',
            edgeType: 'related_to',
            projectId: input.projectId ?? null,
            createdBy: 'auto:positional',
            via: EDGE_MINT_VIA.trunkRef,
            metadata: {},
          },
          pool
        );
        report.edges.push({
          via: 'trunk-ref', edgeType: 'related_to', toType: 'task', toId: taskId, created: r.created,
        });
      }
      // DEMOTED records stop here (member of nothing). A record that kept its membership
      // falls through to the membership mint below with its trunk-refs already in place.
      if (report.trunk) return report;
    }

    // 4. Membership: standing there = membership (skipped only on explicit opt-out, when the
    //    record IS the spine — no self-link, which is also the R1 auto-open case — or at
    //    TRUNK, where R5 mints no membership at all).
    //
    // SK1 item c: the SAME condition now also names WHY when it is false. The order is the
    // order the reasons dominate in, and every arm is terminal — so there is no path through
    // this block that leaves `membership` unset, and no positioned write that mints nothing
    // without saying which of these it was.
    // REVALIDATE THE SOFT REFERENCE BEFORE ANY MINT (signal 2).
    // `branch_positions.spine_id` carries no FK — migration 080 explains why it cannot —
    // so an open position outlives a deleted spine, and the mint below happily attached a
    // DECLARED `informs` to it. MEASURED from a clean DB, not theorized: the pre-fix run of
    // tests/danglingSpine.contract.test.ts returned
    // `[{edge_type:'informs', created_by:'auto:positional'}]` to a task that had been
    // deleted. Rule, reason and rollback flag: config/danglingSpineConfig.ts.
    //
    // BOTH ENDS OF THE BRANCH ARE CHECKED, not just the root. R4 attaches a capture to the
    // TIP (positionTarget), so a live root with a deleted tip is a second way to reach the
    // same wrong edge — and it is the reachable one on a long auto branch, where the tip is
    // whatever record the session created most recently. Checking only `spineId` would fix
    // the case in the bug report and leave its sibling, which is the C5 half of this class.
    //
    // ONLY WHEN A MINT IS OTHERWISE POSSIBLE. An unkeyed, unpositioned or at-trunk write
    // mints nothing anyway, so asking the DB there would buy a query per write to change no
    // outcome and no message.
    let spineMissing = false;
    if (danglingSpineRefused() && report.position && report.position.origin !== 'trunk') {
      const pos = report.position;
      const ends: Array<{ id: string; type: SpineType }> = [{ id: pos.spineId, type: pos.spineType }];
      const tip = positionTarget(pos);
      if (tip.id !== pos.spineId) ends.push(tip);
      for (const end of ends) {
        if (!(await spineRecordExists(end.id, end.type, pool))) {
          spineMissing = true;
          report.warnings.push(
            `branch position skipped: the ${end.type} ${end.id.substring(0, 8)} it stands on ` +
              `no longer exists, so this write was made a member of NOTHING rather than of a ` +
              `record that is gone. branch_close to step off, or branch_open <id> to stand ` +
              `somewhere real.`
          );
          break;
        }
      }
    }

    const blocked: MembershipOutcome | null =
      // TRUNK MATERIAL FIRST, and terminal (P1). This is the arm that makes
      // "a handoff is never a branch member" TRUE for the <2-named-ids case; the multi-name
      // trunk record never reaches it (it returned above, with its trunk-refs minted).
      // Ahead of every other arm deliberately: the classification is a property of the
      // RECORD, so it does not become less true because the caller was also unkeyed or
      // unpositioned — and those two still surface verbatim in `keyRefusal` / `offer`.
      report.trunk ? 'trunk-record'
      : report.keyRefusal !== null ? 'key-refused'
      : !report.position ? 'no-position'
      : input.optedOut ? 'opted-out'
      : report.position.origin === 'trunk' ? 'at-trunk'
      // AHEAD OF record-is-spine, BEHIND opted-out and at-trunk. No arm here mints, so the
      // position in the ladder changes no edge — only which reason the caller is told. It
      // sits behind the two arms that describe what the CALLER did (opted out) or where the
      // session already was (trunk), because those answer "why did nothing mint" completely
      // on their own; it sits ahead of record-is-spine because a spine that is gone is not
      // a spine this record can be. The warning above is pushed unconditionally, so the
      // deleted branch is surfaced on every one of these paths regardless of this ordering.
      : spineMissing ? MEMBERSHIP_SPINE_MISSING
      : report.position.spineId === input.recordId ? 'record-is-spine'
      : null;
    if (blocked !== null) {
      report.membership = { minted: false, reason: blocked };
    }
    if (blocked === null && report.position) {
      const pos = report.position;

      // WHERE the membership edge points — the ONE line R3 and R4 differ on:
      //   • a CREATE attaches to the branch ROOT (R3). Deliberately not the tip: attaching
      //     creates to the tip walks the branch deeper on every record, and recall_thread's
      //     defaultDepth (threadConfig.ts) is 2 — a measured constraint, which is why
      //     naive position-move is on the design's already-rejected list.
      //   • a CAPTURE attaches to the TIP (R4), which positionTarget() resolves to the ROOT
      //     when no tip is set.
      // For a DECLARED position the two are the SAME value, always: migration 082 makes a
      // declared position with a tip an unreachable state, so positionTarget() can only
      // return the root. That is the mechanical reason R0 holds here.
      const isCreate = isCreateWrite(input.recordType);
      const target = isCreate ? { id: pos.spineId, type: pos.spineType } : positionTarget(pos);

      // ── THE MEMBERSHIP ROW. THIS is the fact (migration 086, branch_memberships).
      // WHICH BRANCH this write belongs to is `pos.spineId` — the position's ROOT — and it
      // is NOT recoverable from `target`. When the tip has advanced, target is an earlier
      // member, and a row in that shape is indistinguishable from a NESTED branch's write
      // (a different session standing on that member). SK2 round 1 tried to tell them apart
      // by walking, and could not: measured by the reviewer, branch_history returned 4 members
      // with truncated:false for a branch with 2.
      //
      // IT IS WRITTEN BEFORE, AND INDEPENDENTLY OF, THE EDGE — the round-3 fix. Rounds 1-3
      // all made membership parasitic on the `informs` edge below, and that edge can be
      // SWALLOWED: mintEdge is `ON CONFLICT (from_id, to_id, edge_type) DO NOTHING` and the
      // TAG mint already ran on this write path, so a record that is positioned on S and
      // also TAGS S loses this mint to the tag row. Measured on prod 2026-08-15 that had
      // silently unmembered roughly half of every active branch (an earlier decision and
      // 43e11051 on an earlier spine among them). Order matters here for one reason only: the
      // membership must be recorded even if the edge mint throws.
      const recordedMembership = await recordMembership(
        {
          recordId: input.recordId,
          recordType: input.recordType,
          spineId: pos.spineId,
          spineType: pos.spineType,
          attachedToId: target.id,
          attachedToType: target.type,
          projectId: pos.projectId,
        },
        pool
      );

      const r = await mintEdge(
        {
          fromId: input.recordId,
          fromType: input.recordType,
          toId: target.id,
          toType: target.type,
          edgeType: 'informs',
          projectId: input.projectId ?? null,
          createdBy: 'auto:positional',
          via: EDGE_MINT_VIA.position,
          metadata: {},
        },
        pool
      );
      report.edges.push({
        via: 'position', edgeType: 'informs', toType: target.type, toId: target.id, created: r.created,
      });
      // MINTED IS DERIVED FROM THE ROW THAT WAS JUST WRITTEN — never from the edge. `r.created`
      // is false on a dedup, and that is now genuinely irrelevant to membership: "already
      // linked" is true and sufficient, because the graph edge does exist. What the caller is
      // told is what `branch_memberships` says, so the report cannot claim a membership the
      // table does not hold.
      if (recordedMembership.recorded) {
        report.membership = { minted: true, reason: 'minted' };
      } else {
        // The PK says a write happens at ONE position, and one is already on file naming a
        // DIFFERENT branch. The first position wins; this is surfaced rather than merged,
        // because silently reporting a membership of the branch the caller asked about would
        // be the same lie in a new place.
        report.membership = { minted: false, reason: 'already-member-elsewhere' };
        report.warnings.push(
          `membership not recorded on ${pos.spineId.substring(0, 8)}: this record is already ` +
            `a member of ${recordedMembership.storedSpineId.substring(0, 8)} (a record belongs ` +
            `to one branch).`
        );
      }

      // (Step 4b — the positional `subtask_of` parent mint — was DELETED.
      //  `subtask_of` is a record-intrinsic structural claim; session position — "standing
      //  there" — cannot support it, declared or not. The edge now mints ONLY by explicit
      //  intent: the `parentTaskId` param on task_create (precedence ladder).
      //  This service mints `informs` membership and stops.)

      // 4c. R2/R3/R4 BOOKKEEPING — this write was a MEMBER write, so the position is no
      //     longer virgin (which is what stops R2 misreading a working session as fan-out),
      //     and a CREATE that extended the branch becomes the new TIP.
      //     Only auto positions carry this state: a declared position must stay tipless and
      //     byte-identical (R0), and 082's CHECK would reject a tip on one anyway.
      //
      //     A HANDOFF NO LONGER REACHES THIS BLOCK, AND THAT IS THE DELIBERATE CALL (P1,
      //     an earlier task). It is blocked as 'trunk-record' above, so it no longer marks an
      //     auto position as non-virgin. CONCRETELY: task_create auto-opens (virgin) →
      //     handoff → a second task_create now sees a still-virgin position and R2 reverts
      //     the session to trunk, where before the handoff would have kept the branch alive.
      //     ACCEPTED, not overlooked, for three reasons: (1) `memberWrites` counts MEMBER
      //     writes, and a handoff is by construction never a member — hoisting the call
      //     would make the column mean something other than its name, and R3/R4 read it to
      //     choose a TIP a handoff can never be; (2) the failure direction is MISSING edges,
      //     which the R2 design note above already accepts as the safe direction; (3) the
      //     sequence itself — write the resume point, then file the follow-up tasks — is the
      //     coordinator fan-out shape R2 exists to catch, so firing there is right.
      if (pos.origin === 'auto' && report.position) {
        const advanced = await noteMemberWrite(
          pos.projectId,
          pos.sessionKey,
          isCreate ? { id: input.recordId, type: asSpineType(input.recordType) } : null,
          pool
        );
        if (advanced) report.position = advanced;
      }
    }

    // 5. Single foreign name while positioned: member of position (above) + ONE weak ref.
    if (report.position && report.namedTaskIds.length === 1) {
      const taskId = report.namedTaskIds[0];
      const r = await mintEdge(
        {
          fromId: input.recordId,
          fromType: input.recordType,
          toId: taskId,
          toType: 'task',
          edgeType: 'related_to',
          projectId: input.projectId ?? null,
          createdBy: 'auto:positional',
          via: EDGE_MINT_VIA.namedRef,
          metadata: {},
        },
        pool
      );
      report.edges.push({
        via: 'named-ref', edgeType: 'related_to', toType: 'task', toId: taskId, created: r.created,
      });
    }

    // 6. The no-branch OFFER (D2: identifier ambient, copy free). Only when a branch COULD
    //    be opened (no refusal) and none is.
    if (!report.position && report.keyRefusal === null) {
      report.offer = `branch_open ${input.recordId.substring(0, 8)}`;
    }

    return report;
  } catch (error) {
    // Never break the write — the record is already persisted (same contract as every other
    // write-time minter). Surfaced in the report AND the log.
    logger.error('❌ positional mint failed (record already persisted; write not broken)', error as Error);
    report.warnings.push(`positional mint failed: ${(error as Error).message}`);
    // A throw is the one outcome that must never read as "you are simply not a member".
    report.membership = { minted: false, reason: 'mint-failed' };
    return report;
  }
}
