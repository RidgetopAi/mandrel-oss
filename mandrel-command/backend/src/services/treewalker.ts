/**
 * TreeWalkerService — the whole-thread typed-edge GRAPH + recall_thread-ordered STORY +
 * per-record TRUST read behind `GET /api/treewalker/thread` (resume anchor) and
 * `GET /api/treewalker/:anchorId/thread` (explicit anchor). This is the moat's flagship
 * visualizer's data source: it walks ONE branch of the `links` graph (migration 049) ~2 hops
 * from the anchor and shapes it into the FE `ThreadGraph` contract (api/domains/treewalker.ts).
 *
 * Design mirrors the mcp-server trust model's TWO-LAYER split (a past incident — one definition,
 * unit-testable in isolation):
 *   1. PURE builders (buildThreadGraph / deriveTrust / buildStory / buildSpine) — no DB, no
 *      clock; take gathered rows + injected config, return the shaped graph. This is what the
 *      unit tests hammer (traversal flags, both-direction edges, trust mapping, story order).
 *   2. I/O gather (resolveAnchorId / fetchThreadRaw / getThread) — BFS over `links` (both
 *      directions) + resolve each node's title/kind + gather trust signals, then call the pure
 *      builders. Cheap: bounded by maxNodes, a handful of set-keyed queries.
 *
 * GROUNDING (data policy — never fabricate trust or edges):
 *   - EDGES are real `links` rows; a genuinely-empty thread returns an empty graph (honest).
 *   - TRUST is the CANONICAL model (PHASE 2 item e): the same bands, math
 *     and config as mcp-server's trustModel.ts, via the mirrored
 *     config/treewalkerTrustModel.ts (parity pinned by treewalkerTrustParity.test.ts —
 *     see that module's header for why a mirror and not an import). Signals are gathered
 *     from the same real columns/edges the canonical gather reads: downstream outcomes
 *     over the outcome edge types, freshness from created_at, and provenance-split
 *     supersession (declared hard-caps; a belief-adjudicator/possibly edge only demotes).
 */
import type { Pool } from 'pg';
import { db } from '../database/connection';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';
import { logger } from '../config/logger';
import { TREEWALKER_CONFIG, type TreewalkerConfig, type StoryCaption } from '../config/treewalkerConfig';
import { orderThread, type OrderEdge } from '../config/treewalkerStoryOrder';
import { contextTitle } from './recordTitle';
import { TreeWalkerTiersService, type RootDoc } from './treewalkerTiers';

// Re-exported: contextTitle moved to services/recordTitle.ts (shared with the tier
// resolvers without a require cycle); existing import sites keep working.
export { contextTitle, CONTEXT_TITLE_PREVIEW_CHARS } from './recordTitle';
import {
  computeTrustVerdict,
  mapDecisionOutcome,
  mapTaskOutcome,
  BELIEF_EDGE_CREATED_BY,
  OUTCOME_OUT_EDGE_TYPES,
  type OutcomeSample,
  type TrustBand,
} from '../config/treewalkerTrustModel';

// ── The FE ThreadGraph contract (api/domains/treewalker.ts) — matched exactly. ──────────
/** A node's trust read — the CANONICAL band vocabulary (config/treewalkerTrustModel.ts). */
export type TrustLevel = TrustBand;
export type RecordKind = 'decision' | 'task' | 'context' | 'handoff';
export type StoryMarker = 'decided' | 'informs' | 'now' | 'next' | 'default';

export interface ThreadNode {
  id: string;
  kind: RecordKind;
  title: string;
  trust: TrustLevel;
  isSpine?: boolean;
  isCurrent?: boolean;
}
export interface ThreadEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
}
export interface SpineNode {
  label: string;
  tier: 'root' | 'tree' | 'trunk' | 'branch';
  id?: string;
}
export interface StoryStep {
  id: string;
  kind: RecordKind;
  title: string;
  trust?: TrustLevel;
  relation: string;
  relationTerm?: string;
  marker: StoryMarker;
}
export interface ThreadAnchor {
  branchLabel: string;
  anchorId: string;
  recordCount: number;
}
export interface ThreadGraph {
  anchor: ThreadAnchor;
  spine: SpineNode[];
  nodes: ThreadNode[];
  edges: ThreadEdge[];
  story: StoryStep[];
  /**
   * The trunk HEAD (the project's newest handoff context) — the real jump-to-trunk
   * target (PHASE 2 item d). Null when the project has no handoffs (the honest state;
   * the FE jump control disables rather than pointing nowhere).
   */
  trunkAnchorId: string | null;
}

/** The data-resolved tier inputs buildSpine renders (PHASE 2 items a/b — no literals). */
export interface SpineTierData {
  /** The newest locked root doc (canonical / north-star), or null. */
  root: RootDoc | null;
  /** The newest handoff's id (the trunk head), or null. */
  trunkHeadId: string | null;
  /** FULL live handoff count in scope. */
  trunkCount: number;
}

// ── Internal raw types (what the I/O layer gathers, before shaping). ─────────────────────
type RecordType = 'context' | 'decision' | 'task';

/** A resolved record on the thread (title + kind columns + trust-relevant real columns). */
export interface RawRecord {
  id: string;
  type: RecordType;
  title: string;
  contextType?: string | null; // contexts — 'handoff' distinguishes the handoff kind
  outcomeStatus?: string | null; // decisions
  status?: string | null; // decisions & tasks
  supersededBy?: string | null; // decisions
  tags?: string[] | null; // all kinds — `tree:` lineage (contexts) + `branch:<name>` spine names
  createdAt?: Date | string | null; // ordering + freshness reference
}

/** A real `links` edge touching the thread. */
export interface RawEdge {
  id: string;
  fromId: string;
  fromType: RecordType;
  toId: string;
  toType: RecordType;
  edgeType: string;
}

/**
 * The gathered per-node trust signals — the CANONICAL signal shape (downstream outcome
 * samples + provenance-split supersession), all read from real rows, never invented.
 * ageDays is derived at compute time from the record's own createdAt.
 */
export interface GatheredTrustSignals {
  /** Downstream ground-truth outcomes over the outcome edge types (moat inheritance). */
  outcomes: OutcomeSample[];
  /** A DECLARED supersession points at this record (hard cap → band 'superseded'). */
  supersededDeclared: boolean;
  /** A SOFT (belief-adjudicator / possibly_supersedes) supersession (demotes only). */
  supersededSoft: boolean;
}

/** Raised when an EXPLICIT anchor id resolves to no live record (→ 404 at the controller). */
export class AnchorNotFoundError extends Error {
  constructor(anchorId: string) {
    super(`No live record found for anchor ${anchorId}`);
    this.name = 'AnchorNotFoundError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE LAYER — no DB, no clock. Unit-tested in isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** The record kind a node renders as (colour). A context typed 'handoff' reads as handoff. */
export function kindOf(rec: Pick<RawRecord, 'type' | 'contextType'>): RecordKind {
  if (rec.type === 'context') return rec.contextType === 'handoff' ? 'handoff' : 'context';
  return rec.type;
}

/**
 * Derive a record's canonical trust band (PHASE 2 item e — the CANONICAL model, not a
 * private heuristic). PURE: takes the record row + gathered signals + `now`, builds the
 * canonical TrustSignals, and calls the mirrored computeTrustVerdict:
 *   - outcomes: the gathered downstream samples, PLUS a decision's OWN outcome_status
 *     (direct ground-truth for itself — exactly as the canonical trustForRecord folds it).
 *   - supersession: gathered declared/soft, PLUS a decision's own superseded_by column
 *     (a direct DECLARED signal — canonical).
 *   - freshness: age in days from the record's createdAt to `now` (missing → epoch,
 *     i.e. maximally stale — the canonical missing-date fallback).
 */
export function deriveTrust(
  rec: Pick<RawRecord, 'type' | 'outcomeStatus' | 'supersededBy' | 'createdAt'>,
  signals: GatheredTrustSignals,
  now: Date,
): TrustLevel {
  const outcomes: OutcomeSample[] = [...signals.outcomes];
  if (rec.type === 'decision' && rec.outcomeStatus !== undefined) {
    outcomes.push({ value: mapDecisionOutcome(rec.outcomeStatus), source: 'decision' });
  }
  const created = tms(rec.createdAt); // missing → 0 (epoch) → maximally stale
  const ageDays = Math.max(0, (now.getTime() - created) / (1000 * 60 * 60 * 24));
  return computeTrustVerdict({
    outcomes,
    ageDays,
    supersededDeclared:
      signals.supersededDeclared || (rec.type === 'decision' && rec.supersededBy != null),
    supersededSoft: signals.supersededSoft,
    contradicted: false, // T4 sets this; nothing sets it today (canonical behavior)
  }).band;
}

/** Millis for a raw createdAt (missing → 0, i.e. sorts earliest — deterministic). */
function tms(v: Date | string | null | undefined): number {
  if (v == null) return 0;
  const d = v instanceof Date ? v : new Date(v);
  const n = d.getTime();
  return Number.isFinite(n) ? n : 0;
}

/**
 * The spine (task) node the thread is anchored on: the task the ANCHOR `informs` (outgoing
 * informs → task). Falls back to any task the anchor points at, then any task on the thread.
 * Returns undefined when the thread carries no task (→ no spine emphasis, honest).
 */
export function pickSpineNodeId(
  anchorId: string,
  edges: RawEdge[],
  records: Map<string, RawRecord>,
): string | undefined {
  const isTask = (id: string) => records.get(id)?.type === 'task';
  const byCreated = (a: string, b: string) =>
    tms(records.get(a)?.createdAt) - tms(records.get(b)?.createdAt) || a.localeCompare(b);

  const informsTask = edges
    .filter((e) => e.fromId === anchorId && e.edgeType === 'informs' && isTask(e.toId))
    .map((e) => e.toId);
  if (informsTask.length) return informsTask.sort(byCreated)[0];

  const anyOut = edges.filter((e) => e.fromId === anchorId && isTask(e.toId)).map((e) => e.toId);
  if (anyOut.length) return anyOut.sort(byCreated)[0];

  const anyTask = [...records.values()].filter((r) => r.type === 'task').map((r) => r.id);
  if (anyTask.length) return anyTask.sort(byCreated)[0];
  return undefined;
}

/**
 * A branch's display NAME: the once-on-the-spine `branch:<name>` tag when present, else
 * the spine record's title — the membership/identity split. The old `branch:`
 * TITLE-prefix hack is gone (PHASE 2 item f): the prefix is now only a tag GRAMMAR the
 * name is parsed from, never glued onto a label.
 */
export function branchNameOf(
  spineTask: Pick<RawRecord, 'title' | 'tags'> | undefined,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): { name: string; named: boolean } {
  if (!spineTask) return { name: config.spine.branchFallbackLabel, named: false };
  const prefix = config.spine.branchNameTagPrefix;
  const tag = (spineTask.tags ?? []).find((t) => t.startsWith(prefix) && t.length > prefix.length);
  return tag ? { name: tag.slice(prefix.length), named: true } : { name: spineTask.title, named: false };
}

/**
 * Build the roots → tree → trunk → branch ribbon — EVERY tier resolved from data
 * (PHASE 2 items a/b/f):
 *   root   — the newest locked root doc's title + id (honest label-only fallback when
 *            the project has none).
 *   tree   — the real `tree:` tag / project name (unchanged — was already data).
 *   trunk  — the handoff timeline: `handoffs · <count>`, id = the trunk head (the
 *            jump target). Honest empty label when the project has no handoffs.
 *   branch — the spine record, labeled by branchNameOf (name tag else title; no prefix).
 */
export function buildSpine(
  spineTask: RawRecord | undefined,
  treeLabel: string,
  tiers: SpineTierData,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): SpineNode[] {
  const s = config.spine;
  const root: SpineNode = tiers.root
    ? { tier: 'root', label: tiers.root.title.slice(0, s.rootTitleMaxChars), id: tiers.root.id }
    : { tier: 'root', label: s.rootFallbackLabel };
  const trunk: SpineNode =
    tiers.trunkHeadId && tiers.trunkCount > 0
      ? { tier: 'trunk', label: `handoffs · ${tiers.trunkCount}`, id: tiers.trunkHeadId }
      : { tier: 'trunk', label: s.trunkEmptyLabel };
  const branch: SpineNode = {
    tier: 'branch',
    label: branchNameOf(spineTask, config).name,
    ...(spineTask ? { id: spineTask.id } : {}),
  };
  return [root, { tier: 'tree', label: treeLabel }, trunk, branch];
}

/**
 * Build the STORY in the CANONICAL recall_thread order (PHASE 2 item e, story half).
 * The old bespoke 5-slot narrative (an earlier audit PROSE finding) is
 * deleted: the walk now runs through the mirrored canonical ordering
 * (config/treewalkerStoryOrder.ts — anchor pinned first, causal rank, temporal, id;
 * parity-pinned against the real recallThreadCore by treewalkerStoryOrderParity.test.ts).
 *
 * Every walked node appears exactly once, in canonical order. MARKERS + captions are
 * presentation, derived from real roles:
 *   now     — the anchor (always first, canonically).
 *   decided — a decision the spine/anchor is `decided_by` (the why).
 *   informs — the spine node itself (the branch).
 *   next    — ONE open (todo/in_progress) task, preferring one the anchor/spine points at.
 *   default — any other walked node (generic caption).
 */
export function buildStory(
  anchorId: string,
  spineNodeId: string | undefined,
  nodes: ThreadNode[],
  edges: RawEdge[],
  records: Map<string, RawRecord>,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): StoryStep[] {
  const c = config.captions;

  // 1. CANONICAL ORDER over every walked node (the ordering is the canon; no hand slots).
  const orderable = nodes.map((n) => {
    const created = records.get(n.id)?.createdAt;
    const t = tms(created);
    return { id: n.id, createdAt: t === 0 ? null : new Date(t) };
  });
  const orderEdges: OrderEdge[] = edges.map((e) => ({ from: e.fromId, to: e.toId, type: e.edgeType }));
  const ordered = orderThread(orderable, orderEdges, anchorId);

  // 2. ROLES (presentation): the why / the spine / the single "next" open task.
  const byCreated = (a: string, b: string) =>
    tms(records.get(a)?.createdAt) - tms(records.get(b)?.createdAt) || a.localeCompare(b);
  const decidedFrom = spineNodeId ?? anchorId;
  const decidedIds = new Set(
    edges
      .filter((e) => e.fromId === decidedFrom && e.edgeType === 'decided_by' && e.toType === 'decision')
      .map((e) => e.toId),
  );
  const openTaskIds = nodes
    .filter((n) => n.kind === 'task' && n.id !== spineNodeId && n.id !== anchorId)
    .map((n) => n.id)
    .filter((id) => {
      const st = records.get(id)?.status;
      return st === 'todo' || st === 'in_progress';
    });
  let nextId: string | undefined;
  if (openTaskIds.length) {
    const pointedAt = new Set(
      edges
        .filter((e) => (e.fromId === anchorId || e.fromId === spineNodeId) && e.toType === 'task')
        .map((e) => e.toId),
    );
    nextId =
      openTaskIds.filter((id) => pointedAt.has(id)).sort(byCreated)[0] ??
      openTaskIds.sort(byCreated)[0];
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return ordered
    .map((o) => nodeById.get(o.id))
    .filter((n): n is ThreadNode => n !== undefined)
    .map((n) => {
      const [marker, cap]: [StoryMarker, StoryCaption] =
        n.id === anchorId
          ? ['now', c.now]
          : n.id === spineNodeId
          ? ['informs', c.spine]
          : decidedIds.has(n.id)
          ? ['decided', c.decided]
          : n.id === nextId
          ? ['next', c.next]
          : ['default', c.walk];
      return {
        id: n.id,
        kind: n.kind,
        title: n.title,
        trust: n.trust,
        relation: cap.relation,
        relationTerm: cap.relationTerm,
        marker,
      };
    });
}

/**
 * Shape gathered rows into the FE ThreadGraph — the pure core. `trustBy:` id → TrustLevel,
 * `treeLabel:` the resolved tree tier (real tag / project). Deterministic given its inputs.
 */
export function buildThreadGraph(
  anchorId: string,
  records: Map<string, RawRecord>,
  edges: RawEdge[],
  trustBy: Map<string, TrustLevel>,
  treeLabel: string,
  tiers: SpineTierData,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): ThreadGraph {
  const spineNodeId = pickSpineNodeId(anchorId, edges, records);

  // Nodes — only records that actually resolved (edges to unresolved endpoints are dropped).
  const nodes: ThreadNode[] = [...records.values()].map((rec) => ({
    id: rec.id,
    kind: kindOf(rec),
    title: rec.title,
    trust: trustBy.get(rec.id) ?? 'unproven',
    ...(rec.id === spineNodeId ? { isSpine: true } : {}),
    ...(rec.id === anchorId ? { isCurrent: true } : {}),
  }));

  // Edges — keep only those whose BOTH endpoints resolved to a node (no dangling edges).
  const threadEdges: ThreadEdge[] = edges
    .filter((e) => records.has(e.fromId) && records.has(e.toId))
    .map((e) => ({ id: e.id, source: e.fromId, target: e.toId, edgeType: e.edgeType }));

  const spineTask = spineNodeId ? records.get(spineNodeId) : undefined;
  const spine = buildSpine(spineTask, treeLabel, tiers, config);
  const story = buildStory(anchorId, spineNodeId, nodes, edges, records, config);

  const anchor: ThreadAnchor = {
    branchLabel: branchNameOf(spineTask, config).name,
    anchorId,
    recordCount: nodes.length,
  };

  return { anchor, spine, nodes, edges: threadEdges, story, trunkAnchorId: tiers.trunkHeadId };
}

/** The honest empty graph — a genuinely-empty (no resume anchor) thread. The trunk head
 *  is still surfaced when it exists, so "jump to trunk" works even from an empty walk. */
export function emptyThreadGraph(
  config: TreewalkerConfig = TREEWALKER_CONFIG,
  trunkAnchorId: string | null = null,
): ThreadGraph {
  return {
    anchor: { branchLabel: config.spine.branchFallbackLabel, anchorId: '', recordCount: 0 },
    spine: [],
    nodes: [],
    edges: [],
    story: [],
    trunkAnchorId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O LAYER — BFS over `links` + resolve rows + gather trust signals.
// ─────────────────────────────────────────────────────────────────────────────

export class TreeWalkerService {
  /**
   * Resolve the live resume anchor: the NEWEST context tagged with the resume tag in the
   * active project (project-scoped when `projectId` is provided). Returns null when none
   * exists (→ honest empty thread).
   */
  static async resolveAnchorId(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<string | null> {
    // `($1::uuid IS NULL OR …)` meant an unscoped caller anchored on the NEWEST resume
    // context ON THE BOX — someone else's thread (an earlier task item 7). $3 is the
    // explicit ALL_PROJECTS flag; an EMPTY allowed set resolves to no anchor at all.
    const unrestricted = scope.mode === ALL_PROJECTS;
    const res = await pool.query(
      `SELECT id
         FROM contexts
        WHERE ($3::boolean OR project_id = ANY($1::uuid[]))
          AND $2 = ANY(tags)
          AND archived_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [unrestricted ? [] : [...scope.projectIds], config.resumeTag, unrestricted],
    );
    return res.rows.length ? (res.rows[0].id as string) : null;
  }

  /**
   * BFS from `anchorId` over `links` (both directions) to config.maxDepth, bounded by
   * config.maxNodes. Returns the visited node-id set + every edge among them.
   */
  static async traverse(
    anchorId: string,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<{ nodeIds: string[]; edges: RawEdge[] }> {
    const visited = new Set<string>([anchorId]);
    const edgeById = new Map<string, RawEdge>();
    let frontier: string[] = [anchorId];

    for (let depth = 0; depth < config.maxDepth && frontier.length > 0; depth++) {
      const rows = (
        await pool.query(
          `SELECT id, from_id, from_type, to_id, to_type, edge_type
             FROM links
            WHERE from_id = ANY($1::uuid[]) OR to_id = ANY($1::uuid[])`,
          [frontier],
        )
      ).rows;

      const next = new Set<string>();
      for (const r of rows) {
        const edge: RawEdge = {
          id: r.id,
          fromId: r.from_id,
          fromType: r.from_type,
          toId: r.to_id,
          toType: r.to_type,
          edgeType: r.edge_type,
        };
        edgeById.set(edge.id, edge);
        for (const endpoint of [edge.fromId, edge.toId]) {
          if (!visited.has(endpoint)) {
            if (visited.size >= config.maxNodes) continue; // cap the walk
            visited.add(endpoint);
            next.add(endpoint);
          }
        }
      }
      frontier = [...next];
    }

    return { nodeIds: [...visited], edges: [...edgeById.values()] };
  }

  /** Resolve id → RawRecord across contexts / technical_decisions / tasks (live rows only). */
  static async fetchRecords(nodeIds: string[], pool: Pool = db): Promise<Map<string, RawRecord>> {
    const out = new Map<string, RawRecord>();
    if (nodeIds.length === 0) return out;

    const [ctx, dec, task] = await Promise.all([
      pool.query(
        `SELECT id, content, context_type, tags, created_at
           FROM contexts WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [nodeIds],
      ),
      pool.query(
        `SELECT id, title, outcome_status, status, superseded_by, decision_date, tags
           FROM technical_decisions WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [nodeIds],
      ),
      pool.query(
        `SELECT id, title, status, created_at, tags
           FROM tasks WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [nodeIds],
      ),
    ]);

    for (const r of ctx.rows) {
      out.set(r.id, {
        id: r.id,
        type: 'context',
        title: contextTitle(r.content),
        contextType: r.context_type ?? null,
        tags: r.tags ?? [],
        createdAt: r.created_at ?? null,
      });
    }
    for (const r of dec.rows) {
      out.set(r.id, {
        id: r.id,
        type: 'decision',
        title: r.title ?? '(decision)',
        outcomeStatus: r.outcome_status ?? null,
        status: r.status ?? null,
        supersededBy: r.superseded_by ?? null,
        tags: r.tags ?? [],
        createdAt: r.decision_date ?? null,
      });
    }
    for (const r of task.rows) {
      out.set(r.id, {
        id: r.id,
        type: 'task',
        title: r.title ?? '(task)',
        status: r.status ?? null,
        tags: r.tags ?? [],
        createdAt: r.created_at ?? null,
      });
    }
    return out;
  }

  /**
   * Gather the CANONICAL trust signals for every node — the same reads the canonical
   * trustForRecord makes, batched over the walked node set (bounded by maxNodes):
   *   - downstream decision outcomes + downstream task outcomes over the outcome edge
   *     types (the moat's inheritance; live rows only),
   *   - inbound supersession split by PROVENANCE: a `supersedes` edge whose created_by
   *     is NOT the belief adjudicator is DECLARED (hard cap); an adjudicator `supersedes`
   *     or any `possibly_supersedes` is SOFT (demotes only).
   * Independent of traversal depth — an outcome edge is followed to its downstream
   * decision even when that decision is outside the walked window.
   */
  static async fetchTrustSignals(
    nodeIds: string[],
    pool: Pool = db,
  ): Promise<Map<string, GatheredTrustSignals>> {
    const signals = new Map<string, GatheredTrustSignals>();
    for (const id of nodeIds) {
      signals.set(id, { outcomes: [], supersededDeclared: false, supersededSoft: false });
    }
    if (nodeIds.length === 0) return signals;

    const [sup, decOut, taskOut] = await Promise.all([
      // Inbound supersession WITH provenance (edge_type + created_by) — the declared/soft
      // split is the canonical BL-4 classification, not a lump.
      pool.query(
        `SELECT to_id, edge_type, created_by
           FROM links
          WHERE to_id = ANY($1::uuid[])
            AND edge_type IN ('supersedes', 'possibly_supersedes')`,
        [nodeIds],
      ),
      // Downstream decision outcomes (primary ground-truth; live rows only).
      pool.query(
        `SELECT l.from_id AS from_id, td.outcome_status AS outcome_status
           FROM links l
           JOIN technical_decisions td ON td.id = l.to_id
          WHERE l.from_id = ANY($1::uuid[])
            AND l.to_type = 'decision'
            AND l.edge_type = ANY($2)
            AND td.archived_at IS NULL`,
        [nodeIds, OUTCOME_OUT_EDGE_TYPES as unknown as string[]],
      ),
      // Downstream task completion (secondary ground-truth; live rows only).
      pool.query(
        `SELECT l.from_id AS from_id, t.status AS status
           FROM links l
           JOIN tasks t ON t.id = l.to_id
          WHERE l.from_id = ANY($1::uuid[])
            AND l.to_type = 'task'
            AND l.edge_type = ANY($2)
            AND t.archived_at IS NULL`,
        [nodeIds, OUTCOME_OUT_EDGE_TYPES as unknown as string[]],
      ),
    ]);

    for (const r of sup.rows) {
      const s = signals.get(r.to_id);
      if (!s) continue;
      const isSoft =
        r.edge_type === 'possibly_supersedes' || r.created_by === BELIEF_EDGE_CREATED_BY;
      if (isSoft) s.supersededSoft = true;
      else s.supersededDeclared = true;
    }
    for (const r of decOut.rows) {
      signals
        .get(r.from_id)
        ?.outcomes.push({ value: mapDecisionOutcome(r.outcome_status), source: 'decision' });
    }
    for (const r of taskOut.rows) {
      signals.get(r.from_id)?.outcomes.push({ value: mapTaskOutcome(r.status), source: 'task' });
    }
    return signals;
  }

  /** Extract the real `tree:<x>` lineage tier from a context's tags, else a fallback label. */
  static treeLabelFor(
    anchor: RawRecord | undefined,
    projectName: string | undefined,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
  ): string {
    const tag = (anchor?.tags ?? []).find((t) => t.startsWith(config.spine.treeTagPrefix));
    if (tag) return tag;
    if (projectName && projectName.trim() !== '') return `${config.spine.treeTagPrefix}${projectName}`;
    return config.spine.treeFallbackLabel;
  }

  /**
   * The full read: resolve the anchor (explicit or newest resume), walk the thread, gather
   * trust, and shape the ThreadGraph. `explicitAnchor` distinguishes the two routes:
   *   - explicit anchor that resolves to no live record → AnchorNotFoundError (→ 404).
   *   - no resume anchor found (no-arg route) → honest empty graph (→ 200).
   */
  static async getThread(
    opts: { anchorId?: string; scope: ProjectListScope; projectName?: string },
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<ThreadGraph> {
    try {
      const explicit = opts.anchorId != null && opts.anchorId !== '';
      // The DATA-RESOLVED tiers (PHASE 2): root doc + trunk head/count — fetched for
      // every response, including the honest-empty ones (jump-to-trunk must work from
      // an empty walk too).
      const tiers = await TreeWalkerTiersService.getSpineTierData(opts.scope, config, pool);
      const anchorId = explicit
        ? (opts.anchorId as string)
        : await TreeWalkerService.resolveAnchorId(opts.scope, config, pool);

      if (!anchorId) return emptyThreadGraph(config, tiers.trunkHeadId);

      const { nodeIds, edges } = await TreeWalkerService.traverse(anchorId, config, pool);
      const records = await TreeWalkerService.fetchRecords(nodeIds, pool);

      if (!records.has(anchorId)) {
        // The anchor id resolved to no live record.
        if (explicit) throw new AnchorNotFoundError(anchorId);
        return emptyThreadGraph(config, tiers.trunkHeadId);
      }

      const signals = await TreeWalkerService.fetchTrustSignals([...records.keys()], pool);
      const now = new Date();
      const trustBy = new Map<string, TrustLevel>();
      for (const rec of records.values()) {
        trustBy.set(
          rec.id,
          deriveTrust(
            rec,
            signals.get(rec.id) ?? {
              outcomes: [],
              supersededDeclared: false,
              supersededSoft: false,
            },
            now,
          ),
        );
      }

      const treeLabel = TreeWalkerService.treeLabelFor(records.get(anchorId), opts.projectName, config);
      return buildThreadGraph(anchorId, records, edges, trustBy, treeLabel, tiers, config);
    } catch (error) {
      if (error instanceof AnchorNotFoundError) throw error;
      logger.error('TreeWalker getThread error', { error, opts });
      throw new Error('Failed to build thread graph');
    }
  }
}
