/**
 * TYPED-EDGE GRAPH — the edge-type domain (single source of truth).
 *
 * Mandrel Core Redesign T2a, spec §4 Capability 1 + §8.1 Q1/Q3.
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. The edge-type
 * vocabulary lives here, ONCE. Both the database CHECK constraint (migration 049) and
 * the zod validation (link/unlink/get_links) derive from THIS module — they can never
 * drift. A new edge type is added here and everywhere else follows.
 *
 * EDGES CARRY STRUCTURE; TAGS CARRY LABELS (spec §8.1 Q1 LOCKED). The `links` table is
 * the real, bidirectional, repairable replacement for string-tag threading. Tags stay,
 * demoted to the human-viewable lens/label path (`scope:`/`owner:`/`ref:`).
 *
 * DIRECTION CONVENTION: every edge is stored from `from_id` → `to_id`. The semantic
 * direction of each edge type is documented below so a reader (and the future
 * recall_thread traversal in T3) knows which way the arrow points. The store indexes
 * BOTH (from_id, edge_type) and (to_id, edge_type) so the graph can be walked in either
 * direction regardless of how an edge was minted.
 */

/** The kind of record an edge endpoint refers to. Matches the resolvable entity set. */
export const EDGE_NODE_TYPES = ['context', 'decision', 'task'] as const;
export type EdgeNodeType = (typeof EDGE_NODE_TYPES)[number];

/**
 * A v1 edge-type spec — the value, its semantic direction, and a human description.
 * `from`/`to` document the EXPECTED endpoint kinds (advisory for readers/traversal;
 * the DB does not FK-constrain endpoint type because endpoints span three tables).
 */
export interface EdgeTypeSpec {
  /** The canonical edge-type value (lowercase snake; stored in links.edge_type). */
  readonly type: string;
  /** Human-readable semantic direction of the from→to arrow. */
  readonly direction: string;
  /** What this edge means. */
  readonly description: string;
  /** The reverse-reading label (how to read the edge to→from), for surfacing. */
  readonly reverse: string;
}

/**
 * THE v1 EDGE-TYPE DOMAIN (spec §4 Capability 1). Ordered as the spec lists them.
 *
 * Stored from→to. Read each `direction` as "from {description}".
 */
export const EDGE_TYPE_SPECS: readonly EdgeTypeSpec[] = [
  {
    type: 'decided_by',
    direction: 'record → decision',
    description: 'this record (context/task) was decided by the target decision',
    reverse: 'decides',
  },
  {
    type: 'caused',
    direction: 'record → record',
    description: 'the source caused / led to the target (causal/temporal link)',
    reverse: 'caused_by',
  },
  {
    type: 'built_by',
    direction: 'record → task',
    description: 'this record (decision/context) was built by the target task',
    reverse: 'builds',
  },
  {
    type: 'supersedes',
    direction: 'record → record',
    description: 'the source supersedes (replaces) the target — the target is demoted',
    reverse: 'superseded_by',
  },
  {
    // SOFT belief edge (belief-layer two-tier v1, BL-3). The soft counterpart to
    // `supersedes`: the belief adjudicator judged the source a REAL supersession candidate
    // for the target but the pair MISSED the tight hard-mint bar (confidence and/or cosine
    // short of the thresholds). Minted as its own edge so the soft signal is DATA, not an
    // annotation — mutually exclusive with `supersedes` on a pair (edgeReconciliation.ts).
    // SOFT recall consequence (belief BL-4): trust.ts reads an inbound `possibly_supersedes`
    // as a SOFT supersession — it DEMOTES the target's trust score (softSuperseded=true) but
    // never abstains/drops it ("flag when unsure, still show it"). A DECLARED (human/link/
    // write-time) `supersedes` still HARD-caps; a `possibly_supersedes` never does. Never in
    // trust.ts OUTCOME_OUT_EDGE_TYPES (it is not an outcome edge).
    type: 'possibly_supersedes',
    direction: 'record → record',
    description: 'the source is a SOFT (below-hard-bar) supersession candidate for the target — trust demotes (never abstains) it (BL-4)',
    reverse: 'possibly_superseded_by',
  },
  {
    type: 'learned_from',
    direction: 'record → record',
    description: 'the source was learned from / cites the target as evidence',
    reverse: 'informed_learning',
  },
  {
    type: 'proposed_by',
    direction: 'record → record',
    description: 'this record was proposed by the target (e.g. an agent/decision)',
    reverse: 'proposes',
  },
  {
    type: 'informs',
    direction: 'record → task',
    description: 'this record (context/decision) informs the target task — the moat edge for outcome trust',
    reverse: 'informed_by',
  },
  {
    type: 'produced_outcome',
    direction: 'task → outcome',
    description: 'the task produced the target outcome record (closes the learning loop)',
    reverse: 'outcome_of',
  },
  {
    // TASK SCHEDULING STRUCTURE (task-source edge minting, an earlier change Q2). The ONE strong
    // task→task type added with this work, justified by an UNAMBIGUOUS signal that already
    // exists: the typed, resolver-validated, capped `dependencies` field on task_create.
    // A strong edge earns its strength from a strong signal.
    //
    // Deliberately the ONLY one. `subtask_of` / `follows_from` are NOT added: a `task:<id8>`
    // tag on a task is genuinely ambiguous (subtask-of / follow-up-of / blocks / duplicates /
    // same-workstream), and spending a vocabulary slot on a guess would repeat the original
    // sin in mirror image. That case mints `related_to` + source_tag instead, which is
    // losslessly upgradeable once usage evidence exists.
    //
    // NOT AN OUTCOME EDGE — it must NEVER enter trust.ts OUTCOME_OUT_EDGE_TYPES (guarded
    // there by a load-time assertion). A dependency is SCHEDULING STRUCTURE, not evidence:
    // task A depending on task B says nothing about whether B's outcome is A's evidence.
    type: 'depends_on',
    direction: 'task → task',
    description: 'the source task depends on the target task (scheduling structure, NOT outcome evidence)',
    reverse: 'blocks',
  },
  {
    // STRUCTURAL PARENT edge (migration 080; introduced by PHASE 1).
    // Minted at task_create ONLY from the explicit `parentTaskId` param:
    // `subtask_of` is a record-intrinsic containment claim, and session position
    // — "standing on" a branch — cannot support it, so the positional mint was deleted.
    //
    // WHY THIS EARNS A VOCABULARY SLOT where an earlier change's `subtask_of` was declined: that
    // refusal was about the `task:<id8>` TAG being an AMBIGUOUS signal (subtask-of /
    // follow-up-of / blocks / duplicates). A first-class `parentTaskId` param is not
    // ambiguous — it names the parent outright. A strong edge earns its strength from a
    // strong signal, and declared intent is the strongest one.
    //
    // NOT AN OUTCOME EDGE — must NEVER enter trust.ts OUTCOME_OUT_EDGE_TYPES (guarded there
    // by the load-time assertion): containment is structure, not evidence.
    type: 'subtask_of',
    direction: 'task → task',
    description: 'the source task is a sub-branch/subtask of the target task (structural parent, declared via task_create parentTaskId; NOT outcome evidence)',
    reverse: 'parent_of',
  },
  {
    // WEAK / NON-EVIDENCE edge (reliable-auto-threading, ST-1). Minted by write-time
    // inference (Component B) when there is no explicit link and no valid anchor, so a
    // store is never a silent orphan. It is a LOW-CONFIDENCE, inferred association —
    // deliberately NOT a trust-bearing outcome edge. It MUST NOT appear in
    // services/trust.ts OUTCOME_OUT_EDGE_TYPES (guarded there by a load-time assertion):
    // minting a related_to edge moves NO trust score.
    type: 'related_to',
    direction: 'record → record',
    description: 'a low-confidence, inferred association; NOT evidence',
    reverse: 'associated_with',
  },
] as const;

/** The flat list of allowed edge-type values — the SINGLE source the DB + zod derive from. */
export const EDGE_TYPES: readonly string[] = EDGE_TYPE_SPECS.map((s) => s.type);

/** A literal-union type of the v1 edge types (for typed call sites). */
export type EdgeType = (typeof EDGE_TYPE_SPECS)[number]['type'];

/** Fast membership lookup. */
const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

/** True iff `value` is a known v1 edge type. */
export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && EDGE_TYPE_SET.has(value);
}

/** True iff `value` is a known edge node type (context|decision|task). */
export function isEdgeNodeType(value: unknown): value is EdgeNodeType {
  return typeof value === 'string' && (EDGE_NODE_TYPES as readonly string[]).includes(value);
}

/** Look up the spec for an edge type (or undefined). */
export function edgeTypeSpec(type: string): EdgeTypeSpec | undefined {
  return EDGE_TYPE_SPECS.find((s) => s.type === type);
}

/**
 * The SQL fragment for the DB CHECK constraint's allowed-value list, derived from
 * EDGE_TYPES so the migration and this module cannot drift. Emits a quoted,
 * comma-separated list: 'decided_by', 'caused', … Each value is a fixed identifier
 * from this module (never user input), so this is safe to inline in the migration SQL.
 */
export function edgeTypeCheckSqlList(): string {
  return EDGE_TYPES.map((t) => `'${t}'`).join(', ');
}
