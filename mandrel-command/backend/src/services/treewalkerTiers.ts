/**
 * TreeWalker TIERS — trunk / roots / branch list, all RESOLVED FROM DATA (PHASE 2,
 * an earlier task; tree model). Replaces the literal tier strings the audit
 * called PROSE (an earlier change: the trunk and roots tiers were config strings with no
 * id and no query behind them).
 *
 * THE TRUNK (a): the project's handoff-context TIMELINE, ordered by created_at DESC.
 * TIME IS THE ORDERING — ALWAYS. `supersedes` edges appear only as per-entry
 * CORROBORATION metadata (does a declared handoff-supersession edge point at this
 * entry?), read in ONE flat batched query. This module contains no recursive query and
 * never walks the supersedes graph: an earlier change measured a naive recursive supersedes
 * walk at 22,482,181 rows. Bounded: LIMIT trunkMaxEntries; the count reports the full
 * total.
 *
 * THE ROOTS (b): the newest live context carrying a locked-root tag (`ref:canonical` /
 * `ref:north-star` — config.spine.rootTags). No doc → null (the ribbon renders the
 * honest fallback with no id, never a fake canonical claim).
 *
 * THE BRANCH LIST (c) — the operator's resume surface: spine records that have MEMBERS,
 * enumerated from the `branch_membership` VIEW (migration 086 — the single source of
 * the membership predicate, shared with mcp-server's branch_history; no TypeScript
 * copy). A member is a record whose edge was minted BY POSITION. Until SK2 this read
 * the LOOSE declared+informs predicate off link_provenance and over-counted; see the
 * measured numbers on getBranches below. Newest-active
 * first. A branch is NAMED by its once-on-the-spine `branch:<name>` tag, else by the
 * spine record's title (an earlier change membership/identity split). Open positions
 * (branch_positions) mark which branches sessions are standing on right now.
 */
import type { Pool } from 'pg';
import { db } from '../database/connection';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';
import { TREEWALKER_CONFIG, type TreewalkerConfig } from '../config/treewalkerConfig';
import { BELIEF_EDGE_CREATED_BY } from '../config/treewalkerTrustModel';
import { contextTitle } from './recordTitle';

/** One entry of the trunk timeline (newest first). */
export interface TrunkEntry {
  id: string;
  title: string;
  createdAt: string;
  /**
   * CORROBORATION ONLY (never ordering): a declared `supersedes` edge points at this
   * handoff (its successor formally superseded it). The newest handoff is false here.
   */
  superseded: boolean;
}

/** The trunk timeline: full count + bounded entries + the trunk head (newest handoff). */
export interface TrunkTimeline {
  /** FULL count of live handoff contexts in scope (not capped by the entry limit). */
  count: number;
  /** The newest handoff's id — the jump-to-trunk anchor. Null when count is 0. */
  headId: string | null;
  entries: TrunkEntry[];
}

/** The resolved root doc (the newest locked canonical/north-star context), or null. */
export interface RootDoc {
  id: string;
  title: string;
  createdAt: string;
}

/** One milestone member of a branch — a station on the Map. */
export interface BranchMilestone {
  id: string;
  createdAt: string;
  title: string;
}

/** The share of recent contexts that sit on no branch (the Map's strip). */
export interface UnbranchedShare {
  /** Non-archived contexts in the window that are on no branch (no membership, no declared strong link to a spine). */
  unbranched: number;
  /** ALL non-archived contexts of the project scope created inside the window. */
  total: number;
  /** The window, in days, these two numbers cover. */
  windowDays: number;
}

/** One branch on the resume surface. */
export interface BranchSummary {
  spineId: string;
  spineType: 'context' | 'decision' | 'task';
  /** The once-on-the-spine `branch:<name>` tag value, else the spine's title. */
  name: string;
  /** True when the name came from a `branch:` tag (vs the title fallback). */
  named: boolean;
  /** Declared membership edges onto this spine. */
  members: number;
  /** Oldest member's created_at — where the branch's line starts on the Map. */
  firstActiveAt: string;
  /** Newest declared member edge's created_at — the "newest-active" ordering key. */
  lastActiveAt: string;
  /** Member contexts of type 'milestone', oldest first, capped by config.map.milestonesMax
   *  (the Map's stations). */
  milestones: BranchMilestone[];
  /** A session is currently standing on this branch (branch_positions). */
  open: boolean;
  /**
   * ALWAYS true as returned by `getBranches` (P2):
   * a section (a spine that is itself a member of another branch) is now excluded from
   * the query BEFORE the cap, so it never reaches this array to be marked false. The
   * field survives as an explicit, defense-in-depth fact on the wire — a renderer must
   * not have to trust an upstream filter it cannot see — rather than because any caller
   * still needs to distinguish drawers from sections in this list.
   */
  isTopLevel: boolean;
  /**
   * How many of THIS branch's members are themselves branch spines (i.e. have
   * members of their own) — the drawer's section count. A member that is an
   * ordinary leaf record does not count; only a member that is itself a spine in
   * `branch_membership` does. 0 for a branch with no nested spines.
   */
  sectionCount: number;
}

/** The branch list plus the honest totals a caller needs to never mistake a
 *  capped page for the whole set (P1). */
export interface BranchListResult {
  branches: BranchSummary[];
  /**
   * TRUE count of top-level DRAWERS in scope (P2) —
   * computed over the full scoped population AFTER sections are filtered out but BEFORE
   * `cap` truncates the returned array. Before this change `total` counted drawers and
   * sections together (the `branch_membership` grouping had no drawer/section split at
   * all), which made it useless as a denominator for "how many drawers am I not seeing"
   * — nobody could answer that question because the number that question needs did not
   * exist. Never itself truncated.
   *
   * ARCHIVED SPINES ARE EXCLUDED FROM THIS NUMBER (CLAUSE 5) — from the
   * total and from `branches` by the same predicate, so `total - branches.length` is
   * always either 0 or the number the cap withheld, never a set of drawers that are
   * archived and therefore unreachable by paging.
   */
  total: number;
  /** The `branchListMax` cap actually applied to `branches.length` this call
   *  (config.treewalkerConfig — MANDREL_TW_BRANCH_LIST_MAX). */
  cap: number;
  /** The `sinceDays` window actually applied to the list (echoed, never implied). */
  sinceDays: number;
  /** The unbranched share over the project's recent non-archived contexts. */
  unbranched: UnbranchedShare;
}

/** The scope predicate used by every query here: ($all OR project_id = ANY($ids)). */
function scopeParams(scope: ProjectListScope): { ids: string[]; all: boolean } {
  const all = scope.mode === ALL_PROJECTS;
  return { ids: all ? [] : [...scope.projectIds], all };
}

/** The effective `sinceDays`: a positive integer, defaulted and clamped by config.map. */
export function resolveSinceDays(raw: number | undefined, config: TreewalkerConfig): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return config.map.sinceDaysDefault;
  return Math.min(Math.floor(raw), config.map.sinceDaysMax);
}

export class TreeWalkerTiersService {
  /** (a) The trunk timeline. ONE bounded rows query + ONE count + ONE flat edge batch. */
  static async getTrunk(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<TrunkTimeline> {
    const { ids, all } = scopeParams(scope);
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, content, created_at
           FROM contexts
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
            AND context_type = 'handoff'
            AND archived_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [ids, all, config.trunkMaxEntries],
      ),
      pool.query(
        `SELECT count(*)::int AS n
           FROM contexts
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
            AND context_type = 'handoff'
            AND archived_at IS NULL`,
        [ids, all],
      ),
    ]);

    const entryIds = rows.rows.map((r) => r.id as string);
    // CORROBORATION: one FLAT query — which of these handoffs has a DECLARED supersedes
    // edge pointing at it. No recursion, no ordering role. DECLARED means the same thing
    // it means in the canonical trust split (trust.ts BL-4): a `supersedes` edge whose
    // created_by is NOT the belief adjudicator — a soft/adjudicated guess is not the
    // trunk's corroboration signal (Reviewer NIT 1).
    const superseded = new Set<string>();
    if (entryIds.length > 0) {
      const sup = await pool.query(
        `SELECT DISTINCT to_id FROM links
          WHERE to_id = ANY($1::uuid[])
            AND edge_type = 'supersedes'
            AND created_by IS DISTINCT FROM $2`,
        [entryIds, BELIEF_EDGE_CREATED_BY],
      );
      for (const r of sup.rows) superseded.add(r.to_id as string);
    }

    return {
      count: count.rows[0].n as number,
      headId: entryIds.length > 0 ? entryIds[0] : null,
      entries: rows.rows.map((r) => ({
        id: r.id as string,
        title: contextTitle(r.content),
        createdAt: new Date(r.created_at).toISOString(),
        superseded: superseded.has(r.id as string),
      })),
    };
  }

  /** (b) The newest live root-tagged (canonical / north-star) context, or null. */
  static async getRootDoc(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<RootDoc | null> {
    const { ids, all } = scopeParams(scope);
    const r = await pool.query(
      `SELECT id, content, created_at
         FROM contexts
        WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
          AND tags && $3::text[]
          AND archived_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [ids, all, [...config.spine.rootTags]],
    );
    if (r.rows.length === 0) return null;
    return {
      id: r.rows[0].id as string,
      title: contextTitle(r.rows[0].content),
      createdAt: new Date(r.rows[0].created_at).toISOString(),
    };
  }

  /**
   * The LIGHT tier read the thread endpoint embeds in every ThreadGraph: root doc +
   * trunk head + full trunk count (no timeline entries). Three small bounded queries.
   */
  static async getSpineTierData(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<{ root: RootDoc | null; trunkHeadId: string | null; trunkCount: number }> {
    const { ids, all } = scopeParams(scope);
    const [root, head, count] = await Promise.all([
      TreeWalkerTiersService.getRootDoc(scope, config, pool),
      pool.query(
        `SELECT id FROM contexts
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
            AND context_type = 'handoff' AND archived_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ids, all],
      ),
      pool.query(
        `SELECT count(*)::int AS n FROM contexts
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
            AND context_type = 'handoff' AND archived_at IS NULL`,
        [ids, all],
      ),
    ]);
    return {
      root,
      trunkHeadId: head.rows.length > 0 ? (head.rows[0].id as string) : null,
      trunkCount: count.rows[0].n as number,
    };
  }

  /**
   * (c) The branch list: spines that have MEMBERS, newest-active first.
   *
   * MEMBERSHIP IS NOT SPELLED HERE. It is the `branch_membership` view (migration 086) —
   * the same view mcp-server's branch_history reads. Do not inline the predicate back into
   * this query; that is precisely what went wrong.
   *
   * WHAT THIS USED TO SAY, AND WHY IT WAS WRONG (SK2). This query filtered
   * `link_provenance` on `provenance_class = 'declared' AND edge_type = 'informs'`. That is
   * not the membership predicate — it is a superset. `declared` is generated from mint_via
   * and is also true for tag-minted, links-param, decision-evidence and task-dependency
   * edges, several of which mint `informs`. Membership is minted by ONE path
   * (mint_via = 'position', services/positionalMint.ts). MEASURED ON PROD 2026-08-15:
   *
   *     an earlier spine   this query said 17 members   |   true membership: 9
   *     corpus-wide      this query matched 1979      |   true membership: 77
   *
   * So the dashboard was showing a wrong number on a user-visible surface, and it was wrong
   * because one fact had two authors — this file and mcp-server — with nothing asserting
   * they agreed. The backend cannot import mcp-server TypeScript (see treewalkerTrustModel.ts),
   * so the fix is not a shared constant plus a parity test; it is a shared VIEW, which leaves
   * no second copy that can drift.
   *
   * NO RESIDUAL DIVERGENCE. An earlier draft of this note said the two surfaces still
   * disagreed on tip-chained writes, because mcp-server walked the chain and this GROUP BY
   * did not. Both halves of that are now false: migration 086 stores the minting position's
   * ROOT spine in `branch_memberships`, `branch_membership.spine_id` IS that column, and
   * branch_history reads the same view with the same flat equality. Neither surface
   * traverses anything, so neither can drift from the other by traversing differently —
   * grouping by spine_id here partitions exactly the set branch_history returns per spine.
   *
   * WHAT THIS COUNT DELIBERATELY DOES NOT INCLUDE (SK2 round 3). Records that TAG a spine
   * but carry no recorded position are NOT members and are not counted here. branch_history
   * surfaces them as a separate `tagOnlyNoPosition` band because a reader of ONE branch needs
   * to see that seam; a branch LIST is a different surface, and adding a second number to
   * every row of it would restate the caveat 20 times without making any of them actionable.
   * The two surfaces still compute the same MEMBER set, which is the parity that matters.
   *
   * The note is not deleted outright because the direction it got WRONG is worth one line:
   * it predicted this query would UNDER-count, and what the walk actually did was
   * OVER-count, absorbing nested branches' writes into their parent.
   *
   * P1: a drawer's members can THEMSELVES be branch
   * spines — a spine reachable only by grouping is a SECTION, not a top-level drawer.
   * isTopLevel and sectionCount answer that from `branch_membership.member_id` alone (a
   * spine is nested exactly when it appears as some other branch's member_id) — no
   * recursion, one extra self-join over the same scoped population this query already
   * reads.
   *
   * P2 (an earlier task — "select drawers before the cap"). P1 added
   * isTopLevel/sectionCount but left the `LIMIT $3` sitting on `totals`, i.e. on drawers
   * AND sections mixed by recency — so a spine of active sections could consume the
   * whole cap and push a genuine drawer off the page entirely, with the rail (which
   * filters to isTopLevel client-side) having nothing left to show for it. Measured on
   * riverbend 2026-09-19: 125 branch-shaped spines cut to a cap of 30 by recency, THEN
   * filtered to top-level, left exactly ONE of the operator's nine named drawers on screen.
   *
   * The fix moves the is-top-level filter into a CTE (`drawers`) ahead of the LIMIT, so
   * sections never compete with drawers for a page slot — they are excluded from the
   * query entirely, not merely down-ranked. `total_branches` (`count(*) OVER ()`) now
   * rides on the POST-FILTER, PRE-LIMIT `drawers` CTE: Postgres evaluates a window
   * function over its FROM/WHERE result before ORDER BY/LIMIT apply, so `total` reports
   * the true drawer count in scope, never a truncated page and never sections mixed in.
   * This is why every returned BranchSummary now has isTopLevel === true (see the field
   * doc) and why `total` changed meaning from "drawers + sections" to "drawers only" —
   * the same restructuring answers both the selection bug and the denominator P1 could
   * not honestly report (there was no drawer-only count anywhere in the query).
   *
   * CLAUSE 5 (round-1 critic). P2 left ONE population still split between
   * the rows and the total: ARCHIVED spines. `branch_membership` carries a membership row
   * for a spine whether or not that spine is archived, so an archived drawer rode through
   * the `drawers` CTE, was COUNTED by `count(*) OVER ()`, and was then dropped from the
   * returned array by the `meta.has` filter below (the metadata queries all say
   * `archived_at IS NULL`). MEASURED: archiving 2 of 9 drawers gave total=9 with 7 rows,
   * and the rail read "7 drawers shown of 9 drawers" with no cap in play — a count line
   * that implies two hidden drawers a user could page to, when in fact they are archived
   * and nothing will ever show them. That is the same class of dishonest denominator P2
   * fixed for sections, in the one dimension P2 did not cover.
   *
   * The fix is the same shape and in the same place: the liveness predicate moves INTO
   * `drawers`, ahead of both the window count and the LIMIT, so an archived spine is
   * excluded from the total and from the rows by one act. The downstream `meta.has`
   * filter stays as defense-in-depth (it now removes nothing the SQL left behind), because
   * a renderer must not depend on a filter it cannot see.
   */
  static async getBranches(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
    sinceDaysParam?: number,
  ): Promise<BranchListResult> {
    const { ids, all } = scopeParams(scope);
    const cap = config.branchListMax;
    const sinceDays = resolveSinceDays(sinceDaysParam, config);
    const unbranched = await TreeWalkerTiersService.getUnbranched(scope, config, pool);
    /**
     * `drawers` is computed from the FULL scoped `scoped`/`totals` CTEs — never the
     * capped page — because "is this spine itself a member" is a question about the
     * whole population. Once `drawers` excludes every section, `total_branches`
     * (`count(*) OVER ()`) and `section_count` are both evaluated ON `drawers`, so
     * `LIMIT $3` is the LAST thing applied: it truncates an already-drawers-only,
     * already-ordered list, never decides which drawers survive by mixing them with
     * sections first.
     */
    const grouped = await pool.query(
      `WITH scoped AS (
         SELECT spine_id, spine_type, member_id, created_at
           FROM branch_membership
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))
       ),
       totals AS (
         SELECT spine_id, spine_type, count(*)::int AS members,
                  min(created_at) AS first_active, max(created_at) AS last_active
           FROM scoped
          GROUP BY 1, 2
       ),
       drawers AS (
         SELECT t.spine_id, t.spine_type, t.members, t.first_active, t.last_active
           FROM totals t
          WHERE t.last_active >= now() - ($4::int * interval '1 day')
            AND NOT EXISTS (
            SELECT 1 FROM scoped s WHERE s.member_id = t.spine_id
          )
            -- LIVE SPINES ONLY, and it has to happen HERE (see the CLAUSE 5 note above):
            -- an archived spine that survives into this CTE is counted by the
            -- count(*) OVER () below and then dropped from the rows downstream, which is
            -- exactly the dishonest denominator this predicate exists to prevent. A spine
            -- whose record does not exist at all fails every branch of this OR and drops
            -- out here too, for the same reason.
            AND (
              (t.spine_type = 'context' AND EXISTS (
                SELECT 1 FROM contexts c
                 WHERE c.id = t.spine_id AND c.archived_at IS NULL))
              OR (t.spine_type = 'decision' AND EXISTS (
                SELECT 1 FROM technical_decisions td
                 WHERE td.id = t.spine_id AND td.archived_at IS NULL))
              OR (t.spine_type = 'task' AND EXISTS (
                SELECT 1 FROM tasks tk
                 WHERE tk.id = t.spine_id AND tk.archived_at IS NULL))
            )
       )
       SELECT
         d.spine_id, d.spine_type, d.members, d.first_active, d.last_active,
         (
           SELECT count(*)::int
             FROM scoped s
            WHERE s.spine_id = d.spine_id
              AND EXISTS (SELECT 1 FROM totals t2 WHERE t2.spine_id = s.member_id)
         ) AS section_count,
         count(*) OVER ()::int AS total_branches
         FROM drawers d
        ORDER BY d.last_active DESC
        LIMIT $3`,
      [ids, all, cap, sinceDays],
    );
    if (grouped.rows.length === 0) return { branches: [], total: 0, cap, sinceDays, unbranched };
    const total = grouped.rows[0].total_branches as number;

    const byType = (t: string) => grouped.rows.filter((r) => r.spine_type === t).map((r) => r.spine_id as string);
    const [ctx, dec, task, open, ms] = await Promise.all([
      pool.query(
        `SELECT id, content AS body, tags FROM contexts
          WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [byType('context')],
      ),
      pool.query(
        `SELECT id, title, tags FROM technical_decisions
          WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [byType('decision')],
      ),
      pool.query(
        `SELECT id, title, tags FROM tasks
          WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`,
        [byType('task')],
      ),
      pool.query(
        `SELECT DISTINCT spine_id FROM branch_positions
          WHERE ($2::boolean OR project_id = ANY($1::uuid[]))`,
        [ids, all],
      ),
      // MILESTONE STATIONS: the member contexts typed 'milestone', oldest first. DISTINCT
      // member_id because the branch_membership view LEFT JOINs links and can repeat a row.
      pool.query(
        `SELECT DISTINCT ON (bm.spine_id, bm.member_id)
                bm.spine_id, bm.member_id AS id, bm.created_at, c.content AS body
           FROM branch_membership bm
           JOIN contexts c ON c.id = bm.member_id AND c.archived_at IS NULL
          WHERE bm.spine_id = ANY($1::uuid[])
            AND bm.member_type = 'context'
            AND c.context_type = 'milestone'
            AND ($3::boolean OR bm.project_id = ANY($2::uuid[]))
          ORDER BY bm.spine_id, bm.member_id, bm.created_at`,
        [grouped.rows.map((r) => r.spine_id as string), ids, all],
      ),
    ]);
    const milestonesBySpine = new Map<string, BranchMilestone[]>();
    for (const r of ms.rows) {
      const list = milestonesBySpine.get(r.spine_id as string) ?? [];
      list.push({
        id: r.id as string,
        createdAt: new Date(r.created_at).toISOString(),
        title: contextTitle(r.body),
      });
      milestonesBySpine.set(r.spine_id as string, list);
    }
    for (const [k, list] of milestonesBySpine) {
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      milestonesBySpine.set(k, list.slice(0, config.map.milestonesMax));
    }

    const meta = new Map<string, { title: string; tags: string[] }>();
    for (const r of ctx.rows) meta.set(r.id, { title: contextTitle(r.body), tags: r.tags ?? [] });
    for (const r of dec.rows) meta.set(r.id, { title: r.title ?? '(decision)', tags: r.tags ?? [] });
    for (const r of task.rows) meta.set(r.id, { title: r.title ?? '(task)', tags: r.tags ?? [] });
    const openSpines = new Set<string>(open.rows.map((r) => r.spine_id as string));

    const prefix = config.spine.branchNameTagPrefix;
    const branches: BranchSummary[] = grouped.rows
      // Defense-in-depth only since CLAUSE 5: `drawers` already excluded archived and
      // vanished spines from BOTH the rows and `total`, so this drops nothing. Kept so a
      // future metadata query that narrows further cannot silently emit a row with no name.
      .filter((r) => meta.has(r.spine_id))
      .map((r) => {
        const m = meta.get(r.spine_id) as { title: string; tags: string[] };
        const nameTag = m.tags.find((t) => t.startsWith(prefix) && t.length > prefix.length);
        return {
          spineId: r.spine_id as string,
          spineType: r.spine_type as BranchSummary['spineType'],
          name: nameTag ? nameTag.slice(prefix.length) : m.title,
          named: nameTag !== undefined,
          members: r.members as number,
          firstActiveAt: new Date(r.first_active).toISOString(),
          lastActiveAt: new Date(r.last_active).toISOString(),
          milestones: milestonesBySpine.get(r.spine_id as string) ?? [],
          open: openSpines.has(r.spine_id as string),
          // Every row here already survived the `drawers` CTE's NOT EXISTS filter above.
          isTopLevel: true,
          sectionCount: r.section_count as number,
        };
      });
    return { branches, total, cap, sinceDays, unbranched };
  }

  /**
   * The UNBRANCHED share: over the scope's non-archived contexts created in the last
   * `config.map.unbranchedWindowDays`, how many are on NO branch — neither a
   * `branch_membership` member nor the source of a declared strong edge to a spine (the
   * thread-v2 member predicate, config.branch). `total` is the windowed non-archived
   * context count, so `unbranched <= total` and the two always share one population.
   */
  static async getUnbranched(
    scope: ProjectListScope,
    config: TreewalkerConfig = TREEWALKER_CONFIG,
    pool: Pool = db,
  ): Promise<UnbranchedShare> {
    const { ids, all } = scopeParams(scope);
    const b = config.branch;
    const windowDays = config.map.unbranchedWindowDays;
    const r = await pool.query(
      `WITH spines AS (SELECT DISTINCT spine_id FROM branch_membership)
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT (
                EXISTS (SELECT 1 FROM branch_membership bm WHERE bm.member_id = c.id)
                OR EXISTS (
                  SELECT 1 FROM links l
                   WHERE l.from_id = c.id
                     AND l.provenance_class = $3
                     AND l.edge_type = ANY($4::text[])
                     AND l.mint_via <> ALL($5::text[])
                     AND l.to_id IN (SELECT spine_id FROM spines)
                )
              ))::int AS unbranched
         FROM contexts c
        WHERE ($2::boolean OR c.project_id = ANY($1::uuid[]))
          AND c.archived_at IS NULL
          AND c.created_at >= now() - ($6::int * interval '1 day')`,
      [ids, all, b.declaredProvenance, [...b.strongEdgeTypes], [...b.excludedMintVia], windowDays],
    );
    return {
      unbranched: r.rows[0].unbranched as number,
      total: r.rows[0].total as number,
      windowDays,
    };
  }
}
