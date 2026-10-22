/**
 * GATEWAY task.list `stage` STRING-OR-ARRAY PARITY.
 *
 * THE BUG THIS GUARDS. `task({action:'list', stage:['draft','ready']})` on the gateway
 * surface was reported to reject with "'stage': Invalid input" while the flat `task_list`
 * tool accepted the identical filter (Punch List lane A, f8fdd7fa).
 *
 * ROOT CAUSE (measured, not assumed). `routes/gateway.ts` resolves (gateway,action)->opId
 * and calls the EXACT SAME `validateToolArguments(opId, ...)` the flat tool calls — see
 * gateway.ts:73 — so gateway and flat can never carry two independent schemas for one opId.
 * A native JS array for `stage` already parsed fine on both surfaces. What actually broke:
 * the gateway's LAZY envelope never advertises `stage`'s type for the read-only `list` action
 * (`liftCoreParams` in gatewaySurface.ts only lifts WRITE actions), so a client that types its
 * call against the advertised schema — exactly the "legitimate client behaviour"
 * gatewayParamCoercion.contract.test.ts's header documents — sends `stage` as a
 * JSON-STRINGIFIED array. `coerceValueToDeclaredType`'s ZodUnion arm was DENY-BY-DEFAULT
 * (middleware/validation.ts), unlike its sibling ZodArray arm, which already rescues a
 * stringified array — so `stage`'s `z.union([enum, enum[]])` (validation.ts:1216) never got
 * the same rescue a bare array param gets, and a stringified `stage` array failed loud
 * (identically on both surfaces, since they share the validator).
 *
 * THE FIX: `coerceValueToDeclaredType` gained a narrow ZodUnion case that rescues a
 * JSON-stringified array ONLY when one of the union's arms is actually an array — leaving a
 * genuinely ambiguous union (e.g. recall_thread's `minTrust: band | number`) untouched.
 *
 * This file locks two things:
 *   1. FUNCTIONAL — gateway task.list with stage as an array (native AND the realistic
 *      stringified-wire form) returns rows from every named stage, against real Postgres.
 *   2. SCHEMA PARITY — for EVERY stage-bearing action (list, create, update, bulk_update) the
 *      gateway resolves to the flat opId's OWN schema (not a second, driftable copy), and
 *      behaves identically to the flat tool given the same string/array/stringified-array
 *      `stage` input.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { dispatchGateway } from '../routes/gateway.js';
import { resolveGatewayAction } from '../config/gatewayResolver.js';
import { validationSchemas, validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `gw-task-stage-array-${STAMP}`;
const CONN = `gw-task-stage-array-conn-${STAMP}`;
let projectId: string;

async function makeTask(title: string, stage: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage)
     VALUES ($1, $2, 'general', 'medium', 'todo', $3) RETURNING id`,
    [projectId, title, stage],
  );
  return r.rows[0].id;
}

function stagesOf(resp: any): string[] {
  return (resp?.structuredContent?.results ?? []).map((t: any) => t.stage);
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'gateway task.list stage array parity') RETURNING id`,
    [PROJ_NAME],
  );
  projectId = p.rows[0].id;
  await dispatchGateway('project', { action: 'switch', project: projectId }, { connectionId: CONN });

  await makeTask('draft task', 'draft');
  await makeTask('ready task', 'ready');
  await makeTask('claimed task', 'claimed');
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

/* ───────────────────────── 1. functional: real rows, real Postgres ───────────────────────── */

describe('gateway task.list — stage array filter returns rows from every named stage', () => {
  test('a native JS array — stage:["draft","ready"] — returns both, excludes claimed', async () => {
    const resp = await dispatchGateway(
      'task',
      { action: 'list', projectId, stage: ['draft', 'ready'], limit: 50 },
      { connectionId: CONN },
    );
    expect(resp.isError, `unexpected error: ${JSON.stringify(resp).slice(0, 300)}`).not.toBe(true);
    expect(stagesOf(resp).sort()).toEqual(['draft', 'ready']);
  });

  test('THE REPORTED BUG — a JSON-stringified array (the realistic gateway wire form) — same result', async () => {
    const resp = await dispatchGateway(
      'task',
      { action: 'list', projectId, stage: '["draft","ready"]', limit: 50 },
      { connectionId: CONN },
    );
    expect(
      resp.isError,
      `gateway rejected a stringified stage array: ${JSON.stringify(resp).slice(0, 300)}`,
    ).not.toBe(true);
    expect(stagesOf(resp).sort()).toEqual(['draft', 'ready']);
  });

  test('a single stage value still works on the gateway (the case that never broke)', async () => {
    const resp = await dispatchGateway(
      'task',
      { action: 'list', projectId, stage: 'claimed', limit: 50 },
      { connectionId: CONN },
    );
    expect(resp.isError).not.toBe(true);
    expect(stagesOf(resp)).toEqual(['claimed']);
  });
});

/* ───────────────────────── 2. schema parity: one schema, not two ───────────────────────── */

function safe(fn: () => any): { ok: boolean; value?: any } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Unwrap a ZodEffects (task_update's `.refine()`) down to the plain ZodObject. */
function unwrapObject(schema: any): any {
  let s = schema;
  while (s?._def?.typeName === 'ZodEffects') s = s._def.schema;
  return s;
}

function stageShapeOf(opId: string): any {
  const schema = unwrapObject((validationSchemas as any)[opId]);
  return schema?.shape?.stage;
}

describe('gateway/flat SCHEMA PARITY for every stage-bearing action (list, create, update, bulk_update)', () => {
  const STAGE_ACTIONS = [
    { action: 'list', flatOpId: 'task_list', base: {} as Record<string, unknown> },
    { action: 'create', flatOpId: 'task_create', base: { title: 'parity probe create' } },
    {
      action: 'update',
      flatOpId: 'task_update',
      base: { taskId: '11111111-1111-4111-8111-111111111111' },
    },
    {
      action: 'bulk_update',
      flatOpId: 'task_bulk_update',
      base: { task_ids: ['11111111-1111-4111-8111-111111111111'] },
    },
  ];

  test('the gateway resolves every stage-bearing action to the EXACT flat opId (one schema, not two)', () => {
    for (const { action, flatOpId } of STAGE_ACTIONS) {
      const res = resolveGatewayAction('task', action);
      expect(res, `task.${action} did not resolve`).toBeTruthy();
      expect(res!.opId).toBe(flatOpId);
    }
  });

  test('the `stage` zod schema is REFERENTIALLY the same object gateway and flat both validate against', () => {
    for (const { action, flatOpId } of STAGE_ACTIONS) {
      const res = resolveGatewayAction('task', action)!;
      expect(stageShapeOf(res.opId), `task.${action} stage shape missing`).toBeTruthy();
      // Same opId -> same validationSchemas entry -> same declared `stage` field object.
      // There is no second, gateway-only schema that could drift from the flat one.
      expect(stageShapeOf(res.opId)).toBe(stageShapeOf(flatOpId));
    }
  });

  test.each(STAGE_ACTIONS)(
    'task.$action (via the gateway-resolved opId) accepts/rejects stage IDENTICALLY to the flat tool',
    ({ action, flatOpId, base }) => {
      const res = resolveGatewayAction('task', action)!;

      // A single stage value: every stage-bearing action accepts it, byte-identically.
      const scalarFlat = validateToolArguments(flatOpId, { ...base, stage: 'draft' });
      const scalarGateway = validateToolArguments(res.opId, { ...base, stage: 'draft' });
      expect(scalarGateway.stage).toBe('draft');
      expect(scalarGateway.stage).toBe(scalarFlat.stage);

      // A native array: `list` accepts it (the filter use case); the write actions reject it
      // (setting a task to two stages in one write is not a legal request) — but the gateway
      // and flat surfaces must agree, because they are the same schema.
      const nativeArray = ['draft', 'ready'];
      const flatNative = safe(() => validateToolArguments(flatOpId, { ...base, stage: nativeArray }));
      const gatewayNative = safe(() => validateToolArguments(res.opId, { ...base, stage: nativeArray }));
      expect(gatewayNative.ok, `task.${action}: gateway/flat disagreed on a native array`).toBe(flatNative.ok);

      // THE REPORTED SHAPE — a JSON-stringified array, the realistic gateway wire form.
      const stringified = JSON.stringify(nativeArray);
      const flatString = safe(() => validateToolArguments(flatOpId, { ...base, stage: stringified }));
      const gatewayString = safe(() => validateToolArguments(res.opId, { ...base, stage: stringified }));
      expect(gatewayString.ok, `task.${action}: gateway/flat disagreed on a stringified array`).toBe(
        flatString.ok,
      );

      if (action === 'list') {
        // `list` is the ONE stage-bearing action whose filter accepts multiple stages.
        expect(flatNative.ok).toBe(true);
        expect(flatString.ok).toBe(true);
        expect(gatewayNative.value.stage).toEqual(nativeArray);
        expect(gatewayString.value.stage).toEqual(nativeArray);
      } else {
        // create/update/bulk_update set ONE stage per task — an array must be refused, both
        // in its native and its stringified form, on both surfaces.
        expect(flatNative.ok).toBe(false);
        expect(flatString.ok).toBe(false);
      }
    },
  );
});
