/**
 * branch_current MUST NOT REFUSE A READ UNDER STRICT ANCHOR KEYING.
 *
 * MEASURED 2026-09-19 (the coordinator): with MANDREL_ANCHOR_STRICT_SESSION_KEYING=true and no
 * resolved DB session for the connection (ActiveSessionStore miss — a cold boot, or any
 * fleet restart that wipes the RAM cache), branch_current THREW ANCHOR_NO_SESSION_IDENTITY.
 * That is the wrong answer for a READ: branch_current answers "where am I standing", and
 * the honest answer under an unresolvable key is "cannot determine" (ok:true), not a thrown
 * error — a caller cannot even check its position before writing something, contradicting
 * the boot ritual that tells it to check position FIRST.
 *
 * branch_open / branch_close WRITE the position under that key, so the cross-session leak
 * strict mode exists to refuse is real for them — they keep the loud typed throw,
 * unchanged.
 *
 * Driven through the FULL public path (validate -> routeExecutor), same idiom as
 * positionPerLoop.contract.test.ts / danglingSpine.contract.test.ts. `projectId` is passed
 * explicitly in every call's args so project resolution never depends on ActiveSessionStore
 * or the interactive project slot — the ONLY variable under test is whether a DB session is
 * resolved for the connection.
 */

import { describe, test, expect, afterAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { ANCHOR_SESSION_KEY_ERROR_CODE } from '../handlers/project.js';

const STAMP = Date.now();
const ANCHOR_STRICT_ENV = 'MANDREL_ANCHOR_STRICT_SESSION_KEYING';
const savedStrictFlag = process.env[ANCHOR_STRICT_ENV];

let projectId: string;
let taskId: string;

async function viaTool(toolName: string, rawArgs: any, conn: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: conn });
}

afterEach(() => {
  if (savedStrictFlag === undefined) delete process.env[ANCHOR_STRICT_ENV];
  else process.env[ANCHOR_STRICT_ENV] = savedStrictFlag;
  ActiveSessionStore.clearAll();
});

afterAll(async () => {
  try {
    await db.query('DELETE FROM branch_positions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  } catch {
    /* best-effort fixture teardown */
  }
  await db.end();
});

describe('branch_current honesty under strict anchor keying with no resolved session', () => {
  test('fixture: a real project + spine task to open against', async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'branch-current strict-read fixture') RETURNING id`,
        [`bcsr-${STAMP}`]
      )
    ).rows[0].id;
    taskId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'bcsr spine task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
        [projectId]
      )
    ).rows[0].id;
    expect(projectId).toBeTruthy();
    expect(taskId).toBeTruthy();
  });

  test('(1) strict=true, no resolved session: branch_current answers ok:true, no throw', async () => {
    process.env[ANCHOR_STRICT_ENV] = 'true';
    const conn = `bcsr-current-${STAMP}`;
    // No project_switch, no context_store/task_create/decision_record on this connection —
    // ActiveSessionStore has NEVER seen it, which is exactly the cold-boot / post-restart
    // state the bug report measured.
    expect(ActiveSessionStore.get(conn)).toBeNull();

    const res = await viaTool('branch_current', { projectId }, conn);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.action).toBe('current');
    expect(res.structuredContent.position).toBeNull();
    // The DISTINCT "cannot determine" signal — must survive a revert that collapses this
    // back onto the plain "no branch open" shape (which carries no such field).
    expect(res.structuredContent.positionUnavailable).toBe(true);
    expect(res.content[0].text).not.toContain(ANCHOR_SESSION_KEY_ERROR_CODE);
  });

  test('(2) strict=true, no resolved session: branch_open STILL throws ANCHOR_NO_SESSION_IDENTITY', async () => {
    process.env[ANCHOR_STRICT_ENV] = 'true';
    const conn = `bcsr-open-${STAMP}`;
    expect(ActiveSessionStore.get(conn)).toBeNull();

    const res = await viaTool('branch_open', { id: taskId, projectId }, conn);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(ANCHOR_SESSION_KEY_ERROR_CODE);
    // No position was minted by the refused write.
    expect(ActiveSessionStore.get(conn)).toBeNull();
  });

  test('(3a) strict=true, no resolved session: branch_close STILL throws ANCHOR_NO_SESSION_IDENTITY, mints no position change', async () => {
    // Establish a REAL open position first, under strict=false (legacy fallback keys by
    // connection id — see composePositionKey), so the refusal below has something it could
    // wrongly delete if it did not refuse.
    delete process.env[ANCHOR_STRICT_ENV];
    const conn = `bcsr-close-${STAMP}`;
    const opened = await viaTool('branch_open', { id: taskId, projectId }, conn);
    expect(opened.isError).toBeFalsy();

    const before = await db.query(
      `SELECT spine_id FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectId, conn]
    );
    expect(before.rows.length).toBe(1);

    // Flip to strict mode. This connection was never resolved to a DB session (no
    // project_switch/context_store/task_create on it) — same cold-boot precondition as (1)
    // and (2); branch_open above ran under strict=false and left no ActiveSessionStore entry.
    process.env[ANCHOR_STRICT_ENV] = 'true';
    expect(ActiveSessionStore.get(conn)).toBeNull();

    const res = await viaTool('branch_close', { projectId }, conn);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(ANCHOR_SESSION_KEY_ERROR_CODE);

    // No position change was minted by the refused write — the row opened above is untouched,
    // proving closePositionAny was never reached.
    const after = await db.query(
      `SELECT spine_id FROM branch_positions WHERE project_id = $1 AND session_key = $2`,
      [projectId, conn]
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].spine_id).toBe(before.rows[0].spine_id);
  });

  test('(3) strict=false control: branch_current, no resolved session — legacy shared-fallback behavior, unchanged', async () => {
    delete process.env[ANCHOR_STRICT_ENV];
    const conn = `bcsr-control-${STAMP}`;
    expect(ActiveSessionStore.get(conn)).toBeNull();

    const res = await viaTool('branch_current', { projectId }, conn);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.ok).toBe(true);
    expect(res.structuredContent.position).toBeNull();
    // The strict-mode-only signal must NOT appear when the flag is off — the control's job
    // is to prove nothing else moved.
    expect(res.structuredContent.positionUnavailable).toBeUndefined();
  });
});
