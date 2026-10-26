/**
 * recall_thread — the thread/traversal config (Mandrel Core Redesign T3).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob recall_thread touches — BFS depth, the per-node content budget at each
 * altitude, the total-node cap — lives HERE: a named value with an operator-aligned default,
 * a one-line doc comment, and an env override. Never a literal buried in the service.
 * This mirrors recallConfig.ts (T1), edgeTypes.ts (T2a) and trustConfig.ts (T2b): the
 * config is the contract, the code reads it. The whole point is that the tool is TUNABLE
 * (the eval gate can sweep any knob via env with zero code edit).
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default),
 * exactly like recallConfig.envInt / trustConfig.envFloat.
 */

import { ALTITUDES, isAltitude, type Altitude } from './altitudeConfig.js';

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a string env var, falling back to `fallback` on missing/empty. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

/**
 * The DEFAULT clipped-snippet affordance. `{omitted}` = characters dropped. Names the
 * `altitude` ARGUMENT (see ThreadConfig.summaryClipAffordance for why it must not name an
 * env var).
 */
export const THREAD_SUMMARY_CLIP_AFFORDANCE =
  '…[clipped: {omitted} more chars — re-call with altitude: "full" for the whole body]';

/** Substitute the omitted-char count into a clip affordance template. ONE definition. */
export function formatClipAffordance(template: string, omittedChars: number): string {
  return template.replace('{omitted}', String(omittedChars));
}

/**
 * FRONTIER EDGE-TYPE PRIORITY (the maxNodes-cap survival ranking).
 *
 * WHY: the BFS caps the thread at `maxNodes` DISTINCT nodes. When the cap BITES (more was
 * reachable), the survivors must be the HIGHEST-VALUE reachable nodes — not whichever ones
 * happened to be enqueued first (raw getLinks/insertion order). The only value signal EVERY
 * edge carries at cap time is its `edge_type` — a first-class field whose TIER SEPARATION is
 * explicitly documented in config/edgeTypes.ts: structural/evidential edges are the spine of
 * the story, `possibly_supersedes` is a SOFT below-the-hard-bar signal, and `related_to` is
 * explicitly "a low-confidence, inferred association; NOT evidence". This map materializes
 * those documented tiers as a tunable rank (higher = kept first under the cap). The fine-grained
 * ordering WITHIN the structural tier (the 100/90/80/70/60 spread below) is this module's own
 * heuristic — NOT an edgeTypes.ts-documented spec — and only ever breaks ties among same-tier,
 * same-depth edges.
 * A numeric same-class tie-break (edge weight/similarity/confidence) is layered on top from
 * FRONTIER_WEIGHT_METADATA_KEYS where an edge actually carries one (only the soft/inferred
 * classes do — related_to.metadata.similarity, possibly_supersedes.metadata.confidence).
 *
 * NO HARDCODED VARIABLES (standing rule): this is the ONE named home for the ranking; the
 * traverse() cap reads it, never a literal. It is a value-POLICY map (grounded in the edge
 * semantics), not a per-run sweep knob, so — like edgeTypes.ts / recallThreadCore's
 * CAUSAL_DIRECTION — it lives as a named config default rather than an env scalar. The
 * scalar backstop (FRONTIER_DEFAULT_EDGE_PRIORITY) IS env-overridable.
 */
export const FRONTIER_EDGE_TYPE_PRIORITY: Readonly<Record<string, number>> = {
  // Structural / evidential edges — the spine of the story; kept first when the cap bites.
  decided_by: 100,
  supersedes: 100,
  informs: 90,
  produced_outcome: 90,
  caused: 80,
  learned_from: 80,
  built_by: 70,
  // Task→task SCHEDULING structure. Structural tier: a dependency is real,
  // stated structure and belongs above the weak/soft tiers — but it is not EVIDENCE, so it
  // ranks below the evidential edges (decided_by/informs/learned_from) that carry the story.
  depends_on: 70,
  // Task→task CONTAINMENT structure (PHASE 1 positional membership, 
  // migration 080): the positional parent edge minted at task_create while standing on a
  // task spine. Same structural-not-evidence tier as depends_on, for the same reason.
  subtask_of: 70,
  proposed_by: 60,
  // SOFT belief edge (below the hard bar) — kept only after structural evidence.
  possibly_supersedes: 30,
  // WEAK inferred association ("NOT evidence") — the first to be dropped under the cap.
  related_to: 10,
};

/**
 * The edge-metadata keys that hold a numeric SAME-CLASS tie-break weight, checked in order
 * (first finite number wins). These are the only weights the edge store actually persists:
 * inferred `related_to` edges carry `similarity` (cosine); belief `possibly_supersedes` edges
 * carry `confidence` (adjudicator). Used ONLY to order two candidates of the SAME edge-type
 * tier — never to override the tier itself (a cosine on a weak related_to must not beat a
 * structural decided_by that carries no number).
 */
export const FRONTIER_WEIGHT_METADATA_KEYS: readonly string[] = ['similarity', 'confidence'];

/**
 * THE CONTENT ALTITUDES (spec §4 Capability 2) — the zoom level recall_thread renders each
 * node's CONTENT at. Defined ONCE here so the zod enum, the route logic, the content-shaping,
 * and the docs all reference one source (mirrors recallConfig.RECALL_RESPONSE_FORMATS).
 *
 *   headline — title + type + trust only (a 1-liner per node; no content body).
 *   summary  — headline PLUS a short content snippet (default; "digest" altitude).
 *   full     — headline PLUS the full, untruncated content body.
 *
 * These three form a ZOOM axis: same nodes, more/less body per node. shapeNode() accepts
 * EXACTLY these and nothing else (an altitude off this axis is a loud throw, not a silent
 * fall-through to `summary`).
 *
 * DERIVED, NOT RE-DECLARED (SEARCH P3): the list itself now lives in
 * config/altitudeConfig.ts, which is the ONE vocabulary all four read tools share. This
 * name is kept because the thread code reads in terms of "content altitude" (as opposed to
 * a PROJECTION altitude, a distinction only this module has), but it is the same array — a
 * second copy is exactly how three names for one idea happened in the first place.
 */
export const THREAD_CONTENT_ALTITUDES = ALTITUDES;
export type ThreadContentAltitude = Altitude;

/**
 * THE PROJECTION ALTITUDES — a DIFFERENT axis from the zoom above. A projection altitude
 * does not change how much of each node's body you get; it changes WHICH nodes you get and
 * how they are grouped, by running a deterministic query over the collected subgraph.
 *
 *   current — the deterministic CURRENT-STATE read model:
 *             root gate, active tasks, latest trusted outcomes, unresolved blockers/findings,
 *             current decisions, the artifact/release head, a recommended next action, and
 *             superseded nodes OMITTED BUT COUNTED. Orients an agent in ONE bounded response
 *             at hundreds of nodes; drill down by re-calling at a content altitude.
 *
 * NAMING (deliberate): this is NOT called `frontier`. `frontier` already means
 * the TRAVERSAL frontier in this very module family (FRONTIER_EDGE_TYPE_PRIORITY, the
 * maxNodes-cap survival ranking, prioritizeFrontier). Stacking a second, unrelated meaning on
 * that token inside the same module is exactly the drift this codebase keeps paying for.
 */
export const THREAD_PROJECTION_ALTITUDES = ['current'] as const;
export type ThreadProjectionAltitude = (typeof THREAD_PROJECTION_ALTITUDES)[number];

/**
 * The FULL altitude vocabulary the `altitude` argument accepts — the zoom axis plus the
 * projection axis. The zod enum derives from THIS, so a new altitude is added in one place.
 */
export const THREAD_ALTITUDES = [
  ...THREAD_CONTENT_ALTITUDES,
  ...THREAD_PROJECTION_ALTITUDES,
] as const;
export type ThreadAltitude = (typeof THREAD_ALTITUDES)[number];

/** Is this altitude a CONTENT (zoom) altitude — i.e. one shapeNode() can render? */
export function isContentAltitude(altitude: string): altitude is ThreadContentAltitude {
  return isAltitude(altitude);
}

/** Is this altitude a PROJECTION altitude — i.e. one that runs a read model, not a zoom? */
export function isProjectionAltitude(altitude: string): altitude is ThreadProjectionAltitude {
  return (THREAD_PROJECTION_ALTITUDES as readonly string[]).includes(altitude);
}

/** The default altitude when the caller omits `altitude` (spec: default `summary`). */
export const THREAD_DEFAULT_ALTITUDE: ThreadContentAltitude = 'summary';

/**
 * THE THREAD KNOBS (the operator-aligned defaults, spec §4 Capability 2).
 *
 * Each field is env-overridable so the eval gate can sweep the traversal/payload shape
 * without a code edit.
 */
export interface ThreadConfig {
  /**
   * default_depth — the BFS depth (hops from the anchor) walked when the caller omits
   * `depth`. depth 2 reaches a record's neighbours and THEIR neighbours — the branch — and
   * stops before the graph welds unrelated branches together.
   *
   * WHY 2 AND NOT 3 (the original spec §4 value). Measured on five real anchors in the dev
   * snapshot; distinct nodes reachable at depth 1/2/3 (anchor included):
   *   an earlier change 11/36/83 · an earlier change 50/109/231 · an earlier change 4/9/41 · an earlier change 7/19/94 ·
   *   an earlier change 17/46/92.
   * The third hop is where the subgraph stops being a branch: on the P0-security anchor
   * an earlier change, depth 3 admitted an unrelated Calendar PNG-export handoff (an earlier change) that
   * then ordered SECOND and THIRD in the returned story, ahead of the security work the
   * caller asked for. It is absent at depth 2 on all five. The hop that admitted it was a
   * `decided_by` edge off a depth-2 decision — NOT the handoff `supersedes` chain, which was
   * the standing hypothesis; excluding supersedes+possibly_supersedes was measured and moves
   * an earlier change's depth-3 population only 92 → 87, so depth is the lever and an edge-type
   * exclusion is not. Env: MANDREL_THREAD_DEFAULT_DEPTH. Default 2.
   */
  defaultDepth: number;
  /**
   * max_depth — a HARD ceiling on `depth` regardless of what the caller asks for, so a
   * caller can't force an unbounded walk of a huge graph. A requested depth above this is
   * clamped DOWN to it (honest: the response reports the effective depth used).
   * Env: MANDREL_THREAD_MAX_DEPTH. Default 6.
   */
  maxDepth: number;
  /**
   * max_nodes — the TOTAL node cap for one thread. BFS stops collecting once this many
   * DISTINCT nodes (anchor included) are gathered; if more were reachable the response
   * sets `truncated:true` with a "N more" signal (no silent cap — spec §2/§4). Protects
   * the model window + the DB from a huge fan-out anchor.
   *
   * WHY 150 AND NOT 50. At 50 the cap truncated 5/5 real branches (worst: 50 of 196, 26%),
   * and an honest report of a missing 74% is not a resumable thread. Measured at the new
   * default depth 2, cap 150 returns all five branches COMPLETE (0 truncated). The cost is
   * not uniform: 4 of the 5 anchors are BYTE-IDENTICAL because the cap never bites for them
   * (36/9/19/46 nodes), and only the hub anchor grows, 50→109 nodes and ~13.4k→
   * ~29.1k response tokens. Summed over the five anchors the response is SMALLER than the
   * shipped depth-3/cap-50 default, because depth 2 removes far more than cap 150 adds.
   * A caller who wants a different budget passes the per-call `maxNodes` argument — no env
   * var, since a customer running Mandrel in a container cannot set one.
   * Env: MANDREL_THREAD_MAX_NODES. Default 150.
   */
  maxNodes: number;
  /**
   * max_nodes_ceiling — a HARD ceiling on the per-call `maxNodes` argument, the node-count
   * analogue of maxDepth. A caller asking for more is clamped DOWN to it (honest: the
   * response reports `maxNodesUsed`). Exists so raising the default cannot become an
   * unbounded-payload lever for a caller on a huge graph.
   * Env: MANDREL_THREAD_MAX_NODES_CEILING. Default 500.
   */
  maxNodesCeiling: number;
  /**
   * summary_snippet_maxlen — at the `summary` altitude, the max characters of a node's
   * content returned per node (clipped with an ellipsis when longer). Keeps a multi-node
   * thread lean while still recognisable. `full` returns untruncated; `headline` returns
   * none. Env: MANDREL_THREAD_SUMMARY_SNIPPET_MAXLEN. Default 280 (~a few sentences).
   */
  summarySnippetMaxlen: number;
  /**
   * summary_clip_affordance — the suffix appended to a snippet that WAS clipped at
   * `summarySnippetMaxlen`. A bare '…' told the reader something was removed but neither
   * HOW MUCH nor HOW TO GET IT, while the sibling clipper (config/recallConfig.ts
   * recallSnippetBudget) has always appended a full actionable re-call string. Two clippers,
   * one honest — this closes it. (Both now run through the SAME clipBody in
   * services/altitudeProjection.ts; the sibling's old applyRecallPayload was deleted in an earlier task
   * once nothing called it.)
   *
   * `{omitted}` is substituted with the number of characters dropped. The affordance names
   * an ARGUMENT (`altitude`), never an env var: a customer running Mandrel in a per-tenant
   * container cannot set an env var, so an env-var hint is not an affordance at all — the
   * same rule the truncation hint in recall.routes.ts already follows.
   * Env: MANDREL_THREAD_SUMMARY_CLIP_AFFORDANCE.
   */
  summaryClipAffordance: string;
  /**
   * frontier_edge_type_priority — the maxNodes-cap SURVIVAL ranking. Maps each edge type to
   * a value rank (higher = kept first when the cap bites), materializing edgeTypes.ts's
   * documented value ordering (structural > soft > weak). Read by traverse() to prioritize
   * the BFS frontier BEFORE applying the cap, so the highest-value reachable nodes survive
   * instead of arbitrary insertion order. Named-config default (a value policy, not a sweep
   * knob) = FRONTIER_EDGE_TYPE_PRIORITY.
   */
  frontierEdgeTypePriority: Readonly<Record<string, number>>;
  /**
   * frontier_default_edge_priority — the rank for an edge type NOT in the priority map (e.g.
   * a newly added edge type before it's ranked). Deliberately NEUTRAL: above the weak/soft
   * tiers, below structural, so a new type is neither preferred nor dropped-first by default.
   * Env: MANDREL_THREAD_FRONTIER_DEFAULT_PRIORITY. Default 50.
   */
  frontierDefaultEdgePriority: number;
  /**
   * frontier_weight_metadata_keys — edge-metadata keys holding a numeric SAME-CLASS tie-break
   * weight (checked in order; first finite number wins). Orders two candidates of the SAME
   * edge-type tier; never overrides the tier. Named-config default = FRONTIER_WEIGHT_METADATA_KEYS.
   */
  frontierWeightMetadataKeys: readonly string[];
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are the operator-aligned §4 values;
 * every one is env-overridable for the eval sweep.
 */
export const THREAD_CONFIG: ThreadConfig = {
  defaultDepth: envInt('MANDREL_THREAD_DEFAULT_DEPTH', 2),
  maxDepth: envInt('MANDREL_THREAD_MAX_DEPTH', 6),
  maxNodes: envInt('MANDREL_THREAD_MAX_NODES', 150),
  maxNodesCeiling: envInt('MANDREL_THREAD_MAX_NODES_CEILING', 500),
  summarySnippetMaxlen: envInt('MANDREL_THREAD_SUMMARY_SNIPPET_MAXLEN', 280),
  summaryClipAffordance: envStr(
    'MANDREL_THREAD_SUMMARY_CLIP_AFFORDANCE',
    THREAD_SUMMARY_CLIP_AFFORDANCE
  ),
  frontierEdgeTypePriority: FRONTIER_EDGE_TYPE_PRIORITY,
  frontierDefaultEdgePriority: envInt('MANDREL_THREAD_FRONTIER_DEFAULT_PRIORITY', 50),
  frontierWeightMetadataKeys: FRONTIER_WEIGHT_METADATA_KEYS,
};
