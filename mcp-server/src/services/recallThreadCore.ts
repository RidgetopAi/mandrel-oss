/**
 * recall_thread — the PURE core (Mandrel Core Redesign T3).
 *
 * This module is DB-FREE on purpose (no `pg` / no db import). It holds the deterministic
 * ordering + altitude-shaping + minTrust logic — the part that turns a gathered subgraph
 * into a readable, trust-ranked thread:
 *   - computeCausalRanks() — causal partial order from edge semantics (cycle-safe).
 *   - orderThread()        — causal-then-temporal sort, anchor pinned first.
 *   - shapeNode()          — altitude content shaping (headline/summary/full).
 *   - clearsMinTrust()     — the band/score floor (reuses the T2b band vocabulary).
 *
 * Keeping it here (no db) means the unit tests hammer it with ZERO database — deterministic,
 * offline, fast — exactly like trustModel.ts splits the pure math out of trust.ts (a past incident
 * : one definition of the rule, testable in isolation). The DB/graph GATHERING lives in
 * services/recallThread.ts, which imports these.
 */

import type { Trust, TrustReason } from './trustModel.js';
import { TRUST_BANDS, type TrustBand } from '../config/trustConfig.js';
import {
  type ThreadConfig,
  type ThreadAltitude,
} from '../config/threadConfig.js';
import {
  clipBody,
  projectBody,
  type SnippetBudget,
} from './altitudeProjection.js';
import { type Altitude } from '../config/altitudeConfig.js';
import { type EdgeNodeType, type EdgeType } from '../config/edgeTypes.js';
import {
  REVIEW_OUTCOME_CALL_KEY,
  REVIEW_OUTCOME_CLIP_SUFFIX,
  REVIEW_OUTCOME_MAX_CHARS,
  REVIEW_OUTCOME_METADATA_KEY,
} from '../config/reviewOutcomeConfig.js';
import {
  GATE_EXIT_CODE_KEYS,
  GATE_METADATA_KEY,
  GATE_NOT_RECORDED_LABEL,
  GATE_NOT_RUN_LABEL,
  GATE_RC_ABSENT_TOKEN,
  GATE_RC_LABELS,
  GATE_RC_LABEL_SEPARATOR,
  GATE_RC_UNRECOGNISED_LABEL,
  GATE_REF_KEYS,
  GATE_REF_RENDER_CHARS,
  GATE_REF_SEPARATOR,
  GATE_RUN_KEY,
} from '../config/gateExitCodeConfig.js';

/**
 * WHY THIS NODE IS ON THE DO-NOT-RELY LIST — as STRUCTURED FIELDS (P5.3 half A).
 *
 * THE BUG THIS CLOSES. recall_thread already COMPUTES all of this: which branch of the trust
 * math fired, who superseded the record, at what tier, at what confidence. It then rendered it
 * into a TEXT line and threw the structure away — so the only way to get it back was to
 * string-split the server's own prose. Our runtime shell does exactly that, in ~230 lines of
 * awk (`runtime/lib/boot-recall.sh`), splitting each node line at the LAST ` — trust:` and
 * scanning key:value tokens out of the tail. Its own comments enumerate how fragile that is:
 * a record TITLE containing the words `superseded_by:deadbeef` once made a merely-stale record
 * render as `SUPERSEDED → read deadbeef instead`, pointing at a record that does not exist
 * (measured 2026-08-22). Every one of those failure modes is a consequence of reading a field
 * out of prose, and every one of them vanishes when the field is a field.
 *
 * THE FIELD SET IS THE SHELL'S REAL REQUIREMENTS, not a guess at them — it was read off the
 * awk's own `field(tail, …)` calls and its two annotations. `replacementAlsoDropped` is the
 * "the record we are sending you to is ALSO on this list — keep walking the chain" case, which
 * the shell emits today.
 *
 * ONE THING IS DELIBERATELY BETTER THAN THE TEXT CHANNEL, and it is worth stating because it
 * is the point of the exercise: `supersededBy` here is the FULL id and
 * `replacementAlsoDropped` is computed by matching full ids. The text channel only ever
 * carried the 8-hex short id, so the shell's version of this flag can false-positive on two
 * uuids sharing a prefix (its comment says so, and calls it inherent to id8). It is not
 * inherent; it was an artefact of the straw.
 */
export interface NodeDropReason {
  /**
   * WHICH BRANCH of the trust math put this node on the list — `trust.reason`, verbatim,
   * NOT a second vocabulary. There is exactly one taxonomy of trust verdicts (TRUST_REASONS)
   * and inventing a parallel one here is how the two start disagreeing.
   */
  reason: TrustReason;
  /** The superseding record's FULL id, or null when this drop is not a supersession. */
  supersededBy: string | null;
  /** Which tier decided the supersession; null when there is none. */
  tier: 'declared' | 'soft' | null;
  /** Adjudicator confidence on the deciding edge; null for declared / no metadata / none. */
  conf: number | null;
  /**
   * True when `supersededBy` is ITSELF on this walk's do-not-rely list — i.e. the annotation
   * would otherwise send the reader from one record we just told them not to trust straight to
   * another. FALSE, not null, when there is no supersession at all: the question "is the
   * replacement also dropped" is answered "no" by there being no replacement.
   */
  replacementAlsoDropped: boolean;
  /**
   * True when `supersededBy` names a record that is a NODE IN THIS WALK. When false with a
   * non-null `supersededBy`, the reader is being pointed OUTSIDE the returned thread and
   * cannot expand the pointer from what they were given — a state the text channel could not
   * express at all, and the shell had to render as "NOT ANNOTATABLE".
   */
  replacementInWalk: boolean;
}

/** One ordered, trust-annotated, altitude-shaped node in the returned thread. */
export interface ThreadNode {
  id: string;
  type: EdgeNodeType;
  title: string | null;
  trust: Trust;
  /** Present at `summary` (snippet) / `full` (whole body); omitted at `headline`. */
  content?: string;
  /**
   * WHY this node is on the walk's do-not-rely (abstain) list — structured (P5.3 half A).
   * PRESENT IF AND ONLY IF `trust.abstain` is true, which is exactly the population the text
   * channel names in its `Do NOT rely on N node(s): …` line. Absent means "this node was not
   * de-emphasised", which is a different fact from "it was de-emphasised for no reason", and
   * the two must not render identically.
   */
  dropped?: NodeDropReason;
  /**
   * THE REVIEW CALL this record recorded — APPROVE / REJECT / APPROVE-PENDING-GATE / … —
   * read from the record's own `metadata.verdict`. PRESENT IF AND ONLY IF
   * the record stored one, so absence means "this record is not a review verdict, or its
   * writer stored no structured call" — never "the review failed".
   *
   * IT IS A FIELD, NOT PROSE, for the reason the whole `dropped` block above exists: a
   * verdict rendered only inside a clipped title is a verdict the reader cannot recover.
   * Structured here, every client (this repo's text channel AND the shell boot package that
   * reads structuredContent) renders the same call without parsing anyone's sentences.
   */
  reviewOutcome?: string;
  /**
   * THE GATE RUN this record recorded, as `<code><sep><label>[@<ref8>]` — read from the
   * record's own `metadata.gate`. PRESENT IF AND ONLY IF the record stored a
   * gate block, so absence means "this record says nothing about a gate", never "no gate ran".
   *
   * IT CARRIES THE RAW EXIT CODE, not just a word, and that is the deliverable: the gate's
   * namespace distinguishes 0 GREEN / 1 RED / 2 COULD-NOT-MEASURE / 3 SKIP / 40 STATIC-GREEN
   *, and a two-state GREEN/RED render collapses distinctions the gate
   * makes on purpose — telling a reader "it failed" when the truth is "we could not tell".
   * MEASURED before the fix: rc=1 and rc=2 rendered byte-identical lines.
   */
  gateOutcome?: string;
}

/**
 * BUILD the structured drop reason for ONE node. PURE — it reads the node's own Trust verdict
 * and the walk's abstain set, and computes nothing about trust itself.
 *
 * Returns null for a node that is NOT on the do-not-rely list. That is the whole gate: this
 * function has no opinion about which nodes should be de-emphasised, it only explains the ones
 * the trust math already flagged. One definition of "dropped" (`trust.abstain`), read here and
 * by the abstain list itself.
 */
export function dropReasonFor(
  node: { id: string; trust: Trust },
  abstainIds: ReadonlySet<string>,
  walkIds: ReadonlySet<string>
): NodeDropReason | null {
  if (!node.trust.abstain) return null; // trust-render-exempt: READS the computed flag as the gate for whether a drop reason exists; produces a structured field, not a marker
  const receipt = node.trust.supersession;
  const supersededBy = receipt?.supersededBy ?? null;
  return {
    reason: node.trust.reason,
    supersededBy,
    tier: receipt?.tier ?? null,
    conf: receipt?.confidence ?? null,
    // FULL-ID matching, deliberately — see the interface header.
    replacementAlsoDropped: supersededBy !== null && abstainIds.has(supersededBy),
    replacementInWalk: supersededBy !== null && walkIds.has(supersededBy),
  };
}

/** One edge in the collected subgraph (from → to, by type). */
export interface ThreadEdge {
  from: string;
  to: string;
  type: EdgeType;
}

// ─────────────────────────────────────────────────────────────────────────────
// FRONTIER PRIORITY — which reachable nodes survive the maxNodes cap (PURE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node discovered at a BFS level, awaiting admission under the `maxNodes` cap. The
 * traverse() gatherer builds these per level (DB side); the ranking below is PURE so it is
 * unit-testable with zero database (one definition of the rule, in isolation).
 */
export interface FrontierCandidate<T> {
  /** The candidate node id. */
  id: string;
  /** The edge type via which it was (best) reached — the PRIMARY priority signal. */
  edgeType: EdgeType;
  /**
   * A numeric SAME-CLASS tie-break (edge weight / similarity / confidence) read from the
   * reaching edge's metadata, or null when that edge carries none (most structural edges do).
   */
  weight: number | null;
  /**
   * Discovery order within the level — the FINAL, deterministic tie-break. Preserving it on a
   * full tie keeps the pre-prioritization insertion order, so the walk is unchanged when the
   * cap is NOT hit.
   */
  order: number;
  /** The caller's payload for an admitted candidate (the raw node to enqueue). */
  payload: T;
}

/**
 * The value-rank of an edge type (higher = higher priority = kept first under the cap).
 * Reads config.frontierEdgeTypePriority, falling back to the neutral default for an
 * unranked (e.g. newly added) edge type. PURE.
 */
export function edgeTypePriority(edgeType: EdgeType, config: ThreadConfig): number {
  const p = config.frontierEdgeTypePriority[edgeType];
  return typeof p === 'number' ? p : config.frontierDefaultEdgePriority;
}

/**
 * Read the numeric SAME-CLASS tie-break weight from an edge's metadata: the first configured
 * key (config.frontierWeightMetadataKeys) that is a finite number, else null. PURE — tolerant
 * of any metadata shape (pg returns jsonb as a parsed object; anything else → null).
 */
export function readEdgeWeight(metadata: unknown, config: ThreadConfig): number | null {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const m = metadata as Record<string, unknown>;
    for (const key of config.frontierWeightMetadataKeys) {
      const v = m[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/**
 * Order frontier candidates by DESCENDING priority so that, when the maxNodes cap forces a
 * subset, the HIGHEST-VALUE reachable nodes survive instead of arbitrary insertion order.
 * PURE, total, and STABLE. Sort key (each a tie-break of the previous):
 *   1. edge-type priority DESC — the structural/evidential value of the reaching edge,
 *   2. numeric edge weight DESC — same-class similarity/confidence; an absent weight sorts
 *      LAST within its tier (a present, comparable signal beats "no signal"),
 *   3. discovery order ASC — deterministic; preserves the pre-prioritization order on a full tie.
 * Returns a NEW array; does NOT apply the cap (the caller admits the prefix that fits). BFS
 * DEPTH is intentionally NOT a key here — the level-by-level walk already admits every closer
 * node before any farther one, so ranking only ever orders nodes at the SAME depth.
 */
export function prioritizeFrontier<T>(
  candidates: FrontierCandidate<T>[],
  config: ThreadConfig
): FrontierCandidate<T>[] {
  return [...candidates].sort((a, b) => {
    const pa = edgeTypePriority(a.edgeType, config);
    const pb = edgeTypePriority(b.edgeType, config);
    if (pa !== pb) return pb - pa; // higher edge-type priority first
    const wa = a.weight ?? Number.NEGATIVE_INFINITY;
    const wb = b.weight ?? Number.NEGATIVE_INFINITY;
    if (wa !== wb) return wb - wa; // higher same-class weight first; absent sorts last
    return a.order - b.order; // stable: original discovery order
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// minTrust — band/score floor (REUSES the T2b band vocabulary; no new trust math)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bands ordered most→least trustworthy (the T2b display order). Used to compare a
 * node's band against a `minTrust` BAND floor. superseded/contradicted are the bottom —
 * a minTrust of any quality band drops them.
 */
const BAND_RANK: Record<TrustBand, number> = TRUST_BANDS.reduce((acc, b, i) => {
  acc[b] = TRUST_BANDS.length - i; // trusted highest
  return acc;
}, {} as Record<TrustBand, number>);

/**
 * Does `trust` clear the `minTrust` floor? `minTrust` may be a BAND name (compare by the
 * display rank) OR a numeric score in [0,1] (compare blended score). Returns true when no
 * floor is set. (The ANCHOR is exempted by the caller, never here.)
 */
export function clearsMinTrust(trust: Trust, minTrust: TrustBand | number | undefined): boolean {
  if (minTrust === undefined) return true;
  if (typeof minTrust === 'number') {
    const s = trust.score ?? 0; // blended score is never null in practice; guard anyway
    return s >= minTrust;
  }
  const floorRank = BAND_RANK[minTrust];
  const nodeRank = BAND_RANK[trust.band as TrustBand]; // trust-render-exempt: RANKING, not rendering — no band token is emitted here (an earlier task guard)
  if (floorRank === undefined || nodeRank === undefined) return true; // unknown floor → no-op
  return nodeRank >= floorRank;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDERING — causal-by-edge-semantics, then temporal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edge causal SEMANTICS → which endpoint comes EARLIER in the story. The intent (spec §4):
 * a decision's evidence/contexts come BEFORE the decision, which comes BEFORE what it
 * caused/built. Each v1 edge type maps to a precedence DIRECTION:
 *   'forward'  → from precedes to.
 *   'reverse'  → to precedes from.
 *   (absent)   → carries no ordering (not in this map).
 *
 * The direction reflects what the edge MEANS (stored from→to per edgeTypes.ts):
 *   - learned_from (from cites to as evidence)      → REVERSE: the evidence (to) came first.
 *   - decided_by   (record → the decision it fed)   → FORWARD: the grounding precedes the decision.
 *   - caused       (from caused to)                 → FORWARD.
 *   - informs      (record → the task it fed)       → FORWARD: the record precedes the task.
 *   - produced_outcome (task → its outcome)         → FORWARD: the task precedes the outcome.
 *   - built_by     (artifact → the task that built it) → REVERSE: the build task came first.
 *   - proposed_by  (proposed → the proposer)        → REVERSE: the proposer came first.
 *   - supersedes   (newer → the one it replaces)    → REVERSE: the superseded came first.
 */
const CAUSAL_DIRECTION: Partial<Record<EdgeType, 'forward' | 'reverse'>> = {
  learned_from: 'reverse',
  decided_by: 'forward',
  caused: 'forward',
  informs: 'forward',
  produced_outcome: 'forward',
  built_by: 'reverse',
  proposed_by: 'reverse',
  supersedes: 'reverse',
  // depends_on is stored A→B meaning "A depends on B", so B must come FIRST in the story:
  // the thing you depend on precedes the thing that depends on it. 'reverse' = to precedes
  // from, which is exactly that ordering.
  depends_on: 'reverse',
};

/**
 * The causal ordering an edge type contributes to the story, or `undefined` when it carries
 * NONE (the weak/soft edges — related_to, possibly_supersedes — deliberately do not order).
 *
 * EXPORTED so the contract test can pin each direction against the
 * AUTHORITATIVE map rather than a copy of it — the same reason trust.ts exports
 * OUTCOME_OUT_EDGE_TYPES. A test that re-declares its own expected map proves only that the
 * copy agrees with itself.
 */
export function causalDirectionOf(edgeType: string): 'forward' | 'reverse' | undefined {
  return CAUSAL_DIRECTION[edgeType as EdgeType];
}

/**
 * Compute a causal "rank" per node from the edges: a longest-downstream-chain depth in the
 * causal DAG. Higher rank = EARLIER in the story (more flows from it). Cycle-safe (a node on
 * the current DFS stack returns 0 rather than recursing → a causal cycle can't hang). Pure;
 * edges whose endpoints aren't both in the node set are ignored (dangling).
 */
export function computeCausalRanks(nodeIds: string[], edges: ThreadEdge[]): Map<string, number> {
  const idset = new Set(nodeIds);
  const precedes = new Map<string, Set<string>>();
  for (const id of nodeIds) precedes.set(id, new Set());
  for (const e of edges) {
    if (!idset.has(e.from) || !idset.has(e.to)) continue;
    const dir = CAUSAL_DIRECTION[e.type];
    if (!dir) continue; // edge type carries no ordering
    // 'forward' → from precedes to; 'reverse' → to precedes from.
    const [a, b] = dir === 'reverse' ? [e.to, e.from] : [e.from, e.to];
    if (a === b) continue; // self-loop contributes no ordering
    precedes.get(a)!.add(b); // a comes before b
  }

  const rank = new Map<string, number>();
  const onStack = new Set<string>();
  function depthOf(id: string): number {
    if (rank.has(id)) return rank.get(id)!;
    if (onStack.has(id)) return 0; // cycle backstop — break without recursing
    onStack.add(id);
    let best = 0;
    for (const nxt of precedes.get(id) ?? []) best = Math.max(best, depthOf(nxt) + 1);
    onStack.delete(id);
    rank.set(id, best);
    return best;
  }
  for (const id of nodeIds) depthOf(id);
  return rank;
}

/**
 * Order the nodes into the readable thread (PURE). Sort key, in order:
 *   1. ANCHOR pinned FIRST (you asked to be read in ON it).
 *   2. CAUSAL: higher causal rank first (more flows FROM it → earlier in the story).
 *   3. TEMPORAL: older created_at first (tiebreaker — earlier in time reads first).
 *   4. STABLE: id (deterministic for identical-rank, identical-time nodes).
 */
export function orderThread<T extends { id: string; createdAt: Date | null }>(
  nodes: T[],
  edges: ThreadEdge[],
  anchorId: string
): T[] {
  const ranks = computeCausalRanks(nodes.map((n) => n.id), edges);
  const time = (n: T): number => (n.createdAt ? n.createdAt.getTime() : Number.POSITIVE_INFINITY);
  return [...nodes].sort((a, b) => {
    if (a.id === anchorId) return -1;
    if (b.id === anchorId) return 1;
    const ra = ranks.get(a.id) ?? 0;
    const rb = ranks.get(b.id) ?? 0;
    if (ra !== rb) return rb - ra; // higher rank first
    const ta = time(a);
    const tb = time(b);
    if (ta !== tb) return ta - tb; // older first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ALTITUDE SHAPING — content depth per node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape ONE node's content for the requested altitude (PURE):
 *   - headline → no content field at all (title + type + trust is the 1-liner).
 *   - summary  → content clipped to config.summarySnippetMaxlen (ellipsis when longer).
 *   - full     → the whole, untruncated content body.
 * A node with no content body simply omits the field at summary/full too.
 *
 * THE BODY RULE ITSELF NOW LIVES IN services/altitudeProjection.ts (SEARCH P3).
 * This function was the ONLY implementation of headline/summary/full when
 * recall_thread was the only tool that had them; all four read tools have them now, so the
 * rule was LIFTED to a shared, still-DB-free module rather than copied. What remains here is
 * the thread-specific part: the node shape, and reading the budget from THIS tool's config.
 *
 * FAIL-CLOSED ON AN UNRECOGNIZED ALTITUDE — still true, and still
 * for the same reason, but now enforced inside projectBody(). This function used to be a
 * two-branch if/else in which `headline` returned early, `full` returned the body, and EVERY
 * OTHER value silently fell through to the `summary` clip. The moment a second altitude AXIS
 * existed (the projection altitude `current`), passing one here would have rendered a summary
 * thread while claiming to be something else. shapeNode renders CONTENT DEPTH; a projection
 * altitude is a different question and must be routed to its own read model.
 */
export function shapeNode(
  raw: {
    id: string;
    type: EdgeNodeType;
    title: string | null;
    content: string | null;
    /** The record's jsonb metadata, where a stored review call lives. Optional: a caller
     *  that has none passes none, and the node simply carries no `reviewOutcome`. */
    metadata?: unknown;
  },
  trust: Trust,
  altitude: ThreadAltitude,
  config: ThreadConfig
): ThreadNode {
  const node: ThreadNode = { id: raw.id, type: raw.type, title: raw.title, trust };
  const projected = projectBody(raw.content, altitude as Altitude, threadSnippetBudget(config));
  if (projected.present) node.content = projected.text;
  // THE REVIEW CALL, AT EVERY ALTITUDE — including `headline`, which carries no body at all.
  // That is the whole point: the altitude that clips hardest is exactly the one a boot
  // package uses, and it is where the verdict was being lost.
  const outcome = reviewOutcomeOf(raw.metadata);
  if (outcome !== null) node.reviewOutcome = outcome;
  // THE GATE RUN, AT EVERY ALTITUDE — same reason as the review call above, and derived in
  // the same one place so both channels (story + current-state) inherit it by delegating
  // rather than by re-reading the key twice.
  const gate = gateOutcomeOf(raw.metadata);
  if (gate !== null) node.gateOutcome = gate;
  return node;
}

/**
 * READ THE REVIEW CALL off a record's metadata — the ONE definition, used by every surface.
 *
 * PURE, TOTAL, AND NULL-BIASED. Anything that is not a usable non-empty string returns
 * null: no metadata, a non-object, a missing key, an object without the call sub-key, a
 * number, a nested object, whitespace. Absence must render as ABSENCE — an invented label
 * ("verdict:unknown") on a record that never claimed one is precisely the fabrication the
 * blind readers were forced into when they inferred approval from a merge.
 *
 * IT NORMALISES, IT DOES NOT VALIDATE. Newlines and runs of whitespace collapse to single
 * spaces (this renders inside a one-line stamp; a stored newline would otherwise split the
 * line and hand every downstream line-parser a fragment), and the result is bounded by
 * REVIEW_OUTCOME_MAX_CHARS. It does NOT check the call against a vocabulary — see the
 * config header for why that is deliberate.
 */
export function reviewOutcomeOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[REVIEW_OUTCOME_METADATA_KEY];
  let call: unknown = raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    call = (raw as Record<string, unknown>)[REVIEW_OUTCOME_CALL_KEY];
  }
  if (typeof call !== 'string') return null;
  const flat = call.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > REVIEW_OUTCOME_MAX_CHARS
    ? flat.slice(0, REVIEW_OUTCOME_MAX_CHARS) + REVIEW_OUTCOME_CLIP_SUFFIX
    : flat;
}

/**
 * READ THE GATE RUN off a record's metadata — the ONE definition, used by every surface.
 *
 * PURE, TOTAL, AND NULL-BIASED, exactly like reviewOutcomeOf. A record with no `metadata.gate`
 * returns null and renders NOTHING: a gate stamp on a record that never claimed a gate is the
 * same fabrication as inventing a verdict.
 *
 * WHAT IT RETURNS, and why each state is its own string (CLASSES.md C1 — an
 * instrument has THREE states and "could not measure" never shares a value with "no"):
 *
 *   `0=GREEN@3fd825a2`      a MEASURED pass, on a named ref
 *   `1=RED@9305a39a`        a MEASURED failure — a bug to fix
 *   `2=CANNOT-MEASURE@…`    NOT a verdict on the commit — an instrument to repair
 *   `3=SKIP`                not applicable to this ref
 *   `40=STATIC-GREEN`       the subset passed; NOT the ship condition
 *   `7=UNRECOGNISED`        a code this table has no name for. The CODE still renders, so it
 *                           stays recoverable; it is never folded into a verdict
 *   `none=NOT-RUN`          the writer DECLARED `run:false` (30 records on prod)
 *   `none=NOT-RECORDED`     a gate was mentioned and no code can be read out of it — the
 *                           state the task names: a GREEN with no rc must be visibly
 *                           distinguishable from rc=0 and rc=40
 *
 * IT NORMALISES, IT DOES NOT VALIDATE THE REF. The ref is clipped to its first
 * GATE_REF_RENDER_CHARS and whitespace-collapsed; it is not checked for hex-ness, because a
 * ref this module refused to render is a ref the reader cannot recover, which is the defect.
 * The FULL stored value still travels on the structured channel inside `metadata`.
 *
 * PRECEDENCE, stated because it is a judgement: a READABLE EXIT CODE WINS OVER `run:false`.
 * A record carrying both (measured: prod stores `{run:false, exitCode:null}`) has an explicit
 * null, which is not readable, so it renders NOT-RUN — but if a writer ever records a real
 * code beside a stale `run:false`, the measurement is the stronger fact and is what renders.
 */
export function gateOutcomeOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const block = (metadata as Record<string, unknown>)[GATE_METADATA_KEY];
  if (block === undefined || block === null) return null;

  // A STRING gate block is free prose (14 records on prod). Something was said about a gate
  // and no code is recoverable from it — that is NOT-RECORDED, and it is deliberately not
  // read as NOT-RUN: this module does not parse anyone's sentences to decide whether a gate
  // ran, which is precisely the inference the structured field exists to replace.
  if (typeof block !== 'object' || Array.isArray(block)) {
    return `${GATE_RC_ABSENT_TOKEN}${GATE_RC_LABEL_SEPARATOR}${GATE_NOT_RECORDED_LABEL}`;
  }

  const bag = block as Record<string, unknown>;

  let code: number | null = null;
  for (const key of GATE_EXIT_CODE_KEYS) {
    const raw = bag[key];
    // NUMBERS ONLY — deliberately not Number(raw). Two prod records store prose in the
    // numeric field ("NOT RUN - outstanding, the coordinator's"); coercing it would yield NaN, and
    // coercing a numeric STRING would quietly accept a shape nothing writes. Unreadable is
    // unreadable, and it renders as NOT-RECORDED below.
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      code = raw;
      break;
    }
  }

  let ref: string | null = null;
  for (const key of GATE_REF_KEYS) {
    const raw = bag[key];
    if (typeof raw === 'string') {
      const flat = raw.replace(/\s+/g, ' ').trim();
      if (flat.length > 0) {
        ref = flat.slice(0, GATE_REF_RENDER_CHARS);
        break;
      }
    }
  }

  let head: string;
  if (code !== null) {
    const label = Object.prototype.hasOwnProperty.call(GATE_RC_LABELS, code)
      ? GATE_RC_LABELS[code]
      : GATE_RC_UNRECOGNISED_LABEL;
    head = `${code}${GATE_RC_LABEL_SEPARATOR}${label}`;
  } else if (bag[GATE_RUN_KEY] === false) {
    head = `${GATE_RC_ABSENT_TOKEN}${GATE_RC_LABEL_SEPARATOR}${GATE_NOT_RUN_LABEL}`;
  } else {
    head = `${GATE_RC_ABSENT_TOKEN}${GATE_RC_LABEL_SEPARATOR}${GATE_NOT_RECORDED_LABEL}`;
  }

  // NO CLIP HERE, AND THAT IS DELIBERATE — see GATE_STAMP_WORST_CASE_CHARS. The only
  // free-form input has already been bounded (the ref, above); the rest is a finite number
  // and a label from a closed table, so the stamp is bounded by construction. A clip was
  // written here first and deleted: it could never fire, and a guard that cannot fire is
  // dead weight that reads as protection.
  return ref === null ? head : `${head}${GATE_REF_SEPARATOR}${ref}`;
}

/** This thread's snippet budget, read from ITS named config — never a literal. */
export function threadSnippetBudget(config: ThreadConfig): SnippetBudget {
  return { maxlen: config.summarySnippetMaxlen, affordance: config.summaryClipAffordance };
}

/**
 * THE ONE definition of the `summary` snippet clip — the text AND how much it dropped.
 *
 * Both the shaping path (shapeNode) and the accounting path (buildThread's clippedNodes
 * tally) call this, so the count in the prose can never disagree with what was actually
 * clipped. `omittedChars` is 0 for an unclipped body, which is what makes the caller's
 * tally a measurement rather than a re-derivation of the same rule in a second place.
 *
 * The suffix is the config-driven ACTIONABLE affordance, not a bare '…' — a reader has to
 * be able to tell how much was removed and how to get it (naming the `altitude` argument).
 */
export function clipSummaryBody(
  body: string,
  config: ThreadConfig
): { text: string; omittedChars: number } {
  return clipBody(body, threadSnippetBudget(config));
}
