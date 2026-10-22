/**
 * recall_thread — THE traversal-narrative engine (Mandrel Core Redesign T3).
 * THE HEADLINE PULL TOOL: "read me in on the story of X, at altitude Y, and what to trust."
 *
 * DESIGN (the coordinator, LOCKED): v1 is DETERMINISTIC — NO server-side LLM. Mandrel is a product
 * that runs in customer containers; it must not depend on an LLM/API key. This engine does
 * the hard part — traverse + order + trust-annotate + altitude-prune — and returns a clean,
 * trust-ranked, causally+temporally ordered thread. The CONSUMING agent narrates it (it has
 * its own model). Nothing here calls claude/any LLM.
 *
 * REUSE, don't reimplement (the two shipped foundations):
 *   - the typed-edge graph: services/links.ts:getLinks() walks edges in BOTH directions
 *     with the connected node already hydrated (id/type/title). The BFS below calls it per
 *     frontier node — zero raw graph SQL in this engine.
 *   - trust: services/trust.ts:trustForRecords() computes the band/score/abstain per node
 *     from the loop's outcomes (the moat). We annotate every collected node with it and
 *     derive the abstain list from it. The trust MATH is not re-implemented here.
 *
 * The engine is two layers (a past incident — one definition, testable in isolation):
 *   1. PURE ordering + altitude shaping (orderThread / shapeNode) — no DB, unit-tested.
 *   2. buildThread() — gather (BFS via getLinks) + hydrate + trust (trustForRecords) +
 *      order + shape. Contract-tested against the disposable DB.
 *
 * SECURITY: every DB read binds ids as PARAMETERS — never string-built.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getLinks } from './links.js';
import { trustForRecords, type RecordRef } from './trust.js';
import type { Trust } from './trustModel.js';
import { type TrustBand } from '../config/trustConfig.js';
import { deriveRecordHeadline } from '../config/recordHeadlineConfig.js';
import {
  THREAD_CONFIG,
  type ThreadConfig,
  type ThreadAltitude,
  type ThreadContentAltitude,
} from '../config/threadConfig.js';
import { EDGE_NODE_TYPES, type EdgeNodeType, type EdgeType } from '../config/edgeTypes.js';
import {
  THREAD_TERMINALITY_CONFIG,
  type ThreadTerminalityConfig,
} from '../config/threadTerminalityConfig.js';
import { TerminalityWalk } from './threadTerminalityWalk.js';
import {
  orderThread,
  shapeNode,
  clipSummaryBody,
  clearsMinTrust,
  edgeTypePriority,
  readEdgeWeight,
  prioritizeFrontier,
  dropReasonFor,
  type FrontierCandidate,
  type ThreadNode,
  type ThreadEdge,
} from './recallThreadCore.js';

// Re-export the PURE core surface so existing import sites keep working — the pure
// functions/types LIVE in recallThreadCore.ts (DB-free, unit-testable in isolation) and
// are re-exported here for ergonomics (mirrors trust.ts re-exporting trustModel.ts).
export {
  computeCausalRanks,
  orderThread,
  shapeNode,
  clipSummaryBody,
  edgeTypePriority,
  readEdgeWeight,
  prioritizeFrontier,
  dropReasonFor,
} from './recallThreadCore.js';
export type {
  ThreadNode,
  ThreadEdge,
  FrontierCandidate,
  NodeDropReason,
} from './recallThreadCore.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The LIFECYCLE fields a record carries beyond its title/content — what a read model needs to
 * answer "where does this stand", as opposed to "what does this say". Hydrated for every node
 * (one batched query per entity table either way, so it costs nothing extra) and carried on
 * RawNode so a consumer like the current-state read model never has to run a
 * SECOND pass over the same records to learn their status.
 */
export interface NodeStateFields {
  /** tasks.status | technical_decisions.status. null for a context (no lifecycle column). */
  status: string | null;
  /** technical_decisions.outcome_status — the learning-loop result. null elsewhere. */
  outcomeStatus: string | null;
  /**
   * technical_decisions.implementation_status — the BUILD lifecycle ("was the thing we
   * decided actually done?"). null elsewhere. Hydrated on the SAME batched query as
   * status/outcome_status, so it costs nothing extra.
   *
   * WHY A READ MODEL NEEDS IT: a decision that is `active` with outcome `unknown` and
   * implementation `planned` for 25 days is a HALF-EXECUTED decision, and until this field
   * reached the read model the orienting surfaces (recall_thread / project.insights) could
   * not distinguish it from a decision made yesterday. That blind spot is what let
   * an earlier decision read `planned` for 12 days after shipping and then had an audit
   * derive "unstarted" from it.
   */
  implementationStatus: string | null;
  /** contexts.context_type. null for a task/decision. */
  contextType: string | null;
  /** Last-modified time where the table has one, else the creation time. */
  updatedAt: Date | null;
  /** The record's jsonb metadata (artifact references live here). */
  metadata: unknown;
}

/** A raw node as gathered from the graph (before trust + altitude shaping). */
interface RawNode extends NodeStateFields {
  id: string;
  type: EdgeNodeType;
  /** Title (tasks/decisions) or a content-derived label (contexts). */
  title: string | null;
  /** Full content body (contexts: content; decisions: rationale/description; tasks: desc). */
  content: string | null;
  createdAt: Date | null;
  /** The BFS depth at which this node was first reached (anchor = 0). */
  depth: number;
}

/** The EMPTY lifecycle fields a not-yet-hydrated node carries (the BFS seed / a dangler). */
const EMPTY_STATE_FIELDS: NodeStateFields = {
  status: null,
  outcomeStatus: null,
  implementationStatus: null,
  contextType: null,
  updatedAt: null,
  metadata: null,
};

/** The full result the route renders into structuredContent + the text channel. */
export interface ThreadResult {
  anchor: string;
  altitude: ThreadAltitude;
  /** Ordered nodes (top-to-bottom reads as the story). */
  nodes: ThreadNode[];
  edges: ThreadEdge[];
  /** Ids the agent should NOT rely on (trust.abstain) — pulled out for a quick scan. */
  abstain: string[]; // trust-render-exempt: the thread-level abstain LIST field (ids), not a rendered marker
  /** True when the node cap was hit (more was reachable). Honest, never silent. */
  truncated: boolean;
  /**
   * How many MORE distinct nodes were reachable but dropped by the cap (0 when !truncated).
   * EXACT when `truncationCountStop === 'complete'`; a LOWER BOUND otherwise.
   */
  truncatedCount: number;
  /** The `maxNodes` that returns the whole branch, or null when no value would. */
  resumeMaxNodes: number | null;
  /**
   * WHY there is no such value, when there is none: 'ceiling' (the branch is bigger than any
   * cap this server honours) or 'error' (a read failed, so the count is an unknown floor).
   * 'complete' whenever `truncatedCount` is a true count.
   */
  truncationCountStop: 'complete' | 'ceiling' | 'error';
  /** The effective depth actually walked (after clamping to maxDepth). */
  depthUsed: number;
  /** The effective node cap actually applied (after clamping to maxNodesCeiling). */
  maxNodesUsed: number;
  /** The node cap the CALLER asked for, before the ceiling clamp (see GatheredThread). */
  maxNodesRequested: number;
  /** What the GATHER dropped (cap-independent): trust floor, danglers, and their edges. */
  omissions: ThreadOmissions;
  /**
   * How many of the LISTED nodes had their body clipped by the `summary` snippet budget.
   * A presentation-level omission, so it lives here and not on GatheredThread; 0 at
   * `headline` (no bodies) and at `full` (nothing is clipped).
   */
  clippedNodes: number;
}

/** Anchor resolution failures (actionable; surfaced as a tool error, not a crash). */
export class AnchorUnresolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnchorUnresolvableError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANCHOR RESOLUTION — ref:<slug> | id8 | uuid → a concrete (id, type) node
// ─────────────────────────────────────────────────────────────────────────────

/** A resolved anchor: the concrete record the walk starts from. */
export interface ResolvedAnchor {
  id: string;
  type: EdgeNodeType;
}

/**
 * Resolve the `anchor` arg to a concrete (id, type), project-scoped. Three forms:
 *   - "ref:<slug>"      → the context tagged with that exact ref tag (the resume/handle path).
 *   - a full UUID / id8 → matched against contexts, then decisions, then tasks (first
 *                         unambiguous hit wins). Project-scoped so a prefix is collision-safe.
 *
 * Throws AnchorUnresolvableError with an ACTIONABLE message when nothing matches or a
 * ref/short-id is ambiguous (lists what to do) — never a raw DB error.
 */
export async function resolveAnchor(
  anchor: string,
  projectId: string | undefined,
  pool: Pool = db
): Promise<ResolvedAnchor> {
  const raw = (anchor ?? '').trim();
  if (!raw) {
    throw new AnchorUnresolvableError('anchor is empty — pass a ref:<slug>, a short id, or a full UUID.');
  }

  // ── ref:<slug> → the context carrying that exact tag ──────────────────────────
  if (raw.toLowerCase().startsWith('ref:')) {
    const slug = raw; // keep the full `ref:<slug>` — that's exactly what's stored in tags
    const params: any[] = [slug];
    let sql =
      `SELECT id FROM contexts WHERE tags @> ARRAY[$1]::text[] AND archived_at IS NULL`;
    if (projectId) {
      params.push(projectId);
      sql += ` AND project_id = $${params.length}`;
    }
    // `id DESC` makes "newest wins" DECIDABLE. Two contexts stamped in the
    // same instant tie on created_at, and this LIMIT then picks one arbitrarily — so a cold
    // session booting on `ref:resume` could land on a different handoff depending on which
    // row was written first. Same tiebreaker the handoff-head resolver already uses.
    sql += ` ORDER BY created_at DESC, id DESC LIMIT 2`;
    const rows = (await pool.query(sql, params)).rows;
    if (rows.length === 0) {
      throw new AnchorUnresolvableError(
        `No context is tagged "${slug}". A ref pointer resolves to the context carrying that ` +
          `exact tag. Check the slug, or use context_search to find the record and pass its id.`
      );
    }
    // A ref pointer (e.g. ref:resume) is MOVING by design — newest wins. Multiple matches
    // is expected (each new handoff carries the tag); take the most recent, not an error.
    return { id: rows[0].id, type: 'context' };
  }

  // ── id8 / full uuid → first unambiguous record across the three entity tables ──
  const isFull = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  const hexOnly = raw.replace(/-/g, '').toLowerCase();
  if (!isFull && !(hexOnly.length >= 8 && /^[0-9a-f]+$/.test(hexOnly))) {
    throw new AnchorUnresolvableError(
      `"${raw}" is not a ref:<slug>, a full UUID, or an 8+-hex short id. Pass one of those.`
    );
  }

  // Try each entity table by prefix (full uuid → exact). Collect ALL hits so we can report
  // ambiguity honestly (a short id colliding across types/rows is a real, surfaceable case).
  const TABLES: { type: EdgeNodeType; table: string }[] = [
    { type: 'context', table: 'contexts' },
    { type: 'decision', table: 'technical_decisions' },
    { type: 'task', table: 'tasks' },
  ];
  const hits: ResolvedAnchor[] = [];
  for (const { type, table } of TABLES) {
    const params: any[] = [isFull ? raw.toLowerCase() : hexOnly];
    let where = isFull ? `id::text = $1` : `id::text LIKE $1 || '%'`;
    if (projectId) {
      params.push(projectId);
      where += ` AND project_id = $${params.length}`;
    }
    const rows = (
      await pool.query(`SELECT id::text AS id FROM ${table} WHERE ${where} LIMIT 5`, params)
    ).rows;
    for (const r of rows) hits.push({ id: r.id, type });
  }

  if (hits.length === 0) {
    throw new AnchorUnresolvableError(
      `No context/decision/task matches "${raw}" in this project. ` +
        `Use context_search / decision_search / task_list to find it and copy its 🆔 ID.`
    );
  }
  if (hits.length > 1) {
    const list = hits.map((h) => `${h.type} ${h.id}`).join(', ');
    throw new AnchorUnresolvableError(
      `"${raw}" is ambiguous — it matches ${hits.length} records (${list}). ` +
        `Re-run recall_thread with the FULL id of the one you mean.`
    );
  }
  return hits[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE HYDRATION — load title/content/createdAt for a set of (id,type) nodes
// ─────────────────────────────────────────────────────────────────────────────

/** What one hydration row yields: the readable fields plus the lifecycle fields. */
export type HydratedNode = NodeStateFields & {
  title: string | null;
  content: string | null;
  createdAt: Date | null;
};

/**
 * Hydrate title/content/createdAt AND the lifecycle fields (status / outcome_status /
 * context_type / updated_at / metadata) for each (id,type). One query per entity table for the
 * whole batch (= ANY($1)) — cheap regardless of thread size. A missing referent (edge to a
 * deleted row) is simply omitted from the map; the caller drops it (never throws).
 *
 * The lifecycle columns are read on the SAME batched query the thread already ran:
 * the current-state read model needs them, and a second pass over the identical
 * rows would be a second definition of "the nodes of this thread" waiting to drift.
 *
 * EXPORTED for services/projectCoverage.ts. Graph-aware project insights
 * needs the SAME hydrated shape over a PROJECT-scoped record set rather than an anchor's BFS
 * subgraph — different selection, identical hydration. Reusing this function is what keeps
 * "what a hydrated node is" a single definition; a copy in the insights gather would be the
 * second one, waiting to drift.
 */
export async function hydrateNodes(
  refs: { id: string; type: EdgeNodeType }[],
  pool: Pool
): Promise<Map<string, HydratedNode>> {
  const out = new Map<string, HydratedNode>();
  const byType: Record<EdgeNodeType, string[]> = { context: [], decision: [], task: [] };
  for (const r of refs) if (byType[r.type]) byType[r.type].push(r.id);

  // contexts: no title column → derive a label from content; content body is `content`.
  // A context has no lifecycle status; `context_type` is its kind (error/completion/…).
  if (byType.context.length) {
    const rows = (
      await pool.query(
        `SELECT id::text AS id, content, created_at, context_type, metadata
           FROM contexts WHERE id = ANY($1::uuid[])`,
        [byType.context]
      )
    ).rows;
    for (const r of rows) {
      const body = (r.content ?? '') as string;
      out.set(r.id, {
        title: deriveContextTitle(body),
        content: body,
        createdAt: r.created_at ?? null,
        status: null,
        outcomeStatus: null,
        implementationStatus: null,
        contextType: r.context_type ?? null,
        updatedAt: r.created_at ?? null, // contexts have no updated_at column
        metadata: r.metadata ?? null,
      });
    }
  }
  // decisions: title is `title`; the "content" we surface is the rationale (fallback desc).
  if (byType.decision.length) {
    const rows = (
      await pool.query(
        `SELECT id::text AS id, title, rationale, description, decision_date,
                status, outcome_status, implementation_status, updated_at, metadata
           FROM technical_decisions WHERE id = ANY($1::uuid[])`,
        [byType.decision]
      )
    ).rows;
    for (const r of rows) {
      out.set(r.id, {
        title: r.title ?? null,
        content: (r.rationale || r.description || '') as string,
        createdAt: r.decision_date ?? null,
        status: r.status ?? null,
        outcomeStatus: r.outcome_status ?? null,
        implementationStatus: r.implementation_status ?? null,
        contextType: null,
        updatedAt: r.updated_at ?? r.decision_date ?? null,
        metadata: r.metadata ?? null,
      });
    }
  }
  // tasks: title is `title`; content is the description.
  if (byType.task.length) {
    const rows = (
      await pool.query(
        `SELECT id::text AS id, title, description, created_at,
                status, updated_at, metadata
           FROM tasks WHERE id = ANY($1::uuid[])`,
        [byType.task]
      )
    ).rows;
    for (const r of rows) {
      out.set(r.id, {
        title: r.title ?? null,
        content: (r.description || '') as string,
        createdAt: r.created_at ?? null,
        status: r.status ?? null,
        outcomeStatus: null,
        implementationStatus: null,
        contextType: null,
        updatedAt: r.updated_at ?? r.created_at ?? null,
        metadata: r.metadata ?? null,
      });
    }
  }
  return out;
}

/**
 * A short, human-readable label for a context (which has no title column).
 *
 * EXPORTED for the review-outcome contract test, which needs the REAL clip
 * to build its fixture titles: the whole defect it locks is a call that lives past this
 * boundary, and a hand-typed "clipped" title would be a test of a string the author typed
 * rather than of the clip the product performs.
 */
export function deriveContextTitle(content: string): string | null {
  // ONE headline rule for every surface — config/recordHeadlineConfig.ts. This used to
  // carry its own 80-character slice, the third of five independent spellings of the same
  // decision. No prefix here: recall_thread renders the record's kind in its own column.
  return deriveRecordHeadline(content);
}

// ─────────────────────────────────────────────────────────────────────────────
// BFS TRAVERSAL — both directions, cycle-safe, capped, edgeTypes-filtered
// ─────────────────────────────────────────────────────────────────────────────

/** What the BFS returns before trust/ordering. */
interface Traversal {
  nodes: Map<string, RawNode>;
  edges: ThreadEdge[];
  truncated: boolean;
  /** Distinct reachable-but-dropped nodes. EXACT when `truncatedCountStop === 'complete'`. */
  truncatedCount: number;
  /**
   * HOW THE OVERFLOW COUNT ENDED — an instrument's three states, kept apart
   * because the caller's remedy differs for each:
   *   'complete' — every reachable node was discovered; `truncatedCount` is a COUNT.
   *   'ceiling'  — the reachable set passed config.maxNodesCeiling, so no `maxNodes` a caller
   *                may pass could return the branch. `truncatedCount` is a lower bound, and
   *                the remedy is a narrower walk, never a bigger cap.
   *   'error'    — a links read failed mid-walk. Lower bound, and we do not know by how much.
   */
  truncatedCountStop: 'complete' | 'ceiling' | 'error';
}

/**
 * BFS from the anchor outward in BOTH directions (getLinks handles direction). Cycle-safe
 * via the `nodes` set keyed by id (a self-loop or a back-edge re-points at an already-admitted
 * node → recorded as an edge but never re-enqueued). Caps at config.maxNodes DISTINCT nodes;
 * once full it stops ENQUEUEING new nodes but still records edges between already-seen nodes
 * and counts the distinct overflow so the caller can report "N more" honestly.
 *
 * THE COUNTING WALK. "Stops enqueueing once full" used to mean the walk
 * ENDED there: the frontier went empty, so only the overflow of the level that filled the cap
 * was ever seen, and anything reachable ONLY THROUGH a dropped node was never discovered.
 * `truncatedCount` was therefore a floor while the prose spent it as a count. Overflow nodes
 * are now kept on a SEPARATE count-only frontier and expanded for the remaining levels —
 * discovering ids only. They admit nothing, record no edge (an edge whose endpoint is not in
 * `nodes` would corrupt the returned graph) and hydrate nothing; they cost one links read
 * each. Bounded by config.maxNodesCeiling: past that no re-call could return the branch
 * anyway, so counting further would buy nothing, and the walk says so
 * (`truncatedCountStop:'ceiling'`) rather than reporting a floor as a count.
 *
 * FRONTIER PRIORITY (robustness fix): each BFS LEVEL is gathered as a set of
 * candidate nodes FIRST, then admitted under the remaining cap. While there is room for every
 * candidate the level is admitted in raw discovery (insertion) order — BYTE-IDENTICAL to the
 * pre-fix behavior, so a thread that never hits the cap is unchanged. Only when the cap would
 * BITE do we rank the frontier (prioritizeFrontier: edge-type value, then same-class weight,
 * then discovery order) and admit the highest-value nodes — so "gold" reachable later in
 * insertion order survives instead of being dropped arbitrarily. Level-by-level order is kept,
 * so a closer node always still beats a farther one; ranking only ever decides WITHIN a depth.
 */
async function traverse(
  anchor: ResolvedAnchor,
  opts: {
    depth: number;
    edgeTypes?: EdgeType[];
    config: ThreadConfig;
    /** BRANCH-2's flag, injected rather than read here so both postures are exercisable
     *  in one process against the real database (the same seam `config` already uses). */
    terminality: ThreadTerminalityConfig;
  },
  pool: Pool
): Promise<Traversal> {
  const { depth, edgeTypes, config } = opts;
  const nodes = new Map<string, RawNode>();
  const edges: ThreadEdge[] = [];
  const edgeKeys = new Set<string>(); // dedupe edges (from|to|type)
  const overflow = new Set<string>(); // distinct reachable nodes dropped by the cap
  let truncated = false;
  let countCeilingHit = false;
  let countReadFailed = false;

  // The counting walk's own budget: once the reachable set passes the hard per-call ceiling,
  // no `maxNodes` a caller could pass would return the branch, so a further-refined count
  // buys nothing. Read from the SAME config the clamp in gatherThread reads.
  const countCeiling = Math.max(config.maxNodesCeiling, config.maxNodes);
  const countBudgetSpent = () => nodes.size + overflow.size > countCeiling;

  // Seed with the anchor (depth 0). It always survives (you asked for its story).
  nodes.set(anchor.id, {
    id: anchor.id,
    type: anchor.type,
    title: null,
    content: null,
    createdAt: null,
    depth: 0,
    ...EMPTY_STATE_FIELDS,
  });

  // The frontier: nodes whose neighbors we still need to expand.
  let frontier: { id: string; type: EdgeNodeType; depth: number }[] = [
    { id: anchor.id, type: anchor.type, depth: 0 },
  ];
  // The COUNT-ONLY frontier: nodes the cap refused, kept so their side of the graph is still
  // DISCOVERED (never admitted). Empty unless the cap has bitten.
  let countFrontier: { id: string; type: EdgeNodeType; depth: number }[] = [];

  // TERMINALITY (BRANCH-2) — the one `can_expand` hook. `null` when the flag
  // is OFF, and the `null` is what makes the OFF path BYTE-IDENTICAL to today's walk: no
  // query is issued, no branch below is taken, and the calibration test asserts the node set
  // is unchanged. Opening the walk reads ONE row (the anchor's limbs) to build the cone.
  const terminality =
    opts.terminality.mode === 'on'
      ? await TerminalityWalk.open({ id: anchor.id, type: anchor.type }, opts.terminality, pool)
      : null;

  for (let d = 0; d < depth && (frontier.length > 0 || countFrontier.length > 0); d++) {
    // GATHER this level's NEW candidate nodes (dedup by id; keep the highest-priority reaching
    // edge), recording EVERY discovered edge exactly as before. Admission under the cap happens
    // AFTER the whole level is gathered, so the cap can prioritize across all of it.
    const candidates: FrontierCandidate<{ id: string; type: EdgeNodeType; title: string | null }>[] =
      [];
    const candidateIndex = new Map<string, number>(); // connectedId → index into candidates
    let discovery = 0;

    // ONE batched limb read for the whole level, then one verdict per frontier node. The
    // count-only frontier is judged in the SAME call: a node the walk may not transit is not
    // a corridor for the counter either, or the count would promise nodes a re-call with the
    // advised maxNodes would never return.
    const verdicts = terminality
      ? await terminality.judgeLevel([...frontier, ...countFrontier])
      : null;

    for (const node of frontier) {
      // ADMIT BUT DO NOT TRANSIT. This node is already IN `nodes` — it was admitted by the
      // previous level (or it is the anchor). Skipping it here only stops the walk passing
      // THROUGH it, which is the whole rule: a day's handoff or a plan covering five
      // sub-tasks is a DESTINATION, not a CORRIDOR. Nothing is removed from the thread.
      if (verdicts && verdicts.get(node.id)?.canExpand === false) continue;

      // Pull this node's edges (both directions, hydrated) via the REUSED links service.
      let connected;
      try {
        connected = await getLinks(node.id, { direction: 'both', edgeTypes }, pool);
      } catch (e) {
        logger.warn(`recall_thread: getLinks failed for ${node.id} — skipping its edges`, {
          metadata: { error: (e as Error)?.message },
        });
        // COULD NOT MEASURE, and it must not be spent as a measurement: whatever hung off
        // this node is now neither walked nor counted, so any overflow number is a floor.
        countReadFailed = true;
        continue;
      }

      for (const ce of connected) {
        if (!EDGE_NODE_TYPES.includes(ce.connectedType)) continue; // unknown endpoint kind → skip

        // Record the edge in canonical from→to orientation (getLinks gives direction).
        const from = ce.direction === 'out' ? node.id : ce.connectedId;
        const to = ce.direction === 'out' ? ce.connectedId : node.id;
        const ekey = `${from}|${to}|${ce.edgeType}`;
        if (!edgeKeys.has(ekey)) {
          edgeKeys.add(ekey);
          edges.push({ from, to, type: ce.edgeType });
        }

        // CYCLE-SAFE: a connection to an ALREADY-ADMITTED node (prior level / anchor) is
        // recorded as an edge (above) but NEVER re-enqueued — a self-loop / back-edge can't
        // recurse.
        if (nodes.has(ce.connectedId)) continue;

        const weight = readEdgeWeight(ce.metadata, config);
        const prio = edgeTypePriority(ce.edgeType, config);
        const existing = candidateIndex.get(ce.connectedId);
        if (existing !== undefined) {
          // Reached again THIS level via another edge → keep the HIGHER-priority reaching edge
          // (its edge-type/weight is what ranks the candidate). Same node, so title is stable.
          const cur = candidates[existing];
          const curPrio = edgeTypePriority(cur.edgeType, config);
          const curW = cur.weight ?? Number.NEGATIVE_INFINITY;
          if (prio > curPrio || (prio === curPrio && (weight ?? Number.NEGATIVE_INFINITY) > curW)) {
            cur.edgeType = ce.edgeType;
            cur.weight = weight;
          }
          continue;
        }
        candidateIndex.set(ce.connectedId, candidates.length);
        candidates.push({
          id: ce.connectedId,
          edgeType: ce.edgeType,
          weight,
          order: discovery++,
          payload: {
            id: ce.connectedId,
            type: ce.connectedType,
            title: ce.connectedTitle, // best-effort label from getLinks; re-hydrated below
          },
        });
      }
    }

    // EXPAND THE COUNT-ONLY FRONTIER. Discovery only: no candidate, no edge,
    // no admission — these ids exist to make `truncatedCount` a COUNT rather than a floor.
    const countNext: { id: string; type: EdgeNodeType; depth: number }[] = [];
    for (const node of countFrontier) {
      if (countBudgetSpent()) {
        // Past the ceiling the exact number is unspendable; stop paying for it and SAY so.
        countCeilingHit = true;
        break;
      }
      if (verdicts && verdicts.get(node.id)?.canExpand === false) continue;
      let connected;
      try {
        connected = await getLinks(node.id, { direction: 'both', edgeTypes }, pool);
      } catch (e) {
        logger.warn(`recall_thread: getLinks failed for ${node.id} — overflow count is a floor`, {
          metadata: { error: (e as Error)?.message },
        });
        countReadFailed = true;
        continue;
      }
      for (const ce of connected) {
        if (!EDGE_NODE_TYPES.includes(ce.connectedType)) continue;
        if (nodes.has(ce.connectedId) || overflow.has(ce.connectedId)) continue;
        overflow.add(ce.connectedId);
        countNext.push({ id: ce.connectedId, type: ce.connectedType, depth: d + 1 });
      }
    }

    // ADMIT under the cap. When every candidate FITS, admit in raw discovery order — identical
    // to the pre-fix walk. Only when the cap BITES do we prioritize so the highest-value nodes
    // survive (the rest become the honest "N more" overflow).
    const remaining = Math.max(0, config.maxNodes - nodes.size);
    const admitOrder =
      candidates.length <= remaining ? candidates : prioritizeFrontier(candidates, config);

    const next: { id: string; type: EdgeNodeType; depth: number }[] = [];
    for (const c of admitOrder) {
      // CAP: stop ADDING new nodes once full; count distinct overflow for the honest signal.
      if (nodes.size >= config.maxNodes) {
        truncated = true;
        if (!overflow.has(c.id)) {
          overflow.add(c.id);
          // Dropped, but still a CORRIDOR for the counter — what hangs off it is reachable
          // and belongs in the number the notice hands the caller.
          countNext.push({ id: c.payload.id, type: c.payload.type, depth: d + 1 });
        }
        continue;
      }
      nodes.set(c.id, {
        id: c.payload.id,
        type: c.payload.type,
        title: c.payload.title,
        content: null,
        createdAt: null,
        depth: d + 1,
        ...EMPTY_STATE_FIELDS,
      });
      next.push({ id: c.payload.id, type: c.payload.type, depth: d + 1 });
    }
    frontier = next;
    if (countBudgetSpent() && countNext.length > 0) {
      countCeilingHit = true;
      countFrontier = [];
    } else {
      countFrontier = countNext;
    }
  }

  // Required guard: why each node was terminal + the declared-limb coverage of the
  // traversed set (the stranger-cliff instrument). One line per thread read.
  terminality?.logTelemetry(anchor.type);

  // CEILING BEATS ERROR: overflow only ever grows, so "bigger than any cap you may pass" is
  // still TRUE when a read also failed — and it is the half the caller can act on.
  const truncatedCountStop = countCeilingHit ? 'ceiling' : countReadFailed ? 'error' : 'complete';
  return { nodes, edges, truncated, truncatedCount: overflow.size, truncatedCountStop };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE — gather + trust + order + shape
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildThreadArgs {
  anchor: string;
  /**
   * A CONTENT altitude — the type, not just the doc comment (the reviewer N1). buildThread
   * renders an ordered STORY at a zoom level; a PROJECTION altitude (`current`) is a
   * different read model with a different answer shape and belongs to buildCurrentState().
   *
   * This used to be the wider `ThreadAltitude`, which forced the route to write
   * `altitude as ThreadContentAltitude` — a cast that was redundant (TS already narrows
   * after the route's `isProjectionAltitude` early return) AND an escape hatch that would
   * have silenced a real error later. Narrowing it here makes the COMPILER enforce the axis
   * split and demotes shapeNode's runtime throw to what it should be: a backstop for a
   * caller the type system cannot see, not the only guard.
   */
  altitude: ThreadContentAltitude;
  edgeTypes?: EdgeType[];
  depth?: number;
  /**
   * Per-call override of the total-node cap, clamped to [1, config.maxNodesCeiling].
   * THE RESUMABILITY LEVER (the 50-cap truncation fix): a caller that gets
   * `truncated:true, truncatedCount:N` re-calls with `maxNodes: nodes.length + N` and gets
   * the whole branch, in-tool. It is an ARGUMENT and not only an env var on purpose —
   * Mandrel runs in per-tenant containers and a customer cannot author env for one.
   *
   * Deliberately NOT a BFS cursor. A cursor would have to serialize the frontier + the
   * visited set to be correct across calls, and a stale cursor over a graph that has since
   * been written to returns a thread that never existed. One bounded re-call costs the
   * first page twice and cannot be stale.
   */
  maxNodes?: number;
  minTrust?: TrustBand | number;
  projectId?: string;
}

/** The arguments the GATHER needs — everything in BuildThreadArgs except the altitude. */
export type GatherThreadArgs = Omit<BuildThreadArgs, 'altitude'>;

/**
 * ONE gathered node: the raw record + its lifecycle fields + its computed trust. This is the
 * SEAM every thread read model consumes.
 */
export interface GatheredNode extends NodeStateFields {
  id: string;
  type: EdgeNodeType;
  title: string | null;
  content: string | null;
  createdAt: Date | null;
  depth: number;
  trust: Trust;
}

/**
 * THE EXACT ACCOUNTING OF WHAT THE GATHER THREW AWAY.
 *
 * A walk subtracts nodes THREE separate ways — the cap (already reported as
 * `truncated`/`truncatedCount`), the minTrust floor, and dangling referents — and until this
 * existed only the cap was reported. The header's "N node(s)" silently conflated the other
 * two: a call with `maxNodes:25, minTrust:'ok'` returned 14 nodes while reporting
 * `truncatedCount:25`, so 11 nodes vanished with no line anywhere in either channel.
 *
 * THE RECONCILIATION THIS MAKES CHECKABLE (and which the contract test asserts):
 *   listed + droppedByMinTrust + droppedDangling === examined
 * Every count here is MEASURED at its own drop site — never re-derived from another count,
 * because a derived count agrees with the thing it was derived from by construction and so
 * proves nothing.
 */
export interface ThreadOmissions {
  /** Distinct nodes the traversal actually reached (the population every drop subtracts from). */
  examined: number;
  /** Reached, then dropped because the referent row no longer exists (the anchor is never dropped). */
  droppedDangling: number;
  /** Reached + hydrated, then dropped by the `minTrust` floor (the anchor is never dropped). */
  droppedByMinTrust: number;
  /** Edges dropped BECAUSE an endpoint was dropped above — an edge list is silently short otherwise. */
  droppedEdges: number;
}

/** The gathered, trust-annotated, minTrust-filtered subgraph — before ANY presentation. */
export interface GatheredThread {
  anchorId: string;
  anchorType: EdgeNodeType;
  nodes: GatheredNode[];
  edges: ThreadEdge[];
  truncated: boolean;
  truncatedCount: number;
  /** How the overflow count ended — see Traversal.truncatedCountStop. */
  truncationCountStop: 'complete' | 'ceiling' | 'error';
  /**
   * The `maxNodes` value that WILL return the whole branch, or null when no value would —
   * because the branch is bigger than maxNodesCeiling, or the count is a floor.
   *
   * DERIVED HERE, NOT AT THE RENDER SITE. The number the notice used to print was
   * `nodes.length + truncatedCount` computed by the renderer, which is wrong twice over: it
   * spent a floor as a count, and it added the count to the POST-FILTER list length while the
   * cap acts on the pre-filter traversal set (a `minTrust` call could therefore be advised a
   * number below what it already walked). Only the gather knows both halves.
   */
  resumeMaxNodes: number | null;
  depthUsed: number;
  /** The effective node cap actually applied (after clamping to maxNodesCeiling). */
  maxNodesUsed: number;
  /**
   * The node cap the CALLER asked for (before the ceiling clamp). Carried so the response
   * can say "you asked for 900, you got 500" in the PROSE — until now that clamp was
   * visible only by comparing an argument you sent against `maxNodesUsed` in the structured
   * channel, which a reader of the text channel cannot do.
   */
  maxNodesRequested: number;
  /** What this gather dropped, counted at each drop site. */
  omissions: ThreadOmissions;
}

/**
 * GATHER the subgraph for an anchor: resolve → traverse → hydrate → trust → minTrust filter.
 * Everything up to (but NOT including) presentation.
 *
 * WHY THIS IS ITS OWN FUNCTION: buildThread() renders an ORDERED STORY;
 * buildCurrentState() renders a CURRENT-STATE projection. Those are two presentations of the
 * SAME gather. Extracting the gather is what stops the second read model from growing its own
 * traversal + hydration + trust pass — a second definition of "the nodes of this thread" that
 * would drift from this one the first time either changed. Part C
 * consumes it through buildCurrentState() for the same reason.
 *
 * An anchor with NO edges is NOT an error — it returns just the anchor node (spec).
 */
export async function gatherThread(
  args: GatherThreadArgs,
  config: ThreadConfig = THREAD_CONFIG,
  pool: Pool = db,
  terminality: ThreadTerminalityConfig = THREAD_TERMINALITY_CONFIG
): Promise<GatheredThread> {
  // Effective depth: caller value (if given) clamped to [1, maxDepth]; else the default.
  const requested = args.depth ?? config.defaultDepth;
  const depthUsed = Math.max(1, Math.min(requested, config.maxDepth));

  // Effective node cap: caller value (if given) clamped to [1, maxNodesCeiling]; else the
  // default. Same clamp-and-report contract as depth — a caller can never force an
  // unbounded walk, and is TOLD the cap that was actually applied (maxNodesUsed).
  const requestedNodes = args.maxNodes ?? config.maxNodes;
  const maxNodesUsed = Math.max(1, Math.min(requestedNodes, config.maxNodesCeiling));
  const effectiveConfig: ThreadConfig =
    maxNodesUsed === config.maxNodes ? config : { ...config, maxNodes: maxNodesUsed };

  const anchor = await resolveAnchor(args.anchor, args.projectId, pool);

  // TRAVERSE.
  const trav = await traverse(
    anchor,
    { depth: depthUsed, edgeTypes: args.edgeTypes, config: effectiveConfig, terminality },
    pool
  );

  // HYDRATE every collected node (one batched query per entity table).
  const refs = [...trav.nodes.values()].map((n) => ({ id: n.id, type: n.type }));
  const hydrated = await hydrateNodes(refs, pool);
  const rawNodes: RawNode[] = [];
  let droppedDangling = 0;
  for (const n of trav.nodes.values()) {
    const h = hydrated.get(n.id);
    if (!h) {
      // Dangling referent (edge to a deleted row). Keep the ANCHOR regardless (with what we
      // have); drop other danglers so the thread stays clean — but COUNT them, so a short
      // thread is explained rather than merely short.
      if (n.id === anchor.id) {
        rawNodes.push(n);
      } else {
        droppedDangling++;
      }
      continue;
    }
    rawNodes.push({
      ...n,
      title: h.title ?? n.title,
      content: h.content,
      createdAt: h.createdAt,
      status: h.status,
      outcomeStatus: h.outcomeStatus,
      implementationStatus: h.implementationStatus,
      contextType: h.contextType,
      updatedAt: h.updatedAt,
      metadata: h.metadata,
    });
  }

  // TRUST — annotate every node (REUSE the T2b service; the moat).
  const trustRefs: RecordRef[] = rawNodes.map((n) => ({
    id: n.id,
    type: n.type,
    createdAt: n.createdAt ?? undefined,
  }));
  const trusts = await trustForRecords(trustRefs, undefined, pool);
  const trustById = new Map<string, Trust>();
  rawNodes.forEach((n, i) => trustById.set(n.id, trusts[i]));

  // minTrust filter — NEVER drop the anchor.
  const kept = rawNodes.filter(
    (n) => n.id === anchor.id || clearsMinTrust(trustById.get(n.id)!, args.minTrust)
  );
  const keptIds = new Set(kept.map((n) => n.id));
  const keptEdges = trav.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  // THE RESUMPTION ARITHMETIC, done once, where both halves are known.
  // `trav.nodes.size` — the traversal set the cap acted on — is the right base, NOT the
  // filtered list. A count that could not be finished yields null rather than a number that
  // reads as sufficient and is not.
  const reachableTotal =
    trav.truncatedCountStop === 'complete' ? trav.nodes.size + trav.truncatedCount : null;
  const resumeMaxNodes =
    trav.truncated && reachableTotal !== null && reachableTotal <= config.maxNodesCeiling
      ? reachableTotal
      : null;

  return {
    anchorId: anchor.id,
    anchorType: anchor.type,
    nodes: kept.map((n) => ({ ...n, trust: trustById.get(n.id)! })),
    edges: keptEdges,
    truncated: trav.truncated,
    truncatedCount: trav.truncatedCount,
    resumeMaxNodes,
    truncationCountStop: trav.truncatedCountStop,
    depthUsed,
    maxNodesUsed,
    maxNodesRequested: requestedNodes,
    omissions: {
      examined: trav.nodes.size,
      droppedDangling,
      droppedByMinTrust: rawNodes.length - kept.length,
      droppedEdges: trav.edges.length - keptEdges.length,
    },
  };
}

/**
 * Build the full thread for an anchor (the route's single entry point). Steps:
 *   1-5. GATHER (gatherThread): resolve the anchor → BFS both directions to the effective
 *        depth (clamped to maxDepth), capped at maxNodes → hydrate → trust-annotate (REUSE
 *        trustForRecords; the moat) → apply minTrust, never dropping the anchor.
 *   6.   order (causal + temporal) and shape to the altitude.
 *   7.   derive the abstain list from the computed verdicts.
 *
 * The altitude MUST be a CONTENT altitude — a projection altitude (`current`) is a different
 * read model with a different answer shape, and shapeNode() throws rather than silently
 * rendering a summary thread under another name. The route dispatches on the
 * axis before it gets here.
 *
 * An anchor with NO edges is NOT an error — it returns just the anchor node (spec).
 */
export async function buildThread(
  args: BuildThreadArgs,
  config: ThreadConfig = THREAD_CONFIG,
  pool: Pool = db
): Promise<ThreadResult> {
  const altitude = args.altitude;
  const gathered = await gatherThread(args, config, pool);

  // 6. ORDER (causal + temporal, anchor pinned first) then SHAPE to the altitude.
  const ordered = orderThread(gathered.nodes, gathered.edges, gathered.anchorId);
  const nodes: ThreadNode[] = ordered.map((n) =>
    shapeNode(
      // `metadata` rides along so the ONE derivation in shapeNode can read a stored review
      // call off it. It is already hydrated for every node by hydrateNodes;
      // nothing new is queried.
      { id: n.id, type: n.type, title: n.title, content: n.content, metadata: n.metadata },
      n.trust,
      altitude,
      config
    )
  );

  // CLIPPING IS AN OMISSION TOO — counted from the SAME clipper shapeNode
  // used, so the reported number cannot drift from what was actually clipped. Only the
  // `summary` altitude clips: `headline` carries no body and `full` carries all of it.
  const clippedNodes =
    altitude === 'summary'
      ? ordered.filter((n) => clipSummaryBody(n.content ?? '', config).omittedChars > 0).length
      : 0;

  // 7. ABSTAIN list — the ids the agent should not rely on.
  const abstain = nodes.filter((n) => n.trust.abstain).map((n) => n.id); // trust-render-exempt: BUILDS the abstain list from the computed verdicts; renders nothing

  // 8. DROP REASONS AS FIELDS (P5.3 half A) — the WHY behind the list above, structured, so a
  //    caller never has to recover it by string-splitting the text channel. Built from the
  //    SAME abstain set the prose names, one line below it, so the two cannot disagree about
  //    the population. The text channel is untouched: this ADDS a field, it changes no byte
  //    the renderer emits.
  const abstainIds = new Set(abstain); // trust-render-exempt: INDEXES the abstain LIST built one line above so the drop reasons can be keyed by it; renders nothing
  const walkIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const dropped = dropReasonFor(n, abstainIds, walkIds);
    if (dropped) n.dropped = dropped;
  }

  return {
    anchor: gathered.anchorId,
    altitude,
    nodes,
    edges: gathered.edges,
    abstain, // trust-render-exempt: the abstain LIST on the result object; renders nothing
    truncated: gathered.truncated,
    truncatedCount: gathered.truncatedCount,
    resumeMaxNodes: gathered.resumeMaxNodes,
    truncationCountStop: gathered.truncationCountStop,
    depthUsed: gathered.depthUsed,
    maxNodesUsed: gathered.maxNodesUsed,
    maxNodesRequested: gathered.maxNodesRequested,
    omissions: gathered.omissions,
    clippedNodes,
  };
}
