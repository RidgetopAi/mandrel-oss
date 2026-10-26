/**
 * BRANCH MEMBERSHIP — who was written on this branch, in the order they were written.
 * (SK2, STRONG BONES an earlier spine.)
 *
 * THE PROBLEM THIS SOLVES. A branch's live pointer (`branch_positions`, migration 080) is
 * DELETED on branch_close — `closePosition` is a hard DELETE, and `openPosition` overwrites
 * on re-open. So the position row cannot answer anything about a branch that finished.
 * Membership therefore needs storage of its own that outlives the branch, and that storage
 * is the `branch_memberships` table (migration 086), read through the `branch_membership`
 * VIEW — one predicate, shared with mandrel-command's dashboard, spelled in exactly one
 * place because the two previously disagreed (17 vs 9 members for one real spine).
 *
 * WHY A TABLE AND NOT THE EDGE — the mistake this file made three times. Membership used to
 * be parasitic on the `informs` edge positionalMint mints: inferred from it (round 1),
 * absorbed from its shape by a transitive walk (round 2), then stored on it in columns
 * (round 3). All three failed the same way, because `mintEdge` inserts
 * `ON CONFLICT (from_id, to_id, edge_type) DO NOTHING` and the TAG mint runs FIRST: a write
 * made while positioned on S that also TAGS S loses its positional mint to the tag row and
 * silently stops being a member. Measured on prod 2026-08-15, that was roughly half of every
 * active branch. The edge is the GRAPH's rendering of membership; it is not the fact. The
 * fact is one row, keyed by record_id, written at the membership decision.
 *
 * THREE BANDS, NEVER MERGED INTO ONE NUMBER. A member count over a corpus that straddles the
 * fix cannot be a single honest number, so it is not reported as one:
 *   1. RECORDED     — post-086, from the live position. Exact.
 *   2. LEGACY-APPROX— pre-086 position edges, spine inferred from where the edge attached.
 *   3. TAG-ONLY     — records that TAG this spine but carry no recorded position at all.
 *      NOT members and never counted as such: most predate branches or were genuinely
 *      unpositioned, and admitting them would turn a 50% under-count into a worse
 *      over-count, which is round 1's defect. They are surfaced so the SEAM is visible.
 * `exact` is a FORWARD-ONLY claim — true for a branch whose records are all post-086, and
 * false the moment any of the other two bands is nonempty.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  MEMBERSHIP_SOURCE,
  APPROXIMATE_SOURCES,
  type MembershipSource,
} from '../config/membershipSourceConfig.js';
import { MEMBERSHIP_MOVE_CONFIG } from '../config/membershipMoveConfig.js';
import { deriveRecordHeadline } from '../config/recordHeadlineConfig.js';
import { BRANCH_HISTORY_CONFIG } from '../config/branchHistoryConfig.js';
import type { SpineType } from './branchPosition.js';

/** The record kinds that can be a branch member (mirrors branch_memberships.record_type). */
export type MemberType = 'context' | 'decision' | 'task';

/** One membership row, exactly as stored. */
export interface BranchMember {
  /** The MEMBER record's id — the thing that was written while standing on the branch. */
  id: string;
  type: MemberType;
  /**
   * Where this member's GRAPH EDGE attached at mint time: the branch root, or an earlier
   * member (the tip). NOT the membership key — that is `spine_id`, the branch root.
   */
  attachedToId: string;
  /**
   * The surviving `informs` edge that renders this membership in the graph, or null if none
   * does. NULL IS NOT "NOT A MEMBER": the edge can be deduped into an earlier tag mint or
   * unlinked outright, and membership is stored independently of both. `mintVia` is
   * frequently 'tag' for exactly that reason.
   */
  edgeType: string | null;
  mintVia: string | null;
  provenanceClass: string | null;
  /**
   * HOW this row's branch was obtained: 'recorded' (from the live position at mint time — a
   * fact) or 'legacy-approx' (backfilled by migration 086 from a pre-086 position edge's
   * attachment point — see MEMBERSHIP_SOURCE).
   */
  spineSource: MembershipSource;
  /**
   * True iff some OTHER pre-086 membership row attaches to THIS member. Such a write was
   * either a tip-chained write on this branch or a nested branch's write, and pre-086 data
   * cannot tell which — so this member may have descendants that belong here and are not
   * listed. Always false for 'recorded' descendants, which carry their own branch.
   */
  hasLegacyChildren: boolean;
  /** ISO-8601. The ORDER KEY — "the order they were written". */
  createdAt: string;
}

/** The full member set of one branch, plus every way it is short of the truth. */
export interface BranchMembership {
  /** Every member, sorted by createdAt ASC — write order. */
  members: BranchMember[];
  /** BAND 2: how many members reached this list via 086's backfill rather than a record. */
  approximateMembers: number;
  /**
   * BAND 2, the other half: a member may be MISSING. Some pre-086 row attaches to a member
   * of this branch, and whether it was a tip write here or a nested branch's write is
   * unrecoverable.
   */
  possiblyIncomplete: boolean;
  /**
   * BAND 3: records that TAG this spine but carry NO recorded position, anywhere. They are
   * NOT members and are deliberately not in `members` — but they are the visible edge of the
   * cohort whose membership was destroyed by the pre-086 dedup, so the count is surfaced
   * rather than dropped. A record that carries a position on a DIFFERENT branch is excluded:
   * it is correctly a member of that branch, not an unattributable write.
   */
  tagOnlyNoPosition: number;
  /**
   * BAND 3's ids, bounded by BRANCH_HISTORY_CONFIG.tagOnlyIdLimit. Band 3 is the DISCOVERY
   * SURFACE for `branch_assign` (P3): these are exactly the records whose
   * branch nobody has declared, and declaring one DRAINS it from this band for free (the
   * NOT EXISTS below is what makes that automatic). The COUNT above is complete; this sample
   * is not, and `tagOnlyIdsTruncated` says when.
   */
  tagOnlyNoPositionIds: string[];
  /** True when band 3 has more members than the id sample above carries. */
  tagOnlyIdsTruncated: boolean;
}

/** What `recordMembership` did — the caller reports membership from THIS, never from an edge. */
export interface MembershipWriteResult {
  /** True iff a row now says this record is a member of the spine that was asked for. */
  recorded: boolean;
  /** False when a row already existed (a re-mint of the same write). */
  inserted: boolean;
  /**
   * The spine the stored row actually names. Differs from the requested one only if a
   * membership was already recorded for this record on ANOTHER branch — which the PK makes
   * a contradiction rather than a merge, so the FIRST position wins and the caller is told.
   */
  storedSpineId: string;
}

/**
 * RECORD THE MEMBERSHIP. The one writer, called by services/positionalMint.ts at the
 * membership decision — deliberately NOT bundled into the edge mint, because the edge mint
 * can be deduped away by an earlier tag mint and membership must not ride on that.
 *
 * ON CONFLICT DO NOTHING on the record_id PK: the model is "a write happens at one
 * position", and a second attempt does not overwrite the first. The stored spine is returned
 * so the caller can tell "already a member here" (fine, report minted) from "already a member
 * ELSEWHERE" (a contradiction worth surfacing, and never reported as a mint of THIS branch).
 */
export async function recordMembership(
  input: {
    recordId: string;
    recordType: MemberType;
    spineId: string;
    spineType: SpineType;
    attachedToId: string;
    attachedToType: SpineType;
    projectId: string;
  },
  pool: Pool = db
): Promise<MembershipWriteResult> {
  const inserted = await pool.query(
    `INSERT INTO branch_memberships
       (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
        source, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (record_id) DO NOTHING
     RETURNING spine_id::text AS spine_id`,
    [
      input.recordId,
      input.recordType,
      input.spineId,
      input.spineType,
      input.attachedToId,
      input.attachedToType,
      MEMBERSHIP_SOURCE.recorded,
      input.projectId,
    ]
  );
  if (inserted.rows.length > 0) {
    return { recorded: true, inserted: true, storedSpineId: inserted.rows[0].spine_id };
  }
  // Conflict → a membership already exists for this record. Read what it actually says
  // rather than assuming it says what we just tried to write.
  const existing = await pool.query(
    `SELECT spine_id::text AS spine_id FROM branch_memberships WHERE record_id = $1`,
    [input.recordId]
  );
  const storedSpineId = existing.rows[0]?.spine_id ?? '';
  return { recorded: storedSpineId === input.spineId, inserted: false, storedSpineId };
}

/**
 * WHICH BRANCH IS THIS ONE RECORD A MEMBER OF — the inverse of readBranchMembers, and the
 * thing no read surface answered.
 *
 * WHY IT WAS MISSING AND WHY THAT COST SOMETHING. A task's branch is carried two entirely
 * different ways and only one of them was readable off the task:
 *   · a `branch:<slug>` TAG, which names a WORKSTREAM and is on the record, and
 *   · a row in `branch_memberships`, which points at a SPINE RECORD and is not.
 * They are not two copies of one fact — a slug is not a record id — so neither one implies
 * the other, and a consumer keyed on the tag reports a task with a declared membership and
 * no tag as having NO branch at all. MEASURED on prod 2026-08-31 (157 open tasks in
 * project riverbend): 57 carry the tag, 28 carry a membership, 14 carry a membership and
 * NO tag, 43 carry a tag and no membership. The count that produced an earlier task's title
 * was tag-only, so it overstated the invisible population by those 14 — and the only way to
 * notice that was raw SQL, because nothing returns this.
 *
 * Returns null when the record is a member of nothing, which is a real and legitimate
 * answer (a standalone chore has no branch) and is deliberately distinct from "the record
 * does not exist" — this function does not know or care whether it does.
 */
export async function readMembershipOf(
  recordId: string,
  pool: Pool = db
): Promise<{ spineId: string; spineType: string; attachedToId: string; source: string } | null> {
  const { rows } = await pool.query(
    `SELECT spine_id::text        AS spine_id,
            spine_type,
            attached_to_id::text  AS attached_to_id,
            source
       FROM branch_memberships
      WHERE record_id = $1`,
    [recordId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    spineId: r.spine_id,
    spineType: r.spine_type,
    attachedToId: r.attached_to_id,
    source: r.source,
  };
}

/**
 * Read every member of `spineId`, in write order, plus all three bands. ONE query for the
 * members, one for the tag-only band.
 *
 * The `hasLegacyChildren` sub-select is bounded by the closed and shrinking 'legacy-approx'
 * class — once that class is empty it is constant false and can be deleted along with the
 * rest of the legacy story.
 */
export async function readBranchMembers(
  input: { projectId: string; spineId: string },
  pool: Pool = db
): Promise<BranchMembership> {
  const [rows, tagOnly] = await Promise.all([
    pool.query(
      `SELECT bm.member_id::text      AS member_id,
              bm.member_type,
              bm.attached_to_id::text AS attached_to_id,
              bm.edge_type,
              bm.mint_via,
              bm.provenance_class,
              bm.spine_source,
              bm.created_at,
              EXISTS (
                SELECT 1 FROM branch_membership child
                 WHERE child.spine_id     = bm.member_id
                   AND child.project_id   = bm.project_id
                   AND child.spine_source = $3
              ) AS has_legacy_children
         FROM branch_membership bm
        WHERE bm.spine_id   = $1
          AND bm.project_id = $2
        ORDER BY bm.created_at ASC, bm.member_id ASC`,
      [input.spineId, input.projectId, MEMBERSHIP_SOURCE.legacyApprox]
    ),
    // BAND 3. `informs` edges INTO this spine that were minted by a threading tag, whose
    // source record has no membership row at all. `mint_via='tag'` is the whole population
    // deliberately: a record that names the spine through some other declared path (a links
    // param, decision evidence) stated a relationship, not a position, and inventing a
    // "might have been here" band for it would be the round-1 over-count wearing a caveat.
    pool.query(
      `WITH tag_only AS (
         SELECT DISTINCT l.from_id
           FROM links l
          WHERE l.to_id      = $1
            AND l.project_id = $2
            AND l.mint_via   = 'tag'
            AND l.edge_type  = 'informs'
            AND l.from_id   <> $1
            AND NOT EXISTS (
                  SELECT 1 FROM branch_memberships m WHERE m.record_id = l.from_id
                )
       )
       SELECT (SELECT count(*) FROM tag_only)::int AS n,
              COALESCE(
                (SELECT array_agg(s.from_id::text ORDER BY s.from_id)
                   FROM (SELECT from_id FROM tag_only ORDER BY from_id LIMIT $3) s),
                ARRAY[]::text[]
              ) AS ids`,
      [input.spineId, input.projectId, BRANCH_HISTORY_CONFIG.tagOnlyIdLimit]
    ),
  ]);

  const members: BranchMember[] = rows.rows.map((r) => ({
    id: r.member_id,
    type: r.member_type as MemberType,
    attachedToId: r.attached_to_id,
    edgeType: r.edge_type ?? null,
    mintVia: r.mint_via ?? null,
    provenanceClass: r.provenance_class ?? null,
    spineSource: r.spine_source as MembershipSource,
    hasLegacyChildren: r.has_legacy_children === true,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));

  const tagOnlyCount: number = tagOnly.rows[0]?.n ?? 0;
  const tagOnlyIds: string[] = tagOnly.rows[0]?.ids ?? [];

  return {
    members,
    // POSITIVE SET, never `!== recorded`: a source that is neither recorded nor an
    // approximation (a later DECLARED assignment) must not be counted here — it would make
    // `exact` false for a branch that is exact. See APPROXIMATE_SOURCES.
    approximateMembers: members.filter((m) => APPROXIMATE_SOURCES.has(m.spineSource)).length,
    possiblyIncomplete: members.some((m) => m.hasLegacyChildren),
    tagOnlyNoPosition: tagOnlyCount,
    tagOnlyNoPositionIds: tagOnlyIds,
    tagOnlyIdsTruncated: tagOnlyCount > tagOnlyIds.length,
  };
}

/** Is ANY session currently standing on this spine? (The live pointer, not history.) */
export async function isBranchOpen(
  projectId: string,
  spineId: string,
  pool: Pool = db
): Promise<boolean> {
  // origin='trunk' rows are EXCLUDED: a trunk row retains spine_id as the record the session
  // reverted FROM (provenance, not a position) and mints nothing, so reporting that branch as
  // "open" would tell a caller writes are landing on it when they are not.
  const r = await pool.query(
    `SELECT 1 FROM branch_positions
      WHERE project_id = $1 AND spine_id = $2 AND origin <> 'trunk' LIMIT 1`,
    [projectId, spineId]
  );
  return r.rows.length > 0;
}

/**
 * Resolve human titles for a mixed set of member ids, in ONE query per record kind.
 * A record that cannot be read (archived away, deleted) maps to null rather than being
 * dropped: the membership row is the fact, and hiding a member because its title is
 * unavailable would silently shrink a count the caller is being told is complete.
 */
export async function resolveMemberTitles(
  members: readonly { id: string; type: MemberType }[],
  pool: Pool = db
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (members.length === 0) return out;

  const idsOf = (t: MemberType) => members.filter((m) => m.type === t).map((m) => m.id);
  const [ctx, dec, task] = await Promise.all([
    pool.query(`SELECT id::text AS id, content FROM contexts WHERE id = ANY($1::uuid[])`, [
      idsOf('context'),
    ]),
    pool.query(`SELECT id::text AS id, title FROM technical_decisions WHERE id = ANY($1::uuid[])`, [
      idsOf('decision'),
    ]),
    pool.query(`SELECT id::text AS id, title FROM tasks WHERE id = ANY($1::uuid[])`, [
      idsOf('task'),
    ]),
  ]);

  for (const r of ctx.rows) {
    // ONE headline rule for every surface — config/recordHeadlineConfig.ts. This used to
    // carry its own 60-character slice; a branch-member line is read for WHAT the member
    // was, so it is exactly the population the short clip was failing.
    out.set(r.id, deriveRecordHeadline(r.content == null ? null : String(r.content)));
  }
  for (const r of dec.rows) out.set(r.id, r.title ?? null);
  for (const r of task.rows) out.set(r.id, r.title ?? null);
  for (const m of members) if (!out.has(m.id)) out.set(m.id, null);
  return out;
}

/** One branch member, reduced to what a briefing line needs. */
export interface BranchMemberSummary {
  id: string;
  type: MemberType;
  /** The member's human headline (a title, or a context's first content line), or null. */
  headline: string | null;
  /**
   * HOW THIS ROW'S BRANCH WAS OBTAINED — 'recorded' (from the live position at mint time, a
   * FACT) or 'legacy-approx' (migration 086 derived it from where a pre-086 edge happened to
   * attach). NOT optional and NOT droppable: the `branch_membership` view's own COMMENT makes
   * surfacing it a contract — "consumers MUST surface that, not hide it" — and this reader
   * previously selected around it, which let a caller print the strongest possible count over
   * a set that was 82% derived. Same class as the count that started SK5: the field existed
   * and the display asserted without it.
   */
  spineSource: MembershipSource;
  createdAt: Date;
}

/**
 * A BOUNDED member read for the briefing (SK5): members of one spine, in
 * write order, at most `limit` of them, with headlines resolved.
 *
 * WHY IT LIVES HERE rather than in projectBriefing.ts: migration 086 made the
 * `branch_membership` VIEW the one place the membership predicate is spelled, and this
 * module is its mcp-server-side owner. A second consumer writing its own membership SQL is
 * how the 17-vs-9 disagreement happened the first time.
 *
 * NOT readBranchMembers(): that one is unbounded and computes the three provenance bands
 * for `branch_history`, which a size-capped renderer neither needs nor can afford. BAND 2
 * (`spine_source`) travels on every row regardless, because it is a property of the row and
 * a bounded read is not a licence to drop it.
 *
 * WHAT THIS READER DOES NOT ANSWER, stated so no caller infers it: bands 2b
 * (`possiblyIncomplete`) and 3 (`tagOnlyNoPosition`) are NOT computed here, so nothing built
 * on this function may claim `exact` — that conjunction needs all three bands and lives in
 * branch_history. A caller may say "N of these are approximate"; it may not say "the rest is
 * exact".
 *
 * NO `hitLimit`: it used to be returned here with a comment claiming the caller reported a
 * FLOOR from it, and no caller ever read it — the one consumer re-derives the same fact from
 * the row count. A returned value nothing consumes is a claim about behaviour that does not
 * exist, so it is deleted rather than documented.
 */
export async function readBranchMemberSummaries(
  input: { projectId: string; spineId: string; limit: number },
  pool: Pool = db
): Promise<{ members: BranchMemberSummary[] }> {
  const rows = await pool.query(
    `SELECT bm.member_id::text AS member_id, bm.member_type, bm.spine_source, bm.created_at
       FROM branch_membership bm
      WHERE bm.spine_id = $1 AND bm.project_id = $2
      ORDER BY bm.created_at ASC, bm.member_id ASC
      LIMIT $3`,
    [input.spineId, input.projectId, input.limit]
  );
  const base = rows.rows.map((r) => ({
    id: r.member_id as string,
    type: r.member_type as MemberType,
    spineSource: r.spine_source as MembershipSource,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  }));
  const titles = await resolveMemberTitles(base, pool);
  return { members: base.map((m) => ({ ...m, headline: titles.get(m.id) ?? null })) };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * MUTABLE MEMBERSHIP — branch_assign / branch_unassign (P3, migration 090)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY MEMBERSHIP BECAME MUTABLE. `recordMembership` above is ON CONFLICT DO NOTHING: the
 * FIRST position wins and every later one is refused. That is right for the mint — a write
 * happened at one position and a re-mint must not rewrite history — and it is WRONG as the
 * end of the story, because the system opens positions the author never asked for
 * (auto/byproduct opens, services/branchPosition.ts). So the SYSTEM manufactures wrong
 * memberships, and until now the only correction available was none.
 *
 * WHAT MAKES REWRITING AN IMMUTABLE FACT ACCEPTABLE: it is not rewritten quietly. Every
 * change appends a row to `branch_membership_moves` naming the actor, the previous branch,
 * the new one (or NULL for a removal) and the time — a log, never an UPDATE, because a
 * `previous_spine_id` column would lose every move but the last and could not represent a
 * removal at all.
 *
 * ⚠️ `created_at` IS THE BRANCH'S WRITE-ORDER KEY (`ORDER BY bm.created_at ASC` at the two
 * readers above). A move MUST NOT touch it, or the branch silently reorders itself — a
 * confident wrong answer to the one question branch_history exists to answer. The UPDATE
 * below names its columns explicitly for that reason; do not be tempted to add a
 * `created_at = NOW()`.
 *
 * PROJECT SCOPE, TWO LAYERS, AND THE SECOND ONE IS NOT DECORATION:
 *   1. Both ids are resolved by services/spineResolver.ts at the route, which is
 *      project-scoped and never-first-match — this is the layer that fires in product.
 *   2. `AND project_id = $n` on the UPDATE and the DELETE here. Because record ids are
 *      UUIDs no PRODUCT path can put a foreign membership row behind a resolvable record,
 *      so this layer bites only on rows written OUTSIDE the mint (raw SQL, a migration, a
 *      future service). The table permits that state, and it is what the cross-project test
 *      writes by hand.
 *      ⚠️ THE CROSS-PROJECT TEST DOES NOT ISOLATE THIS LAYER, and an earlier draft of this
 *      comment claimed it did. MEASURED (Reviewer): dropping ONLY this
 *      filter leaves that test GREEN, because the handler's pre-check refuses first;
 *      disabling ONLY the pre-check turns it RED with "membership UPDATE affected 0 rows",
 *      which is the evidence that the filter does bite. So do NOT read a green suite as
 *      permission to delete this as redundant — no single guard fails when you do.
 */

/** How a membership write ended. Reported to the caller — a move is never silent. */
export type MembershipAssignOutcome =
  /** No membership row existed; one now does. */
  | 'assigned'
  /** A row existed naming a DIFFERENT branch; it now names the requested one. */
  | 'moved'
  /** A row already named exactly this branch. Nothing was written, and no move was logged. */
  | 'unchanged';

/** How a removal ended. */
export type MembershipRemoveOutcome =
  /** A row existed and is gone; the removal is logged. */
  | 'unassigned'
  /** There was no membership row to remove. Nothing was written, and nothing was logged. */
  | 'absent';

/** Why a membership write was refused, as a discriminated reason rather than a message. */
export const MEMBERSHIP_WRITE_REFUSAL = {
  /**
   * The membership row that exists for this record carries ANOTHER project's id. The record
   * resolved inside our project, so the row was written outside the mint; we refuse rather
   * than move it, because moving it would silently re-parent another project's fact.
   */
  foreignProjectRow: 'membership-foreign-project-row',
  /** A record cannot be a member of itself (branch_memberships_not_self, migration 086). */
  selfMembership: 'membership-self',
} as const;
export type MembershipWriteRefusal =
  (typeof MEMBERSHIP_WRITE_REFUSAL)[keyof typeof MEMBERSHIP_WRITE_REFUSAL];

export type MembershipAssignResult =
  | {
      ok: true;
      outcome: MembershipAssignOutcome;
      /** The branch the record was on before, or null if it was on none. */
      previousSpineId: string | null;
      spineId: string;
    }
  | { ok: false; reason: MembershipWriteRefusal; storedProjectId?: string };

export type MembershipRemoveResult =
  | { ok: true; outcome: MembershipRemoveOutcome; previousSpineId: string | null }
  | { ok: false; reason: MembershipWriteRefusal; storedProjectId?: string };

/** One row of `branch_membership_moves`, as stored. */
export interface MembershipMove {
  id: string;
  recordId: string;
  /** The branch it left, or null if it was a member of nothing (a first assign). */
  fromSpineId: string | null;
  /** The branch it joined, or null if the membership was REMOVED. */
  toSpineId: string | null;
  actor: string;
  movedAt: string;
  reason: string | null;
}

/** Trim a caller-supplied reason to the configured bound (null when there is none). */
function boundedReason(reason: string | undefined | null): string | null {
  if (reason === undefined || reason === null) return null;
  const t = String(reason).trim();
  if (t === '') return null;
  return t.slice(0, MEMBERSHIP_MOVE_CONFIG.maxReasonLength);
}

/**
 * ASSIGN or MOVE a record's branch, and log what happened.
 *
 * ONE upsert-shaped operation covering both cases deliberately: "no row" versus "wrong row"
 * is the STORE's distinction, not the author's intent, and splitting it into two actions
 * would force every caller to know which case it is in without giving it a way to find out.
 * The RESULT reports which happened, so nothing is hidden — same shape branch_open already
 * uses for a position move.
 *
 * ONE TRANSACTION. The membership row and its audit row are the same fact from two angles;
 * a crash between them would leave either an untraceable rewrite or a trace of a change that
 * did not happen. Both are worse than failing the call.
 */
export async function assignMembership(
  input: {
    recordId: string;
    recordType: MemberType;
    spineId: string;
    spineType: SpineType;
    projectId: string;
    actor?: string;
    reason?: string;
  },
  pool: Pool = db
): Promise<MembershipAssignResult> {
  if (input.recordId === input.spineId) {
    return { ok: false, reason: MEMBERSHIP_WRITE_REFUSAL.selfMembership };
  }
  const actor = input.actor?.trim() || MEMBERSHIP_MOVE_CONFIG.unknownActor;
  const reason = boundedReason(input.reason);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the record's membership row (if any) for the duration: two concurrent assigns of
    // the same record must serialize, or the two move rows can describe a history that never
    // happened (both reading the same `from`).
    const existing = await client.query(
      `SELECT spine_id::text AS spine_id, project_id::text AS project_id
         FROM branch_memberships WHERE record_id = $1 FOR UPDATE`,
      [input.recordId]
    );
    const prior = existing.rows[0];

    if (prior && prior.project_id !== input.projectId) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: MEMBERSHIP_WRITE_REFUSAL.foreignProjectRow,
        storedProjectId: prior.project_id,
      };
    }

    if (prior && prior.spine_id === input.spineId) {
      // Already exactly where it was asked to be. A no-op is not an event: writing a move row
      // here would fabricate history, and the table's not_noop CHECK would reject it anyway.
      await client.query('COMMIT');
      return { ok: true, outcome: 'unchanged', previousSpineId: prior.spine_id, spineId: input.spineId };
    }

    if (prior) {
      // THE MOVE. `created_at` is deliberately absent from this SET list — see the header.
      // `attached_to_*` is set to the spine itself: an assignment declares direct membership
      // of the branch ROOT and mints no edge, so there is no tip for it to have attached to.
      const moved = await client.query(
        `UPDATE branch_memberships
            SET spine_id = $2, spine_type = $3,
                attached_to_id = $2, attached_to_type = $3,
                source = $4
          WHERE record_id = $1 AND project_id = $5`,
        [input.recordId, input.spineId, input.spineType, MEMBERSHIP_SOURCE.assigned, input.projectId]
      );
      if (moved.rowCount !== 1) {
        // The row was there a statement ago under FOR UPDATE, so this is unreachable in
        // product; failing loudly beats logging a move that did not happen.
        await client.query('ROLLBACK');
        throw new Error(
          `branch_assign: membership UPDATE affected ${moved.rowCount} rows for ${input.recordId}`
        );
      }
      await client.query(
        `INSERT INTO branch_membership_moves
           (record_id, project_id, from_spine_id, to_spine_id, actor, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.recordId, input.projectId, prior.spine_id, input.spineId, actor, reason]
      );
      await client.query('COMMIT');
      return { ok: true, outcome: 'moved', previousSpineId: prior.spine_id, spineId: input.spineId };
    }

    // FIRST ASSIGN. `created_at` defaults to NOW() — this record is joining the branch now,
    // and now IS its write-order position on it.
    await client.query(
      `INSERT INTO branch_memberships
         (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type,
          source, project_id)
       VALUES ($1, $2, $3, $4, $3, $4, $5, $6)`,
      [
        input.recordId,
        input.recordType,
        input.spineId,
        input.spineType,
        MEMBERSHIP_SOURCE.assigned,
        input.projectId,
      ]
    );
    await client.query(
      `INSERT INTO branch_membership_moves
         (record_id, project_id, from_spine_id, to_spine_id, actor, reason)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [input.recordId, input.projectId, input.spineId, actor, reason]
    );
    await client.query('COMMIT');
    return { ok: true, outcome: 'assigned', previousSpineId: null, spineId: input.spineId };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is already unusable */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * REMOVE a record's membership, and log the removal.
 *
 * SHIPPED IN THE SAME ROUND AS assignMembership, and not speculatively: auto/byproduct
 * positions open WITHOUT the author asking, so the system creates memberships nobody
 * declared. Without removal the only correction available is replacing one wrong fact with a
 * different wrong fact.
 *
 * The DELETE is what makes `to_spine_id IS NULL` the only possible record of the event, and
 * the reason `branch_membership_moves` carries no foreign key back to `branch_memberships`.
 */
export async function removeMembership(
  input: { recordId: string; projectId: string; actor?: string; reason?: string },
  pool: Pool = db
): Promise<MembershipRemoveResult> {
  const actor = input.actor?.trim() || MEMBERSHIP_MOVE_CONFIG.unknownActor;
  const reason = boundedReason(input.reason);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT spine_id::text AS spine_id, project_id::text AS project_id
         FROM branch_memberships WHERE record_id = $1 FOR UPDATE`,
      [input.recordId]
    );
    const prior = existing.rows[0];

    if (!prior) {
      await client.query('COMMIT');
      return { ok: true, outcome: 'absent', previousSpineId: null };
    }
    if (prior.project_id !== input.projectId) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        reason: MEMBERSHIP_WRITE_REFUSAL.foreignProjectRow,
        storedProjectId: prior.project_id,
      };
    }

    const deleted = await client.query(
      `DELETE FROM branch_memberships WHERE record_id = $1 AND project_id = $2`,
      [input.recordId, input.projectId]
    );
    if (deleted.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new Error(
        `branch_unassign: membership DELETE affected ${deleted.rowCount} rows for ${input.recordId}`
      );
    }
    await client.query(
      `INSERT INTO branch_membership_moves
         (record_id, project_id, from_spine_id, to_spine_id, actor, reason)
       VALUES ($1, $2, $3, NULL, $4, $5)`,
      [input.recordId, input.projectId, prior.spine_id, actor, reason]
    );
    await client.query('COMMIT');
    return { ok: true, outcome: 'unassigned', previousSpineId: prior.spine_id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is already unusable */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Read one record's membership move history, oldest first — the append-only trail that makes
 * a mutable membership auditable. Project-scoped like every other read here.
 */
export async function readMembershipMoves(
  input: { recordId: string; projectId: string; limit?: number },
  pool: Pool = db
): Promise<MembershipMove[]> {
  const r = await pool.query(
    `SELECT id::text                AS id,
            record_id::text         AS record_id,
            from_spine_id::text     AS from_spine_id,
            to_spine_id::text       AS to_spine_id,
            actor,
            moved_at,
            reason
       FROM branch_membership_moves
      WHERE record_id = $1 AND project_id = $2
      ORDER BY moved_at ASC, id ASC
      LIMIT $3`,
    [input.recordId, input.projectId, input.limit ?? MEMBERSHIP_MOVE_CONFIG.movesReadLimit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    recordId: row.record_id,
    fromSpineId: row.from_spine_id ?? null,
    toSpineId: row.to_spine_id ?? null,
    actor: row.actor,
    movedAt: row.moved_at instanceof Date ? row.moved_at.toISOString() : String(row.moved_at),
    reason: row.reason ?? null,
  }));
}
