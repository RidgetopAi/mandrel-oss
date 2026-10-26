// GUARDS-CLASS: serializer-literal-recurs
/**
 * EVERY ROUTE THAT RETURNS A RECORD RETURNS THE SERIALIZER'S RECORD.
 *
 * ═══ THE CLASS ═══
 * an earlier change: `dueAt`/`blockedOn` were stored, mapped and echoed on write — and unreadable,
 * because task_details' structuredContent was a hand-written field-by-field literal nobody
 * extended. The same literal existed on task_list, the create/update echoes and every
 * context and decision route: N copies of "what a <type> looks like on the wire", each free
 * to forget a field. taskFieldsReadable.contract.test.ts asserted VALUES for task_details
 * alone; nothing asserted the OTHER surfaces used the same enumeration.
 *
 * ═══ THE GUARD'S POPULATION, AND WHY IT IS THE WHOLE ONE ═══
 * Not a hand list. Every op comes from OP_REGISTRY, and an op is RECORD-BEARING iff its
 * declared output schema (`outputZodSchemas[opId]`) embeds one of RECORD_OUTPUT_SCHEMAS by
 * OBJECT IDENTITY — the same `taskRecord` / `contextRecord` / `decisionRecord` instances
 * the advertised tools/list is built from. So the population is "every op whose CONTRACT
 * says it returns a task/context/decision", derived from the contract itself; an op that
 * gains such a schema joins this guard the same day. Zod wrappers (optional / nullable /
 * array / effects) are unwrapped, and an op whose schema cannot be walked is a FINDING (G0),
 * never a silent "not record-bearing" — that is the C1 third state.
 *
 * ═══ WHAT IS ASSERTED, PER OP ═══
 * G1 — the op is DRIVEN through the real public path (validate → routeExecutor) on a
 *      disposable migrated database, and the object(s) at its declared record key are
 *      objects the serializer PRODUCED (WeakSet membership, see recordSerializer.ts). A hand
 *      literal — or a `{...serializeTask(t), extra}` copy — is not a member and goes RED.
 *      MEASURED: replacing task_list's `serializeTask(task, {view:'row'})` with an equivalent
 *      hand literal turned this RED naming task_list; the unmutated control was GREEN.
 * G2 — NOTHING ELSE in the response carries the fixture record's id as a plain object that
 *      is not serializer-produced. This is the hand-literal detector for a route that puts
 *      the record somewhere other than its declared key.
 * G3 — an op in the population with no driver here FAILS, naming itself. An unresolvable
 *      input is a finding, not a skip.
 *
 * Values are asserted by the sibling guard (taskFieldsReadable: every declared write param
 * reads back off task_details AND task_list). This file asserts the SOURCE of the object;
 * that one asserts its CONTENT. Together: one enumeration, every surface, checked values.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { OP_REGISTRY } from '../config/opRegistry.js';
import { outputZodSchemas, RECORD_OUTPUT_SCHEMAS } from '../config/outputSchemas.js';
import { isSerializedRecord, type RecordKind } from '../services/serializers/recordSerializer.js';

const STAMP = Date.now();
let projectId: string;

async function viaPublicTool(op: string, rawArgs: any): Promise<any> {
  return routeExecutor(op, validateToolArguments(op, rawArgs));
}

interface RecordBearing {
  op: string;
  kind: RecordKind;
  /** structuredContent key the record(s) live under. */
  key: string;
  list: boolean;
}

/** Unwrap optional/nullable/default/effects to the schema they wrap. */
function unwrap(schema: any): any {
  let cur = schema;
  for (let i = 0; i < 12 && cur?._def; i++) {
    const next = cur._def.innerType ?? cur._def.schema;
    if (!next) break;
    cur = next;
  }
  return cur;
}

function shapeOf(schema: any): Record<string, any> | null {
  const s = unwrap(schema);
  const sh = s?._def?.shape?.() ?? (typeof s?.shape === 'object' ? s.shape : null);
  return sh ?? null;
}

/** Derive the record-bearing population from the registry + output schemas. */
function recordBearingOps(): { ops: RecordBearing[]; unresolved: string[] } {
  const ops: RecordBearing[] = [];
  const unresolved: string[] = [];
  for (const entry of OP_REGISTRY as any[]) {
    const schema = (outputZodSchemas as Record<string, any>)[entry.opId];
    if (!schema) {
      unresolved.push(`${entry.opId}: no outputZodSchema`);
      continue;
    }
    const shape = shapeOf(schema);
    if (!shape) {
      unresolved.push(`${entry.opId}: output schema shape could not be walked`);
      continue;
    }
    for (const [key, prop] of Object.entries(shape)) {
      let inner = unwrap(prop);
      let list = false;
      if (inner?._def?.typeName === 'ZodArray') {
        inner = unwrap(inner._def.type);
        list = true;
      }
      for (const [kind, recordSchema] of Object.entries(RECORD_OUTPUT_SCHEMAS)) {
        if (inner === recordSchema) ops.push({ op: entry.opId, kind: kind as RecordKind, key, list });
      }
    }
  }
  return { ops, unresolved };
}

/** Every plain object in `node` (depth-first) whose `id` equals `id`. */
function objectsWithId(node: unknown, id: string, out: object[] = []): object[] {
  if (Array.isArray(node)) {
    for (const n of node) objectsWithId(n, id, out);
  } else if (node && typeof node === 'object') {
    if ((node as any).id === id) out.push(node);
    for (const v of Object.values(node as Record<string, unknown>)) objectsWithId(v, id, out);
  }
  return out;
}

/**
 * Fixture records, one per kind, plus a second of each for the archive/restore pair (a
 * restore needs an archived subject; a delete must not remove the subject the reads use).
 */
const fx: Record<string, string> = {};

/**
 * DRIVERS — how to call each record-bearing op so it returns a known fixture record. Each
 * yields one or more { args, id } cases (a route with several exits — context_search's
 * by-id / tags-only / semantic branches — is driven once per exit, because each is its own
 * literal). `id` is the fixture record the response must carry; `null` means "the op
 * creates the record, read the id off the response".
 *
 * THIS IS NOT THE POPULATION. The population is derived above; this only says how to drive
 * a member. A member with no driver is G3's failure, by name.
 */
const DRIVERS: Record<string, () => Array<{ args: any; id: string | null }>> = {
  task_create: () => [{ args: { projectId, title: 'serializer guard create' }, id: null }],
  task_list: () => [{ args: { projectId, limit: 50 }, id: fx.task }],
  task_details: () => [{ args: { projectId, taskId: fx.task }, id: fx.task }],
  task_update: () => [{ args: { projectId, taskId: fx.task, priority: 'low' }, id: fx.task }],
  task_delete: () => [{ args: { projectId, taskId: fx.task2 }, id: fx.task2 }],
  task_restore: () => [{ args: { projectId, taskId: fx.task2 }, id: fx.task2 }],
  cancel_task: () => [{ args: { projectId, taskId: fx.task3 }, id: fx.task3 }],

  context_store: () => [
    { args: { projectId, content: 'serializer guard store subject', type: 'planning' }, id: null },
  ],
  context_search: () => [
    { args: { projectId, id: fx.context }, id: fx.context },
    { args: { projectId, tags: ['rl9-serializer-guard'] }, id: fx.context },
    { args: { projectId, query: 'serializer guard fixture subject', limit: 20 }, id: fx.context },
  ],
  context_get_recent: () => [{ args: { projectId, limit: 20 }, id: fx.context }],
  context_update: () => [{ args: { projectId, contextId: fx.context, relevanceScore: 7 }, id: fx.context }],
  context_delete: () => [{ args: { projectId, contextId: fx.context2 }, id: fx.context2 }],
  context_restore: () => [{ args: { projectId, contextId: fx.context2 }, id: fx.context2 }],

  decision_record: () => [
    {
      args: {
        projectId,
        decisionType: 'architecture',
        title: 'serializer guard record',
        description: 'd',
        rationale: 'r',
        impactLevel: 'low',
      },
      id: null,
    },
  ],
  decision_search: () => [{ args: { projectId, limit: 50 }, id: fx.decision }],
  decision_get: () => [{ args: { projectId, decisionId: fx.decision }, id: fx.decision }],
  decision_update: () => [{ args: { projectId, decisionId: fx.decision, outcomeStatus: 'successful' }, id: fx.decision }],
  decision_delete: () => [{ args: { projectId, decisionId: fx.decision2 }, id: fx.decision2 }],
  decision_restore: () => [{ args: { projectId, decisionId: fx.decision2 }, id: fx.decision2 }],
  // The decision inbox: each mutates its subject
  // to answer_status='decided'/'discussing', so each gets its OWN open fixture decision.
  decision_answer: () => [{ args: { projectId, decisionId: fx.decisionOpenAnswer, option: 'a' }, id: fx.decisionOpenAnswer }],
  decision_discuss: () => [{ args: { projectId, decisionId: fx.decisionOpenDiscuss, note: 'serializer guard' }, id: fx.decisionOpenDiscuss }],
};

/** Ops whose archive-pair ordering matters: delete before restore. Everything else is free. */
const ORDER_FIRST = ['task_delete', 'context_delete', 'decision_delete'];

describe('every record-bearing op returns serializer-produced records', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'serializer guard') RETURNING id`,
        [`serializer-guard-${STAMP}`],
      )
    ).rows[0].id;
    const created = await viaPublicTool('task_create', { projectId, title: 'serializer guard subject' });
    fx.task = created.structuredContent.task.id;
    fx.task2 = (await viaPublicTool('task_create', { projectId, title: 'archive pair' })).structuredContent.task.id;
    fx.task3 = (await viaPublicTool('task_create', { projectId, title: 'cancel subject' })).structuredContent.task.id;
    fx.context = (
      await viaPublicTool('context_store', {
        projectId,
        content: 'serializer guard fixture subject',
        type: 'planning',
        tags: ['rl9-serializer-guard'],
      })
    ).structuredContent.context.id;
    fx.context2 = (
      await viaPublicTool('context_store', { projectId, content: 'archive pair', type: 'planning' })
    ).structuredContent.context.id;
    const dec = (args: any) =>
      viaPublicTool('decision_record', {
        projectId,
        decisionType: 'architecture',
        description: 'd',
        rationale: 'r',
        impactLevel: 'low',
        ...args,
      });
    fx.decision = (await dec({ title: 'serializer guard decision' })).structuredContent.decision.id;
    fx.decision2 = (await dec({ title: 'archive pair decision' })).structuredContent.decision.id;
    const openOptions = [
      { key: 'a', label: 'Option A', pros: ['pro'], cons: ['con'] },
      { key: 'b', label: 'Option B', pros: ['pro'], cons: ['con'] },
    ];
    fx.decisionOpenAnswer = (
      await dec({ title: 'serializer guard open (answer)', answerStatus: 'open', question: 'q?', options: openOptions })
    ).structuredContent.decision.id;
    fx.decisionOpenDiscuss = (
      await dec({ title: 'serializer guard open (discuss)', answerStatus: 'open', question: 'q?', options: openOptions })
    ).structuredContent.decision.id;
  }, 180_000); // the fixtures embed through the real store path; a cold Transformers.js model is slow

  afterAll(async () => {
    for (const t of ['branch_memberships', 'links', 'tasks', 'technical_decisions', 'contexts']) {
      try {
        await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]);
      } catch {
        /* table may lack project_id on this schema; the project delete below cascades what it can */
      }
    }
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('G0: the population resolved — every registry op has a walkable output schema', () => {
    const { ops, unresolved } = recordBearingOps();
    expect(unresolved, 'an op whose schema cannot be read would fall out of the population silently').toEqual([]);
    // The naive shape of this class: someone re-declares a record inline and the identity
    // check stops matching. Pin the three kinds are all represented, and the size is not tiny.
    expect(new Set(ops.map((o) => o.kind))).toEqual(new Set(['task', 'context', 'decision']));
    expect(ops.length).toBeGreaterThanOrEqual(19);
  });

  test('G3: every record-bearing op has a driver — an undriveable member is a finding', () => {
    const { ops } = recordBearingOps();
    const undriveable = [...new Set(ops.map((o) => o.op))].filter((op) => !(op in DRIVERS));
    expect(
      undriveable,
      `record-bearing ops this guard cannot drive: ${undriveable.join(', ')}. Add a DRIVERS entry.`,
    ).toEqual([]);
  });

  test('G1+G2: the record on the wire IS the serializer output, at the declared key and nowhere else', async () => {
    const { ops } = recordBearingOps();
    const ordered = [...ops].sort((a, b) => ORDER_FIRST.indexOf(b.op) - ORDER_FIRST.indexOf(a.op));
    const failures: string[] = [];

    for (const rb of ordered) {
      for (const [i, c] of DRIVERS[rb.op]().entries()) {
        const label = `${rb.op}#${i}`;
        const resp = await viaPublicTool(rb.op, c.args);
        const sc = resp.structuredContent;
        if (!sc || sc.ok === false) {
          failures.push(`${label}: op failed — ${JSON.stringify(sc).slice(0, 200)}`);
          continue;
        }
        const at = sc[rb.key];
        const records: any[] = rb.list ? (Array.isArray(at) ? at : []) : at ? [at] : [];
        const id = c.id ?? records[0]?.id;
        const mine = records.filter((r) => r?.id === id);
        if (mine.length === 0) {
          failures.push(`${label}: fixture record ${id} not found under structuredContent.${rb.key}`);
          continue;
        }
        // G1 — the declared record objects came out of the serializer.
        for (const r of mine) {
          if (!isSerializedRecord(rb.kind, r)) {
            failures.push(
              `${label}: structuredContent.${rb.key} is a hand-built ${rb.kind} literal (not ` +
                `serialize${rb.kind[0].toUpperCase()}${rb.kind.slice(1)}'s output). Build it ` +
                `with the serializer; route extras go through its \`extras\` option — never spread.`,
            );
          }
        }
        // G2 — no OTHER copy of the record hides elsewhere in the response as a hand literal.
        for (const o of objectsWithId(sc, id)) {
          if (!isSerializedRecord(rb.kind, o)) {
            failures.push(`${label}: an object carrying id ${id} at another path is not serializer-produced`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  }, 180_000);
});
