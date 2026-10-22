/**
 * AUTO-THREAD — the session active-thread anchor config (Mandrel Core Redesign T5b,
 * an earlier decision).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. Every knob the
 * deterministic auto-threading layer touches lives HERE, once — a named value with a
 * Operator-aligned default, a one-line note, and (where it's a runtime tunable) an env
 * override. Never a literal buried in the route. Mirrors recallConfig.ts (T1),
 * edgeTypes.ts (T2a), trustConfig.ts (T2b), threadConfig.ts (T3) and linksConfig.ts (T5a).
 *
 * NOTE: this is a SEPARATE module from config/threadConfig.ts (which holds T3
 * recall_thread's BFS/altitude knobs). T5b is the WRITE-time auto-threading layer; T3 is
 * the READ-time traversal — different concerns, so the two configs stay un-tangled.
 *
 * THE EDGE-TYPE VOCABULARY IS NOT REDEFINED HERE. Which edge an active task vs an active
 * decision maps to is sourced from config/edgeTypes.ts (the single source the DB CHECK +
 * zod both derive from): active-task → `informs` (the moat edge), active-decision →
 * `decided_by`. We re-export those two as named constants so the route reads a name, not
 * a string literal, and a vocabulary change can't silently drift this layer.
 */

import { isEdgeType, type EdgeType } from './edgeTypes.js';

/** Read a boolean env var, falling back to `fallback` on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/**
 * The edge an ACTIVE TASK anchor mints (record → active task). `informs` is the moat edge
 * for outcome trust (edgeTypes.ts) — the SAME edge the `task:` threading tag mints, so the
 * automatic layer and the tag/shorthand layer can never disagree about what an active task
 * link means. Asserted against the domain at module load so a vocabulary rename is caught
 * here (fail fast), never silently mints a now-invalid edge.
 */
export const ACTIVE_TASK_EDGE_TYPE: EdgeType = 'informs';

/**
 * The edge an ACTIVE DECISION anchor mints (record → active decision). `decided_by` is the
 * SAME edge the `decision:` threading tag mints (edgeTypes.ts) — the record ladders up to
 * the decision it was made under. Asserted against the domain at module load.
 */
export const ACTIVE_DECISION_EDGE_TYPE: EdgeType = 'decided_by';

// Fail fast at import if the vocabulary drifted out from under these mappings.
if (!isEdgeType(ACTIVE_TASK_EDGE_TYPE) || !isEdgeType(ACTIVE_DECISION_EDGE_TYPE)) {
  throw new Error(
    '[autoThreadConfig] active-thread edge mapping references an edge type that is no ' +
      'longer in config/edgeTypes.ts — update the mapping (informs / decided_by).'
  );
}

/**
 * The per-call OPT-OUT flag name. When a context_store call sets this param truthy, the
 * automatic active-thread edges are SKIPPED for that one write (the writer is being
 * deliberate — e.g. capturing something that should NOT thread onto the current anchor).
 * Defined ONCE here so the zod schema, the route check, and the docs all reference one
 * name — it can never drift. (A typo'd name would otherwise silently never opt out.)
 */
export const AUTO_THREAD_OPT_OUT_FLAG = 'noAutoThread';

/** The auto-thread tunables — read once at module load; the runtime knob is env-overridable. */
export interface AutoThreadConfig {
  /**
   * enabled — the global master switch for the automatic active-thread layer. When false,
   * a set active thread mints NOTHING on context_store (the explicit tools — thread_set,
   * links param, tags — are unaffected). Env: MANDREL_AUTO_THREAD_ENABLED. Default true
   * (the whole point of T5b is that captures thread themselves with zero ceremony).
   */
  enabled: boolean;
  /** The edge type for an active-task anchor (record → task). Sourced from edgeTypes.ts. */
  activeTaskEdgeType: EdgeType;
  /** The edge type for an active-decision anchor (record → decision). Sourced from edgeTypes.ts. */
  activeDecisionEdgeType: EdgeType;
  /** The per-call opt-out param name (see AUTO_THREAD_OPT_OUT_FLAG). */
  optOutFlag: string;
}

/** THE LIVE CONFIG — operator-aligned defaults; the enabled switch is env-overridable. */
export const AUTO_THREAD_CONFIG: AutoThreadConfig = {
  enabled: envBool('MANDREL_AUTO_THREAD_ENABLED', true),
  activeTaskEdgeType: ACTIVE_TASK_EDGE_TYPE,
  activeDecisionEdgeType: ACTIVE_DECISION_EDGE_TYPE,
  optOutFlag: AUTO_THREAD_OPT_OUT_FLAG,
};
