/**
 * HANDOFF SUPERSESSION — the PHASE 2 item-g acceptance contract
 * (folds D5-A from an earlier change).
 *
 * Driven through the FULL public path (validate → routeExecutor — the exact path the
 * HTTP bridge uses), asserted at the ROW level, same conventions as
 * positionalMembership.contract.test.ts:
 *
 *   1. Storing handoff B after handoff A mints EXACTLY ONE declared `supersedes` edge
 *      B → A (created_by 'auto:handoff-supersession') — the edge ROW is asserted.
 *   2. The FIRST handoff in a project mints nothing (no predecessor — honest no-op).
 *   3. A THIRD handoff supersedes only the SECOND (created_at adjacency, not fan-out):
 *      C → B exists, C → A does NOT. The chain is a line, never a web — this is the
 *      structural "never recurse for ordering" guarantee at the write end.
 *   4. A NON-handoff write mints NO supersession edge (the guard population is
 *      context_type='handoff', not all contexts).
 *   5. PROVENANCE (acceptance 7): the minted edge classifies DECLARED in the
 *      link_provenance view (migration 081) — read from the VIEW, the single source.
 *      On new writes the handoff-chain declared coverage is 100% by construction,
 *      up from the measured 14.2% prod baseline (177/1,249, task description).
 *   6. Cross-project isolation: a handoff in project Q never supersedes project P's.
 *   7. Lanes + EXACT-tag pairing: ws:x never supersedes
 *      ws:y; ws:x and untagged never pair either way (the read rule's untagged→default
 *      mapping is not the write rule); untagged↔untagged and ws:x↔ws:x still do.
 *   8. Explicit predecessor: a `supersedes:` tag, or exactly one
 *      `context:` tag naming a live handoff IN THE SAME EXACT LANE, wins over the newest —
 *      the case. A cross-lane `context:` is only a citation (round 2, Reviewer P7);
 *      `supersedes:` is the one deliberate cross-lane override.
 *
 * Embeddings mocked to zeros (similarity plays NO role — determinism is the point).
 * DB target: the disposable migrated ci_* DB — never production.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  READ_HANDOFF_LANE_TAG_PREFIX,
  READ_HANDOFF_DEFAULT_LANE,
} from '../config/handoffLaneConfig.js';
import {
  HANDOFF_SUPERSESSION_CREATED_BY,
  HANDOFF_PREDECESSOR_SOURCE,
  untaggedHandoffWarning,
} from '../services/handoffSupersession.js';
import { READ_HANDOFF_SUPERSEDES_TAG_PREFIX } from '../config/handoffLaneConfig.js';
import { trustForRecord } from '../services/trust.js';

const STAMP = Date.now();
const projectIds: string[] = [];

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'P2 handoff fixture') RETURNING id`,
      [`p2ho-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `p2ho-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

async function storeContext(conn: string, type: string, content: string, tags?: string[]): Promise<string> {
  const r = await viaTool('context_store', tags ? { content, type, tags } : { content, type }, conn);
  const id = r.structuredContent?.context?.id;
  expect(id, `context_store (${type}) must return an id`).toBeTruthy();
  return id as string;
}

/** Store a handoff and return the id plus the supersession report and text channel. */
async function storeHandoff(
  conn: string,
  content: string,
  tags?: string[]
): Promise<{ id: string; report: any; text: string }> {
  const r = await viaTool('context_store', tags ? { content, type: 'handoff', tags } : { content, type: 'handoff' }, conn);
  const ctx = r.structuredContent?.context;
  expect(ctx?.id, 'context_store (handoff) must return an id').toBeTruthy();
  return { id: ctx.id as string, report: ctx.handoffSupersession, text: r.content?.[0]?.text ?? '' };
}

async function band(id: string): Promise<string> {
  return (await trustForRecord({ id, type: 'context' })).band;
}

/** The supersedes edge rows FROM a record (row-level assertion surface). */
async function supersedesRows(fromId: string) {
  return (
    await db.query(
      `SELECT to_id, edge_type, created_by FROM links
        WHERE from_id = $1 AND edge_type = 'supersedes' ORDER BY to_id`,
      [fromId]
    )
  ).rows as Array<{ to_id: string; edge_type: string; created_by: string | null }>;
}

afterAll(async () => {
  for (const pid of projectIds) {
    await db.query(`DELETE FROM links WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM contexts WHERE project_id = $1`, [pid]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [pid]);
  }
  await db.end?.();
});

describe('PHASE 2 item g — handoff supersession minting', () => {
  test('1+2. first handoff mints nothing; the second mints EXACTLY the declared edge B → A', async () => {
    const { conn } = await freshCase('chain');
    const a = await storeContext(conn, 'handoff', `handoff A ${STAMP} — first trunk entry`);
    expect(await supersedesRows(a)).toEqual([]); // first handoff: no predecessor

    const b = await storeContext(conn, 'handoff', `handoff B ${STAMP} — second trunk entry`);
    const rows = await supersedesRows(b);
    expect(rows).toEqual([
      { to_id: a, edge_type: 'supersedes', created_by: HANDOFF_SUPERSESSION_CREATED_BY },
    ]);

    // 3. The third supersedes ONLY the second — a line, not a web.
    const c = await storeContext(conn, 'handoff', `handoff C ${STAMP} — third trunk entry`);
    const cRows = await supersedesRows(c);
    expect(cRows.map((r) => r.to_id)).toEqual([b]);
    expect(cRows.map((r) => r.to_id)).not.toContain(a);
  });

  test('4. a non-handoff write mints NO supersession edge', async () => {
    const { conn } = await freshCase('nonhandoff');
    await storeContext(conn, 'handoff', `handoff base ${STAMP}`);
    const note = await storeContext(conn, 'discussion', `an ordinary note ${STAMP}`);
    expect(await supersedesRows(note)).toEqual([]);
  });

  test('5. the minted edge classifies DECLARED in link_provenance (migration 081), and new handoff chains are 100% declared vs the 14.2% baseline', async () => {
    const { projectId, conn } = await freshCase('meter');
    await storeContext(conn, 'handoff', `handoff M1 ${STAMP}`);
    await storeContext(conn, 'handoff', `handoff M2 ${STAMP}`);
    await storeContext(conn, 'handoff', `handoff M3 ${STAMP}`);

    // Read from the VIEW — the single source of the classification, never a TS copy.
    const meter = (
      await db.query(
        `SELECT provenance_class, count(*)::int AS n
           FROM link_provenance
          WHERE project_id = $1 AND edge_type = 'supersedes'
          GROUP BY 1`,
        [projectId]
      )
    ).rows as Array<{ provenance_class: string; n: number }>;
    // The whole new chain (2 edges for 3 handoffs) is DECLARED — nothing unclassified,
    // nothing guessed. 2/2 = 100% declared on new writes (baseline was 14.2%).
    expect(meter).toEqual([{ provenance_class: 'declared', n: 2 }]);
  });

  test('6. cross-project isolation: a handoff never supersedes another project\'s trunk', async () => {
    const p = await freshCase('isoP');
    const q = await freshCase('isoQ');
    const pHandoff = await storeContext(p.conn, 'handoff', `P trunk ${STAMP}`);
    const qHandoff = await storeContext(q.conn, 'handoff', `Q trunk ${STAMP}`);
    expect(await supersedesRows(qHandoff)).toEqual([]); // Q's first — P's is invisible to it
    expect(await supersedesRows(pHandoff)).toEqual([]);
  });

  test('7. lanes: ws:research never supersedes ws:coordinator; ws:coordinator chains on ws:coordinator', async () => {
    const { conn } = await freshCase('lanes');
    const coordinator = `${READ_HANDOFF_LANE_TAG_PREFIX()}${READ_HANDOFF_DEFAULT_LANE()}`;
    const research = `${READ_HANDOFF_LANE_TAG_PREFIX()}research`;
    const a = await storeContext(conn, 'handoff', `lane A ${STAMP}`, [coordinator]);
    const b = await storeContext(conn, 'handoff', `lane B ${STAMP}`, [research]);
    expect(await supersedesRows(b)).toEqual([]); // research's first — A is another lane
    const c = await storeContext(conn, 'handoff', `lane C ${STAMP}`, [coordinator]);
    expect((await supersedesRows(c)).map((r) => r.to_id)).toEqual([a]);
    expect(await supersedesRows(b)).toEqual([]); // no edge between B and C, either way
  });
});

describe('an earlier task — write-side pairing is EXACT-tag; an explicit predecessor wins', () => {
  const ws = (lane: string) => `${READ_HANDOFF_LANE_TAG_PREFIX()}${lane}`;

  test('ws:x then ws:y → no edge, and A keeps its band', async () => {
    const { conn } = await freshCase('xy');
    const a = await storeHandoff(conn, `xy A ${STAMP}`, [ws('xlane')]);
    const bandBefore = await band(a.id);
    expect(bandBefore).not.toBe('superseded');
    const b = await storeHandoff(conn, `xy B ${STAMP}`, [ws('ylane')]);
    expect(await supersedesRows(b.id)).toEqual([]);
    expect(b.report.predecessorId).toBeNull();
    expect(await band(a.id)).toBe(bandBefore);
  });

  test('ws:x then untagged → no edge (the 2026-10-23 flip-flop); and untagged then ws:x → no edge', async () => {
    const { conn } = await freshCase('xu');
    const a = await storeHandoff(conn, `xu A ${STAMP}`, [ws(READ_HANDOFF_DEFAULT_LANE())]);
    const bandBefore = await band(a.id);
    const u = await storeHandoff(conn, `xu U ${STAMP}`); // untagged — the boot hook reads it as the default lane
    expect(await supersedesRows(u.id)).toEqual([]);
    expect(await band(a.id)).toBe(bandBefore);
    const c = await storeHandoff(conn, `xu C ${STAMP}`, [ws(READ_HANDOFF_DEFAULT_LANE())]);
    // C pairs with A (same exact tag), never with the newer untagged U.
    expect((await supersedesRows(c.id)).map((r) => r.to_id)).toEqual([a.id]);
  });

  test('untagged then untagged → edge, and the untagged write carries the workstream warning', async () => {
    const { conn } = await freshCase('uu');
    const a = await storeHandoff(conn, `uu A ${STAMP}`);
    expect(a.report.warning).toContain(untaggedHandoffWarning());
    const b = await storeHandoff(conn, `uu B ${STAMP}`);
    expect(await supersedesRows(b.id)).toEqual([
      { to_id: a.id, edge_type: 'supersedes', created_by: HANDOFF_SUPERSESSION_CREATED_BY },
    ]);
    expect(b.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
    // Shown WITH the edge line, not instead of it.
    expect(b.report.warning).toContain(untaggedHandoffWarning());
    expect(b.text).toContain(`supersedes → context ${a.id}`);
    expect(b.text).toContain(untaggedHandoffWarning());
  });

  test('ws:x then ws:x → edge (control), and a tagged write carries no workstream warning', async () => {
    const { conn } = await freshCase('xx');
    const a = await storeHandoff(conn, `xx A ${STAMP}`, [ws('xlane')]);
    const b = await storeHandoff(conn, `xx B ${STAMP}`, [ws('xlane')]);
    expect((await supersedesRows(b.id)).map((r) => r.to_id)).toEqual([a.id]);
    expect(b.report.warning).toBeNull();
    expect(await band(a.id)).toBe('superseded');
  });

  test('a named context:<handoff> → edge to the NAMED one, not the newest (the case)', async () => {
    const { conn } = await freshCase('named');
    const named = await storeHandoff(conn, `named old ${STAMP}`, [ws('xlane')]);
    const newest = await storeHandoff(conn, `named newest ${STAMP}`, [ws('xlane')]);
    const c = await storeHandoff(conn, `named C ${STAMP} — Supersedes ${named.id.slice(0, 8)}`, [
      ws('xlane'),
      `context:${named.id.slice(0, 8)}`,
    ]);
    expect((await supersedesRows(c.id)).map((r) => r.to_id)).toEqual([named.id]);
    expect(c.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.contextTag);
    expect(await band(newest.id)).not.toBe('superseded');
  });

  test('a supersedes:<id8> tag wins across lanes (repair-survival: handoffLaneRepair.contract.test.ts)', async () => {
    const { conn } = await freshCase('suptag');
    const coordinatorHead = await storeHandoff(conn, `sup coordinator ${STAMP}`, [ws(READ_HANDOFF_DEFAULT_LANE())]);
    const other = await storeHandoff(conn, `sup other ${STAMP}`, [ws('ylane')]);
    const c = await storeHandoff(conn, `sup C ${STAMP}`, [
      ws('ylane'),
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${coordinatorHead.id.slice(0, 8)}`,
    ]);
    expect((await supersedesRows(c.id)).map((r) => r.to_id)).toEqual([coordinatorHead.id]);
    expect(c.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.supersedesTag);
    expect(await band(other.id)).not.toBe('superseded');
  });

  test('a context: tag naming a handoff in ANOTHER lane is only a citation — no edge to it, its band unchanged (P7)', async () => {
    const { conn } = await freshCase('ctxcross');
    const xHead = await storeHandoff(conn, `cross x head ${STAMP}`, [ws('xlane')]);
    const yHead = await storeHandoff(conn, `cross y head ${STAMP}`, [ws('ylane')]);
    const yBand = await band(yHead.id);
    expect(yBand).not.toBe('superseded');
    const c = await storeHandoff(conn, `cross C ${STAMP} — cites ${yHead.id.slice(0, 8)}`, [
      ws('xlane'),
      `context:${yHead.id.slice(0, 8)}`,
    ]);
    // The timeline ran on C's own lane: C supersedes the x head, never the cited y head.
    expect((await supersedesRows(c.id)).map((r) => r.to_id)).toEqual([xHead.id]);
    expect(c.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
    expect(await band(yHead.id)).toBe(yBand);
    expect(await band(xHead.id)).toBe('superseded');
  });

  test('a context: tag naming a NON-handoff is ignored; the timeline runs', async () => {
    const { conn } = await freshCase('ctxnonho');
    const a = await storeHandoff(conn, `nonho A ${STAMP}`, [ws('xlane')]);
    const note = await storeContext(conn, 'discussion', `nonho note ${STAMP}`);
    const b = await storeHandoff(conn, `nonho B ${STAMP}`, [ws('xlane'), `context:${note.slice(0, 8)}`]);
    expect((await supersedesRows(b.id)).map((r) => r.to_id)).toEqual([a.id]);
    expect(b.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
  });

  test('an ARCHIVED target is ignored, whether named by supersedes: or context:', async () => {
    const { conn } = await freshCase('archived');
    const old = await storeHandoff(conn, `arch old ${STAMP}`, [ws('xlane')]);
    const head = await storeHandoff(conn, `arch head ${STAMP}`, [ws('xlane')]);
    await db.query(`UPDATE contexts SET archived_at = now() WHERE id = $1`, [old.id]);
    const viaSup = await storeHandoff(conn, `arch S ${STAMP}`, [
      ws('xlane'),
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${old.id.slice(0, 8)}`,
    ]);
    expect((await supersedesRows(viaSup.id)).map((r) => r.to_id)).toEqual([head.id]);
    expect(viaSup.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
    expect(viaSup.report.warning).toContain('does not name a live handoff');
    const viaCtx = await storeHandoff(conn, `arch C ${STAMP}`, [ws('xlane'), `context:${old.id.slice(0, 8)}`]);
    expect((await supersedesRows(viaCtx.id)).map((r) => r.to_id)).toEqual([viaSup.id]);
    expect(viaCtx.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
  });

  test('a CROSS-PROJECT target named by full uuid is ignored, and the foreign handoff keeps its band', async () => {
    const p = await freshCase('xprojP');
    const q = await freshCase('xprojQ');
    const foreign = await storeHandoff(q.conn, `xproj foreign ${STAMP}`, [ws('xlane')]);
    const foreignBand = await band(foreign.id);
    const a = await storeHandoff(p.conn, `xproj A ${STAMP}`, [ws('xlane')]);
    const b = await storeHandoff(p.conn, `xproj B ${STAMP}`, [
      ws('xlane'),
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${foreign.id}`,
      `context:${foreign.id}`,
    ]);
    expect((await supersedesRows(b.id)).map((r) => r.to_id)).toEqual([a.id]);
    expect(b.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
    expect(await band(foreign.id)).toBe(foreignBand);
  });

  test('two supersedes: tags naming different handoffs → no edge at all, and a warning', async () => {
    const { conn } = await freshCase('twosup');
    const a = await storeHandoff(conn, `twosup A ${STAMP}`, [ws('xlane')]);
    const b = await storeHandoff(conn, `twosup B ${STAMP}`, [ws('xlane')]);
    const c = await storeHandoff(conn, `twosup C ${STAMP}`, [
      ws('xlane'),
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${a.id.slice(0, 8)}`,
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${b.id.slice(0, 8)}`,
    ]);
    expect(await supersedesRows(c.id)).toEqual([]);
    expect(c.report.predecessorId).toBeNull();
    expect(c.report.warning).toContain('no supersedes edge minted');
  });

  test('supersedes: beats context:', async () => {
    const { conn } = await freshCase('supbeats');
    const sTarget = await storeHandoff(conn, `beats S ${STAMP}`, [ws('xlane')]);
    const cTarget = await storeHandoff(conn, `beats C ${STAMP}`, [ws('xlane')]);
    await storeHandoff(conn, `beats newest ${STAMP}`, [ws('xlane')]);
    const d = await storeHandoff(conn, `beats D ${STAMP}`, [
      ws('xlane'),
      `context:${cTarget.id.slice(0, 8)}`,
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${sTarget.id.slice(0, 8)}`,
    ]);
    expect((await supersedesRows(d.id)).map((r) => r.to_id)).toEqual([sTarget.id]);
    expect(d.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.supersedesTag);
  });

  test('a supersedes: tag naming nothing live is surfaced, and the timeline still runs', async () => {
    const { conn } = await freshCase('supmiss');
    const a = await storeHandoff(conn, `miss A ${STAMP}`, [ws('xlane')]);
    const note = await storeContext(conn, 'discussion', `not a handoff ${STAMP}`);
    const b = await storeHandoff(conn, `miss B ${STAMP}`, [
      ws('xlane'),
      `${READ_HANDOFF_SUPERSEDES_TAG_PREFIX()}${note.slice(0, 8)}`,
    ]);
    expect((await supersedesRows(b.id)).map((r) => r.to_id)).toEqual([a.id]);
    expect(b.report.source).toBe(HANDOFF_PREDECESSOR_SOURCE.timeline);
    expect(b.report.warning).toContain('does not name a live handoff');
  });
});
