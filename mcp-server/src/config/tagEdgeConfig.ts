/**
 * TAG → EDGE MATRIX — the SOURCE-DEPENDENT threading-tag mapping (Q1).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. The mapping from a
 * threading tag to a typed edge lives HERE, once, as an EXPLICIT cell per (source, prefix)
 * pair. Mirrors edgeTypes.ts (the vocabulary), threadConfig.ts (traversal), trustConfig.ts
 * (scoring), autoThreadConfig.ts (the anchor).
 *
 * WHY A MATRIX AND NOT A FUNCTION OF THE TAG ALONE. The old mapping was SOURCE-BLIND —
 * `tagToEdgeIntent(tag)` — so `task:<id8>` meant `informs` no matter what record carried it.
 * That was correct for the two record types that could carry it (context, decision) and
 * became WRONG the moment tasks started minting, because config/edgeTypes.ts already says so:
 *
 *   `informs`  (edgeTypes.ts) — "this record (CONTEXT/DECISION) informs the target task".
 *              It explicitly does NOT list task as a valid source.
 *   `decided_by` — "this record (context/TASK) was decided by the target decision".
 *              It explicitly DOES list task.
 *
 * The vocabulary authors anticipated this; the tag map never got the memo. Exactly ONE cell
 * differs from the old source-blind behaviour: (task, `task:`).
 *
 * THE CONTESTED CELL — (task, `task:`) → `related_to`, NOT `informs`. Three reasons:
 *   (a) the `informs` spec excludes task as a source (above);
 *   (b) trust.ts OUTCOME_OUT_EDGE_TYPES includes `informs`, so a task→task `informs` would
 *       make the new task INHERIT the referenced task's outcome as its own evidence —
 *       parent/child noise polluting the moat;
 *   (c) it is not what the tag MEANS. `task:X` on a task is genuinely ambiguous: subtask-of /
 *       follow-up-of / blocks / duplicates / same-workstream.
 * Ambiguous → deny-by-default → a weak, non-trust-bearing edge, never a guessed strong one.
 *
 * AND IT IS LOSSLESSLY UPGRADEABLE, which is what makes the weak choice safe rather than
 * merely timid: every auto-minted edge carries metadata.source_tag, and this path additionally
 * stamps `explicit: true` to distinguish an EXPLICIT-weak edge (a human stated a relation whose
 * TYPE we don't know) from an INFERRED-weak `related_to` (a machine similarity guess). A future
 * migration can re-type every related_to whose source_tag starts with `task:` once real usage
 * evidence exists. A wrong STRONG edge has no such escape hatch.
 *
 * DENY BY DEFAULT. There is NO default case and NO fallthrough. An unknown source type or an
 * unknown tag prefix yields NOTHING and the caller surfaces a SKIP. The failure mode we are
 * refusing is the one that bit this workstream: a new record type silently inheriting the
 * CONTEXT row's semantics because that happened to be the fallback.
 */

import {
  EDGE_NODE_TYPES,
  EDGE_TYPES,
  type EdgeNodeType,
  type EdgeType,
} from './edgeTypes.js';

/**
 * Parse a boolean flag value, falling back to `fallback` on missing/unknown. Accepts (case-
 * and whitespace-insensitive) 1/true/yes/on → true and 0/false/no/off → false; anything else
 * (incl. empty/missing) → `fallback`. Exported so the accepted spellings can be asserted
 * directly, without reloading modules — the same shape (and for the same reason) as
 * declaredLimbsConfig.parseBooleanFlag: this reads a KILL SWITCH, and a switch an operator
 * cannot reliably pull mid-incident (`FALSE`, `0`, `off`) is not a switch.
 */
export function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/** Read a boolean env var through `parseBooleanFlag`. */
function envBool(name: string, fallback: boolean): boolean {
  return parseBooleanFlag(process.env[name], fallback); // env-read: via-callers
}

/**
 * The threading-tag PREFIXES that carry graph STRUCTURE. Everything else in the tag grammar
 * (`scope:` / `owner:` / `tranche:` / `ref:`) is a LENS/LABEL and deliberately mints nothing.
 */
export const TAG_EDGE_PREFIXES = ['task', 'decision', 'context'] as const;
export type TagEdgePrefix = (typeof TAG_EDGE_PREFIXES)[number];

/**
 * THE 9-CELL MATRIX. Row = the record type doing the WRITING; column = the tag prefix;
 * cell = the edge minted FROM the writing record TO the referent.
 *
 * Every cell is written out. Do not "simplify" this into a shared default plus overrides —
 * the explicitness IS the feature (see DENY BY DEFAULT above).
 *
 *            | task:        | decision:    | context:
 *   ---------+--------------+--------------+---------------
 *   context  | informs      | decided_by   | learned_from
 *   decision | informs      | decided_by   | learned_from
 *   task     | related_to * | decided_by   | learned_from
 *
 *   * the contested cell — weak on purpose, and upgradeable. See the header.
 */
export const TAG_EDGE_MATRIX: Readonly<
  Record<EdgeNodeType, Readonly<Record<TagEdgePrefix, EdgeType>>>
> = {
  // A CONTEXT informs a task, is decided_by a decision, and learned_from another context.
  context: {
    task: 'informs',
    decision: 'decided_by',
    context: 'learned_from',
  },
  // A DECISION behaves identically to a context here (both are valid `informs` sources).
  decision: {
    task: 'informs',
    decision: 'decided_by',
    context: 'learned_from',
  },
  // A TASK ladders up to the decision that authorized it and cites the context it came from
  // exactly like the others — only the task→task cell differs (weak, ambiguous, upgradeable).
  task: {
    task: 'related_to',
    decision: 'decided_by',
    context: 'learned_from',
  },
};

// ── LOAD-TIME INTEGRITY ASSERTIONS (fail fast at import, never silently mis-mint) ────────
// The matrix references the edge vocabulary by string. If a type is renamed or removed in
// edgeTypes.ts and this file is not updated, every affected write would mint an edge the DB
// CHECK rejects — at RUNTIME, on the user's write. These turn that into an import-time crash.
for (const sourceType of EDGE_NODE_TYPES) {
  const row = TAG_EDGE_MATRIX[sourceType];
  if (!row) {
    throw new Error(
      `[tagEdgeConfig] MATRIX INCOMPLETE: no row for source type "${sourceType}". Every ` +
        'record type that can carry threading tags needs an EXPLICIT row — there is no default.',
    );
  }
  for (const prefix of TAG_EDGE_PREFIXES) {
    const edgeType = row[prefix];
    if (!edgeType) {
      throw new Error(
        `[tagEdgeConfig] MATRIX INCOMPLETE: no cell for (${sourceType}, ${prefix}:). Add it ` +
          'explicitly (deny-by-default means a missing cell mints nothing, which is almost ' +
          'certainly not what you meant).',
      );
    }
    if (!(EDGE_TYPES as readonly string[]).includes(edgeType)) {
      throw new Error(
        `[tagEdgeConfig] UNKNOWN EDGE TYPE: cell (${sourceType}, ${prefix}:) maps to ` +
          `"${edgeType}", which is not in config/edgeTypes.ts EDGE_TYPES. The vocabulary is ` +
          'the single source of truth; update this matrix to match it.',
      );
    }
  }
}

/** One resolved tag→edge intent: what to mint, and to what. */
export interface TagEdgeIntent {
  /** The referent as written in the tag (id8 or full uuid), normalized lower-case. */
  ref: string;
  /** The endpoint kind the referent resolves against. */
  toType: EdgeNodeType;
  /** The edge type to mint, from the matrix. */
  edgeType: EdgeType;
  /**
   * True when this edge is EXPLICIT-WEAK: the writer stated a relation but its TYPE is
   * unknown, so a weak edge stands in for a strong one we refuse to guess. Distinguishes
   * this from an INFERRED weak `related_to` (a similarity guess). The future re-typing
   * migration keys on it.
   */
  explicit: boolean;
}

/**
 * Map one threading tag to an edge intent GIVEN THE RECORD TYPE WRITING IT, or `null` when
 * the pair mints nothing (not a threading tag / unknown prefix / unknown source type).
 *
 * `null` is a DENY, and every caller must surface it as a skip rather than fall back to some
 * other row's semantics.
 *
 * @param sourceType the record type carrying the tag (the FROM endpoint)
 * @param tag        the raw tag, e.g. `task:0f3906cd`
 */
export function tagToEdgeIntent(sourceType: EdgeNodeType, tag: string): TagEdgeIntent | null {
  // An unrecognized source type denies outright — no default row (the whole point).
  const row = TAG_EDGE_MATRIX[sourceType];
  if (!row) return null;

  const t = tag.trim().toLowerCase();
  for (const prefix of TAG_EDGE_PREFIXES) {
    const marker = `${prefix}:`;
    if (!t.startsWith(marker)) continue;
    const ref = t.slice(marker.length);
    if (!ref) return null; // a bare `task:` with no referent mints nothing
    const edgeType = row[prefix];
    if (!edgeType) return null; // deny-by-default: no cell, no edge
    return {
      ref,
      toType: prefix as EdgeNodeType,
      edgeType,
      // EXPLICIT-WEAK marker: only meaningful where the matrix chose a weak type to stand in
      // for an ambiguous strong one. Stamped on every cell so the metadata shape is uniform.
      explicit: true,
    };
  }
  return null; // not a structural threading tag (scope:/owner:/ref:/tranche:/prose)
}

/**
 * TASK-EDGE MINTING — the kill switch (rollout).
 *
 * This is an ADDITIVE write-path change, so a full Lesson-025 shadow/canary rollout is
 * overkill — but a config kill switch is NOT. If task-source minting turns out to pollute the
 * graph in prod, the response must be a FLAG FLIP, not a code rollback and redeploy.
 *
 * WHAT IT GATES — exactly the task-source minters inside the `TASK_EDGE_MINT_CONFIG.enabled`
 * blocks in routes/tasks.routes.ts: tag-minted edges (autoMintFromTags), the dependencies
 * mirror (autoMintFromTaskDependencies), and the `links` param on task_create
 * (mintExplicitLinks). OFF → those sources are silent.
 *
 * WHAT IT DOES NOT GATE, deliberately: positional membership (mintPositional runs OUTSIDE
 * the gated block — a positioned session still mints its membership edge with the flag OFF),
 * and every pre-existing mint path (context_store, decision_record, the explicit link tool),
 * so flipping it can never disable pre-existing behaviour. The contract test pins this scope
 * from both sides (gated sources silent; positional membership still mints).
 */
export interface TaskEdgeMintConfig {
  /**
   * enabled — master switch for minting edges FROM tasks (tags + the dependencies mirror).
   * Env: MANDREL_TASK_EDGE_MINT_ENABLED. Default true (the point of the work is that tasks
   * stop being born graph leaves).
   */
  enabled: boolean;
}

export const TASK_EDGE_MINT_CONFIG: TaskEdgeMintConfig = {
  enabled: envBool('MANDREL_TASK_EDGE_MINT_ENABLED', true),
};

/** The env var name, defined ONCE so docs/tests/route reference a name, never a literal. */
export const TASK_EDGE_MINT_ENV_FLAG = 'MANDREL_TASK_EDGE_MINT_ENABLED';

/**
 * The read-back string, built in ONE place so the startup log and `mandrel_status` cannot
 * disagree about what the process is actually running (the declaredLimbsFlagSummary pattern).
 * Reads the live config object, not the env — a mid-incident flip of the object (or a
 * restart with the var set) is what an operator needs echoed back.
 */
export function taskEdgeMintFlagSummary(): string {
  return `task-edge minting (tags/deps/links on task writes): ${TASK_EDGE_MINT_CONFIG.enabled ? 'ON' : 'OFF'} (${TASK_EDGE_MINT_ENV_FLAG})`;
}

/**
 * The `createdBy` provenance stamps this work writes. Defined here so the write path, the
 * backfill, and the provenance-scoped UNDO all reference ONE name — a drifting literal is how
 * a "reversible by construction" backfill quietly stops being reversible.
 */
export const TASK_EDGE_CREATED_BY = {
  /** task_create minting from the `dependencies` field. */
  taskDeps: 'auto:task_deps',
  /** task_create minting `subtask_of` from the explicit `parentTaskId` param.
   *  The `links:` prefix is deliberate: the link_provenance view (migration 081) classifies
   *  `LIKE 'links:%'` as DECLARED — which this is (an explicitly named target) — so the new
   *  stamp lands in the right bucket with no migration. Pinned executable in
   *  linkProvenanceMeter.contract.test.ts. */
  taskParent: 'links:task_parent',
  /** task_create minting from threading tags. */
  taskTags: 'auto:task_create',
  /** task_update re-minting after a tag edit. */
  taskUpdate: 'auto:task_update',
  /** BACKFILL pass 1: dependencies → depends_on over existing tasks. */
  backfillDeps: 'backfill:task_deps',
  /** BACKFILL pass 2: task threading tags → edges over existing tasks. */
  backfillTags: 'backfill:task_tags',
} as const;
