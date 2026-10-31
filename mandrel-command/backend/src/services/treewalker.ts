/**
 * TreeWalkerService — the BRANCH thread behind `GET /api/treewalker/thread` (newest-active
 * branch) and `GET /api/treewalker/:anchorId/thread` (explicit anchor): a typed-edge GRAPH of
 * ONE declared branch, a createdAt-ordered STORY, and a per-record TRUST read.
 *
 * THREAD v2 (design). v1 ran an undirected 2-hop BFS over every
 * edge type and sampled 1544 reachable records down to 60 (hub decisions fan out 1438 via
 * decided_by). v2 walks a declared BRANCH instead:
 *   - SPINE: the anchor if it is a branch spine, else the spine of the branch it is a member
 *     of (branch_membership view), else the anchor itself. No anchor → the first branch
 *     getBranches returns (same ordering + drawer filter as GET /branches).
 *   - MEMBERS: the spine + its branch_membership rows + every same-project record with a
 *     DECLARED strong-type edge TO the spine. Handoffs, `alert*` contexts and archived
 *     records are never members. Capped by config.maxMembers (newest kept).
 *   - GHOST CAUSES: non-members a member points at through a declared decided_by /
 *     learned_from / depends_on edge — returned with inBranch:false, capped by config.maxGhosts.
 *   - EDGES: declared edges whose both ends are returned, each carrying mintVia + provenance.
 *
 * Design mirrors the mcp-server trust model's TWO-LAYER split:
 *   1. PURE builders (buildThreadGraph / deriveTrust / buildStory / buildSpine / selectBranch)
 *      — no DB, no clock; gathered rows + injected config in, shaped graph out.
 *   2. I/O gather (resolveSpine / gatherBranch / getThread) — a handful of set-keyed queries.
 *
 * GROUNDING (data policy — never fabricate trust or edges):
 *   - EDGES are real declared `links` rows; a genuinely-empty thread returns an empty graph.
 *   - TRUST is the CANONICAL model (PHASE 2 item e): the same bands, math
 *     and config as mcp-server's trustModel.ts, via the mirrored
 *     config/treewalkerTrustModel.ts (parity pinned by treewalkerTrustParity.test.ts).
 */
import type { Pool } from 'pg';
import { db } from '../database/connection';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';
import { logger } from '../config/logger';
import { TREEWALKER_CONFIG, type TreewalkerConfig, type StoryCaption } from '../config/treewalkerConfig';
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
  /** ISO creation time (decisions: decision_date) — what a client lays the node out by. */
  createdAt: string;
  /** True for the spine + members; false for a GHOST cause (context the branch leans on). */
  inBranch: boolean;
  /** Contexts only — the context_type. */
  contextType?: string | null;
  /** Tasks only — the task status. */
  status?: string | null;
  /** Decisions only — outcome_status, null when unset. */
  outcomeStatus?: string | null;
  isSpine?: boolean;
  isCurrent?: boolean;
}
export interface ThreadEdge {
  id: string;
  source: string;
  target: string;
  edgeType: string;
  /** links.mint_via — the derivation path that minted the edge. */
  mintVia: string;
  /** links.provenance_class — always 'declared' on this endpoint. */
  provenance: string;
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
  /** TRUE number of eligible branch members (spine included) before the maxMembers cap. */
  memberTotal: number;
  /** True when memberTotal exceeded maxMembers and only the newest were returned. */
  truncated: boolean;
}

/** What buildThreadGraph needs beyond the rows: which nodes are ghosts + the cap report. */
export interface ThreadShape {
  ghostIds?: ReadonlySet<string>;
  memberTotal?: number;
  truncated?: boolean;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  mintVia: string;
  provenance: string;
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

/** ISO string for a raw createdAt (missing → epoch, matching the ordering's fallback). */
export function isoOf(v: Date | string | null | undefined): string {
  return new Date(tms(v)).toISOString();
}

/** createdAt ASC, id as the tiebreak — the ONE ordering of a branch story. */
function byTimeThenId(a: { id: string; createdAt?: Date | string | null }, b: { id: string; createdAt?: Date | string | null }): number {
  return tms(a.createdAt) - tms(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Handoffs are the trunk and `alert*`-tagged contexts are vitals noise — neither is a story
 * member (or a ghost cause). Only contexts are judged: tasks/decisions carry neither marker.
 */
export function isExcludedFromBranch(
  rec: Pick<RawRecord, 'type' | 'contextType' | 'tags'>,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): boolean {
  if (rec.type !== 'context') return false;
  if (rec.contextType != null && config.branch.excludedContextTypes.includes(rec.contextType)) return true;
  return (rec.tags ?? []).some((t) => t.startsWith(config.branch.excludedTagPrefix));
}

/**
 * Apply the member cap. Keeps the spine plus the NEWEST (maxMembers − 1) others — i.e. the
 * newest `maxMembers` with the spine pinned in, so the thread is never detached from the
 * record it is the thread OF. `total` is the true eligible count; `truncated` iff over cap.
 */
export function selectMembers(
  spineId: string,
  eligible: RawRecord[],
  config: TreewalkerConfig = TREEWALKER_CONFIG,
): { kept: RawRecord[]; total: number; truncated: boolean } {
  const total = eligible.length;
  if (total <= config.maxMembers) return { kept: [...eligible], total, truncated: false };
  const spine = eligible.filter((r) => r.id === spineId);
  const newest = eligible
    .filter((r) => r.id !== spineId)
    .sort((a, b) => byTimeThenId(b, a))
    .slice(0, Math.max(0, config.maxMembers - spine.length));
  return { kept: [...spine, ...newest], total, truncated: true };
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
 * Build the STORY: every returned node once, ordered by createdAt ASCENDING with id as the
 * tiebreak. Narration runs in time — the causal-rank order recall_thread uses puts a member
 * BEFORE the decision it was decided_by, which is wrong for a story (thread v2).
 * MARKERS + captions are presentation, derived from real roles:
 *   now     — the anchor (the spine the thread was resolved to).
 *   decided — a decision some returned node is `decided_by` (the why).
 *   informs — the spine node when it is not the anchor.
 *   next    — ONE open (todo/in_progress) task, preferring one the spine points at.
 *   default — any other node (generic caption).
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
  const ordered = [...nodes].sort((a, b) => byTimeThenId(a, b));

  const decidedIds = new Set(
    edges.filter((e) => e.edgeType === 'decided_by' && e.toType === 'decision').map((e) => e.toId),
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
    const byCreated = (x: string, y: string) =>
      byTimeThenId({ id: x, createdAt: records.get(x)?.createdAt }, { id: y, createdAt: records.get(y)?.createdAt });
    const pointedAt = new Set(
      edges
        .filter((e) => (e.fromId === anchorId || e.fromId === spineNodeId) && e.toType === 'task')
        .map((e) => e.toId),
    );
    nextId =
      openTaskIds.filter((id) => pointedAt.has(id)).sort(byCreated)[0] ??
      openTaskIds.sort(byCreated)[0];
  }

  return ordered.map((n) => {
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
 * Shape gathered rows into the FE ThreadGraph — the pure core. `anchorId` is the resolved
 * SPINE. `trustBy:` id → TrustLevel, `treeLabel:` the resolved tree tier (real tag /
 * project), `shape:` the ghost set + member-cap report. Deterministic given its inputs.
 */
export function buildThreadGraph(
  anchorId: string,
  records: Map<string, RawRecord>,
  edges: RawEdge[],
  trustBy: Map<string, TrustLevel>,
  treeLabel: string,
  tiers: SpineTierData,
  config: TreewalkerConfig = TREEWALKER_CONFIG,
  shape: ThreadShape = {},
): ThreadGraph {
  const ghostIds = shape.ghostIds ?? new Set<string>();

  // Nodes — only records that actually resolved (edges to unresolved endpoints are dropped).
  const nodes: ThreadNode[] = [...records.values()].map((rec) => ({
    id: rec.id,
    kind: kindOf(rec),
    title: rec.title,
    trust: trustBy.get(rec.id) ?? 'unproven',
    createdAt: isoOf(rec.createdAt),
    inBranch: !ghostIds.has(rec.id),
    ...(rec.type === 'context' ? { contextType: rec.contextType ?? null } : {}),
    ...(rec.type === 'task' ? { status: rec.status ?? null } : {}),
    ...(rec.type === 'decision' ? { outcomeStatus: rec.outcomeStatus ?? null } : {}),
    ...(rec.id === anchorId ? { isSpine: true, isCurrent: true } : {}),
  }));

  // Edges — keep only those whose BOTH endpoints resolved to a node (no dangling edges).
  const threadEdges: ThreadEdge[] = edges
    .filter((e) => records.has(e.fromId) && records.has(e.toId))
    .map((e) => ({
      id: e.id,
      source: e.fromId,
      target: e.toId,
      edgeType: e.edgeType,
      mintVia: e.mintVia,
      provenance: e.provenance,
    }));

  const spineRec = records.get(anchorId);
  const spine = buildSpine(spineRec, treeLabel, tiers, config);
  const story = buildStory(anchorId, anchorId, nodes, edges, records, config);

  const anchor: ThreadAnchor = {
    branchLabel: branchNameOf(spineRec, config).name,
    anchorId,
    recordCount: nodes.length,
  };

  return {
    anchor,
    spine,
    nodes,
    edges: threadEdges,
    story,
    trunkAnchorId: tiers.trunkHeadId,
    memberTotal: shape.memberTotal ?? nodes.length - ghostIds.size,
    truncated: shape.truncated ?? false,
  };
}

/** The honest empty graph — a project with no branch. The trunk head is still surfaced
 *  when it exists, so "jump to trunk" works even from an empty walk. */
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
    memberTotal: 0,
    truncated: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O LAYER — resolve the spine, gather the branch + trust signals.
// ─────────────────────────────────────────────────────────────────────────────

export class TreeWalkerService {
  /**
   * Resolve a record id to its live row + project, across the three record tables.
   * Archived → null. `scope` bounds visibility (an out-of-scope id reads as not found).
   */
  static async liveRecord(
    id: string,
    scope: ProjectListScope,
    pool: Pool = db,
  ): Promise<{ id: string; projectId: string } | null> {
    if (!UUID_RE.test(id)) return null;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const res = await pool.query(
      `SELECT id, project_id FROM (
         SELECT id, project_id FROM contexts WHERE id = $1 AND archived_at IS NULL
         UNION ALL
         SELECT id, project_id FROM technical_decisions WHERE id = $1 AND archived_at IS NULL
         UNION ALL
         SELECT id, project_id FROM tasks WHERE id = $1 AND archived_at IS NULL
       ) r
       WHERE $3::boolean OR project_id = ANY($2::uuid[])
       LIMIT 1`,
      [id, unrestricted ? [] : [...scope.projectIds], unrestricted],
    );
    return res.rows.length ? { id: res.rows[0].id, projectId: res.rows[0].project_id } : null;
  }

  /**
   * SPINE RESOLUTION (thread v2): the anchor if it is a branch spine; else the spine of the
   * branch it is a member of (branch_membership view); else the anchor itself. A member whose
   * spine is archived/out of scope falls back to the anchor. Null → the anchor is not a live
   * record in scope.
   */
  static async resolveSpine(
    anchorId: string,
    scope: ProjectListScope,
    pool: Pool = db,
  ): Promise<{ spineId: string; projectId: string } | null> {
    const anchor = await TreeWalkerService.liveRecord(anchorId, scope, pool);
    if (!anchor) return null;
    const spineId = await TreeWalkerService.membershipSpine(anchor, scope, pool);
    if (spineId) return { spineId, projectId: anchor.projectId };
    return { spineId: anchorId, projectId: anchor.projectId };
  }

  /**
   * The spine a live record belongs to by recorded branch membership: itself when it IS a
   * spine, else the live spine it is a member of, else null (on no branch).
   */
  static async membershipSpine(
    anchor: { id: string; projectId: string },
    scope: ProjectListScope,
    pool: Pool = db,
  ): Promise<string | null> {
    const asSpine = await pool.query(`SELECT 1 FROM branch_membership WHERE spine_id = $1 LIMIT 1`, [anchor.id]);
    if (asSpine.rows.length) return anchor.id;
    const asMember = await pool.query(
      `SELECT spine_id FROM branch_membership WHERE member_id = $1 AND project_id = $2 LIMIT 1`,
      [anchor.id, anchor.projectId],
    );
    if (asMember.rows.length) {
      const spine = await TreeWalkerService.liveRecord(asMember.rows[0].spine_id, scope, pool);
      if (spine) return spine.id;
    }
    return null;
  }

  /**
   * Gather ONE branch: eligible members (capped), ghost causes (capped) and the declared
   * edges among the returned records. Every query is a flat set-keyed read — no recursion.
   */
  static async gatherBranch(
    spineId: string,
    projectId: string,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<{
    records: Map<string, RawRecord>;
    ghostIds: Set<string>;
    edges: RawEdge[];
    memberTotal: number;
    truncated: boolean;
  }> {
    const b = config.branch;
    // MEMBERS: the spine + branch_membership rows + declared strong edges TO the spine.
    const cand = await pool.query(
      `SELECT member_id AS id FROM branch_membership WHERE spine_id = $1
       UNION
       SELECT from_id AS id FROM links
        WHERE to_id = $1
          AND provenance_class = $2
          AND edge_type = ANY($3::text[])
          AND mint_via <> ALL($4::text[])`,
      [spineId, b.declaredProvenance, [...b.strongEdgeTypes], [...b.excludedMintVia]],
    );
    const candIds = new Set<string>([spineId, ...cand.rows.map((r) => r.id as string)]);
    const fetched = await TreeWalkerService.fetchRecords([...candIds], pool, projectId);
    const eligible = [...fetched.values()].filter(
      (r) => r.id === spineId || !isExcludedFromBranch(r, config),
    );
    const { kept, total, truncated } = selectMembers(spineId, eligible, config);
    const records = new Map(kept.map((r) => [r.id, r]));
    const eligibleIds = new Set(eligible.map((r) => r.id));

    // GHOST CAUSES: non-members a kept member points at via a declared why/learned/depends edge.
    const ghostRows = await pool.query(
      `SELECT DISTINCT to_id FROM links
        WHERE from_id = ANY($1::uuid[])
          AND provenance_class = $2
          AND edge_type = ANY($3::text[])`,
      [[...records.keys()], b.declaredProvenance, [...b.ghostEdgeTypes]],
    );
    const ghostCandIds = ghostRows.rows.map((r) => r.to_id as string).filter((id) => !eligibleIds.has(id));
    const ghostFetched = await TreeWalkerService.fetchRecords(ghostCandIds, pool, projectId);
    const ghosts = [...ghostFetched.values()]
      .filter((r) => !isExcludedFromBranch(r, config))
      .sort((x, y) => byTimeThenId(y, x))
      .slice(0, config.maxGhosts);
    const ghostIds = new Set(ghosts.map((g) => g.id));
    for (const g of ghosts) records.set(g.id, g);

    // EDGES: declared, both ends returned.
    const ids = [...records.keys()];
    const edgeRows = await pool.query(
      `SELECT id, from_id, from_type, to_id, to_type, edge_type, mint_via, provenance_class
         FROM links
        WHERE from_id = ANY($1::uuid[]) AND to_id = ANY($1::uuid[])
          AND provenance_class = $2
        ORDER BY created_at, id`,
      [ids, b.declaredProvenance],
    );
    const edges: RawEdge[] = edgeRows.rows.map((r) => ({
      id: r.id,
      fromId: r.from_id,
      fromType: r.from_type,
      toId: r.to_id,
      toType: r.to_type,
      edgeType: r.edge_type,
      mintVia: r.mint_via,
      provenance: r.provenance_class,
    }));
    return { records, ghostIds, edges, memberTotal: total, truncated };
  }

  /** Resolve id → RawRecord across contexts / technical_decisions / tasks (live rows only). */
  static async fetchRecords(
    nodeIds: string[],
    pool: Pool = db,
    projectId?: string,
  ): Promise<Map<string, RawRecord>> {
    const out = new Map<string, RawRecord>();
    if (nodeIds.length === 0) return out;

    const [ctx, dec, task] = await Promise.all([
      pool.query(
        `SELECT id, content, context_type, tags, created_at
           FROM contexts WHERE id = ANY($1::uuid[]) AND archived_at IS NULL
            AND ($2::uuid IS NULL OR project_id = $2)`,
        [nodeIds, projectId ?? null],
      ),
      pool.query(
        `SELECT id, title, outcome_status, status, superseded_by, decision_date, tags
           FROM technical_decisions WHERE id = ANY($1::uuid[]) AND archived_at IS NULL
            AND ($2::uuid IS NULL OR project_id = $2)`,
        [nodeIds, projectId ?? null],
      ),
      pool.query(
        `SELECT id, title, status, created_at, tags
           FROM tasks WHERE id = ANY($1::uuid[]) AND archived_at IS NULL
            AND ($2::uuid IS NULL OR project_id = $2)`,
        [nodeIds, projectId ?? null],
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
      // No anchor → the FIRST branch GET /branches returns (same ordering + drawer filter).
      const anchorInput = explicit
        ? (opts.anchorId as string)
        : (await TreeWalkerTiersService.getBranches(opts.scope, config, pool)).branches[0]?.spineId;

      if (!anchorInput) return emptyThreadGraph(config, tiers.trunkHeadId);

      const resolved = await TreeWalkerService.resolveSpine(anchorInput, opts.scope, pool);
      if (!resolved) {
        if (explicit) throw new AnchorNotFoundError(anchorInput);
        return emptyThreadGraph(config, tiers.trunkHeadId);
      }
      const anchorId = resolved.spineId;
      const { records, ghostIds, edges, memberTotal, truncated } = await TreeWalkerService.gatherBranch(
        anchorId,
        resolved.projectId,
        config,
        pool,
      );

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
      return buildThreadGraph(anchorId, records, edges, trustBy, treeLabel, tiers, config, {
        ghostIds,
        memberTotal,
        truncated,
      });
    } catch (error) {
      if (error instanceof AnchorNotFoundError) throw error;
      logger.error('TreeWalker getThread error', { error, opts });
      throw new Error('Failed to build thread graph');
    }
  }
}
