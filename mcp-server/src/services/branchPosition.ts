/**
 * BRANCH POSITION STORE — PHASE 1 positional membership.
 *
 * The DB-authoritative home of the per-(project, session) CURRENT BRANCH (migration 080
 * `branch_positions`). This is the git model: membership = POSITION. Every write made while
 * a position is open stamps a DECLARED `informs` edge (created_by 'auto:positional') to the
 * spine — see services/positionalMint.ts for the write-path integration.
 *
 * DELIBERATE CONTRASTS with the retired anchor store (activeThreadStore):
 *   - NO TTL. A position lives until branch_close or a re-open. The 24h window was exactly
 *     the assumption an interrupt breaks ("everything for the next 24h belongs here").
 *   - NO similarity gate. Position is declared, not judged. A wrong position is visible,
 *     attributable and correctable (demote/promote); a guessed one is none of those.
 *   - NO project-scoped fallback. Reading another session's position is the cross-agent
 *     contamination Phase 1's acceptance explicitly forbids.
 *   - ONE spine of ANY record type (context | decision | task) — spine-first, not
 *     task-first — instead of a task+decision pair.
 *
 * KEYING: callers derive keys through projectHandler.resolvePositionKeys — the same choke
 * point the anchor's strict-keying rule guarded — so per-loop isolation has ONE rule,
 * including the strict-mode refusal for unidentified callers. Since an earlier task the key
 * is the CONNECTION identity (the loop), never the resolved DB session: in actor resolver
 * mode one DB session is shared by every connection of an actor, and a session-derived key
 * let one agent's position stamp membership onto a concurrent agent's writes.
 *
 * All SQL fully parameterized. Row shape mirrors the table 1:1.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';

/** The kinds a branch spine may be (matches branch_positions.spine_type CHECK). */
export const SPINE_TYPES = ['context', 'decision', 'task'] as const;
export type SpineType = (typeof SPINE_TYPES)[number];

/**
 * HOW a position came to exist — and therefore WHICH RULE SET governs it ( * migration 082; matches branch_positions.origin CHECK):
 *
 *   'declared'  — branch_open ONLY. A stated stance. P1 semantics, BYTE-IDENTICAL to
 *                 v0.23.0. Explicit intent outranks every byproduct (R0).
 *   'byproduct' — task_claim / task_update(in_progress) (migration 084).
 *                 Work-start INFERRED from another act. Mints IDENTICALLY to 'declared'
 *                 (tipless, no auto-open, membership to the spine); it differs in exactly one
 *                 respect — it YIELDS, never overwriting a 'declared' position. Before 084
 *                 these opens stored 'declared', so the two were indistinguishable in the row
 *                 even though the column existed.
 *   'auto'      — opened as a byproduct of a create by an UNPOSITIONED session (R1).
 *   'trunk'     — the session fanned out (R2) and reverted to trunk: mints no membership and
 *                 auto-opens nothing until a DECLARED act (R5).
 *
 * ONE state field rather than a pair of booleans, so "auto AND trunk" is unreachable.
 */
export const POSITION_ORIGINS = ['declared', 'byproduct', 'auto', 'trunk'] as const;
export type PositionOrigin = (typeof POSITION_ORIGINS)[number];

/** A persisted position row (DB-authoritative). */
export interface BranchPosition {
  projectId: string;
  sessionKey: string;
  /**
   * The branch ROOT. For an origin='trunk' row this retains the record the session reverted
   * FROM — provenance, not a position: nothing is minted to it (R5), and branch_current
   * renders trunk as trunk. Read `origin` before treating this as somewhere you are standing.
   */
  spineId: string;
  spineType: SpineType;
  origin: PositionOrigin;
  /**
   * R3/R4 TIP — the deepest record on an auto branch. NULL means TIP = ROOT, which is why a
   * declared position (where the tip is never set — enforced by a CHECK in 082) behaves
   * exactly as it did in P1.
   */
  tipId: string | null;
  tipType: SpineType | null;
  /** R2 virginity counter: member writes made from THIS position. Zero = virgin. */
  memberWrites: number;
  openedAt: Date;
  updatedAt: Date;
}

/** Is this position at TRUNK (R5: mints nothing, auto-opens nothing)? */
export function isTrunkPosition(position: BranchPosition | null): boolean {
  return position?.origin === 'trunk';
}

/**
 * The record a member write attaches to: the TIP, or the ROOT when no tip is set (R4).
 * The one place "tip = root when null" is spelled, so declared and auto positions cannot
 * drift apart on it.
 */
export function positionTarget(position: BranchPosition): { id: string; type: SpineType } {
  return position.tipId && position.tipType
    ? { id: position.tipId, type: position.tipType }
    : { id: position.spineId, type: position.spineType };
}

/** Every column of the row, in one place, so reads and writes cannot drift. */
const POSITION_COLUMNS =
  'project_id, session_key, spine_id, spine_type, origin, tip_id, tip_type, member_writes, opened_at, updated_at';

function rowToPosition(row: any): BranchPosition {
  return {
    projectId: row.project_id,
    sessionKey: row.session_key,
    spineId: row.spine_id,
    spineType: row.spine_type,
    origin: row.origin,
    tipId: row.tip_id ?? null,
    tipType: row.tip_type ?? null,
    memberWrites: row.member_writes,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open (or move) this session's position onto a spine. UPSERT on (project_id, session_key):
 * re-opening onto a different spine REPLACES the position (that is the interrupt/switch
 * semantic — you stand in one place at a time). opened_at resets on every open, so it
 * always reports when THIS position was taken, not when the row first existed.
 */
export async function openPosition(
  input: {
    projectId: string;
    sessionKey: string;
    spineId: string;
    spineType: SpineType;
    /** Defaults to 'declared' — a caller that does not say is a declared act (R0). */
    origin?: PositionOrigin;
  },
  pool: Pool = db
): Promise<BranchPosition> {
  // R0/R5, both enforced by this one statement: opening RESETS tip and member_writes and
  // STAMPS the origin. So a declared act always lands a virgin, tipless, declared row —
  // which is why a declared position is byte-identical to P1 no matter what the session did
  // before it, and why a declared act is the only thing that exits trunk.
  const result = await pool.query(
    `INSERT INTO branch_positions
       (project_id, session_key, spine_id, spine_type, origin, tip_id, tip_type, member_writes, opened_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, 0, now(), now())
     ON CONFLICT (project_id, session_key) DO UPDATE SET
       spine_id      = EXCLUDED.spine_id,
       spine_type    = EXCLUDED.spine_type,
       origin        = EXCLUDED.origin,
       tip_id        = NULL,
       tip_type      = NULL,
       member_writes = 0,
       opened_at     = now(),
       updated_at    = now()
     RETURNING ${POSITION_COLUMNS}`,
    [input.projectId, input.sessionKey, input.spineId, input.spineType, input.origin ?? 'declared']
  );
  return rowToPosition(result.rows[0]);
}

/**
 * R2 — revert this session to TRUNK. Retains spine_id as the record it reverted FROM
 * (provenance) and clears the tip: nothing is minted from trunk, so there is no target to
 * keep. Returns null when no row existed (nothing to revert).
 */
export async function revertToTrunk(
  projectId: string,
  sessionKey: string,
  pool: Pool = db
): Promise<BranchPosition | null> {
  const result = await pool.query(
    `UPDATE branch_positions
        SET origin = 'trunk', tip_id = NULL, tip_type = NULL, updated_at = now()
      WHERE project_id = $1 AND session_key = $2
      RETURNING ${POSITION_COLUMNS}`,
    [projectId, sessionKey]
  );
  return result.rows.length > 0 ? rowToPosition(result.rows[0]) : null;
}

/**
 * R3/R4 — record ONE member write from this position: increment the virginity counter and,
 * when `tip` is given (R3, a create that extends the branch), move the TIP onto it.
 * The increment and the tip move are ONE statement so a position can never be left virgin
 * with a tip, or advanced without counting.
 */
export async function noteMemberWrite(
  projectId: string,
  sessionKey: string,
  tip: { id: string; type: SpineType } | null,
  pool: Pool = db
): Promise<BranchPosition | null> {
  const result = await pool.query(
    `UPDATE branch_positions
        SET member_writes = member_writes + 1,
            tip_id        = COALESCE($3::uuid, tip_id),
            tip_type      = COALESCE($4::text, tip_type),
            updated_at    = now()
      WHERE project_id = $1 AND session_key = $2
      RETURNING ${POSITION_COLUMNS}`,
    [projectId, sessionKey, tip?.id ?? null, tip?.type ?? null]
  );
  return result.rows.length > 0 ? rowToPosition(result.rows[0]) : null;
}

/**
 * Read this session's current position, or null when none is open. Exact
 * (project_id, session_key) match ONLY — no fallback, no TTL filter (see header).
 */
export async function readPosition(
  projectId: string,
  sessionKey: string,
  pool: Pool = db
): Promise<BranchPosition | null> {
  const result = await pool.query(
    `SELECT ${POSITION_COLUMNS}
       FROM branch_positions
      WHERE project_id = $1 AND session_key = $2`,
    [projectId, sessionKey]
  );
  return result.rows.length > 0 ? rowToPosition(result.rows[0]) : null;
}

/**
 * Close this session's position. Idempotent — returns the closed position (so the caller
 * can say WHAT was closed), or null when nothing was open.
 */
export async function closePosition(
  projectId: string,
  sessionKey: string,
  pool: Pool = db
): Promise<BranchPosition | null> {
  const result = await pool.query(
    `DELETE FROM branch_positions
      WHERE project_id = $1 AND session_key = $2
      RETURNING ${POSITION_COLUMNS}`,
    [projectId, sessionKey]
  );
  return result.rows.length > 0 ? rowToPosition(result.rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-KEY WRAPPERS — the keying seam (projectHandler.resolvePositionKeys).
// Since an earlier task the resolver returns a SINGLE key (the connection identity —
// a resolved DB session id is actor-shared in actor mode, so it may never key a
// position). The list-shaped seam is retained: it is the one interface every caller
// consumes, and every key in `keys` belongs to the SAME caller by construction of
// resolvePositionKeys — never a cross-loop fallback.
// ─────────────────────────────────────────────────────────────────────────────

/** Read the position under the first key that has one (ordered strongest-first). */
export async function readPositionAny(
  projectId: string,
  keys: readonly string[],
  pool: Pool = db
): Promise<BranchPosition | null> {
  for (const key of keys) {
    const p = await readPosition(projectId, key, pool);
    if (p) return p;
  }
  return null;
}

/**
 * Open under the STRONGEST key and delete any straggler rows under the weaker keys of the
 * same caller (convergence — one caller, one position row).
 */
export async function openPositionAny(
  input: {
    projectId: string;
    keys: readonly string[];
    spineId: string;
    spineType: SpineType;
    origin?: PositionOrigin;
  },
  pool: Pool = db
): Promise<BranchPosition> {
  const position = await openPosition(
    {
      projectId: input.projectId,
      sessionKey: input.keys[0],
      spineId: input.spineId,
      spineType: input.spineType,
      origin: input.origin,
    },
    pool
  );
  for (const key of input.keys.slice(1)) {
    await closePosition(input.projectId, key, pool);
  }
  return position;
}

/** Close under EVERY key (idempotent); returns the first position actually closed. */
export async function closePositionAny(
  projectId: string,
  keys: readonly string[],
  pool: Pool = db
): Promise<BranchPosition | null> {
  let closed: BranchPosition | null = null;
  for (const key of keys) {
    const c = await closePosition(projectId, key, pool);
    if (c && !closed) closed = c;
  }
  return closed;
}
