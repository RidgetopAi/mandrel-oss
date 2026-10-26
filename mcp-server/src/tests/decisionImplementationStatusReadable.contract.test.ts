/**
 * MAKE implementation_status READABLE — end-to-end contract tests
 * (item 2 of an earlier decision).
 *
 * WHAT WENT WRONG THAT THIS EXISTS TO PREVENT: an earlier decision's
 * implementation_status read `planned` for 12 days after the work shipped. NOTHING read
 * that field — no filter on decision_search, no breakdown in decision_stats, absent from
 * project_insights and recall_thread — so nothing corrected it. An audit then DERIVED
 * "unstarted, prod included" from it and ranked a COMPLETED security task as the day's top
 * priority. A field nobody can read in aggregate does not merely hide the truth; it
 * manufactures a false conclusion.
 *
 * EVERY ASSERTION HERE READS THROUGH THE PUBLIC TOOL PATH — validate → routeExecutor (flat)
 * or dispatchGateway (gateway), the exact paths the HTTP bridge and the MCP gateway use.
 * The only direct SQL is (a) bulk FIXTURE seeding of the >100-row population, where the
 * rows are scenery rather than the thing under test, and (b) the direct DB counts the
 * acceptance criteria require as an INDEPENDENT cross-check — the whole point of which is
 * that they do NOT come from the code under test, so a wrong-but-self-consistent
 * implementation cannot satisfy them.
 *
 * WHAT IT LOCKS:
 *   A. implementationStatus FILTERS decision_search — asserted as the returned SET (by id),
 *      not merely a count, AND cross-checked against a direct DB count for EVERY value in
 *      the vocabulary (including the values with ZERO members — C3's empty population).
 *   B. decision_stats carries an implementation_status breakdown whose buckets SUM to the
 *      total decision count (a breakdown that silently drops a bucket is a number that
 *      reads like a total and is not one).
 *   C. REAL pagination — a class of >100 members is FULLY enumerable via offset (this test
 *      reaches record 101+; a pagination test that never crosses the old cap proves
 *      nothing), the pages are DISJOINT and their union is exactly the DB's id set, and
 *      `hasMore` is correct at the exact boundary: total == limit (false) and
 *      total == limit + 1 (true), plus offset-past-the-end (returned 0, hasMore false,
 *      total still truthful).
 *   D. implementation_status reaches the READ MODEL — it is rendered by the surfaces people
 *      actually orient with (project_insights / recall_thread), not only by a caller who
 *      already knew to filter for it.
 *   E. BOTH TOOL SURFACES. Params are validated strict per-branch, so a filter declared on
 *      only one surface is rejected on the other — the two-representations defect an earlier decision
 *      exists to kill. Asserted at the SCHEMA level (both derived keysets) and by
 *      RUNNING the same query through routeExecutor and dispatchGateway and comparing the
 *      answers.
 *   F. ONE SOURCE FOR THE ENUM. The zod validator, both advertised schemas, the model-facing
 *      prose, and the live Postgres CHECK constraint are all asserted against
 *      config/decisionVocab.ts — including the negative direction (a value NOT in the
 *      vocabulary is rejected by the validator AND by Postgres), which is what makes the
 *      claim "one source" rather than "five agreeing copies".
 *   G. THE PAYOFF QUERY: "every active, non-superseded decision whose implementation_status
 *      is still planned, oldest first" — the query nobody could ask before this task.
 *
 * Embeddings are mocked → deterministic + offline (same idiom as the currentState /
 * projectInsightsGraphAware contract suites).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { dispatchGateway } from '../routes/gateway.js';
import { validateToolArguments } from '../middleware/validation.js';
import { buildInputSchema } from '../config/toolDefinitions.js';
import { buildGatewayBranchSchema } from '../config/gatewaySurface.js';
import { OP_BY_ID } from '../config/opRegistry.js';
import {
  IMPLEMENTATION_STATUSES,
  IMPLEMENTATION_STATUS_DEFAULT,
} from '../config/decisionVocab.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import { THREAD_CONFIG } from '../config/threadConfig.js';
import { ARTIFACT_REF_CONFIG } from '../config/artifactRefConfig.js';
import { projectCurrentState } from '../services/currentStateCore.js';
import { computeTrust } from '../services/trustModel.js';

const STAMP = Date.now();
const CONN = `impl-status-conn-${STAMP}`;

/**
 * THE VOCABULARY IS READ FROM THE PRODUCT, never typed here (Lesson: never hardcode a
 * config-derived value in a test — derive it from the same source the product reads). Every
 * loop below iterates THIS, so adding a sixth value to the vocabulary automatically extends
 * the coverage instead of leaving a silently-untested bucket.
 */
const VOCAB = [...IMPLEMENTATION_STATUSES];

/** The read model's "not built yet" POLICY SUBSET — also read from the product's config. */
const UNBUILT = [...CURRENT_STATE_CONFIG.unbuiltImplementationStatuses];

/** A value that is NOT in the vocabulary — derived, so it can never accidentally become one. */
const NOT_IN_VOCAB = `${VOCAB.join('-')}-definitely-not-a-status`;

/** The >100-row population. 105 so page 3 lands strictly past the old max limit of 100. */
const BULK_N = 105;
/** The exact-boundary population: EXACTLY_N and a limit of EXACTLY_N / EXACTLY_N - 1. */
const EXACTLY_N = 7;
/**
 * A population where EVERY row shares one decision_date — the shape that makes an ORDER BY
 * without a total tiebreaker unstable. Sized past the old 100 cap for the same reason as BULK_N.
 */
const TIED_N = 105;

let mixedProjectId: string;
let bulkProjectId: string;
let boundaryProjectId: string;
let tiedProjectId: string;

/** id → the implementation_status it was seeded with, for the SET assertions in part A. */
const mixedIds = new Map<string, string>();

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** The response's structured channel, whichever field the route used (`data` or `structuredContent`). */
function dataOf(resp: any): any {
  return resp?.structuredContent ?? resp?.data ?? {};
}

/** FLAT surface: the exact path the HTTP bridge uses — validate THEN routeExecutor. */
async function viaFlat(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** GATEWAY surface: the discriminated form the coordinator and the agents actually call. */
async function viaGateway(gateway: string, action: string, rawArgs: any): Promise<any> {
  return dispatchGateway(gateway, { action, ...rawArgs }, { connectionId: CONN });
}

async function createProject(name: string): Promise<string> {
  const r = await viaFlat('project_create', { name, description: 'impl-status readability fuse' });
  return r.structuredContent.project.id;
}

/**
 * Record a decision through the PUBLIC tool at a given implementation_status.
 * decision_record accepts implementationStatus up front, so this needs no second call.
 */
async function recordDecision(
  projectId: string,
  title: string,
  implementationStatus: string
): Promise<string> {
  const r = await viaFlat('decision_record', {
    decisionType: 'architecture',
    title,
    description: 'd',
    rationale: 'r',
    impactLevel: 'medium',
    implementationStatus,
    projectId,
  });
  const id = r.structuredContent?.decision?.id;
  expect(id, `decision_record gave no id: ${textOf(r)}`).toBeTruthy();
  return id;
}

/**
 * Bulk FIXTURE seed. Direct INSERT on purpose: these rows are the POPULATION SIZE under
 * test, not the tool contract under test — every read in every assertion still goes through
 * the public tool. Going through decision_record 105 times would add ~105 embed+session
 * round-trips to prove nothing extra about pagination.
 *
 * decision_date is spread one day apart DESCENDING from a fixed base so `sortDirection`
 * has something real to order by and the oldest row is deterministic — a fixture where every
 * row shares a timestamp would let an unstable sort pass the enumeration assertions.
 */
async function bulkSeed(
  projectId: string,
  n: number,
  implementationStatus: string,
  titlePrefix: string
): Promise<string[]> {
  const rows = await db.query(
    `INSERT INTO technical_decisions
       (project_id, decision_type, title, description, rationale, impact_level,
        status, implementation_status, decision_date)
     SELECT $1, 'process', $2 || ' ' || i, 'd', 'r', 'medium',
            'active', $3, TIMESTAMPTZ '2026-01-01 00:00:00Z' + (i || ' days')::interval
       FROM generate_series(1, $4) AS i
     RETURNING id::text AS id`,
    [projectId, titlePrefix, implementationStatus, n]
  );
  expect(rows.rows.length).toBe(n);
  return rows.rows.map((r) => r.id);
}

/**
 * Seed `n` rows that ALL share ONE decision_date. Deliberately the pathological fixture: the
 * ordinary bulkSeed above spreads dates one day apart, which makes the sort order total by
 * accident and hides an unstable ORDER BY. See the C7 test.
 */
async function bulkSeedTied(projectId: string, n: number, titlePrefix: string): Promise<void> {
  const rows = await db.query(
    `INSERT INTO technical_decisions
       (project_id, decision_type, title, description, rationale, impact_level,
        status, implementation_status, decision_date)
     SELECT $1, 'process', $2 || ' ' || i, 'd', 'r', 'medium',
            'active', $3, TIMESTAMPTZ '2026-03-03 03:03:03Z'
       FROM generate_series(1, $4) AS i
     RETURNING id`,
    [projectId, titlePrefix, IMPLEMENTATION_STATUS_DEFAULT, n]
  );
  expect(rows.rows.length).toBe(n);
}

/** INDEPENDENT ground truth: a direct DB count, not derived from the code under test. */
async function dbCount(projectId: string, implementationStatus?: string): Promise<number> {
  const sql = implementationStatus
    ? `SELECT COUNT(*)::int AS c FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL AND implementation_status = $2`
    : `SELECT COUNT(*)::int AS c FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL`;
  const params = implementationStatus ? [projectId, implementationStatus] : [projectId];
  return (await db.query(sql, params)).rows[0].c;
}

/** INDEPENDENT ground truth: the id SET, straight from Postgres. */
async function dbIds(projectId: string, implementationStatus?: string): Promise<Set<string>> {
  const sql = implementationStatus
    ? `SELECT id::text AS id FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL AND implementation_status = $2`
    : `SELECT id::text AS id FROM technical_decisions
        WHERE project_id = $1 AND archived_at IS NULL`;
  const params = implementationStatus ? [projectId, implementationStatus] : [projectId];
  return new Set((await db.query(sql, params)).rows.map((r) => r.id));
}

/** Search on the flat surface and hand back both channels. */
async function search(args: any): Promise<{ resp: any; data: any; ids: string[]; text: string }> {
  const resp = await viaFlat('decision_search', args);
  expect(resp.isError, `decision_search errored: ${textOf(resp)}`).toBeFalsy();
  const data = dataOf(resp);
  return { resp, data, ids: (data.results ?? []).map((r: any) => r.id), text: textOf(resp) };
}

describe('implementation_status is READABLE: filter + breakdown + real pagination + read model', () => {
  beforeAll(async () => {
    // ── PROJECT 1: one decision per vocabulary value, recorded through the public tool.
    //    Built by ITERATING the vocabulary, so a value added to decisionVocab.ts is covered
    //    here automatically rather than leaving an untested bucket behind.
    mixedProjectId = await createProject(`impl-status-mixed-${STAMP}`);
    for (const value of VOCAB) {
      const id = await recordDecision(mixedProjectId, `Mixed ${value} ${STAMP}`, value);
      mixedIds.set(id, value);
    }

    // ── PROJECT 2: a >100-member class. BULK_N 'planned' rows PLUS a handful of
    //    non-'planned' rows, so a filter that quietly matched everything would be caught.
    bulkProjectId = await createProject(`impl-status-bulk-${STAMP}`);
    await bulkSeed(bulkProjectId, BULK_N, IMPLEMENTATION_STATUS_DEFAULT, `Bulk planned ${STAMP}`);
    await bulkSeed(bulkProjectId, 4, 'implemented', `Bulk implemented ${STAMP}`);

    // ── PROJECT 3: EXACTLY_N members, for the hasMore boundary pair.
    boundaryProjectId = await createProject(`impl-status-boundary-${STAMP}`);
    await bulkSeed(boundaryProjectId, EXACTLY_N, IMPLEMENTATION_STATUS_DEFAULT, `Boundary ${STAMP}`);

    // ── PROJECT 4: every row on the SAME decision_date — the tie population C7 needs.
    tiedProjectId = await createProject(`impl-status-tied-${STAMP}`);
    await bulkSeedTied(tiedProjectId, TIED_N, `Tied ${STAMP}`);
  }, 120_000);

  afterAll(async () => {
    for (const p of [mixedProjectId, bulkProjectId, boundaryProjectId, tiedProjectId]) {
      if (!p) continue;
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [p]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── A. THE FILTER ──────────────────────────────────────────────────────────────

  test('A1: implementationStatus returns exactly the matching SET, for EVERY vocabulary value', async () => {
    for (const value of VOCAB) {
      const { ids, data } = await search({
        projectId: mixedProjectId,
        implementationStatus: value,
        limit: 100,
      });
      const expected = [...mixedIds.entries()].filter(([, v]) => v === value).map(([id]) => id);
      // THE SET, not the count: a filter that returned the right NUMBER of the wrong rows
      // passes a count assertion and fails this one.
      expect(new Set(ids), `implementationStatus:'${value}' returned the wrong set`).toEqual(
        new Set(expected)
      );
      // And every returned row genuinely carries that value on the wire.
      for (const row of data.results) expect(row.implementationStatus).toBe(value);
    }
  });

  test('A2: the tool count matches a DIRECT DB count, for every value INCLUDING the empty ones', async () => {
    // The empty/zero population is the value that slips through: a filter accidentally
    // ignored yields "everything" for a real value and is only unmasked by a value with
    // ZERO members. The bulk project has zero rows for three of the five values.
    for (const projectId of [mixedProjectId, bulkProjectId, boundaryProjectId]) {
      for (const value of VOCAB) {
        const expected = await dbCount(projectId, value);
        const { data } = await search({ projectId, implementationStatus: value, limit: 100 });
        expect(
          data.total,
          `total for implementationStatus:'${value}' disagreed with the DB`
        ).toBe(expected);
        if (expected === 0) {
          expect(data.results).toEqual([]);
          expect(data.hasMore).toBe(false);
        }
      }
    }
  });

  test('A3: the filter does NOT widen — a filtered total is strictly less than the unfiltered total', async () => {
    const all = await search({ projectId: bulkProjectId, limit: 100 });
    const planned = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 100,
    });
    expect(all.data.total).toBe(await dbCount(bulkProjectId));
    expect(planned.data.total).toBe(BULK_N);
    expect(planned.data.total).toBeLessThan(all.data.total);
  });

  // ── B. THE STATS BREAKDOWN ────────────────────────────────────────────────────

  test('B1: decision_stats carries an implementation_status breakdown that SUMS to the total', async () => {
    for (const projectId of [mixedProjectId, bulkProjectId]) {
      const resp = await viaFlat('decision_stats', { projectId });
      expect(resp.isError, textOf(resp)).toBeFalsy();
      const data = dataOf(resp);
      const breakdown = data.by_implementation_status;
      expect(breakdown, 'decision_stats must expose by_implementation_status').toBeTruthy();
      const sum = Object.values(breakdown as Record<string, number>).reduce(
        (a, b) => a + Number(b),
        0
      );
      // The breakdown is a partition of the decision set: no value filter, nothing dropped.
      expect(sum, 'the breakdown buckets must sum to total_decisions').toBe(data.total_decisions);
      // Every bucket key must be a real vocabulary value (the '(unset)' NULL bucket is
      // legal but must not appear on rows written under the column default).
      for (const key of Object.keys(breakdown)) expect(VOCAB).toContain(key);
      // Per-bucket, the number equals a direct DB count.
      for (const [key, count] of Object.entries(breakdown as Record<string, number>)) {
        expect(Number(count)).toBe(await dbCount(projectId, key));
      }
    }
  });

  test('B2: the breakdown is on the PROSE channel too (a tool-only agent reads the text)', async () => {
    const resp = await viaFlat('decision_stats', { projectId: mixedProjectId });
    const text = textOf(resp);
    expect(text).toContain('By Implementation Status');
    // Each vocabulary value present in this project must be named in the rendered text.
    for (const value of VOCAB) expect(text).toContain(`${value}: 1`);
  });

  // ── C. REAL PAGINATION ───────────────────────────────────────────────────────

  test('C1: a >100-member class is FULLY enumerable via offset (reaches record 101+)', async () => {
    const pageSize = 50;
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    let last: any;
    // A hard page ceiling so a broken hasMore loops forever in the test rather than in prod.
    while (pages < 20) {
      const { ids, data } = await search({
        projectId: bulkProjectId,
        implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
        limit: pageSize,
        offset,
        sortDirection: 'oldest',
      });
      pages += 1;
      last = data;
      expect(data.total).toBe(BULK_N);
      expect(data.offset).toBe(offset);
      expect(data.returned).toBe(ids.length);
      seen.push(...ids);
      if (!data.hasMore) break;
      offset += ids.length;
      expect(ids.length, 'hasMore:true with an empty page would loop forever').toBeGreaterThan(0);
    }
    // THE ENUMERATION IS COMPLETE AND DISJOINT — the union of the pages is exactly the DB's
    // id set, with no duplicate. A duplicate here is the page-boundary bug an unstable sort
    // under OFFSET produces, and it is invisible to a length-only assertion.
    expect(seen.length).toBe(BULK_N);
    expect(new Set(seen).size).toBe(BULK_N);
    expect(new Set(seen)).toEqual(await dbIds(bulkProjectId, IMPLEMENTATION_STATUS_DEFAULT));
    // The last page CROSSED the old max-limit of 100 — this is the assertion that makes the
    // test meaningful. 105 rows in pages of 50 ⇒ 3 pages, the last starting at offset 100.
    expect(pages).toBe(3);
    expect(last.offset).toBe(100);
    expect(last.offset).toBeGreaterThanOrEqual(100);
    expect(last.returned).toBe(BULK_N - 100);
    expect(last.hasMore).toBe(false);
  });

  test('C2: hasMore at the EXACT boundary — total == limit is false, total == limit+1 is true', async () => {
    // total == limit → the window covers the whole class → hasMore MUST be false. An
    // off-by-one (offset + returned <= total) shows up here and nowhere else.
    const exact = await search({
      projectId: boundaryProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: EXACTLY_N,
    });
    expect(exact.data.total).toBe(EXACTLY_N);
    expect(exact.data.returned).toBe(EXACTLY_N);
    expect(exact.data.hasMore).toBe(false);

    // total == limit + 1 → exactly one row is beyond the window → hasMore MUST be true.
    const short = await search({
      projectId: boundaryProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: EXACTLY_N - 1,
    });
    expect(short.data.returned).toBe(EXACTLY_N - 1);
    expect(short.data.hasMore).toBe(true);
    // …and the final row is reachable, with hasMore back to false.
    const tail = await search({
      projectId: boundaryProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: EXACTLY_N - 1,
      offset: EXACTLY_N - 1,
    });
    expect(tail.data.returned).toBe(1);
    expect(tail.data.hasMore).toBe(false);
    expect(tail.ids[0]).not.toBe(short.ids[0]);
  });

  test('C3: an offset PAST the end reports an empty window honestly, not "no matches"', async () => {
    // The zero/absent population again: the pre-change route hardcoded `total: 0` on the
    // empty branch and told the caller to broaden a filter that in fact matched 105 rows.
    const { data, text, ids } = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 10,
      offset: BULK_N + 100,
    });
    expect(ids).toEqual([]);
    expect(data.total).toBe(BULK_N);
    expect(data.returned).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(text).toContain('No decisions in this window');
    expect(text).not.toContain('Broader search terms');
  });

  test('C7: the order is STABLE across page sizes even when every row shares a date', async () => {
    // WHY THIS FIXTURE AND NOT THE ORDINARY ONE (the honest history): the enumeration walk in
    // C1 seeds rows one day apart, which makes the sort order total by accident. An adversarial
    // probe that DELETED the `id` tiebreaker from the ORDER BY left C1 GREEN — the guard's
    // population did not contain the shape that breaks. So this test uses the pathological
    // population: TIED_N rows all on ONE decision_date.
    //
    // MEASURED on the CI Postgres before writing this: with all rows tied and no tiebreaker,
    // asking for LIMIT 50 vs LIMIT 105 returns a DIFFERENT row at all 50 of the first 50
    // positions (top-N heapsort vs a full sort — two different plans, two different tie
    // orders). That is the real defect: an enumeration whose page size changes, or a caller who
    // re-reads a page, silently duplicates rows and skips others.
    const args = {
      projectId: tiedProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      sortDirection: 'oldest' as const,
    };
    const small = await search({ ...args, limit: 50 });
    const large = await search({ ...args, limit: 100 });
    expect(small.data.total).toBe(TIED_N);
    expect(large.data.total).toBe(TIED_N);
    // A TOTAL order gives the same prefix regardless of how many rows you asked for.
    expect(
      large.ids.slice(0, small.ids.length),
      'the first page changes identity when the page size changes — the ORDER BY is not total'
    ).toEqual(small.ids);

    // …and the offset walk over the TIED population is still disjoint and complete.
    const seen: string[] = [];
    for (let offset = 0; offset < TIED_N; offset += 50) {
      const page = await search({ ...args, limit: 50, offset });
      seen.push(...page.ids);
    }
    expect(seen.length).toBe(TIED_N);
    expect(new Set(seen).size, 'a page boundary duplicated or skipped a row').toBe(TIED_N);
    expect(new Set(seen)).toEqual(await dbIds(tiedProjectId, IMPLEMENTATION_STATUS_DEFAULT));
  });

  test('C4: the response DELIVERS every pagination field its output schema declares', async () => {
    // The contract used to advertise page/offset/hasMore/returned and return only
    // total/page/limit. Naming each field explicitly is the point: this is the assertion
    // that fails if the contract goes back to over-promising.
    const { data } = await search({ projectId: bulkProjectId, limit: 10, offset: 10 });
    for (const field of ['total', 'page', 'limit', 'returned', 'offset', 'hasMore']) {
      expect(data[field], `pagination field '${field}' missing from the response`).toBeDefined();
    }
    // `page` is DERIVED from the window, not the literal 1 the route used to emit.
    expect(data.page).toBe(2);
    expect(data.offset).toBe(10);
    expect(data.limit).toBe(10);
  });

  test('C5: a PARTIAL window says so in the PROSE, and the header reports the grand total', async () => {
    const { text } = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 10,
    });
    // The header must not present a 10-row page as the whole 105-row class.
    expect(text).toContain(`Found ${BULK_N} technical decisions:`);
    expect(text).toContain('Showing 1-10');
    expect(text).toContain('more match');
    // A FULL window keeps the historical single-line header EXACTLY (the Command UI backend
    // scrapes /Found (\d+) technical decisions?:/ from this prose).
    const full = await search({ projectId: mixedProjectId, limit: 100 });
    expect(full.text).toMatch(/Found \d+ technical decisions?:/);
    expect(full.text).not.toContain('Showing 1-');
  });

  test('C6: sortDirection actually flips the order, and defaults to newest (unchanged)', async () => {
    const oldest = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 5,
      sortDirection: 'oldest',
    });
    const newest = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 5,
      sortDirection: 'newest',
    });
    const dflt = await search({
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 5,
    });
    // Default == newest: every pre-existing caller sees byte-identical ordering.
    expect(dflt.ids).toEqual(newest.ids);
    expect(oldest.ids).not.toEqual(newest.ids);
    // And the dates really are ascending / descending.
    const dates = (r: any) => r.data.results.map((x: any) => x.created_at);
    const asc = dates(oldest);
    expect([...asc].sort()).toEqual(asc);
    const desc = dates(newest);
    expect([...desc].sort().reverse()).toEqual(desc);
  });

  // ── D. THE READ MODEL ────────────────────────────────────────────────────────

  test('D1: project_insights reports HOW MANY standing decisions were never built', async () => {
    // project_insights is a COUNTS surface — it renders `N standing decision(s)`, never the
    // per-decision lines. So the field reaches it as the aggregate that count could not
    // express: 5 standing decisions all shipped and 5 never started read IDENTICALLY before
    // this. (The per-decision `impl:<status>` stamp lives on recall_thread — see D2.)
    const resp = await viaFlat('project_insights', { projectId: mixedProjectId });
    expect(resp.isError, textOf(resp)).toBeFalsy();
    const text = textOf(resp);
    // The mixed project holds one decision per vocabulary value, so the count is exactly the
    // size of the UNBUILT policy subset — derived from config, never a literal.
    const expected = UNBUILT.length;
    expect(expected).toBeGreaterThan(0);
    expect(text).toContain(`${expected} not yet implemented`);
    // BOTH CHANNELS: a dual-channel client that drops `content` must still learn it.
    expect(dataOf(resp).coverage?.openWork?.halfExecutedDecisions).toBe(expected);
  });

  test('D1b: the UNBUILT policy subset is a real subset of the single-source vocabulary', () => {
    // The policy list in currentStateConfig is a SUBSET of the vocabulary, not a second copy
    // of it. A typo there would silently under-count half-executed decisions forever, with no
    // symptom — which is the exact failure mode this whole task exists to close.
    for (const value of UNBUILT) expect(VOCAB).toContain(value);
    expect(UNBUILT.length).toBeLessThan(VOCAB.length);
    expect(UNBUILT).toContain(IMPLEMENTATION_STATUS_DEFAULT);
  });

  test('D1d: the HISTORICAL-SPLIT policy subsets are real subsets, and DISJOINT', () => {
    // an earlier task. `builtImplementationStatuses` and `abandonedImplementationStatuses` are
    // the two halves of "was the decided thing carried out?". Same subset rule as D1b — a
    // typo would silently classify shipped work as abandoned, which is precisely the
    // confusion the split exists to remove.
    const BUILT = [...CURRENT_STATE_CONFIG.builtImplementationStatuses];
    const ABANDONED = [...CURRENT_STATE_CONFIG.abandonedImplementationStatuses];
    for (const value of [...BUILT, ...ABANDONED]) expect(VOCAB).toContain(value);
    expect(BUILT.length).toBeGreaterThan(0);
    expect(ABANDONED.length).toBeGreaterThan(0);
    // Disjoint: one value cannot mean both "built" and "stopped before building".
    for (const value of BUILT) expect(ABANDONED).not.toContain(value);
    // And the DB DEFAULT is in NEITHER — an untouched column must classify as UNKNOWN, never
    // as a confident verdict. This is the assertion that keeps the honest-unknown honest.
    expect(BUILT).not.toContain(IMPLEMENTATION_STATUS_DEFAULT);
    expect(ABANDONED).not.toContain(IMPLEMENTATION_STATUS_DEFAULT);
  });

  test('D1c: an UNKNOWN implementation_status counts as UNBUILT, never as shipped', () => {
    // C3's absent population. "We do not know whether it was built" rendering as "it shipped"
    // is the direction the miss went; the projector must fail OPEN. Asserted on the
    // pure projector so a null is reachable at all (the DB column is default-'planned').
    const decision = (implementationStatus: string | null) => ({
      id: `d-${implementationStatus ?? 'null'}`,
      type: 'decision' as const,
      title: 't',
      content: null,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
      updatedAt: new Date(Date.UTC(2026, 0, 1)),
      status: CURRENT_STATE_CONFIG.standingDecisionStatuses[0],
      outcomeStatus: 'successful',
      implementationStatus,
      contextType: null,
      metadata: null,
      // Trust is COMPUTED by the product's own computeTrust rather than hand-written as a
      // Trust literal — one fewer copy of a shape this test does not own, and it keeps this
      // file clear of the trust-render marker rules that hand-assigned band/abstain need.
      trust: computeTrust({
        outcomes: [{ value: 1, source: 'decision' }],
        ageDays: 1,
        supersededDeclared: false,
        supersededSoft: false,
        contradicted: false,
      }),
    });
    const state = projectCurrentState(
      [decision(null), decision('implemented')],
      'd-null',
      CURRENT_STATE_CONFIG,
      THREAD_CONFIG,
      ARTIFACT_REF_CONFIG
    );
    expect(state.currentDecisions.total).toBe(2);
    expect(state.halfExecutedDecisions).toBe(1);
  });

  test('D2: recall_thread(altitude:current) surfaces implementation_status', async () => {
    // Anchor on one of the decisions themselves; the current-state altitude is the surface
    // whose entire job is "where does this stand", which is unanswerable without this field.
    const anchor = [...mixedIds.keys()][0];
    await viaFlat('project_switch', { project: mixedProjectId });
    const resp = await viaFlat('recall_thread', { anchor, altitude: 'current' });
    expect(resp.isError, textOf(resp)).toBeFalsy();
    const expected = mixedIds.get(anchor)!;
    const text = textOf(resp);
    const json = JSON.stringify(dataOf(resp));
    expect(text + json).toContain(expected);
    // BOTH CHANNELS, ASSERTED SEPARATELY. This was written as `prose || structured` first, and
    // an adversarial mutation probe (blanking the `impl:` stamp in currentStateLine) left the
    // suite GREEN — the structured channel silently covered for the deleted prose. An OR across
    // two channels guards NEITHER of them.
    expect(text, `recall_thread PROSE omits impl:${expected}:\n${text}`).toContain(`impl:${expected}`);
    expect(json, 'recall_thread structured channel omits implementationStatus').toContain(
      `"implementationStatus":"${expected}"`
    );
  });

  // ── E. BOTH TOOL SURFACES ────────────────────────────────────────────────────

  test('E1: both ADVERTISED schemas declare the new params, with the same derived enum', async () => {
    const entry = OP_BY_ID.get('decision_search')!;
    const flat = buildInputSchema('decision_search' as any, entry.humanDescriptions);
    const gw = buildGatewayBranchSchema('decision', 'search', 'decision_search');
    for (const param of ['implementationStatus', 'offset', 'sortDirection']) {
      expect(flat.properties[param], `flat surface is missing '${param}'`).toBeDefined();
      expect((gw.properties as any)[param], `gateway surface is missing '${param}'`).toBeDefined();
    }
    // The advertised enum on BOTH surfaces is the single-source list, in order.
    expect((flat.properties as any).implementationStatus.enum).toEqual(VOCAB);
    expect((gw.properties as any).implementationStatus.enum).toEqual(VOCAB);
    // The gateway branch is the flat keyset plus the `action` discriminator — nothing else.
    expect(new Set(Object.keys(gw.properties as any))).toEqual(
      new Set([...Object.keys(flat.properties), 'action'])
    );
  });

  test('E2: the same query through the FLAT and the GATEWAY surface gives the same answer', async () => {
    const args = {
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 10,
      offset: 100,
      sortDirection: 'oldest' as const,
    };
    const flat = await viaFlat('decision_search', args);
    const gateway = await viaGateway('decision', 'search', args);
    expect(gateway.isError, `gateway decision.search errored: ${textOf(gateway)}`).toBeFalsy();
    const f = dataOf(flat);
    const g = dataOf(gateway);
    expect(g.total).toBe(f.total);
    expect(g.returned).toBe(f.returned);
    expect(g.offset).toBe(f.offset);
    expect(g.hasMore).toBe(f.hasMore);
    expect((g.results ?? []).map((r: any) => r.id)).toEqual((f.results ?? []).map((r: any) => r.id));
    // …and it really did page past the old cap on the gateway too.
    expect(g.offset).toBe(100);
    expect(g.returned).toBe(BULK_N - 100);
  });

  test('E3: an out-of-vocabulary value is REJECTED on BOTH surfaces (strict, per-branch)', async () => {
    expect(() =>
      validateToolArguments('decision_search', { implementationStatus: NOT_IN_VOCAB })
    ).toThrow(/implementationStatus/i);
    const gw = await viaGateway('decision', 'search', {
      projectId: mixedProjectId,
      implementationStatus: NOT_IN_VOCAB,
    });
    expect(gw.isError, 'the gateway accepted an out-of-vocabulary implementationStatus').toBe(true);
  });

  test('E4: offset survives the bridge as a STRING (MCP clients serialize args as JSON)', async () => {
    const validated = validateToolArguments('decision_search', {
      projectId: bulkProjectId,
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      limit: 10,
      offset: '100',
    });
    expect(validated.offset).toBe(100);
    const resp = await routeExecutor('decision_search', validated, { connectionId: CONN });
    expect(dataOf(resp).offset).toBe(100);
    expect(dataOf(resp).returned).toBe(BULK_N - 100);
  });

  // ── F. ONE SOURCE FOR THE ENUM ───────────────────────────────────────────────

  test('F1: search, record and update advertise the SAME enum — derived, not copied', async () => {
    const enumOf = (opId: string) => {
      const entry = OP_BY_ID.get(opId)!;
      const schema = buildInputSchema(opId as any, entry.humanDescriptions);
      return (schema.properties as any).implementationStatus?.enum;
    };
    for (const opId of ['decision_search', 'decision_record', 'decision_update']) {
      expect(enumOf(opId), `${opId} does not advertise the implementationStatus enum`).toEqual(VOCAB);
    }
  });

  test('F2: the model-facing PROSE names every vocabulary value (derived, so it cannot fall behind)', () => {
    for (const opId of ['decision_search', 'decision_record', 'decision_update']) {
      const prose = OP_BY_ID.get(opId)!.humanDescriptions.implementationStatus ?? '';
      for (const value of VOCAB) {
        expect(prose, `${opId}'s implementationStatus help text omits '${value}'`).toContain(value);
      }
    }
  });

  test('F3: the LIVE Postgres CHECK constraint lists EXACTLY the vocabulary', async () => {
    // This is the assertion that makes "one source" a fact rather than five agreeing copies:
    // the DB CHECK constraint is the one copy no TypeScript refactor can reach. Read the
    // constraint DEFINITION out of pg_catalog and compare the literal set it permits to the
    // vocabulary — so a value added to decisionVocab.ts WITHOUT a migration is a RED here
    // rather than a runtime 500 for whoever tries to store it first.
    const def: string = (
      await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'technical_decisions_implementation_status_check'`
      )
    ).rows[0].def;
    const permitted = new Set([...def.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1]));
    expect(permitted, `CHECK constraint permits ${[...permitted]} — vocabulary is ${VOCAB}`).toEqual(
      new Set(VOCAB)
    );

    // …and every value really is storable end-to-end (the constraint text agreeing is not the
    // same as Postgres accepting the write).
    for (const value of VOCAB) {
      const r = await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, implementation_status)
         VALUES ($1, 'process', $2, 'd', 'r', 'medium', $3) RETURNING implementation_status`,
        [mixedProjectId, `vocab-probe ${value} ${STAMP}`, value]
      );
      expect(r.rows[0].implementation_status).toBe(value);
      await db.query('DELETE FROM technical_decisions WHERE title = $1', [
        `vocab-probe ${value} ${STAMP}`,
      ]);
    }
    // A value OUTSIDE the vocabulary is REJECTED by Postgres. The assertion is on rejection
    // rather than the message because the shared db wrapper deliberately sanitizes DB error
    // text into a [DATASTORE_ERROR] envelope (it must not leak SQL to a caller) — so the
    // constraint-name match lives in the pg_catalog read above instead.
    await expect(
      db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level, implementation_status)
         VALUES ($1, 'process', $2, 'd', 'r', 'medium', $3)`,
        [mixedProjectId, `vocab-probe-bad ${STAMP}`, NOT_IN_VOCAB]
      )
    ).rejects.toThrow();
    // …and nothing landed.
    expect(
      (await db.query('SELECT COUNT(*)::int AS c FROM technical_decisions WHERE title = $1', [
        `vocab-probe-bad ${STAMP}`,
      ])).rows[0].c
    ).toBe(0);
  });

  test('F4: the DB column DEFAULT is the vocabulary default the prose advertises', async () => {
    const r = await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, 'process', $2, 'd', 'r', 'medium') RETURNING implementation_status`,
      [mixedProjectId, `default-probe ${STAMP}`]
    );
    expect(r.rows[0].implementation_status).toBe(IMPLEMENTATION_STATUS_DEFAULT);
    await db.query('DELETE FROM technical_decisions WHERE title = $1', [`default-probe ${STAMP}`]);
  });

  // ── G. THE PAYOFF QUERY ──────────────────────────────────────────────────────

  test('G1: "every active, non-superseded decision still only planned, oldest first" — in ONE call', async () => {
    // The query nobody could ask before this task. status:'active' excludes the superseded
    // lifecycle (decision_update flips status to 'superseded' when supersededBy is set), and
    // the archived_at IS NULL default excludes soft-deleted rows.
    const { data, ids } = await search({
      projectId: bulkProjectId,
      status: 'active',
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      sortDirection: 'oldest',
      limit: 100,
    });
    expect(data.total).toBe(BULK_N);
    // The first row really is the oldest in the class, per an INDEPENDENT DB read.
    const oldestFromDb = (
      await db.query(
        `SELECT id::text AS id FROM technical_decisions
          WHERE project_id = $1 AND archived_at IS NULL AND status = 'active'
            AND implementation_status = $2
          ORDER BY decision_date ASC, id ASC LIMIT 1`,
        [bulkProjectId, IMPLEMENTATION_STATUS_DEFAULT]
      )
    ).rows[0].id;
    expect(ids[0]).toBe(oldestFromDb);
    // Every returned row satisfies BOTH predicates.
    for (const row of data.results) {
      expect(row.status).toBe('active');
      expect(row.implementationStatus).toBe(IMPLEMENTATION_STATUS_DEFAULT);
    }
    // …and the class is bigger than the page, honestly reported, and fully reachable.
    expect(data.hasMore).toBe(true);
    const tail = await search({
      projectId: bulkProjectId,
      status: 'active',
      implementationStatus: IMPLEMENTATION_STATUS_DEFAULT,
      sortDirection: 'oldest',
      limit: 100,
      offset: 100,
    });
    expect(tail.data.hasMore).toBe(false);
    expect(new Set([...ids, ...tail.ids]).size).toBe(BULK_N);
  });
});
