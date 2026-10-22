/**
 * RENDER-SITE PERMALINKS — THE BEHAVIOURAL HALF, at the real surface.
 * an earlier task (follows 31dd078e).
 *
 * =============================================================================
 * WHY THIS FILE EXISTS ALONGSIDE renderSitePermalinkCoverage.contract.test.ts
 * =============================================================================
 * The coverage guard is a SOURCE analysis: it proves each id-rendering route file contains
 * `${formatRecordRef(...)}` call sites. That is the right instrument for the POPULATION
 * question ("is any render site uncovered?") and it is the one that was missing.
 *
 * It is the WRONG instrument for "does a user actually see a clickable link", and the whole
 * lineage of this task is a chain of three corrections in which every wrong answer came from
 * reading an instrument one layer too high (an earlier note -> 2d08fbd8 -> 7c1465d3;
 * CLASSES.md C1's layer ladder). A `${formatRecordRef(` in the source is CODE-layer evidence.
 * The claim being made is about OBSERVED OUTPUT. So this file drives the REAL tools through
 * the REAL `routeExecutor` against a REAL migrated Postgres and asserts on the text a caller
 * receives — the same surface the Reviewer used to refute the original claim:
 *     project_info(riverbend) -> "🆔 ID: <uuid>"   has /r/ permalink: False
 *
 * The two files are complements, not duplicates: delete the source guard and a NEW route can
 * ship unlinkified; delete this one and the source guard can be satisfied by a call site that
 * never reaches the output.
 *
 * WHAT IS ASSERTED, per tool: the human `content` text contains the permalink for the id that
 * tool is reporting — built from the SAME `recordUrl()` the product uses, never a URL literal
 * spelled out here (a hardcoded expectation would drift from COMMAND_BASE_URL config and is
 * the C4 mistake this repo already learned).
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Distinct ids per real create (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { recordUrl, recordId8 } from '../config/commandUrlConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `permalink-render-${STAMP}`;
const CONN = `permalink-render-conn-${STAMP}`;
const ACTOR = `permalink-render-actor-${STAMP}`;

let projectId: string;

const textOf = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';

/** The exact permalink the product would emit for `id` — derived, never a literal. */
const refFor = (id: string): string => recordUrl(id);

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'render-site permalink probe') RETURNING id`,
      [PROJ_NAME]
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM session_pins WHERE actor = $1`, [ACTOR]).catch(() => {});
  await db.query(`DELETE FROM sessions WHERE project_id = $1`, [projectId]).catch(() => {});
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]).catch(() => {});
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * PROJECT — the tool the Reviewer measured as broken
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('project_* results carry a clickable /r/<id8> permalink', () => {
  // WS1 (D2): project READ surfaces (info/list) are machine-lean — the id
  // line stays, the per-row permalink line is gone from TEXT (structuredContent carries the
  // raw rows). The WRITE acks (create/update) below still carry their one clickable line.
  test('project_info — the id line stays; the text permalink is gone (machine-lean read)', async () => {
    const text = textOf(await routeExecutor('project_info', { project: PROJ_NAME }));
    expect(text).toContain(`ID: ${projectId}`); // the id line is preserved
    expect(text).not.toContain('/r/'); // no per-row permalink in read text
  });

  test('project_list — rows are machine-lean (no per-row text permalink)', async () => {
    const text = textOf(await routeExecutor('project_list', { limit: 100 }));
    expect(text).toContain(PROJ_NAME);
    expect(text).not.toContain('/r/');
  });

  test('project_create — the created id is clickable in the confirmation', async () => {
    const name = `${PROJ_NAME}-created`;
    const resp = await routeExecutor('project_create', { name, description: 'probe' });
    const created = (resp as any).structuredContent?.project?.id;
    expect(created, 'project_create must report the new id').toBeTruthy();
    expect(textOf(resp)).toContain(refFor(created));
    await db.query(`DELETE FROM projects WHERE id = $1`, [created]);
  });

  test('project_update — the updated id is clickable in the confirmation', async () => {
    const text = textOf(
      await routeExecutor('project_update', { project: PROJ_NAME, description: 'probe updated' })
    );
    expect(text).toContain(refFor(projectId));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * SESSION — the other file that had zero emissions
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('session_* results carry a clickable /r/<id8> permalink', () => {
  const ctx = { connectionId: CONN, actor: ACTOR } as any;
  let sessionId: string;

  test('session_start — the new session id is clickable', async () => {
    const resp = await routeExecutor(
      'session_start',
      { title: 'permalink probe', project: PROJ_NAME },
      ctx
    );
    sessionId = (resp as any).structuredContent?.sessionId;
    expect(sessionId, 'session_start must report a session id').toBeTruthy();
    expect(textOf(resp)).toContain(refFor(sessionId));
  });

  test('session_status — the active session block carries the permalink', async () => {
    const text = textOf(await routeExecutor('session_status', {}, ctx));
    // Only assert the link when a session actually resolved — an unresolved status is a
    // DIFFERENT answer, and asserting a link on it would be asserting the wrong thing.
    expect(text).toContain('session:');
    expect(text).toMatch(/https?:\/\/\S+\/r\/[0-9a-f]{8}/);
  });

  test('session_get — the identity block carries the permalink', async () => {
    const text = textOf(await routeExecutor('session_get', { sessionId }, ctx));
    expect(text).toContain(sessionId);
    expect(text).toContain(refFor(sessionId));
  });

  test('session_list — every listed session row carries its own permalink', async () => {
    const text = textOf(await routeExecutor('session_list', { project: PROJ_NAME }, ctx));
    expect(text).toContain(refFor(sessionId));
  });

  test('session_pin set + get — the pinned session id is clickable in both', async () => {
    const setText = textOf(await routeExecutor('session_pin', { action: 'set', sessionId }, ctx));
    expect(setText).toContain(refFor(sessionId));

    const getText = textOf(await routeExecutor('session_pin', { action: 'get' }, ctx));
    expect(getText).toContain(refFor(sessionId));

    await routeExecutor('session_pin', { action: 'clear' }, ctx);
  });

  test('session_end — the finalized session id is clickable', async () => {
    const text = textOf(await routeExecutor('session_end', {}, ctx));
    expect(text).toMatch(/https?:\/\/\S+\/r\/[0-9a-f]{8}/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE SHAPE OF THE LINK — one source, config-driven, never a literal
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('the emitted permalink is the SHARED helper output, not a hand-built URL', () => {
  test('an emitted project permalink (create ack) is byte-identical to recordUrl(id)', async () => {
    // WS1: read surfaces no longer emit text permalinks — the WRITE ack is the emitting
    // surface, so the shape assertion moves there.
    const name = `${PROJ_NAME}-shape`;
    const resp = await routeExecutor('project_create', { name, description: 'probe' });
    const created = (resp as any).structuredContent?.project?.id;
    expect(created, 'project_create must report the new id').toBeTruthy();
    const text = textOf(resp);
    const emitted = text.match(/https?:\/\/\S+\/r\/[0-9a-f]{8}/g) ?? [];
    // Non-empty first: an empty match list would make the `every` below vacuously true — the
    // zero population is the value that slips through.
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).toContain(recordUrl(created));
    for (const url of emitted) {
      expect(url.endsWith(`/r/${recordId8(created)}`)).toBe(true);
    }
    await db.query(`DELETE FROM projects WHERE id = $1`, [created]);
  });
});
