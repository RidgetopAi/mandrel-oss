/**
 * Repair for delete auto-minted handoff supersession edges whose two endpoints
 * are in DIFFERENT workstream lanes (the pre-fix project-wide minting). Same-lane edges and
 * edges with any other created_by are untouched. Idempotent — a second run deletes nothing.
 * Lane rule: SQL function mandrel_handoff_lane (migration 105) fed from handoffLaneConfig.
 */
import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { READ_HANDOFF_LANE_TAG_PREFIX, READ_HANDOFF_DEFAULT_LANE } from '../config/handoffLaneConfig.js';
import { HANDOFF_SUPERSESSION_CREATED_BY } from './handoffSupersession.js';

export async function repairCrossLaneHandoffSupersession(pool: Pool = db): Promise<number> {
  const r = await pool.query(
    `DELETE FROM links l
      USING contexts f, contexts t
      WHERE l.created_by = $1
        AND l.edge_type = 'supersedes'
        AND l.from_type = 'context' AND l.to_type = 'context'
        AND f.id = l.from_id AND t.id = l.to_id
        AND mandrel_handoff_lane(f.tags, $2, $3) <> mandrel_handoff_lane(t.tags, $2, $3)`,
    [HANDOFF_SUPERSESSION_CREATED_BY, READ_HANDOFF_LANE_TAG_PREFIX(), READ_HANDOFF_DEFAULT_LANE()]
  );
  return r.rowCount ?? 0;
}
