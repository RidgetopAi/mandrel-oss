/**
 * Repair for delete auto-minted handoff supersession edges whose two endpoints
 * are in DIFFERENT workstream lanes (the pre-fix project-wide minting). Same-lane edges and
 * edges with any other created_by are untouched. Idempotent — a second run deletes nothing.
 * an edge whose predecessor the writer named with a `supersedes:` tag
 * (metadata.predecessor_source) is a deliberate cross-lane override and is never deleted.
 * Every other source — including `context:`, which is same-lane by construction — is.
 * Lane rule: SQL function mandrel_handoff_lane (migration 105) fed from handoffLaneConfig.
 */
import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { READ_HANDOFF_LANE_TAG_PREFIX, READ_HANDOFF_DEFAULT_LANE } from '../config/handoffLaneConfig.js';
import {
  HANDOFF_SUPERSESSION_CREATED_BY,
  HANDOFF_CROSS_LANE_PREDECESSOR_SOURCES,
} from './handoffSupersession.js';

export async function repairCrossLaneHandoffSupersession(pool: Pool = db): Promise<number> {
  const r = await pool.query(
    `DELETE FROM links l
      USING contexts f, contexts t
      WHERE l.created_by = $1
        AND l.edge_type = 'supersedes'
        AND l.from_type = 'context' AND l.to_type = 'context'
        AND f.id = l.from_id AND t.id = l.to_id
        AND mandrel_handoff_lane(f.tags, $2, $3) <> mandrel_handoff_lane(t.tags, $2, $3)
        AND COALESCE(l.metadata->>'predecessor_source', '') <> ALL($4::text[])`,
    [
      HANDOFF_SUPERSESSION_CREATED_BY,
      READ_HANDOFF_LANE_TAG_PREFIX(),
      READ_HANDOFF_DEFAULT_LANE(),
      [...HANDOFF_CROSS_LANE_PREDECESSOR_SOURCES],
    ]
  );
  return r.rowCount ?? 0;
}
