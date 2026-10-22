/**
 * EDGE CHRONOLOGY AT THE MINT SITE — contract test.
 *
 * WHAT IS BEING GUARDED: `supersedes` / `possibly_supersedes` are not symmetric. "A
 * supersedes B" is a claim that A came AFTER B. Before this task, links.ts
 * `autoMintFromDecision` mirrored a decision's `superseded_by` column into a `supersedes`
 * edge with no chronology check at all, and the `link` tool would mint any direction asked
 * for. Measured on prod 2026-08-27 (query in the task record): 1 backwards `supersedes`
 * from that unguarded mirror, and 58 backwards `possibly_supersedes` from the belief
 * adjudicator — which HAS its own chronology guard, one layer above the write.
 *
 * WHERE THE GUARD IS, AND WHY THAT MATTERS HERE: at `mintEdge`, the choke point every edge
 * in the database passes through. So this file drives the SHIPPED TOOL SURFACE (`link`,
 * `decision_update`) rather than calling mintEdge directly — a test that composes its own
 * pipe proves the pipe, not the product (C3). The one direct-service test below is
 * deliberately about the SERVICE-level contract (the three-state return), and says so.
 *
 * THE POPULATION THIS FILE ENUMERATES: the chronology-ordered edge types named in
 * config/edgeChronologyConfig.ts — read FROM that config, not re-listed here, so adding a
 * member there without a guard makes this file's sweep cover it automatically.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { embedDim } from './helpers/embedGeometry.js';

// EMBEDDING STUB. Not an optimization — a REQUIREMENT for running alongside the other edge
// suites: onnxruntime-node's native binding cannot self-register twice in one worker, so a
// file that loads the real embedding service dies with "Module did not self-register" the
// moment it shares a worker with a file that mocked it. Nothing here asserts on similarity,
// so the stub is also honest: it removes a dependency this file never had.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: new Array(embedDim()).fill(0),
      model: 'stub-zero',
      dimensions: embedDim(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { mintEdge, findBackwardsEdges } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';
import {
  CHRONOLOGY_ORDERED_EDGE_TYPES,
  BACKWARDS_IN_TIME_REASON,
} from '../config/edgeChronologyConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'chronology guard fixture') RETURNING id`,
      [`chrono-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `chrono-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/**
 * Seed a context at an EXPLICIT age. Ages are set rather than inferred from insert order:
 * two inserts a microsecond apart leave the `(created_at, id)` total order decided by a
 * random uuid, which is a coin-flip flake, not a test.
 */
async function seedContext(projectId: string, content: string, ageMinutes: number): Promise<string> {
  return (
    await db.query(
      `INSERT INTO contexts (project_id, content, context_type, created_at)
       VALUES ($1, $2, 'completion', now() - ($3 || ' minutes')::interval) RETURNING id`,
      [projectId, content, String(ageMinutes)]
    )
  ).rows[0].id;
}

async function seedDecision(projectId: string, title: string, ageMinutes: number): Promise<string> {
  return (
    await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level, decision_date)
       VALUES ($1, 'architecture', $2, 'chronology fixture', 'chronology fixture', 'low',
               now() - ($3 || ' minutes')::interval)
       RETURNING id`,
      [projectId, title, String(ageMinutes)]
    )
  ).rows[0].id;
}

const edgeCount = async (fromId: string, toId: string, edgeType: string): Promise<number> =>
  (
    await db.query(
      `SELECT count(*)::int AS c FROM links WHERE from_id=$1::uuid AND to_id=$2::uuid AND edge_type=$3`,
      [fromId, toId, edgeType]
    )
  ).rows[0].c;

afterAll(async () => {
  for (const p of projectIds) {
    await db.query('DELETE FROM links WHERE project_id = $1', [p]);
    await db.query('DELETE FROM contexts WHERE project_id = $1', [p]);
    await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [p]);
    await db.query('DELETE FROM projects WHERE id = $1', [p]);
  }
});

describe('edge chronology — a supersession may never point backwards in time', () => {
  /**
   * THE SHIPPED SURFACE, BOTH WAYS. One test, two directions on the SAME pair of records, so
   * the RED and the GREEN differ by exactly one thing — which endpoint is `from`. A refusal
   * that also refused the correct direction would look identical to a working guard if only
   * the backwards case were asserted.
   */
  test.each(CHRONOLOGY_ORDERED_EDGE_TYPES)(
    '`link` REFUSES a backwards %s and ACCEPTS the same pair forwards',
    async (edgeType) => {
      const { projectId, conn } = await freshCase(`link-${edgeType}`);
      const older = await seedContext(projectId, `chrono older ${edgeType} ${STAMP}`, 10);
      const newer = await seedContext(projectId, `chrono newer ${edgeType} ${STAMP}`, 1);

      const backwards = await viaTool(
        'link',
        { from: id8(older), fromType: 'context', to: id8(newer), toType: 'context', edgeType },
        conn
      );
      expect(backwards.isError, 'a backwards supersession is an ERROR, not a quiet no-op').toBe(true);
      expect(backwards.structuredContent).toMatchObject({
        ok: false,
        action: 'rejected',
        reason: BACKWARDS_IN_TIME_REASON,
      });
      // REFUSED, NOT SILENTLY DROPPED: the caller is told which way round it should go.
      expect(responseText(backwards)).toContain('swapped');
      expect(await edgeCount(older, newer, edgeType), 'nothing was written').toBe(0);

      const forwards = await viaTool(
        'link',
        { from: id8(newer), fromType: 'context', to: id8(older), toType: 'context', edgeType },
        conn
      );
      expect(forwards.isError).not.toBe(true);
      expect(await edgeCount(newer, older, edgeType), 'the correct direction still mints').toBe(1);
    }
  );

  /**
   * THE ORIGINAL DEFECT'S OWN PATH. `decision_update` mirrors `superseded_by` into a
   * `supersedes` edge. The mirror mints `thisDecision --supersedes--> target`, so naming an
   * OLDER decision as the superseder of a NEWER one is the backwards case, and it is the
   * shape of the one such row that exists on prod.
   */
  test('the decision `superseded_by` mirror mints NO backwards supersedes edge', async () => {
    const { projectId, conn } = await freshCase('decision-mirror');
    const older = await seedDecision(projectId, `chrono older decision ${STAMP}`, 10);
    const newer = await seedDecision(projectId, `chrono newer decision ${STAMP}`, 1);

    // BACKWARDS: the OLDER decision claims to be superseded by... a record that predates it
    // is impossible, so state it the wrong way round — older is updated to point at newer,
    // which mints older --supersedes--> newer.
    const bad = await viaTool('decision_update', { decisionId: id8(older), supersededBy: id8(newer) }, conn);
    // The UPDATE itself still succeeds — the column write is the writer's stated intent and
    // is not this guard's business. Only the derived EDGE is refused.
    expect(bad.isError).not.toBe(true);
    expect(await edgeCount(older, newer, 'supersedes'), 'no backwards mirror edge').toBe(0);

    // FORWARD CONTROL on the same pair: the newer decision superseded by nothing newer, so
    // instead assert the mirror DOES mint when the direction is right.
    const good = await viaTool('decision_update', { decisionId: id8(newer), supersededBy: id8(older) }, conn);
    expect(good.isError).not.toBe(true);
    expect(await edgeCount(newer, older, 'supersedes'), 'the forward mirror edge mints').toBe(1);
  });

  /**
   * THE SERVICE CONTRACT — three outcomes, never two. This one calls mintEdge directly ON
   * PURPOSE: the shape of the return value IS the deliverable for every other caller, and no
   * tool surface exposes `chronology`/`refused` verbatim.
   */
  test('mintEdge returns REFUSED (not created, not deduped) and reports its chronology verdict', async () => {
    const { projectId } = await freshCase('service');
    const older = await seedContext(projectId, `svc older ${STAMP}`, 10);
    const newer = await seedContext(projectId, `svc newer ${STAMP}`, 1);

    const refused = await mintEdge({
      fromId: older, fromType: 'context', toId: newer, toType: 'context',
      edgeType: 'possibly_supersedes', projectId, via: EDGE_MINT_VIA.beliefAdjudication,
    });
    expect(refused).toMatchObject({ created: false, refused: BACKWARDS_IN_TIME_REASON, chronology: 'backwards' });
    expect(refused.edgeId, 'a refusal has no edge id — there is no row').toBeUndefined();

    const ok = await mintEdge({
      fromId: newer, fromType: 'context', toId: older, toType: 'context',
      edgeType: 'possibly_supersedes', projectId, via: EDGE_MINT_VIA.beliefAdjudication,
    });
    expect(ok.created).toBe(true);
    expect(ok.refused).toBeUndefined();
    expect(ok.chronology).toBe('ok');

    // THE THIRD STATE. An endpoint with no readable row cannot be compared. That is NOT
    // "not backwards" and NOT a refusal — it is reported as `unknown` and the mint proceeds,
    // because absence of a row is not evidence that the edge is wrong.
    const ghost = '00000000-0000-4000-8000-0000000abcde';
    const unknown = await mintEdge({
      fromId: newer, fromType: 'context', toId: ghost, toType: 'context',
      edgeType: 'possibly_supersedes', projectId, via: EDGE_MINT_VIA.beliefAdjudication,
    });
    expect(unknown.chronology).toBe('unknown');
    expect(unknown.refused).toBeUndefined();
    expect(unknown.created).toBe(true);
  });

  /**
   * THE DETECTION HALF. mintEdge stops NEW backwards edges; findBackwardsEdges reports the
   * ones already in the table. Both read the same edge-type set and the same per-entity
   * timestamp source from config, so a change to either moves both together.
   *
   * The subject is PLANTED with raw SQL on purpose — the guard makes it unmintable through
   * any service path, so the only way to have a pre-existing backwards row to detect is to
   * write one the way history did, behind the service.
   */
  test('findBackwardsEdges reports a PLANTED backwards edge and ignores a forward one', async () => {
    const { projectId } = await freshCase('detect');
    const older = await seedContext(projectId, `detect older ${STAMP}`, 10);
    const newer = await seedContext(projectId, `detect newer ${STAMP}`, 1);
    const decisionOld = await seedDecision(projectId, `detect older decision ${STAMP}`, 10);
    const decisionNew = await seedDecision(projectId, `detect newer decision ${STAMP}`, 1);

    const plant = async (fromId: string, fromType: string, toId: string, toType: string) =>
      (
        await db.query(
          `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
           VALUES ($1,$2,$3,$4,'possibly_supersedes',$5,'test-plant',$6) RETURNING id`,
          [fromId, fromType, toId, toType, projectId, EDGE_MINT_VIA.beliefAdjudication]
        )
      ).rows[0].id;

    const backwardsContextEdge = await plant(older, 'context', newer, 'context');
    // A DECISION endpoint is the case a naive detector gets wrong: technical_decisions has no
    // `created_at` column, so a query that assumed one would find no row and silently report
    // nothing here — a too-small count that reads as clean.
    const backwardsDecisionEdge = await plant(decisionOld, 'decision', decisionNew, 'decision');
    await plant(newer, 'context', older, 'context'); // the forward control — must NOT be flagged
    await plant(decisionNew, 'decision', decisionOld, 'decision');

    const found = await findBackwardsEdges();
    const mine = found.filter((e) => [backwardsContextEdge, backwardsDecisionEdge].includes(e.edgeId));
    expect(mine.map((e) => e.edgeId).sort()).toEqual([backwardsContextEdge, backwardsDecisionEdge].sort());
    expect(mine.every((e) => e.mintVia === EDGE_MINT_VIA.beliefAdjudication)).toBe(true);
    // The forward rows are in the same table, same project, same edge type — and absent.
    const forwardFlagged = found.filter((e) => e.fromId === newer || e.fromId === decisionNew);
    expect(forwardFlagged, 'a forward edge is never reported as backwards').toEqual([]);
  });

  /**
   * THE POPULATION BOUNDARY — the values most likely to slip through are the ones just
   * OUTSIDE the guarded set. An `informs` edge from an older record to a newer one is
   * ordinary and correct; a guard that refused it would break every threading write in the
   * product, and nothing else in this file would notice.
   */
  test('a NON-chronological edge type is unaffected: older → newer `informs` still mints', async () => {
    const { projectId, conn } = await freshCase('unordered');
    const older = await seedContext(projectId, `unordered older ${STAMP}`, 10);
    const newer = await seedContext(projectId, `unordered newer ${STAMP}`, 1);
    const resp = await viaTool(
      'link',
      { from: id8(older), fromType: 'context', to: id8(newer), toType: 'context', edgeType: 'informs' },
      conn
    );
    expect(resp.isError).not.toBe(true);
    expect(await edgeCount(older, newer, 'informs')).toBe(1);
  });
});
