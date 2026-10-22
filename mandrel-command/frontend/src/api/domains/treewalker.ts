/**
 * treewalker domain — the work/thread MAP surface: a whole-thread typed-edge GRAPH
 * (every record + the edges linking them) plus its `recall_thread`-ordered STORY and a
 * per-record TRUST read. This is the scaled-up counterpart of the per-record thread box
 * (`api.decisions.links` etc.) — a full walk of one branch, not one record's 1-hop edges.
 *
 * ── BACKEND STATUS (LIVE 2026-07-15) ─────────────────────────────
 * The Command backend now exposes the whole-thread graph + recall_thread story + trust read:
 *   • GET /api/treewalker/thread            → the LIVE resume anchor (newest `ref:resume`
 *     context in the active project, X-Project-ID scoped) — the screen's default.
 *   • GET /api/treewalker/:anchorId/thread  → an EXPLICIT anchor.
 * Both return the `ThreadGraph` below. TRUST is derived from REAL columns/edges and a
 * genuinely-empty thread returns an honest empty graph — never fabricated.
 * `TREEWALKER_CONFIG.backendReady` is now true; the screen reads live.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';

/*
 * SCOPING: this domain took a bare `projectId` and built its own pinned-header config —
 * a second, private copy of the rule that now lives in `api/http/projectScope.ts`
 * (C5: two paths doing one job drift, and this one had already drifted, silently falling
 * back to the ambient interceptor when the id was absent). Both methods now take the
 * axios config that `usePageProject().scope()` produces, which pins X-Project-ID to the
 * page's own project and THROWS rather than falling back to the ambient default.
 *
 * The header is load-bearing here, not decorative: neither endpoint takes the project in
 * its path or query. `TreeWalkerController.getResumeThread` resolves the newest
 * `ref:resume` context via `resolveListScope(req)`, so an unscoped call to it does not
 * return nothing — for an admin it walks EVERY project's threads.
 */

/**
 * A record's trust read — the CANONICAL band vocabulary (PHASE 2 item e):
 * the same bands every mcp-server recall surface renders, served by the backend's mirrored
 * canonical model (backend config/treewalkerTrustModel.ts, parity-pinned). Labels/colours
 * live in pages/treewalker/config.
 */
export type TrustLevel = 'trusted' | 'ok' | 'unproven' | 'stale' | 'superseded' | 'contradicted';

/** The record kinds a thread node can be (colour-encoded on the canvas). */
export type RecordKind = 'decision' | 'task' | 'context' | 'handoff';

/** One node on the thread graph — a record, its kind (colour), and its trust read (ring). */
export interface ThreadNode {
  /** Full record id (the short id8 is derived for display). */
  id: string;
  kind: RecordKind;
  title: string;
  trust: TrustLevel;
  /** The highlighted spine node this thread is anchored on. */
  isSpine?: boolean;
  /** The "you are here" resume node. */
  isCurrent?: boolean;
}

/**
 * One typed edge between two thread nodes. `edgeType` reuses the shared edge vocabulary
 * (config/graphEdges → EDGE_LABELS): decided_by / informs / caused / supersedes / …
 */
export interface ThreadEdge {
  id: string;
  /** Source/target are ThreadNode ids. */
  source: string;
  target: string;
  edgeType: string;
}

/**
 * A tier of the spine ribbon. `tier` is SERVER-DRIVEN vocabulary (PHASE 2):
 * the backend derives each tier from data and this client renders whatever
 * it is sent — no tier string is hardcoded here. Styling maps known tier names to
 * classes with a neutral fallback (SpineRibbon).
 */
export interface SpineNode {
  label: string;
  tier: string;
  /** Optional anchor id this tier resolves to (for a jump). */
  id?: string;
}

/** The spindle marker a story step draws (mirrors the mock's decided/informs/now/next dots). */
export type StoryMarker = 'decided' | 'informs' | 'now' | 'next' | 'default';

/** One step of the recall_thread-ordered story rail. */
export interface StoryStep {
  id: string;
  kind: RecordKind;
  title: string;
  /** May be absent for a not-yet-walked "next" step. */
  trust?: TrustLevel;
  /** The relation caption ("the why · decided_by", "informs → spine", "you are here …"). */
  relation: string;
  /** The emphasised term inside the relation caption (the mock's `.rt`). */
  relationTerm?: string;
  marker: StoryMarker;
}

/** The anchor readout ("Walking <branch> · anchored on <id> · N records"). */
export interface ThreadAnchor {
  branchLabel: string;
  anchorId: string;
  recordCount: number;
}

/** The full thread the screen walks: anchor + spine lineage + graph (nodes/edges) + story. */
export interface ThreadGraph {
  anchor: ThreadAnchor;
  spine: SpineNode[];
  nodes: ThreadNode[];
  edges: ThreadEdge[];
  story: StoryStep[];
  /** The trunk HEAD (newest handoff) — the real jump-to-trunk target; null = no handoffs. */
  trunkAnchorId: string | null;
}

/** One entry of the trunk timeline (newest first) — GET /api/treewalker/trunk. */
export interface TrunkEntry {
  id: string;
  title: string;
  createdAt: string;
  /** Corroboration only (never ordering): a declared supersedes edge points at it. */
  superseded: boolean;
}

/** The trunk timeline: FULL handoff count + bounded entries + the head id. */
export interface TrunkTimeline {
  count: number;
  headId: string | null;
  entries: TrunkEntry[];
}

/** One branch on the resume surface — GET /api/treewalker/branches. */
export interface BranchSummary {
  spineId: string;
  spineType: 'context' | 'decision' | 'task';
  /** The once-on-the-spine `branch:<name>` tag value, else the spine's title. */
  name: string;
  named: boolean;
  members: number;
  lastActiveAt: string;
  /** A session is currently standing on this branch. */
  open: boolean;
  /**
   * ALWAYS true as served by GET /api/treewalker/branches (P2):
   * a section (a spine that is itself a member of another branch) is filtered
   * out server-side BEFORE the cap, so it never reaches this array. Kept on the wire as
   * an explicit fact the rail still checks — defense-in-depth, not trust in an upstream
   * filter it cannot see.
   */
  isTopLevel: boolean;
  /** How many of THIS branch's own members are themselves branch spines (nested drawers). */
  sectionCount: number;
}

/** The branch list plus the honest totals a caller needs to never mistake a capped page
 *  for the whole set (P1, P2). */
export interface BranchListResult {
  branches: BranchSummary[];
  /** TRUE count of top-level DRAWERS (sections excluded) in scope, computed over the
   *  full population AFTER the drawer filter but BEFORE `cap` truncates the returned
   *  array (P2). */
  total: number;
  /** The branch-list cap actually applied to `branches.length` this call. */
  cap: number;
}

export const treewalkerApi = {
  /**
   * GET /api/treewalker/:anchorId/thread — the whole-thread graph + recall_thread story +
   * trust reads for one EXPLICIT anchor.
   */
  async getThread(anchorId: string, config?: AxiosRequestConfig): Promise<ThreadGraph> {
    const body = await http.get<ApiEnvelope<ThreadGraph>>(
      `/treewalker/${encodeURIComponent(anchorId)}/thread`,
      config,
    );
    const thread = unwrapData(body, 'Failed to load thread');
    if (!thread) {
      throw new Error('Thread payload missing in response');
    }
    return thread;
  },

  /**
   * GET /api/treewalker/thread — the LIVE resume-anchor thread: the backend resolves the
   * newest `ref:resume` context in the project THIS REQUEST NAMES (via `config`, i.e. the
   * page's `scope()`) and returns its walked thread. The screen's default read when no
   * explicit anchor is selected.
   */
  async getResumeThread(config?: AxiosRequestConfig): Promise<ThreadGraph> {
    const body = await http.get<ApiEnvelope<ThreadGraph>>(
      `/treewalker/thread`,
      config,
    );
    const thread = unwrapData(body, 'Failed to load resume thread');
    if (!thread) {
      throw new Error('Thread payload missing in response');
    }
    return thread;
  },

  /** GET /api/treewalker/trunk — the handoff TIMELINE (time-ordered; PHASE 2 item a). */
  async getTrunk(config?: AxiosRequestConfig): Promise<TrunkTimeline> {
    const body = await http.get<ApiEnvelope<TrunkTimeline>>(`/treewalker/trunk`, config);
    const trunk = unwrapData(body, 'Failed to load the trunk timeline');
    if (!trunk) {
      throw new Error('Trunk payload missing in response');
    }
    return trunk;
  },

  /**
   * GET /api/treewalker/branches — the resume surface (top-level drawers only, newest-
   * active first; item c). Returns the full envelope, not just the array: `total`/`cap`
   * (P1, drawer-only semantics from P2)
   * are how a caller (the BranchRail) tells a capped page from the whole set instead of
   * inferring it from `branches.length`.
   */
  async getBranches(config?: AxiosRequestConfig): Promise<BranchListResult> {
    const body = await http.get<ApiEnvelope<BranchListResult>>(`/treewalker/branches`, config);
    const data = unwrapData(body, 'Failed to load the branch list');
    if (!data) {
      throw new Error('Branch list payload missing in response');
    }
    return data;
  },
};

export type TreewalkerApi = typeof treewalkerApi;
