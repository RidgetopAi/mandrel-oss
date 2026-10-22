/**
 * Decision Inbox Contract Test
 *
 * "An OPEN decision carries a question + options with pros/cons, or is refused."
 *
 * Drives the REAL public tool path (zod validator -> route handler -> real migrated
 * Postgres, mandrel_builder — never production) for decision_record/decision_update's
 * new answer_status invariant, decision_answer, decision_discuss, decision_search's
 * answerStatus filter, and the REST /api/decisions family (a real http.Server + fetch
 * against the ACTUAL Express router — no mocking of the router itself).
 *
 * WHAT THIS PROVES (mapped to the punch's DONE WHEN):
 *  1. decision_record({answerStatus:'open', ...}) malformed -> typed refusal naming the
 *     field, ROW COUNT UNCHANGED; well-formed -> succeeds and round-trips
 *     question/options/deadline through decision_get.
 *  2. decision_record without answerStatus -> answer_status='decided' (today's behaviour).
 *  3. decision_answer sets chosen/answered_at/answered_by/answer_status='decided' and folds
 *     every non-chosen option into alternatives_considered; unknown key / already-decided
 *     is refused, row UNCHANGED.
 *  4. decision_discuss sets answer_status='discussing' and appends the note; refused once
 *     decided.
 *  5. decision_search({answerStatus:'open'}) returns only open rows; REST GET
 *     /api/decisions?answerStatus=open and POST /api/decisions/:id/answer|/discuss behave
 *     identically to the tool actions.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { createDecisionsRestRouter } from '../api/decisionsRestRoutes.js';
import express from 'express';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-inbox-${STAMP}`;
const CONN = `decision-inbox-conn-${STAMP}`;
const CTX = { connectionId: CONN };

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

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

async function rowCount(): Promise<number> {
  const r = await db.query('SELECT COUNT(*)::int AS n FROM technical_decisions WHERE project_id = $1', [projectId]);
  return r.rows[0].n;
}

const wellFormedOptions = () => ([
  { key: 'postgres', label: 'Stick with Postgres', pros: ['no new infra'], cons: ['scaling ceiling'] },
  { key: 'dedicated', label: 'Dedicated vector DB', pros: ['purpose-built'], cons: ['new infra to run'] },
]);

describe('decision inbox', () => {
  let restServer: http.Server;
  let restBaseUrl: string;

  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'decision inbox fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await bindConnectionToProject(CONN, PROJ_NAME);

    // REST harness — a real Express app mounting ONLY the router under test, exercised over
    // a real http.Server + fetch (no supertest dependency in this repo; same pattern as
    // sessionRestAuth.test.ts). Auth is a separate concern (mirrors bearerAuth() at the
    // healthServer.ts mount); this proves the ROUTER's decision-inbox behaviour.
    const app = express();
    app.use('/api/decisions', createDecisionsRestRouter());
    restServer = http.createServer(app);
    await new Promise<void>((resolve) => restServer.listen(0, resolve));
    const addr = restServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    restBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => restServer.close(() => resolve()));
    if (projectId) {
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── (1) THE OPEN-DECISION INVARIANT, ON RECORD ──────────────────────────────────────────

  describe('decision_record({answerStatus:"open"})', () => {
    test('no question -> typed refusal naming `question`, NO ROW WRITTEN', async () => {
      const before = await rowCount();
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox no-question ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_OPEN_INVALID');
      expect(resp.structuredContent?.field).toBe('question');
      expect(textOf(resp)).toMatch(/question/i);
      expect(await rowCount()).toBe(before);
    });

    test('one option -> typed refusal naming `options`, NO ROW WRITTEN', async () => {
      const before = await rowCount();
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox one-option ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore?',
          options: [wellFormedOptions()[0]],
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_OPEN_INVALID');
      expect(resp.structuredContent?.field).toBe('options');
      expect(await rowCount()).toBe(before);
    });

    test('an option with empty pros -> typed refusal naming pros, NO ROW WRITTEN', async () => {
      const before = await rowCount();
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox empty-pros ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore?',
          options: [
            { key: 'a', label: 'A', pros: [], cons: ['x'] },
            { key: 'b', label: 'B', pros: ['y'], cons: ['z'] },
          ],
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_OPEN_INVALID');
      expect(resp.structuredContent?.field).toBe('options[].pros');
      expect(await rowCount()).toBe(before);
    });

    test('an option with empty cons -> typed refusal naming cons, NO ROW WRITTEN', async () => {
      const before = await rowCount();
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox empty-cons ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore?',
          options: [
            { key: 'a', label: 'A', pros: ['y'], cons: [] },
            { key: 'b', label: 'B', pros: ['y'], cons: ['z'] },
          ],
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_OPEN_INVALID');
      expect(resp.structuredContent?.field).toBe('options[].cons');
      expect(await rowCount()).toBe(before);
    });

    test('well-formed -> succeeds and round-trips question/options/deadline via decision_get', async () => {
      const deadline = new Date(Date.now() + 86_400_000).toISOString();
      const recordResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox well-formed ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore should we use for embeddings?',
          options: wellFormedOptions(),
          deadline,
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      expect(recordResp.isError).toBeFalsy();
      const id = idFromRecordText(textOf(recordResp));

      const getResp = await viaPublicTool('decision_get', { decisionId: id }, (a, c) => decisionsRoutes.handleGet(a, c));
      const d = (getResp as any).data.decision;
      expect(d.answerStatus).toBe('open');
      expect(d.question).toBe('Which datastore should we use for embeddings?');
      expect(d.options).toHaveLength(2);
      expect(d.options[0].key).toBe('postgres');
      expect(d.options[0].pros).toEqual(['no new infra']);
      expect(new Date(d.deadline).toISOString()).toBe(deadline);
    }, 30000);
  });

  // ── (2) OMITTED answerStatus -> 'decided', UNCHANGED BEHAVIOUR ──────────────────────────

  test('decision_record WITHOUT answerStatus stores answer_status=\'decided\' (unchanged behaviour)', async () => {
    const resp = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'tooling', title: `Inbox default-decided ${STAMP}`, description: 'd', rationale: 'r',
        impactLevel: 'low', projectId,
      },
      (a, c) => decisionsRoutes.handleRecord(a, c)
    );
    expect(resp.isError).toBeFalsy();
    const id = idFromRecordText(textOf(resp));
    const row = (await db.query('SELECT answer_status, question, options FROM technical_decisions WHERE id = $1', [id])).rows[0];
    expect(row.answer_status).toBe('decided');
    expect(row.question).toBeNull();
    expect(row.options).toEqual([]);
  }, 30000);

  // ── (3) decision_answer ──────────────────────────────────────────────────────────────────

  describe('decision_answer', () => {
    async function recordOpen(titleSuffix: string) {
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox answer ${titleSuffix} ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore?',
          options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      return idFromRecordText(textOf(resp));
    }

    test('valid option key -> chosen/answered_at/answered_by/answer_status=decided + alternatives_considered folds every non-chosen option', async () => {
      const id = await recordOpen('valid');
      const resp = await viaPublicTool(
        'decision_answer',
        { decisionId: id, option: 'postgres', note: 'cheapest to operate' },
        (a) => decisionsRoutes.handleAnswer(a, { ...CTX, actor: 'operator' })
      );
      expect(resp.isError).toBeFalsy();

      const row = (await db.query(
        'SELECT chosen, answered_at, answered_by, answer_status, alternatives_considered FROM technical_decisions WHERE id = $1',
        [id]
      )).rows[0];
      expect(row.chosen).toBe('postgres');
      expect(row.answered_at).not.toBeNull();
      expect(row.answered_by).toBe('operator');
      expect(row.answer_status).toBe('decided');
      const alts = typeof row.alternatives_considered === 'string' ? JSON.parse(row.alternatives_considered) : row.alternatives_considered;
      expect(alts).toHaveLength(1);
      expect(alts[0].name).toBe('Dedicated vector DB');
      expect(alts[0].pros).toEqual(['purpose-built']);
      expect(alts[0].cons).toEqual(['new infra to run']);
      expect(alts[0].reasonRejected).toBe('cheapest to operate');
    }, 30000);

    test('alternatives already on the row are PRESERVED, not overwritten — the fold APPENDS (round-2 critic T1)', async () => {
      const preExisting = [{ name: 'Legacy shelved option', pros: ['cheap'], cons: ['unsupported'], reasonRejected: 'shelved last quarter' }];
      const resp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox preserve-alts ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open',
          question: 'Which datastore?',
          options: wellFormedOptions(),
          alternativesConsidered: preExisting,
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const id = idFromRecordText(textOf(resp));

      const answerResp = await viaPublicTool(
        'decision_answer',
        { decisionId: id, option: 'postgres', note: 'cheapest to operate' },
        (a) => decisionsRoutes.handleAnswer(a, { ...CTX, actor: 'operator' })
      );
      expect(answerResp.isError).toBeFalsy();

      const row = (await db.query(
        'SELECT alternatives_considered FROM technical_decisions WHERE id = $1',
        [id]
      )).rows[0];
      const alts = typeof row.alternatives_considered === 'string' ? JSON.parse(row.alternatives_considered) : row.alternatives_considered;
      expect(alts).toHaveLength(2);
      // PRESERVED: the pre-existing alternative is still there, untouched, in place.
      expect(alts[0]).toEqual(preExisting[0]);
      // APPENDED: the non-chosen inbox option is folded in after it, not in its place.
      expect(alts[1].name).toBe('Dedicated vector DB');
      expect(alts[1].pros).toEqual(['purpose-built']);
      expect(alts[1].cons).toEqual(['new infra to run']);
      expect(alts[1].reasonRejected).toBe('cheapest to operate');
    }, 30000);

    test('unknown option key -> refused, row UNCHANGED', async () => {
      const id = await recordOpen('unknown-key');
      const resp = await viaPublicTool(
        'decision_answer',
        { decisionId: id, option: 'not-a-real-key' },
        (a) => decisionsRoutes.handleAnswer(a, CTX)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_UNKNOWN_OPTION');
      const row = (await db.query('SELECT chosen, answer_status FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.chosen).toBeNull();
      expect(row.answer_status).toBe('open');
    }, 30000);

    test('a decision already decided -> refused, row UNCHANGED', async () => {
      const id = await recordOpen('already-decided');
      await viaPublicTool('decision_answer', { decisionId: id, option: 'postgres' }, (a) => decisionsRoutes.handleAnswer(a, CTX));

      const resp = await viaPublicTool(
        'decision_answer',
        { decisionId: id, option: 'dedicated' },
        (a) => decisionsRoutes.handleAnswer(a, CTX)
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_ALREADY_DECIDED');
      const row = (await db.query('SELECT chosen FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.chosen).toBe('postgres'); // unchanged from the FIRST answer
    }, 30000);
  });

  // ── (4) decision_discuss ─────────────────────────────────────────────────────────────────

  describe('decision_discuss', () => {
    test('sets answer_status=\'discussing\' and appends the note', async () => {
      const recordResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox discuss ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open', question: 'Which datastore?', options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const id = idFromRecordText(textOf(recordResp));

      const first = await viaPublicTool('decision_discuss', { decisionId: id, note: 'need Coordinator input' }, (a) => decisionsRoutes.handleDiscuss(a, CTX));
      expect(first.isError).toBeFalsy();
      let row = (await db.query('SELECT answer_status, answer_note FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.answer_status).toBe('discussing');
      expect(row.answer_note).toBe('need Coordinator input');

      const second = await viaPublicTool('decision_discuss', { decisionId: id, note: 'still waiting' }, (a) => decisionsRoutes.handleDiscuss(a, CTX));
      expect(second.isError).toBeFalsy();
      row = (await db.query('SELECT answer_status, answer_note FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.answer_status).toBe('discussing');
      expect(row.answer_note).toBe('need Coordinator input\nstill waiting'); // APPENDED, not replaced
    }, 30000);

    test('refused once decided', async () => {
      const recordResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox discuss-after-decided ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open', question: 'Which datastore?', options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const id = idFromRecordText(textOf(recordResp));
      await viaPublicTool('decision_answer', { decisionId: id, option: 'postgres' }, (a) => decisionsRoutes.handleAnswer(a, CTX));

      const resp = await viaPublicTool('decision_discuss', { decisionId: id, note: 'too late' }, (a) => decisionsRoutes.handleDiscuss(a, CTX));
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent?.code).toBe('DECISION_ALREADY_DECIDED');
      const row = (await db.query('SELECT answer_status FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.answer_status).toBe('decided'); // unchanged
    }, 30000);
  });

  // ── (5a) decision_search({answerStatus:'open'}) returns ONLY open rows ──────────────────

  test('decision_search({answerStatus:"open"}) returns only open rows', async () => {
    const openResp = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'database', title: `Inbox search-open ${STAMP}`, description: 'd', rationale: 'r',
        impactLevel: 'medium', projectId,
        answerStatus: 'open', question: 'Which datastore?', options: wellFormedOptions(),
      },
      (a, c) => decisionsRoutes.handleRecord(a, c)
    );
    const openId = idFromRecordText(textOf(openResp));

    const decidedResp = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'database', title: `Inbox search-decided ${STAMP}`, description: 'd', rationale: 'r',
        impactLevel: 'medium', projectId,
      },
      (a, c) => decisionsRoutes.handleRecord(a, c)
    );
    const decidedId = idFromRecordText(textOf(decidedResp));

    const searchResp = await viaPublicTool(
      'decision_search',
      { answerStatus: 'open', projectId, limit: 100 },
      (a, c) => decisionsRoutes.handleSearch(a, c)
    );
    const ids: string[] = ((searchResp as any).data?.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(decidedId);
  }, 45000);

  // ── (5b) REST: GET /api/decisions?answerStatus=open, POST /:id/answer, /:id/discuss ────

  describe('REST /api/decisions (behaves identically to the tool actions)', () => {
    test('GET /api/decisions?answerStatus=open returns question+options+deadline, only open rows', async () => {
      const openResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox REST-open ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open', question: 'REST: which datastore?', options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const openId = idFromRecordText(textOf(openResp));

      const decidedResp = await viaPublicTool(
        'decision_record',
        { decisionType: 'database', title: `Inbox REST-decided ${STAMP}`, description: 'd', rationale: 'r', impactLevel: 'medium', projectId },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const decidedId = idFromRecordText(textOf(decidedResp));

      const res = await fetch(`${restBaseUrl}/api/decisions?answerStatus=open&projectId=${projectId}&limit=100`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      const ids: string[] = (body.results ?? []).map((r: any) => r.id);
      expect(ids).toContain(openId);
      expect(ids).not.toContain(decidedId);
      const openRow = (body.results ?? []).find((r: any) => r.id === openId);
      expect(openRow.question).toBe('REST: which datastore?');
      expect(openRow.options).toHaveLength(2);
    }, 45000);

    test('POST /api/decisions/:id/answer behaves identically to decision_answer', async () => {
      const recordResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox REST-answer ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open', question: 'REST: which datastore?', options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const id = idFromRecordText(textOf(recordResp));

      const res = await fetch(`${restBaseUrl}/api/decisions/${id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'operator' },
        body: JSON.stringify({ option: 'postgres', note: 'via REST' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.decision.chosen).toBe('postgres');
      expect(body.decision.answerStatus).toBe('decided');
      expect(body.decision.answeredBy).toBe('operator');

      const row = (await db.query('SELECT chosen, answered_by FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.chosen).toBe('postgres');
      expect(row.answered_by).toBe('operator');

      // Refused a second time — same code the tool action returns.
      const again = await fetch(`${restBaseUrl}/api/decisions/${id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option: 'dedicated' }),
      });
      expect(again.status).toBe(409);
      const againBody = await again.json();
      expect(againBody.ok).toBe(false);
      expect(againBody.error).toBe('DECISION_ALREADY_DECIDED');
    }, 30000);

    test('POST /api/decisions/:id/discuss behaves identically to decision_discuss', async () => {
      const recordResp = await viaPublicTool(
        'decision_record',
        {
          decisionType: 'database', title: `Inbox REST-discuss ${STAMP}`, description: 'd', rationale: 'r',
          impactLevel: 'medium', projectId,
          answerStatus: 'open', question: 'REST: which datastore?', options: wellFormedOptions(),
        },
        (a, c) => decisionsRoutes.handleRecord(a, c)
      );
      const id = idFromRecordText(textOf(recordResp));

      const res = await fetch(`${restBaseUrl}/api/decisions/${id}/discuss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'need more context' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.decision.answerStatus).toBe('discussing');

      const row = (await db.query('SELECT answer_status, answer_note FROM technical_decisions WHERE id = $1', [id])).rows[0];
      expect(row.answer_status).toBe('discussing');
      expect(row.answer_note).toBe('need more context');
    }, 30000);
  });
});
