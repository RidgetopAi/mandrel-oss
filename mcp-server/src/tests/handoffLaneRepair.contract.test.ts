/**
 * Migration 105 + handoffLaneRepair contract: the repair deletes cross-lane
 * auto:handoff-supersession edges (ws:research -> ws:coordinator), keeps same-lane auto edges
 * (ws:coordinator -> untagged), cross-lane edges with a different created_by, and
 * cross-lane auto edges whose predecessor the writer named with a supersedes: tag; a cross-lane
 * edge claiming predecessor_source 'context-tag' is still deleted (context: is same-lane only);
 * idempotent.
 */
import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { mintEdge } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import { repairCrossLaneHandoffSupersession } from '../services/handoffLaneRepair.js';
import {
  HANDOFF_SUPERSESSION_CREATED_BY,
  HANDOFF_PREDECESSOR_SOURCE,
} from '../services/handoffSupersession.js';
import {
  READ_HANDOFF_LANE_TAG_PREFIX as PFX,
  READ_HANDOFF_DEFAULT_LANE as DEF,
} from '../config/handoffLaneConfig.js';

const STAMP = Date.now();
let projectId: string;

async function mkCtx(tags: string[], label: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags)
       VALUES ($1, 'handoff', $2, $3) RETURNING id`,
      [projectId, `${label} ${STAMP}`, tags]
    )
  ).rows[0].id;
}
async function mkEdge(from: string, to: string, by: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await mintEdge(
    { fromId: from, fromType: 'context', toId: to, toType: 'context', edgeType: 'supersedes',
      projectId, createdBy: by, via: EDGE_MINT_VIA.handoffTimeline, metadata },
    db
  );
}
async function edgeKeys(): Promise<string[]> {
  return (
    await db.query(`SELECT from_id || '>' || to_id || '@' || created_by AS k FROM links WHERE project_id = $1 ORDER BY 1`, [projectId])
  ).rows.map((r) => r.k as string);
}

afterAll(async () => {
  if (projectId) {
    await db.query(`DELETE FROM links WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  }
  await db.end?.();
});

describe('handoff lane repair (migration 105)', () => {
  test('deletes only cross-lane auto edges; idempotent', async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [`lane-repair-${STAMP}`])
    ).rows[0].id;
    // Created oldest -> newest: the chronology guard only admits newer-supersedes-older.
    const untagged = await mkCtx([], 'untagged');
    const coordinator = await mkCtx([`${PFX()}${DEF()}`], 'coordinator');
    const research = await mkCtx([`${PFX()}research`], 'research');
    const named = await mkCtx([`${PFX()}research`], 'named');
    const cited = await mkCtx([`${PFX()}research`], 'cited');
    const other = 'manual:someone';

    await mkEdge(research, coordinator, HANDOFF_SUPERSESSION_CREATED_BY); // cross-lane auto -> DELETED
    await mkEdge(coordinator, untagged, HANDOFF_SUPERSESSION_CREATED_BY); // same lane auto -> kept
    await mkEdge(research, untagged, other); // cross-lane, other author -> kept
    await mkEdge(named, coordinator, HANDOFF_SUPERSESSION_CREATED_BY, {
      predecessor_source: HANDOFF_PREDECESSOR_SOURCE.supersedesTag,
    }); // cross-lane auto, but EXPLICITLY named by the writer -> kept
    await mkEdge(cited, coordinator, HANDOFF_SUPERSESSION_CREATED_BY, {
      predecessor_source: HANDOFF_PREDECESSOR_SOURCE.contextTag,
    }); // cross-lane auto claiming context-tag -> DELETED (context: never crosses a lane)

    expect(await repairCrossLaneHandoffSupersession(db)).toBe(2);
    const after = await edgeKeys();
    expect(after).toEqual(
      [
        `${coordinator}>${untagged}@${HANDOFF_SUPERSESSION_CREATED_BY}`,
        `${research}>${untagged}@${other}`,
        `${named}>${coordinator}@${HANDOFF_SUPERSESSION_CREATED_BY}`,
      ].sort()
    );

    expect(await repairCrossLaneHandoffSupersession(db)).toBe(0);
    expect(await edgeKeys()).toEqual(after);
  });
});
