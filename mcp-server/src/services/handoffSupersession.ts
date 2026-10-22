/**
 * HANDOFF SUPERSESSION MINTING — the trunk's own declared-edge feed (PHASE 2 item g,
 * folded from 8f218f17 / D5-A; tree model a4f8886d).
 *
 * THE MODEL: the TRUNK is the project's handoff TIMELINE — time orders it, always
 * (a4f8886d: a naive supersedes walk measured 22,482,181 rows; supersedes is
 * CORROBORATION, never ordering). But the corroboration itself was starved: at the
 * measured baseline only 177 of 1,249 handoff-chain links (14.2%) were DECLARED. This
 * service closes that at the WRITE: storing a new handoff deterministically mints ONE
 * declared `supersedes` edge from the new handoff to the project's previous newest
 * handoff. No similarity, no judgment call — pure created_at adjacency, which is why the
 * stamp is DECLARED-grade: the predecessor is structurally named, not guessed.
 *
 * TRUST CONSEQUENCE (deliberate): services/trust.ts classifies a `supersedes` edge whose
 * created_by is not the belief adjudicator as a DECLARED supersession → the superseded
 * handoff hard-caps to band 'superseded'. That is the semantic we want: the newest
 * handoff IS the resume point; a superseded handoff is kept for lineage, not for acting on.
 *
 * ROBUSTNESS: mintHandoffSupersession NEVER throws — the handoff row is already
 * persisted; a failed corroboration mint must not break or roll back the store (same
 * contract as positionalMint / tag minting).
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { mintEdge } from './links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { READ_HANDOFF_LANE_TAG_PREFIX, READ_HANDOFF_DEFAULT_LANE } from '../config/handoffLaneConfig.js';

/**
 * The provenance stamp for a handoff-timeline supersession edge. DECLARED in the
 * link_provenance view (migration 081) — the target is structurally named (the project's
 * previous newest handoff), not similarity-guessed. Also DECLARED for trust.ts: any
 * `supersedes` created_by other than the belief adjudicator hard-caps.
 * Single source — never re-literal this string.
 */
export const HANDOFF_SUPERSESSION_CREATED_BY = 'auto:handoff-supersession';

/** The context_type whose writes feed the trunk timeline. */
export const TRUNK_CONTEXT_TYPE = 'handoff';

/** The honest report of what the handoff-supersession layer did for one write. */
export interface HandoffSupersessionReport {
  /** The predecessor handoff's id (null = first handoff in the project, nothing to mint). */
  predecessorId: string | null;
  /** True iff a NEW edge row was inserted (false on dedup or no predecessor). */
  created: boolean;
  /** Failure surfacing (never thrown). */
  warning: string | null;
}

/**
 * Deterministically mint the declared `supersedes` edge: new handoff → the project's
 * previous newest live handoff (created_at strictly before this one's; id as a stable
 * tiebreak on identical timestamps). ONE bounded query + ONE idempotent insert — this
 * path is structurally incapable of walking the supersedes graph (it never reads it).
 *
 * Call ONLY for a just-persisted context whose context_type is 'handoff'
 * (the caller checks; asserted here fail-loud for defense in depth).
 */
export async function mintHandoffSupersession(input: {
  /** The just-persisted handoff context. */
  recordId: string;
  contextType: string;
  projectId: string | undefined;
  pool?: Pool;
}): Promise<HandoffSupersessionReport> {
  const pool = input.pool ?? db;
  const report: HandoffSupersessionReport = { predecessorId: null, created: false, warning: null };
  try {
    if (input.contextType !== TRUNK_CONTEXT_TYPE) {
      // Defense in depth: minting a supersession off a non-handoff write would silently
      // hard-cap an unrelated record's trust. Loud in the report, never thrown.
      report.warning = `handoff supersession skipped: context_type '${input.contextType}' is not '${TRUNK_CONTEXT_TYPE}'`;
      return report;
    }
    if (!input.projectId) {
      report.warning = 'handoff supersession skipped: no project id (the trunk is per-project)';
      return report;
    }

    // The predecessor: the project's newest OTHER live handoff written before this one.
    // (created_at, id) < the new row's pair — a total order, so identical timestamps
    // still pick deterministically. Archived rows are not trunk material. The predecessor
    // must also share the new handoff's workstream LANE: a ws:research
    // handoff must never supersede the live ws:coordinator head. Lane rule = SQL function
    // mandrel_handoff_lane (migration 105), fed from config/handoffLaneConfig.ts.
    const prior = await pool.query(
      `SELECT c.id
         FROM contexts c, contexts self
        WHERE self.id = $1
          AND c.project_id = self.project_id
          AND c.context_type = $2
          AND c.archived_at IS NULL
          AND c.id <> self.id
          AND mandrel_handoff_lane(c.tags, $3, $4) = mandrel_handoff_lane(self.tags, $3, $4)
          AND (c.created_at, c.id) < (self.created_at, self.id)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1`,
      [input.recordId, TRUNK_CONTEXT_TYPE, READ_HANDOFF_LANE_TAG_PREFIX(), READ_HANDOFF_DEFAULT_LANE()]
    );
    if (prior.rows.length === 0) return report; // first handoff — nothing to corroborate.

    report.predecessorId = prior.rows[0].id as string;
    const r = await mintEdge(
      {
        fromId: input.recordId,
        fromType: 'context',
        toId: report.predecessorId,
        toType: 'context',
        edgeType: 'supersedes',
        projectId: input.projectId,
        createdBy: HANDOFF_SUPERSESSION_CREATED_BY,
        via: EDGE_MINT_VIA.handoffTimeline,
        metadata: {},
      },
      pool
    );
    report.created = r.created;
    return report;
  } catch (error) {
    // Never break the write — the handoff is already persisted (same contract as every
    // other write-time minter). Surfaced in the report AND the log.
    logger.error('❌ handoff supersession mint failed (record already persisted; write not broken)', error as Error);
    report.warning = `handoff supersession mint failed: ${(error as Error).message}`;
    return report;
  }
}
