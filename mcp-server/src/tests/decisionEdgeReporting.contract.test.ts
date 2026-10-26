/**
 * DECISION EDGE-REPORTING HONESTY — contract tests.
 *
 * THE DISEASE, AND WHY IT IS THE SAME ONE AS an earlier change
 * ---------------------------------------------------
 * `context_store` used to report `linksMinted: 0` for a write that had minted real edges;
 * an earlier task fixed it with a per-write LEDGER (`edgesMinted`, one row per edge, each
 * labeled with the path that minted it) whose created-rows count IS the reported total.
 * `storeEdgeReporting.contract.test.ts` locks that in for the context write path.
 *
 * The decision write path had the same disease in two different degrees, both MEASURED on
 * ref 61d4f00 before this file existed:
 *
 *   decision_record  — reported a correct `linksMinted` TOTAL (an earlier task summed the
 *                      three sources) but NO itemization at all. A caller could see "4"
 *                      and could not see WHICH four, by what provenance, or whether any of
 *                      them were dedups rather than new rows. Opacity, not arithmetic.
 *
 *   decision_update  — reported NOTHING. It calls `autoMintFromDecision` and
 *                      `autoMintFromTags` and DISCARDS both return values; the response
 *                      carried no edge field of any kind. Retiring a decision via
 *                      `supersededBy` mints a `supersedes` edge — the single most
 *                      decision-relevant edge in the product — and the tool that minted it
 *                      said nothing. That is a truthfulness defect in a product whose whole
 *                      value is the graph.
 *
 * THE CONTRACT (choke-point invariant, both write paths):
 *
 *     record():  decision.linksMinted === get_links(id).total
 *     update():  decision.linksMinted === get_links(id).total AFTER  −  BEFORE
 *
 * The right-hand side is read through the PUBLIC `get_links` tool, never raw SQL, so both
 * sides of the comparison are tool-surface numbers — the same rule storeEdgeReporting uses,
 * and the reason a lie in the reporting layer cannot hide behind a healthy data layer.
 *
 * THE LEDGER'S OWN ACCOUNTING IS ASSERTED, NOT DESCRIBED
 * -----------------------------------------------------
 * `edgesMinted` itemizes every source that hands back its edges: `autoMintFromTags`,
 * `mintExplicitLinks`, `mintPositional`. `autoMintFromDecision` (evidence → `learned_from`,
 * superseded_by → `supersedes`) returns `{minted, attempted}` and NO edge list, so its rows
 * are counted in the total and in `mintedBySource.decision` but cannot be itemized without
 * changing `services/links.ts`. Rather than write that fact as a comment nobody can check,
 * the accounting identity is EXECUTED below:
 *
 *     edgesMinted.filter(created).length + mintedBySource.decision === linksMinted
 *
 * If someone later teaches `autoMintFromDecision` to return its edges and adds them to the
 * ledger without updating `mintedBySource.decision`, that assertion goes RED. The remainder
 * is named and measured, not asserted away.
 *
 * ISOLATION: every case gets its own fresh project and its own connection id — branch
 * positions are connection-keyed, and a leaked position changes what the positional layer
 * mints.
 *
 * DB target: a disposable migrated ci_* database. Never production.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

/** Full public path: validate THEN routeExecutor, scoped to a connection. */
async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}
function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function parseId(resp: any): string {
  const m = responseText(resp).match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse id from: ${responseText(resp).slice(0, 200)}`);
  return m[1];
}
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function freshCase(label: string): Promise<{ projectId: string; conn: string }> {
  const projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'decision edge-report fixture') RETURNING id`,
      [`dec-edge-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(projectId);
  const conn = `dec-edge-conn-${label}-${STAMP}`;
  await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });
  return { projectId, conn };
}

/** The invariant's right-hand side, read through the PUBLIC tool (never raw SQL). */
async function graphTotal(recordId: string, conn: string): Promise<number> {
  const resp = await viaTool('get_links', { id: recordId }, conn);
  expect(resp.isError).not.toBe(true);
  return resp.structuredContent.total ?? 0;
}

const decOf = (resp: any) => resp.structuredContent.decision;

/** Record a decision with the minimum required fields. */
async function recordDecision(conn: string, extra: Record<string, any> = {}): Promise<any> {
  return viaTool(
    'decision_record',
    {
      decisionType: 'architecture',
      title: `d-${Math.random().toString(36).slice(2, 8)}`,
      description: 'fixture decision',
      rationale: 'fixture rationale',
      impactLevel: 'medium',
      ...extra,
    },
    conn
  );
}

/**
 * THE LEDGER ACCOUNTING IDENTITY — asserted for every write in this file, so no case can
 * pass while the ledger and the total disagree. See the header for why the `decision`
 * source is a named remainder rather than a ledger row.
 */
function expectLedgerAccountsForTotal(payload: any) {
  expect(Array.isArray(payload.edgesMinted), 'edgesMinted must always be an array').toBe(true);
  const itemizedCreated = payload.edgesMinted.filter((e: any) => e.created).length;
  expect(
    itemizedCreated + payload.mintedBySource.decision,
    `ledger does not account for the reported total: itemized-created=${itemizedCreated} ` +
      `+ decision=${payload.mintedBySource.decision} != linksMinted=${payload.linksMinted}\n` +
      JSON.stringify(payload.edgesMinted, null, 2)
  ).toBe(payload.linksMinted);
  // Every ledger row carries a provenance label. A row with no `via` is an unattributed
  // edge, which is the opacity this whole feature exists to end.
  for (const e of payload.edgesMinted) {
    expect(typeof e.via, `ledger row missing via: ${JSON.stringify(e)}`).toBe('string');
    expect(typeof e.created, `ledger row missing created: ${JSON.stringify(e)}`).toBe('boolean');
  }
}

describe('decision_record / decision_update edge-reporting honesty', () => {
  afterAll(async () => {
    try {
      for (const pid of projectIds) {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      }
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ══ decision_record ════════════════════════════════════════════════════════════════

  test("record: tag-derived edges are ITEMIZED with via:'tag' and the minting tag", async () => {
    const { conn } = await freshCase('rec-tag');
    const task = parseId(await viaTool('task_create', { title: 'target task', type: 'feature' }, conn));
    // task_create auto-opens a branch on the task; close it so this case exercises the TAG
    // path alone and the positional layer is not silently supplying a second edge.
    await viaTool('branch_close', {}, conn);

    const resp = await recordDecision(conn, { tags: [`task:${id8(task)}`] });
    expect(resp.isError).not.toBe(true);
    const dec = decOf(resp);

    expect(dec.linksMinted).toBe(1);
    expect(await graphTotal(dec.id, conn)).toBe(dec.linksMinted);
    expect(dec.edgesMinted).toEqual([
      expect.objectContaining({
        via: 'tag',
        edgeType: 'informs',
        toType: 'task',
        toId: task,
        created: true,
        sourceTag: `task:${id8(task)}`,
      }),
    ]);
    expectLedgerAccountsForTotal(dec);
    // Success is as visible as failure in the TEXT channel too.
    expect(responseText(resp)).toMatch(/Linked:/);
    expect(responseText(resp)).toMatch(/informs → task/);
  });

  test("record: explicit `links` edges are ITEMIZED with via:EDGE_MINT_VIA.linksParam", async () => {
    const { conn } = await freshCase('rec-links');
    const task = parseId(await viaTool('task_create', { title: 'link target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);

    const resp = await recordDecision(conn, {
      links: [{ edgeType: 'informs', to: task, toType: 'task' }],
    });
    const dec = decOf(resp);

    expect(dec.linksMinted).toBe(1);
    expect(await graphTotal(dec.id, conn)).toBe(dec.linksMinted);
    expect(dec.edgesMinted).toEqual([
      expect.objectContaining({
        via: EDGE_MINT_VIA.linksParam,
        edgeType: 'informs',
        toType: 'task',
        toId: task,
        created: true,
      }),
    ]);
    expectLedgerAccountsForTotal(dec);
  });

  test('record: a DEDUP is surfaced as created:false and does NOT inflate the total', async () => {
    const { conn } = await freshCase('rec-dedup');
    const task = parseId(await viaTool('task_create', { title: 'dedup target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);

    // The SAME edge requested twice, by two different paths, in one write.
    const resp = await recordDecision(conn, {
      tags: [`task:${id8(task)}`],
      links: [{ edgeType: 'informs', to: task, toType: 'task' }],
    });
    const dec = decOf(resp);

    // Two ledger rows (both paths report what they did) — ONE created row, ONE new edge.
    expect(dec.edgesMinted).toHaveLength(2);
    const byVia = Object.fromEntries(dec.edgesMinted.map((e: any) => [e.via, e]));
    expect(byVia['tag']).toMatchObject({ toId: task, edgeType: 'informs' });
    expect(byVia[EDGE_MINT_VIA.linksParam]).toMatchObject({ toId: task, edgeType: 'informs' });
    expect(dec.edgesMinted.filter((e: any) => e.created)).toHaveLength(1);

    expect(dec.linksMinted).toBe(1);
    expect(await graphTotal(dec.id, conn)).toBe(1);
    expectLedgerAccountsForTotal(dec);
    expect(responseText(resp)).toMatch(/already linked/);
  });

  test('record: the honest ZERO — an unthreaded decision reports 0 === graph 0 with an empty ledger', async () => {
    const { conn } = await freshCase('rec-zero');
    const resp = await recordDecision(conn);
    const dec = decOf(resp);

    expect(dec.linksMinted).toBe(0);
    expect(dec.edgesMinted).toEqual([]);
    expect(dec.mintedBySource).toEqual({ links: 0, tags: 0, decision: 0, positional: 0 });
    expect(await graphTotal(dec.id, conn)).toBe(0);
    expectLedgerAccountsForTotal(dec);
  });

  test('record: the un-itemizable `decision` source is COUNTED and named in the remainder', async () => {
    const { conn } = await freshCase('rec-evidence');
    const evidence = decOf(await recordDecision(conn)).id;
    await viaTool('branch_close', {}, conn);

    const resp = await recordDecision(conn, { metadata: { evidence: [evidence] } });
    const dec = decOf(resp);

    // One `learned_from` edge minted by autoMintFromDecision. It is in the TOTAL and in the
    // named remainder; it is NOT in the itemized ledger, because the helper returns no edge
    // list. The identity below is what keeps that honest instead of merely stated.
    expect(dec.mintedBySource.decision).toBe(1);
    expect(dec.linksMinted).toBe(1);
    expect(await graphTotal(dec.id, conn)).toBe(dec.linksMinted);
    expectLedgerAccountsForTotal(dec);
  });

  // ══ decision_update — the path that reported NOTHING ═══════════════════════════════

  test('update: a supersedes edge minted by supersededBy is REPORTED (was: silent)', async () => {
    const { conn } = await freshCase('upd-sup');
    const older = decOf(await recordDecision(conn)).id;
    await viaTool('branch_close', {}, conn);
    const newer = decOf(await recordDecision(conn)).id;
    await viaTool('branch_close', {}, conn);

    const before = await graphTotal(newer, conn);
    const resp = await viaTool('decision_update', { decisionId: newer, supersededBy: older }, conn);
    expect(resp.isError).not.toBe(true);
    const dec = decOf(resp);
    const after = await graphTotal(newer, conn);

    // The update DID mint an edge — the graph proves it.
    expect(after - before).toBe(1);
    // ...and the response now says so. Before this fix `dec.linksMinted` was `undefined`.
    expect(dec.linksMinted).toBe(after - before);
    expect(dec.mintedBySource.decision).toBe(1);
    expectLedgerAccountsForTotal(dec);
    expect(responseText(resp)).toMatch(/Edges minted: 1/);
  });

  test("update: tag edges added by a tag edit are ITEMIZED with via:'tag'", async () => {
    const { conn } = await freshCase('upd-tag');
    const decId = decOf(await recordDecision(conn)).id;
    await viaTool('branch_close', {}, conn);
    const task = parseId(await viaTool('task_create', { title: 'late target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);

    const before = await graphTotal(decId, conn);
    const resp = await viaTool('decision_update', { decisionId: decId, tags: [`task:${id8(task)}`] }, conn);
    const dec = decOf(resp);
    const after = await graphTotal(decId, conn);

    expect(after - before).toBe(1);
    expect(dec.linksMinted).toBe(after - before);
    expect(dec.edgesMinted).toEqual([
      expect.objectContaining({
        via: 'tag',
        edgeType: 'informs',
        toType: 'task',
        toId: task,
        created: true,
        sourceTag: `task:${id8(task)}`,
      }),
    ]);
    expectLedgerAccountsForTotal(dec);
  });

  test('update: re-applying the SAME tag mints nothing and reports 0, with the dedup visible', async () => {
    const { conn } = await freshCase('upd-dedup');
    const task = parseId(await viaTool('task_create', { title: 'redup target', type: 'feature' }, conn));
    await viaTool('branch_close', {}, conn);
    const decId = decOf(await recordDecision(conn, { tags: [`task:${id8(task)}`] })).id;
    await viaTool('branch_close', {}, conn);

    const before = await graphTotal(decId, conn);
    const resp = await viaTool('decision_update', { decisionId: decId, tags: [`task:${id8(task)}`] }, conn);
    const dec = decOf(resp);
    const after = await graphTotal(decId, conn);

    // Nothing new in the graph...
    expect(after - before).toBe(0);
    // ...the reported total agrees...
    expect(dec.linksMinted).toBe(0);
    // ...and the dedup is SURFACED rather than rendering as nothing-happened.
    expect(dec.edgesMinted).toEqual([
      expect.objectContaining({ via: 'tag', toId: task, created: false }),
    ]);
    expectLedgerAccountsForTotal(dec);
  });

  test('update: an update that mints nothing reports an honest empty ledger', async () => {
    const { conn } = await freshCase('upd-zero');
    const decId = decOf(await recordDecision(conn)).id;
    await viaTool('branch_close', {}, conn);

    const before = await graphTotal(decId, conn);
    const resp = await viaTool('decision_update', { decisionId: decId, status: 'active' }, conn);
    const dec = decOf(resp);

    expect(await graphTotal(decId, conn)).toBe(before);
    expect(dec.linksMinted).toBe(0);
    expect(dec.edgesMinted).toEqual([]);
    expect(dec.mintedBySource).toEqual({ links: 0, tags: 0, decision: 0, positional: 0 });
    expectLedgerAccountsForTotal(dec);
  });
});
