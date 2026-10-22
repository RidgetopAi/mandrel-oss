/**
 * TRUST — READ-TIME OUTCOME INHERITANCE ALONG **IN** EDGES (SK3,  * an earlier decision).
 *
 * THE GAP THIS PINS, and it is directional. trustForRecord's outcome gather walked OUT
 * edges only. `decided_by` is stored task → decision, so the tasks that IMPLEMENTED a
 * decision point AT it — and a decision could therefore never inherit the ground-truth of
 * the work that carried it out. On prod that is the whole population: every task→decision
 * edge is `decided_by` (106 of them, and no other type). The fix walks those edges in
 * reverse at READ time.
 *
 * WHAT IS DELIBERATELY NOT HERE: any write. This suite asserts the computed signal moves
 * and asserts the stored column does NOT — outcome_status stays human-owned, because the
 * briefing's `outcome_status IS DISTINCT FROM 'failed'` filter decides SECTION MEMBERSHIP
 * off it. A derived value must never reach it (ruling 3).
 *
 * Driven through validate → routeExecutor (the path the HTTP bridge uses) against the CI
 * Postgres, with the gather called directly where a sample COUNT is the thing under test.
 * Embeddings mocked → deterministic + offline.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { trustForRecord, OUTCOME_IN_EDGE_TYPES } from '../services/trust.js';

const STAMP = Date.now();
const CONN = `trust-inedge-conn-${STAMP}`;
const PROJ_NAME = `trust-inedge-P-${STAMP}`;

let projectId: string;

const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Record a decision with NO outcome of its own, so the ONLY possible sample is inherited. */
async function recordDecision(title: string): Promise<string> {
  const resp = await viaTool('decision_record', {
    decisionType: 'architecture',
    title,
    description: 'd',
    rationale: 'r',
    impactLevel: 'medium',
  });
  const id = resp?.structuredContent?.decision?.id;
  expect(id, 'decision_record returned no id').toBeTruthy();
  return id;
}

/**
 * Create a task DECIDED BY `decisionId`, and PROVE the edge exists in the direction this
 * whole feature is about. Without this precondition the cases below could pass on an empty
 * graph — a test that asserts "no evidence" is vacuous if the evidence never got wired.
 */
async function createImplementingTask(title: string, decisionId: string): Promise<string> {
  const resp = await viaTool('task_create', {
    title,
    type: 'feature',
    tags: [`decision:${id8(decisionId)}`],
  });
  const id = resp?.structuredContent?.task?.id;
  expect(id, 'task_create returned no id').toBeTruthy();

  const edges = await db.query(
    `SELECT edge_type FROM links WHERE from_id = $1 AND to_id = $2 AND from_type = 'task'`,
    [id, decisionId],
  );
  expect(
    edges.rows.map((r: any) => r.edge_type),
    'PRECONDITION: the task must point AT the decision with an edge the reverse walk reads',
  ).toContain(OUTCOME_IN_EDGE_TYPES[0]);
  return id;
}

async function setTaskStatus(taskId: string, status: string): Promise<void> {
  await viaTool('task_update', { taskId, status });
  const row = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  expect(row.rows[0].status, `precondition: task is ${status}`).toBe(status);
}

/** The decision's own stored outcome column — the one this feature must never write. */
async function storedOutcome(decisionId: string): Promise<string | null> {
  const r = await db.query(`SELECT outcome_status FROM technical_decisions WHERE id = $1`, [decisionId]);
  return r.rows[0].outcome_status ?? null;
}

/**
 * The value a freshly recorded decision's outcome column carries — READ from the product
 * rather than restated as a literal, so this stays an "unchanged" assertion even if the
 * schema default moves. (It is `unknown` today, not null: the loop's not-yet-scored state.)
 */
let UNSCORED: string | null = null;

describe('trust IN-edge outcome inheritance (SK3)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'sk3 in-edge inheritance') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    UNSCORED = await storedOutcome(await recordDecision(`sk3 unscored baseline ${STAMP}`));
  });

  // Auto-open means a task_create / decision_record leaves this connection standing on a
  // branch, and every later write would then carry a positional membership edge. Each case
  // below states its own edge precondition; this keeps that precondition honest.
  beforeEach(async () => {
    await routeExecutor('branch_close', {}, { connectionId: CONN });
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  test('a COMPLETED implementing task becomes the decision\'s outcome evidence — the OUT walk alone finds none', async () => {
    const decisionId = await recordDecision(`sk3 decision with implementing work ${STAMP}`);
    const taskId = await createImplementingTask(`sk3 implementing task ${STAMP}`, decisionId);

    // BEFORE: the work is not done, so there is nothing to inherit — cold start, and this
    // is also the control that the sample below comes from the STATUS, not the edge.
    const before = await trustForRecord({ id: decisionId, type: 'decision' }, undefined, db);
    expect(before.outcome.samples, 'an in-flight implementing task is not evidence').toBe(0);
    expect(before.outcome.score).toBeNull();

    await setTaskStatus(taskId, 'completed');

    const after = await trustForRecord({ id: decisionId, type: 'decision' }, undefined, db);
    expect(after.outcome.samples, 'the completed implementing task is now a counted sample').toBe(1);
    expect(after.outcome.score).toBe(1);

    // The OUT walk sees nothing here — proving the reverse walk is what moved it, not some
    // other path. The decision has NO outbound outcome edges at all.
    const outbound = await db.query(
      `SELECT count(*)::int AS n FROM links WHERE from_id = $1 AND edge_type = ANY($2)`,
      [decisionId, ['informs', 'decided_by', 'learned_from']],
    );
    expect(outbound.rows[0].n, 'the decision has no OUT outcome edges — inheritance came from IN').toBe(0);

    // ZERO WRITES: the computed signal moved, the stored column did NOT — it still holds
    // the not-yet-scored value it was created with. This is the load-bearing one: the
    // briefing evicts a decision from every future boot on `outcome_status='failed'`, so a
    // derived signal reaching that column would silently delete live guidance at scale.
    expect(after.outcome.score, 'precondition: the computed signal DID move').toBe(1);
    expect(await storedOutcome(decisionId)).toBe(UNSCORED);
  });

  test('a CANCELLED implementing task contributes NO sample — not a zero (ruling 5)', async () => {
    const decisionId = await recordDecision(`sk3 decision whose work was descoped ${STAMP}`);
    const taskId = await createImplementingTask(`sk3 descoped task ${STAMP}`, decisionId);
    await setTaskStatus(taskId, 'cancelled');

    const t = await trustForRecord({ id: decisionId, type: 'decision' }, undefined, db);
    // The distinction that matters: 0 samples (no evidence → cold-start `unproven`), NOT
    // 1 sample worth 0 (which reads as a measured failure and, at minOutcomeSamples=1,
    // would flip the decision's whole outcome signal on one hygiene cancellation).
    expect(t.outcome.samples, 'a cancellation is absence of evidence').toBe(0);
    expect(t.outcome.score).toBeNull();
    expect(t.band).toBe('unproven');
    expect(t.abstain, 'a descoped task must not make live guidance abstain').toBe(false);
  });

  test('mixed evidence: a cancellation alongside a completion does not dilute the mean', async () => {
    const decisionId = await recordDecision(`sk3 decision with mixed implementing work ${STAMP}`);
    const done = await createImplementingTask(`sk3 mixed done ${STAMP}`, decisionId);
    const dropped = await createImplementingTask(`sk3 mixed dropped ${STAMP}`, decisionId);
    await setTaskStatus(done, 'completed');
    await setTaskStatus(dropped, 'cancelled');

    const t = await trustForRecord({ id: decisionId, type: 'decision' }, undefined, db);
    expect(t.outcome.samples, 'one counted sample, not two').toBe(1);
    expect(t.outcome.score, 'the mean is 1.0, not 0.5').toBe(1);
  });

  test('the inherited signal reaches the real recall surface (decision_search), still with no write', async () => {
    const title = `sk3 decision surfaced through search ${STAMP}`;
    const decisionId = await recordDecision(title);
    const taskId = await createImplementingTask(`sk3 surfaced task ${STAMP}`, decisionId);
    await setTaskStatus(taskId, 'completed');

    const resp = await viaTool('decision_search', { query: title });
    const row = resp.structuredContent.results.find((r: any) => r.id === decisionId);
    expect(row, 'the decision is in the search results').toBeTruthy();
    // The wire carries band+score only; the inherited SAMPLE is read
    // from the service. Both halves are asserted: the signal exists, and it reached the row.
    expect(row.trust.band, 'evidence + fresh → trusted, and it took no human curation').toBe('trusted');
    const t = await trustForRecord({ id: decisionId, type: 'decision' });
    expect(t.outcome.samples).toBe(1);
    expect(t.outcome.score).toBe(1);
    expect(await storedOutcome(decisionId)).toBe(UNSCORED);
  });

  test('direction discipline: a CONTEXT decided_by the decision mints no task sample', async () => {
    // Contexts carry no status, so they are not outcome-bearing in this direction. This is
    // the population most likely to break the reverse walk: on prod, context→decision
    // `decided_by` edges outnumber task→decision ones 529 to 106, so a reverse walk that
    // resolved its from_id against anything but `tasks` would fabricate samples from all
    // of them. What holds the line is the JOIN to `tasks` (measured: deleting the query's
    // `from_type = 'task'` predicate leaves this case GREEN — that predicate is a
    // redundant narrowing, not the guarantee).
    const decisionId = await recordDecision(`sk3 decision with only context inbound ${STAMP}`);
    await viaTool('context_store', {
      content: `sk3 context grounding the decision ${STAMP}`,
      type: 'planning',
      tags: [`decision:${id8(decisionId)}`],
    });

    const inbound = await db.query(
      `SELECT count(*)::int AS n FROM links
        WHERE to_id = $1 AND from_type = 'context' AND edge_type = ANY($2)`,
      [decisionId, OUTCOME_IN_EDGE_TYPES as unknown as string[]],
    );
    expect(inbound.rows[0].n, 'PRECONDITION: the context edge exists and points AT the decision').toBeGreaterThan(0);

    const t = await trustForRecord({ id: decisionId, type: 'decision' }, undefined, db);
    expect(t.outcome.samples, 'an inbound context is not outcome evidence').toBe(0);
  });

  test('a CONTEXT does not inherit from its inbound edges — the reverse walk is decision-only', async () => {
    // The reverse walk is scoped to decisions on purpose (an earlier decision ruling 4). A
    // context with a completed task pointing at it must stay cold-start: widening the walk
    // to every record type is not what was authorised, and this pins the boundary.
    const ctxResp = await viaTool('context_store', {
      content: `sk3 context that a task points at ${STAMP}`,
      type: 'planning',
    });
    const ctxId = ctxResp.structuredContent.context.id;
    const taskResp = await viaTool('task_create', {
      title: `sk3 task pointing at a context ${STAMP}`,
      type: 'feature',
      tags: [`context:${id8(ctxId)}`],
    });
    const taskId = taskResp.structuredContent.task.id;
    await setTaskStatus(taskId, 'completed');

    const inbound = await db.query(
      `SELECT count(*)::int AS n FROM links WHERE to_id = $1 AND from_id = $2`,
      [ctxId, taskId],
    );
    expect(inbound.rows[0].n, 'PRECONDITION: the task points at the context').toBeGreaterThan(0);

    const t = await trustForRecord({ id: ctxId, type: 'context' }, undefined, db);
    expect(t.outcome.samples, 'a context inherits along OUT edges only').toBe(0);
  });
});
