/**
 * Decision Learning-Loop Contract Test (an earlier task — the MOAT acceptance test)
 *
 * Drives the REAL public tool path (zod validator → route handler → real migrated
 * Postgres, the disposable ci_* DB from the CI gate — never production) for the
 * technical-decision learning loop. decision_record/update now embed-on-write,
 * but the embedder is NOT stubbed here: in CI it falls back to the
 * deterministic mock embedding, and these searches use exact-title queries that
 * match strongly on the trgm/text signal regardless — so every DB read/write is real
 * and the learning-loop field round-trip is unaffected by the embedding addition.
 *
 * WHAT THIS PROVES:
 *
 *  THE MOAT (capture → evaluate → correct, ZERO SQL):
 *   1. decision_record accepts success_criteria (+ problem_statement,
 *      implementation_status) UP FRONT and persists them.
 *   2. decision_update sets outcome_status + outcome_notes + lessons_learned AFTER
 *      the fact, plus implementation_status.
 *   3. decision_search reads the SAME row back and every learning-loop field
 *      round-trips — the whole loop lives in one decision row, reached only through
 *      the public tools (no raw SQL on technical_decisions).
 *
 *  DEFECT A (decision_update was a no-op through the bridge):
 *   4. The exact bridge path — validateToolArguments('decision_update', ...) THEN
 *      decisionsRoutes.handleUpdate(validatedArgs) — actually mutates the row.
 *      Previously the zod schema declared `outcome`/`lessons` while the handler read
 *      outcomeStatus/outcomeNotes/lessonsLearned, so zod .parse() stripped the real
 *      params → "No update fields provided". This asserts the fix end-to-end.
 *   5. The back-compat synonyms (`outcome`/`lessons`) still map through.
 *
 *  DEFECT B (enum clarity): covered by the schema-drift guard
 *  (retrievalSchemaContract.contract.test.ts) which now asserts decision_record /
 *  decision_update advertise EXACTLY the validated param set; here we additionally
 *  prove a wrong enum is REJECTED (so a clear, surfaced enum is the only path).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-learning-loop-${STAMP}`;

// ONE CONNECTION, BOUND TO THIS FILE'S PROJECT. `decision_record` and
// `decision_search` take an explicit `projectId`; `decision_update` and `decision_get` do
// NOT, so they resolved their project from the ambient ladder — whose last rung is
// `projects[0] ORDER BY updated_at DESC`, i.e. whichever project this DATABASE touched
// most recently. Every assertion in this file is about rows in PROJ_NAME, so the
// connection says so instead of letting row ordering answer.
const CONN = `decision-learning-loop-conn-${STAMP}`;
const CTX = { connectionId: CONN };
const TITLE = `Adopt pgvector for embeddings ${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Extract the decision UUID this route prints (`ID: <uuid>`). */
function idFromRecordText(text: string): string {
  const m = text.match(/\bID:\s*([0-9a-f-]{36})/i);
  expect(m, 'record response must include the decision UUID').toBeTruthy();
  return m![1];
}

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(
  toolName: string,
  rawArgs: any,
  handler: (a: any, ctx: typeof CTX) => Promise<any>,
) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated, CTX);
}

describe('decision learning loop (capture → evaluate → correct via public tools, zero SQL)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'decision learning loop fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await bindConnectionToProject(CONN, PROJ_NAME);
  });

  afterAll(async () => {
    if (projectId) {
      // Only test scaffolding (the project) is torn down via SQL; the decision rows
      // themselves were created AND mutated AND read entirely through the tools.
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('MOAT: record(success_criteria) → update(outcome_status+lessons) → search round-trips, zero SQL', async () => {
    // --- CAPTURE: record the decision WITH success_criteria up front -----------
    const recordResp = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'database',
        title: TITLE,
        description: 'Use pgvector for semantic search instead of an external vector DB',
        rationale: 'Keeps everything in Postgres; zero extra infra; good-enough recall',
        impactLevel: 'high',
        problemStatement: 'We need semantic search but do not want to run a second datastore',
        successCriteria: 'p95 search < 200ms AND recall@10 >= 0.8 AND no new infra',
        implementationStatus: 'planned',
        projectId,
      },
      (a, c) => decisionsRoutes.handleRecord(a, c)
    );
    const recordText = textOf(recordResp);
    expect(recordText).toContain('Technical decision recorded');
    const decisionId = idFromRecordText(recordText);

    // --- EVALUATE → CORRECT: close the loop after the fact (the bridge path) ----
    // This is the EXACT path that was broken (Defect A): validate then route.
    const updateResp = await viaPublicTool(
      'decision_update',
      {
        decisionId,
        outcomeStatus: 'successful',
        outcomeNotes: 'p95 settled at 140ms; recall@10 measured 0.86 on the eval set',
        lessonsLearned: 'pgvector was sufficient; the external DB would have been premature',
        implementationStatus: 'validated',
      },
      (a, c) => decisionsRoutes.handleUpdate(a, c)
    );
    const updateText = textOf(updateResp);
    // Must NOT be the old "No update fields provided" failure, and must reflect the new outcome.
    expect(updateText).toContain('Decision updated successfully');
    expect(updateText).toContain('successful');
    expect(updateText).toContain('validated');
    expect(updateText).not.toContain('No update fields provided');

    // --- READ BACK via the public search tool: assert EVERY field round-trips --
    const searchResp = await viaPublicTool(
      'decision_search',
      { query: TITLE, projectId },
      (a, c) => decisionsRoutes.handleSearch(a, c)
    );
    const results = (searchResp as any).data?.results ?? [];
    const found = results.find((r: any) => r.id === decisionId);
    expect(found, 'the recorded decision must be findable via decision_search').toBeTruthy();

    // Capture fields (set at record time):
    expect(found.successCriteria).toBe('p95 search < 200ms AND recall@10 >= 0.8 AND no new infra');
    // Evaluate/correct fields (set at update time):
    expect(found.outcomeStatus).toBe('successful');
    expect(found.outcomeNotes).toContain('recall@10 measured 0.86');
    expect(found.lessonsLearned).toContain('pgvector was sufficient');
    expect(found.implementationStatus).toBe('validated');
  });

  test('DEFECT A: decision_update via validate→route MUTATES the row (was a no-op)', async () => {
    // Record a minimal decision through the tool, then update ONLY the outcome.
    const rec = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'tooling',
        title: `Defect-A guard ${STAMP}`,
        description: 'Minimal decision to prove decision_update mutates',
        rationale: 'guard',
        impactLevel: 'low',
        projectId,
      },
      (a, c) => decisionsRoutes.handleRecord(a, c)
    );
    const id = idFromRecordText(textOf(rec));

    // The validated args MUST still carry the learning-loop params (not stripped).
    const validated = validateToolArguments('decision_update', {
      decisionId: id,
      outcomeStatus: 'mixed',
      lessonsLearned: 'partial win',
    });
    expect((validated as any).outcomeStatus).toBe('mixed');
    expect((validated as any).lessonsLearned).toBe('partial win');

    const resp = await decisionsRoutes.handleUpdate(validated, CTX);
    expect(textOf(resp)).toContain('Decision updated successfully');
    expect(textOf(resp)).toContain('mixed');

    // Confirm via search (public read).
    const search = await viaPublicTool('decision_search', { query: `Defect-A guard ${STAMP}`, projectId }, (a, c) => decisionsRoutes.handleSearch(a, c));
    const row = ((search as any).data?.results ?? []).find((r: any) => r.id === id);
    expect(row.outcomeStatus).toBe('mixed');
    expect(row.lessonsLearned).toBe('partial win');
  });

  test('DEFECT A: back-compat synonyms (outcome/lessons) still map to the canonical params', () => {
    const validated = validateToolArguments('decision_update', {
      decisionId: '00000000-0000-0000-0000-000000000000',
      outcome: 'it worked',
      lessons: 'keep it simple',
    });
    expect((validated as any).outcomeNotes).toBe('it worked');
    expect((validated as any).lessonsLearned).toBe('keep it simple');
    // The synonym keys are consumed (not left to confuse the handler).
    expect((validated as any).outcome).toBeUndefined();
    expect((validated as any).lessons).toBeUndefined();
  });

  test('decision_update rejects an empty update (no fields) — must surface a clear error', () => {
    expect(() => validateToolArguments('decision_update', {
      decisionId: '00000000-0000-0000-0000-000000000000',
    })).toThrow(/At least one field/i);
  });

  test('DEFECT B: a wrong enum is REJECTED (clear surfaced enums are the only valid path)', () => {
    // outcome_status guard
    expect(() => validateToolArguments('decision_update', {
      decisionId: '00000000-0000-0000-0000-000000000000',
      outcomeStatus: 'totally-made-up',
    })).toThrow(/outcomeStatus/i);
    // record decisionType / impactLevel guards (the first-call-invalid pain)
    expect(() => validateToolArguments('decision_record', {
      decisionType: 'not-a-type',
      title: 't', description: 'd', rationale: 'r', impactLevel: 'high',
    })).toThrow(/decisionType/i);
    expect(() => validateToolArguments('decision_record', {
      decisionType: 'database',
      title: 't', description: 'd', rationale: 'r', impactLevel: 'enormous',
    })).toThrow(/impactLevel/i);
    // implementation_status guard
    expect(() => validateToolArguments('decision_record', {
      decisionType: 'database',
      title: 't', description: 'd', rationale: 'r', impactLevel: 'high',
      implementationStatus: 'half-done',
    })).toThrow(/implementationStatus/i);
  });
});
