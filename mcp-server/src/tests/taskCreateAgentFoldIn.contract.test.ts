/**
 * task_create AGENT FOLD-IN GATE — contract test (REALIGN step 5).
 *
 * ═══ THE RULE UNDER TEST ═══
 * An actor listed in MANDREL_AGENT_ACTORS may create a task only when it is tagged
 * `needs-operator`. Everyone else, and every deployment with the list unset, is untouched.
 * services/agentFoldInGuard.ts is the check; this file proves it is WIRED into the shipped
 * create path and does nothing it should not.
 *
 * ═══ DRIVEN THROUGH THE SHIPPED PATH ═══
 * validateToolArguments → routeExecutor, the exact sequence both bridges use. The gateway's
 * `task({action:'create'})` delegates to routeExecutor('task_create', …) as well, so one path
 * is the whole population. SQL is used only to seed the project and to READ the row count.
 *
 * ═══ THE ASSERTIONS THAT GO RED WITH THE CHECK DELETED ═══
 * Only the first one — "builder + no tag → refused" — distinguishes a wired guard from a
 * deleted one. The other three (builder + needs-operator, coordinator, env unset) PASS on a tree with
 * no guard at all; they are here to bound the blast radius, not to prove the guard exists.
 * The mutation probe for this file is therefore: delete the assertAgentMayCreateTask call in
 * tasksRoutes.handleCreate and watch the first describe go red while the rest stay green.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { DEPLOYMENT_VOCABULARY } from '../config/deploymentVocabularyConfig.js';
import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import {
  AGENT_ACTORS_ENV,
  AGENT_FOLD_IN_EXEMPT_TAG,
  readAgentActors,
} from '../config/agentActorsConfig.js';
import { AGENT_FOLD_IN_ERROR_CODE, hasFoldInExemptTag } from '../services/agentFoldInGuard.js';

const STAMP = Date.now();
const PROJ_NAME = `agent-fold-in-${STAMP}`;
const MARKER = `agent fold-in probe ${STAMP}`;
const ROSTER = 'builder,reviewer,auditor,ops-bot,researcher';
let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaPublicTool(toolName: string, rawArgs: any, context?: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, context);
}

async function create(actor: string | undefined, tags?: string[]): Promise<any> {
  return viaPublicTool(
    'task_create',
    { projectId, title: `${MARKER} ${Math.random()}`, tags },
    actor === undefined ? undefined : { actor },
  );
}

async function rowsWritten(): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [projectId]);
  return r.rows[0].n;
}

function expectAccepted(res: any): void {
  expect(res?.isError, textOf(res)).toBeFalsy();
  expect(textOf(res)).not.toContain(AGENT_FOLD_IN_ERROR_CODE);
  expect(res?.structuredContent?.task?.id ?? res?.structuredContent?.id).toBeTruthy();
}

function expectRefused(res: any): void {
  expect(res?.isError).toBe(true);
  expect(textOf(res)).toContain(`[${AGENT_FOLD_IN_ERROR_CODE}]`);
  expect(res?.transportStatus).toBe(403);
}

const priorEnv = process.env[AGENT_ACTORS_ENV];

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'agent fold-in contract') RETURNING id`,
    [PROJ_NAME],
  );
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env[AGENT_ACTORS_ENV];
  else process.env[AGENT_ACTORS_ENV] = priorEnv;
});

describe('env set — the four acceptance assertions', () => {
  test('builder + no needs-operator tag → REFUSED with the code, the rule, and NOTHING written', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    const before = await rowsWritten();
    const res = await create('builder', ['realign', 'from:builder']);
    expectRefused(res);
    const text = textOf(res);
    // The message tells the agent what to do INSTEAD — both branches of the rule.
    expect(text).toMatch(/fix it/i);
    expect(text).toContain(`return to ${DEPLOYMENT_VOCABULARY.coordinatorName}`);
    expect(text).toContain(AGENT_FOLD_IN_EXEMPT_TAG);
    expect(await rowsWritten()).toBe(before);
  });

  test('builder + needs-operator → ACCEPTED', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    expectAccepted(await create('builder', [AGENT_FOLD_IN_EXEMPT_TAG, 'from:builder']));
  });

  test('coordinator (not on the list) → ACCEPTED, no tag needed', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    expectAccepted(await create('coordinator', ['realign']));
  });

  test('no actor at all → ACCEPTED (an unattributed caller is not an agent)', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    expectAccepted(await create(undefined, ['realign']));
  });
});

describe('env unset — the tenant-neutral default', () => {
  test('builder + no tag → ACCEPTED when MANDREL_AGENT_ACTORS is unset', async () => {
    delete process.env[AGENT_ACTORS_ENV];
    expectAccepted(await create('builder', ['realign']));
  });

  test('builder + no tag → ACCEPTED when MANDREL_AGENT_ACTORS is set but EMPTY', async () => {
    process.env[AGENT_ACTORS_ENV] = ' , ,';
    expectAccepted(await create('builder', ['realign']));
  });
});

describe('spellings fold through the ONE actor normalizer and the ONE tag key', () => {
  test('roster entry `Builder ` and caller `builder` are one member', async () => {
    process.env[AGENT_ACTORS_ENV] = ' Builder , Reviewer';
    expectRefused(await create('builder', []));
  });

  test('the known `needs:<human>` colon spelling satisfies the exemption', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    expectAccepted(await create('builder', [AGENT_FOLD_IN_EXEMPT_TAG.replace('-', ':')]));
  });

  test('readAgentActors: blank → empty set; garbage entries dropped', () => {
    expect(readAgentActors(undefined).size).toBe(0);
    expect(readAgentActors('').size).toBe(0);
    expect([...readAgentActors('a, ,B')]).toEqual(['a', 'b']);
    expect(hasFoldInExemptTag(undefined)).toBe(false);
    expect(hasFoldInExemptTag([])).toBe(false);
  });
});

describe('composite actors classify by handle segment, same as classifyActor', () => {
  const COMPOSITE_ENV = 'MANDREL_ACTOR_COMPOSITE_ENABLED';
  const priorComposite = process.env[COMPOSITE_ENV];
  afterEach(() => {
    if (priorComposite === undefined) delete process.env[COMPOSITE_ENV];
    else process.env[COMPOSITE_ENV] = priorComposite;
  });
  test('principal/builder with composite ON and no needs-operator → REFUSED', async () => {
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    process.env[COMPOSITE_ENV] = 'true';
    const before = await rowsWritten();
    expectRefused(await create('operator/builder'));
    expect(await rowsWritten()).toBe(before);
  });
});

describe('blast radius — creation only', () => {
  test('builder may task_update a task and read task_list with the list set', async () => {
    delete process.env[AGENT_ACTORS_ENV];
    const created = await create('coordinator', ['realign']);
    const id = created.structuredContent?.task?.id ?? created.structuredContent?.id;
    process.env[AGENT_ACTORS_ENV] = ROSTER;
    const upd = await viaPublicTool('task_update', { projectId, taskId: id, status: 'in_progress' }, { actor: 'builder' });
    expect(upd?.isError, textOf(upd)).toBeFalsy();
    expect(textOf(upd)).not.toContain(AGENT_FOLD_IN_ERROR_CODE);
    const list = await viaPublicTool('task_list', { projectId, limit: 5 }, { actor: 'builder' });
    expect(list?.isError, textOf(list)).toBeFalsy();
  });

  test('discover explain for task create names the rule in its contract', async () => {
    const res = await viaPublicTool('mandrel_explain', { toolName: 'task_create' });
    const text = textOf(res);
    expect(text).toContain(AGENT_FOLD_IN_ERROR_CODE);
    expect(text).toContain(AGENT_FOLD_IN_EXEMPT_TAG);
  });
});
