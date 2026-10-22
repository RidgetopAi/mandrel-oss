/**
 * v_session_summaries WIRE TYPES — what the driver actually hands JavaScript ( * Reviewer B2).
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ─────────────────────────────────────────────────────
 * `COUNT(*)` returns **bigint**. node-pg ships no int8 parser and this repo installs none
 * (setTypeParser appears nowhere in either package), so int8 arrives in JS as a **STRING**.
 * Migration 070 rewrote four view columns from `integer` counter columns to `COUNT(*)`
 * subqueries. Uncast, that flipped their wire type integer -> bigint -> string, and:
 *
 *     sessionFormatters.calcCompletionRate:  if (session.tasks_created === 0) return 0;
 *
 * never fires on `'0'`, so a zero-task session rendered **"NaN% completion rate"** onto the
 * live bearer-authed `/api/v2/sessions/compare` surface, and the list/detail endpoints
 * shipped their counts as JSON strings against an OpenAPI schema declaring `type: 'integer'`.
 *
 * ── WHY THE EXISTING CONTRACT TEST COULD NOT SEE IT ─────────────────────────────────────
 * sessionCountRule.contract.test.ts asserts the same view — but its SELECT casts `::int`
 * ITSELF (`SELECT contexts_created::int AS contexts, ...`) and wraps the rate in `Number()`.
 * It therefore measures a query NO consumer issues: it pins the NUMBERS and is structurally
 * blind to the TYPE. A test double must enforce the same contract the real dependency does;
 * casting in your own query is a double that doesn't. That is the whole reason all 2092
 * tests stayed green over a live NaN.
 *
 * So the load-bearing property of THIS file is negative and easy to destroy:
 *
 *     ***  NOTHING BELOW MAY CAST, CONVERT, OR Number() A VIEW COLUMN.  ***
 *     ***  `SELECT *`, exactly as production issues it, or this file guards nothing.  ***
 *
 * ── MUTATION MATRIX (MEASURED, not asserted — re-run after touching this file) ──────────
 * Each test was verified to go RED on the specific damage it claims to detect, and GREEN
 * otherwise. Apply the mutated view AS THE APP ROLE, not as the postgres superuser: a
 * superuser-owned view makes information_schema return ZERO columns to the test role, and
 * every test then fails for a permissions reason that looks like a real catch. (That artifact
 * happened on the first probe run; the >= 25 column floor in test 2 is what exposed it.)
 *
 *   mutation                                          T1    T2    T3    T4
 *   ─────────────────────────────────────────────────────────────────────
 *   none (as committed)                               green green green green
 *   strip the four ::int from the view                 RED  green green  RED
 *   strip ::int AND revert calcCompletionRate          RED  green  RED   RED   ← the branch
 *                                                                              as Reviewer
 *                                                                              found it
 *   add an unclassified count column to the view      green  RED  green green
 *
 * Read the second row honestly: T3 does NOT detect the view cast alone, because the
 * Number() normalize in sessionFormatters independently prevents the NaN. T3 guards the
 * user-visible OUTCOME across both layers; T1 and T4 are what pin the view cast itself.
 * Two layers, two detectors — do not delete one believing the other covers it.
 *
 * DB target: the disposable migrated Postgres the CI gate provisions (Stage 0b). NEVER prod.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Real UUIDs (the global vitest.setup.ts mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import {
  formatSessionSummary,
  formatSessionComparison,
  type SessionSummaryData,
} from '../utils/sessionFormatters.js';

const STAMP = Date.now();

// ── THE PIN ────────────────────────────────────────────────────────────────────────────
// Written as LITERAL column names and a LITERAL expected typeof. Deliberately NOT derived
// from the catalog, from the view definition, or from any product constant: a guard that
// reads the value it is guarding widens in lockstep with it and can never report the change
//. Adding a column here, or moving one to WIRE_STRING below, is a two-file diff
// against the migration — a decision someone makes on purpose, not a drift.
const MUST_BE_JS_NUMBER = [
  'tasks_created',
  'tasks_completed',
  'contexts_created',
  'decisions_created',
] as const;

// Columns that are string-on-the-wire BY CONTRACT (bigint / numeric), each with the reason
// it is exempt. Co-located with the rule, not in a registry that drifts away from it.
const WIRE_STRING: Record<string, string> = {
  duration_minutes: 'numeric — fractional minutes; string on prod today, unchanged by 070',
  task_completion_rate: 'numeric — has decimals; OpenAPI declares type:string; unchanged by 070',
  productivity_score: 'numeric — stubbed NULL by the view, but numeric-typed',
  input_tokens: 'bigint on the BASE table (sessions.input_tokens); string long before 070',
  output_tokens: 'bigint on the BASE table',
  total_tokens: 'bigint on the BASE table',
};

// Everything else in the view: uuid / varchar / text / timestamptz / jsonb / int4 literals.
// Not type-sensitive to this defect, but enumerated so the coverage assertion below is total.
const NOT_NUMERIC = [
  'id', 'display_id', 'project_id', 'project_name', 'agent_type', 'started_at', 'ended_at',
  'status', 'title', 'description', 'session_goal', 'tags', 'lines_added', 'lines_deleted',
  'lines_net', 'files_modified_count', 'activity_count', 'ai_model', 'last_activity_at',
  'metadata',
] as const;

let projectId: string;
let emptySessionId: string;  // zero tasks — the NaN case
let busySessionId: string;   // real counts — proves the cast survives a non-zero COUNT

const TASKS_TOTAL = 4;
const TASKS_DONE = 3;
const CONTEXTS = 2;
const DECISIONS = 1;

describe('v_session_summaries wire types (Reviewer B2)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'wire types') RETURNING id`,
        [`wire-types-${STAMP}`]
      )
    ).rows[0].id;

    emptySessionId = (
      await db.query(
        `INSERT INTO sessions (project_id, agent_type, status, started_at, ended_at)
           VALUES ($1, 'mcp-server', 'ended', NOW() - INTERVAL '10 minutes', NOW())
         RETURNING id`,
        [projectId]
      )
    ).rows[0].id;

    busySessionId = (
      await db.query(
        `INSERT INTO sessions (project_id, agent_type, status, started_at, ended_at)
           VALUES ($1, 'mcp-server', 'ended', NOW() - INTERVAL '20 minutes', NOW())
         RETURNING id`,
        [projectId]
      )
    ).rows[0].id;

    for (let i = 0; i < TASKS_TOTAL; i++) {
      await db.query(
        `INSERT INTO tasks (project_id, session_id, title, status, created_by)
           VALUES ($1, $2, $3, $4, 'wire-types')`,
        [projectId, busySessionId, `wire task ${i}`, i < TASKS_DONE ? 'completed' : 'todo']
      );
    }
    for (let i = 0; i < CONTEXTS; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, session_id, context_type, content)
           VALUES ($1, $2, 'code', $3)`,
        [projectId, busySessionId, `wire ctx ${i}`]
      );
    }
    for (let i = 0; i < DECISIONS; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, session_id, decision_type, title, description, rationale, decision_date)
         VALUES ($1, $2, 'architecture', $3, 'd', 'r', NOW())`,
        [projectId, busySessionId, `wire dec ${i}`]
      );
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE session_id = ANY($1)`, [[emptySessionId, busySessionId]]);
    await db.query(`DELETE FROM contexts WHERE session_id = ANY($1)`, [[emptySessionId, busySessionId]]);
    await db.query(`DELETE FROM technical_decisions WHERE session_id = ANY($1)`, [[emptySessionId, busySessionId]]);
    await db.query(`DELETE FROM sessions WHERE id = ANY($1)`, [[emptySessionId, busySessionId]]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // TEST 1 — the mutation target. UNCAST `SELECT *`, byte for byte what
  // sessionAnalyticsController.ts:386/:464/:631 and SessionStatsService.ts:192 issue.
  // ──────────────────────────────────────────────────────────────────────────────────────
  test('every count column arrives as a JS number from an UNCAST SELECT *', async () => {
    // Zero-count AND non-zero-count: a literal `0::int` in place of the subquery would
    // satisfy the empty session alone, so the busy session is what proves the cast is on a
    // real COUNT and not on a constant.
    for (const [label, id, expected] of [
      ['zero-count session', emptySessionId, { tasks_created: 0, tasks_completed: 0, contexts_created: 0, decisions_created: 0 }],
      ['non-zero session', busySessionId, { tasks_created: TASKS_TOTAL, tasks_completed: TASKS_DONE, contexts_created: CONTEXTS, decisions_created: DECISIONS }],
    ] as const) {
      const res = await db.query(`SELECT * FROM v_session_summaries WHERE id = $1`, [id]);
      expect(res.rows, `${label}: fixture row missing`).toHaveLength(1);
      const row = res.rows[0];

      for (const col of MUST_BE_JS_NUMBER) {
        // typeof, not Number(x) === x: a string '0' passes every numeric coercion check
        // there is. The wire TYPE is the whole claim.
        expect(
          typeof row[col],
          `${label}: v_session_summaries.${col} came back as ${typeof row[col]} ` +
            `(value ${JSON.stringify(row[col])}). node-pg returns bigint/numeric as a STRING — ` +
            `migration 070 must cast this column ::int.`
        ).toBe('number');
        expect(row[col], `${label}: ${col} value`).toBe(expected[col]);
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // TEST 2 — FAIL CLOSED. Every column of the view must be accounted for by one of the three
  // lists above. A future migration adding a fifth COUNT lands in NONE of them and this goes
  // RED, forcing a deliberate classification instead of a silent string on a live surface.
  // ──────────────────────────────────────────────────────────────────────────────────────
  test('every view column is classified — an unrecognised column is RED, not a silent pass', async () => {
    const cols = (
      await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'v_session_summaries'
          ORDER BY ordinal_position`
      )
    ).rows.map((r) => r.column_name as string);

    // Probe the probe (a past incident rule 7): with an empty or missing view every set-difference
    // below is trivially empty and this test would pass while asserting nothing. Zero/empty
    // is the value that slips through a coverage check, so pin a floor first.
    expect(cols.length, 'view returned no columns — the coverage check would pass vacuously').toBeGreaterThanOrEqual(25);
    expect(MUST_BE_JS_NUMBER.length).toBe(4);
    expect(Object.keys(WIRE_STRING).length).toBeGreaterThan(0);

    const classified = new Set<string>([
      ...MUST_BE_JS_NUMBER,
      ...Object.keys(WIRE_STRING),
      ...NOT_NUMERIC,
    ]);

    const unclassified = cols.filter((c) => !classified.has(c));
    expect(
      unclassified,
      `v_session_summaries has column(s) this guard has never seen: ${unclassified.join(', ')}. ` +
        `Classify each one: a COUNT/SUM column belongs in MUST_BE_JS_NUMBER *and* needs ::int ` +
        `in migration 070; a bigint/numeric column belongs in WIRE_STRING with its reason.`
    ).toEqual([]);

    // ...and the reverse, so a column deleted from the view leaves a stale pin behind rather
    // than quietly shrinking what this file covers.
    const stale = [...classified].filter((c) => !cols.includes(c));
    expect(stale, `pinned column(s) no longer exist in the view: ${stale.join(', ')}`).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // TEST 3 — the user-visible surface. The REAL exported formatters, fed the REAL uncast
  // row. Not a re-implementation of calcCompletionRate: a guard must CALL the thing it
  // guards, or it only proves a copy of the logic works.
  // ──────────────────────────────────────────────────────────────────────────────────────
  test('the real formatters render no NaN for a zero-count session', async () => {
    const empty = (await db.query(`SELECT * FROM v_session_summaries WHERE id = $1`, [emptySessionId]))
      .rows[0] as SessionSummaryData;
    const busy = (await db.query(`SELECT * FROM v_session_summaries WHERE id = $1`, [busySessionId]))
      .rows[0] as SessionSummaryData;

    const summary = formatSessionSummary(empty, [], [], 0);
    expect(summary, 'session_summary rendered NaN').not.toContain('NaN');
    expect(summary).toContain('0 created, 0 completed (0% completion rate)');

    // /api/v2/sessions/compare — sessionAnalyticsController.ts:631 -> :656. This is the
    // string that reached a live bearer-authed endpoint as "NaN% ".
    const compare = formatSessionComparison(empty, busy);
    expect(compare, '/compare rendered NaN').not.toContain('NaN');
    expect(compare).toContain('75%'); // 3 of 4 on the busy session

    // Both directions: the zero session as session2 exercises the other calc path.
    expect(formatSessionComparison(busy, empty), '/compare (reversed) rendered NaN').not.toContain('NaN');
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // TEST 4 — the JSON the REST surface actually ships. sessionAnalyticsController returns
  // `result.rows` straight out (`:429`, `:480`), so serialization is the customer's view.
  // ──────────────────────────────────────────────────────────────────────────────────────
  test('serialized counts are JSON numbers, not quoted strings', async () => {
    const row = (await db.query(`SELECT * FROM v_session_summaries WHERE id = $1`, [busySessionId])).rows[0];
    const json = JSON.parse(JSON.stringify(row));
    for (const col of MUST_BE_JS_NUMBER) {
      expect(
        typeof json[col],
        `${col} serialized as ${JSON.stringify(json[col])} — the OpenAPI schema declares type:'integer'`
      ).toBe('number');
    }
  });
});
