/**
 * `task_update` HAS AN APPEND AFFORDANCE, AND `description` IS NO LONGER A ONE-WAY DOOR
 *.
 *
 * THE TRAP THIS CLOSES — measured 2026-08-21, twice in one session, by two actors who had
 * never spoken to each other:
 *   1. The caller reaches for `notes`. It does not exist; strict mode rejects it.
 *   2. The caller reads the schema, sees `description`, and uses it.
 *   3. `description` is a SILENT FULL REPLACE. The task's SPEC is destroyed — no warning,
 *      no diff, no undo, and the call returns ok:true.
 * One of the two destroyed a build spec that way. That is a trap, not a mistake: the
 * second actor did exactly what the first one did.
 *
 * THE ASYMMETRY THAT NAMES THE DEFECT: `task_update`'s own contract already said of
 * `metadata` — "MERGED (shallow) … omitted keys are preserved (no silent data loss)".
 * Someone had already thought about silent data loss and written a merge semantic to
 * prevent it, three lines above a field that had none.
 *
 * WHAT IS ASSERTED HERE
 *   - THE ACCEPTANCE CRITERION, stated exactly as the task states it: an update carrying
 *     ONLY a status note leaves `description` BYTE-IDENTICAL. That is also the smallest
 *     input where fixed and broken diverge — pre-fix, that call is not merely harmless,
 *     it is REJECTED, so there was no way to express it at all.
 *   - APPEND, not replace: a second note does not destroy the first. This is the assertion
 *     the "make the append a silent replace" mutation has to break.
 *   - The destructive act is now RECOVERABLE: replacing `description` preserves the text
 *     that was replaced, in the same record.
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor) — no SQL
 * shortcuts past the tool contract. Direct SQL is used only to SEED and to READ, so a
 * "description is unchanged" assertion is read from the row and not from the tool's own
 * echo of what it thinks it did.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import {
  TASK_NOTES_CONFIG,
  TASK_NOTE_LOG_KEY,
  TASK_DESCRIPTION_HISTORY_KEY,
} from '../config/taskNotes.js';

const STAMP = Date.now();
const PROJ_NAME = `task-notes-append-${STAMP}`;

/** The spec text that used to get destroyed. Long, because a long spec is the population. */
const SPEC = [
  'SPEC: the C4 build. Do NOT summarise this away.',
  'Acceptance: (1) the gate is green on the merged ref; (2) the guard is mutation-probed;',
  '(3) the count carries the command that produced it.',
].join('\n');

let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  // BIND THE FIXTURE PROJECT. Unbound, this helper fell through the project
  // ladder to Priority 4 — `projects[0]`, ORDER BY updated_at DESC — so the project under
  // test was chosen by whichever project this DATABASE touched last. It passed only while
  // the fixture happened to sort first. The binding makes the subject the test's own choice.
  return routeExecutor(toolName, validated, { projectBinding: projectId });
}

// STAGE PINNED TO 'draft' (an earlier task clause 10): a bare INSERT naming no `stage` is
// backfilled to 'ready' by the tasks_sync_stage_status trigger (migration 101, status='todo'
// -> stage='ready'). The completeness gate now keys on the MERGED row's stage, so an
// unrelated note/metadata update against a row left at 'ready' with no punch fields would be
// correctly refused — a gate concern this file's append-affordance tests are not exercising.
async function makeTask(description = SPEC): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, description, type, priority, status, stage)
     VALUES ($1, 'append-affordance fuse', $2, 'general', 'medium', 'todo', 'draft')
     RETURNING id`,
    [projectId, description],
  );
  return res.rows[0].id;
}

async function readRow(id: string): Promise<{ description: string | null; metadata: any }> {
  const res = await db.query(`SELECT description, metadata FROM tasks WHERE id = $1`, [id]);
  return res.rows[0];
}

const noteLog = (metadata: any): any[] => metadata?.[TASK_NOTE_LOG_KEY] ?? [];
const descHistory = (metadata: any): any[] => metadata?.[TASK_DESCRIPTION_HISTORY_KEY] ?? [];

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'append-affordance fuse') RETURNING id`,
      [PROJ_NAME],
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('the affordance EXISTS at the contract boundary', () => {
  test('`notes` is a declared param on task_update — not a rejected unknown', () => {
    // The literal step 1 of the measured trap. If this regresses, the caller is pushed
    // back onto `description` by the schema itself, which is how the loss happened.
    let schema: any = (validationSchemas as any).task_update;
    while (schema?._def?.typeName === 'ZodEffects') schema = schema._def.schema;
    expect(Object.keys(schema.shape)).toContain('notes');
  });

  test('a note ALONE is a legal update — the refine admits it', () => {
    // "Just record a status note" must be expressible on its own. Advertising the param and
    // then rejecting every call that uses it alone is the declared-but-unreachable defect.
    expect(() => validateToolArguments('task_update', { taskId: 'a'.repeat(32), notes: 'hi' }))
      .not.toThrow();
  });
});

describe('THE ACCEPTANCE CRITERION — a status note cannot touch the spec', () => {
  test('an update carrying ONLY a note leaves description BYTE-IDENTICAL', async () => {
    const id = await makeTask();

    // POSITIVE CONTROL: the spec is really there before we annotate. Otherwise
    // "unchanged" could be two equal nulls.
    const before = await readRow(id);
    expect(before.description).toBe(SPEC);

    await viaPublicTool('task_update', { taskId: id, notes: 'round 2 green, gate not run' });

    const after = await readRow(id);
    expect(after.description).toBe(SPEC); // byte-identical, the task's own words
    expect(noteLog(after.metadata)).toHaveLength(1);
    expect(noteLog(after.metadata)[0].note).toBe('round 2 green, gate not run');
  });

  test('a note carries WHEN and WHO, and never invents an actor', async () => {
    const id = await makeTask();
    await viaPublicTool('task_update', { taskId: id, notes: 'unattributed' });

    const entry = noteLog((await readRow(id)).metadata)[0];
    expect(typeof entry.at).toBe('string');
    expect(Number.isFinite(Date.parse(entry.at))).toBe(true);
    // `actor` is present and explicitly null rather than absent or guessed: an
    // unattributed note must SAY it is unattributed.
    expect(entry).toHaveProperty('actor');
    expect(entry.actor).toBeNull();
  });
});

describe('APPEND, not replace — the property the whole task turns on', () => {
  test('a second note does not destroy the first, and order is preserved', async () => {
    const id = await makeTask();

    await viaPublicTool('task_update', { taskId: id, notes: 'first' });
    // POSITIVE CONTROL: exactly one entry after the first write, so "two entries" below
    // is a real accumulation and not a fixture that already had two.
    expect(noteLog((await readRow(id)).metadata)).toHaveLength(1);

    await viaPublicTool('task_update', { taskId: id, notes: 'second' });

    const log = noteLog((await readRow(id)).metadata);
    expect(log.map((e: any) => e.note)).toEqual(['first', 'second']);
  });

  test('a note does not clobber sibling metadata keys, and can travel WITH a metadata merge', async () => {
    const id = await makeTask();
    await viaPublicTool('task_update', { taskId: id, metadata: { origin: 'coordinator', keep: 1 } });
    await viaPublicTool('task_update', { taskId: id, notes: 'note one' });

    // The whole column is ONE assignment composed of three writers; this is the case that
    // would have raised "multiple assignments to same column" if they were separate.
    await viaPublicTool('task_update', { taskId: id, metadata: { origin: 'builder' }, notes: 'note two' });

    const md = (await readRow(id)).metadata;
    expect(md.origin).toBe('builder');   // merged
    expect(md.keep).toBe(1);             // untouched sibling survived
    expect(noteLog(md).map((e: any) => e.note)).toEqual(['note one', 'note two']);
  });

  test('the log is bounded — the OLDEST entries fall off, never the newest', async () => {
    const id = await makeTask();
    const max = TASK_NOTES_CONFIG.maxNoteEntries;
    // Derived from config, not a hardcoded number, so the test cannot disagree with the
    // bound the product actually applies.
    for (let i = 1; i <= max + 2; i++) {
      await viaPublicTool('task_update', { taskId: id, notes: `n${i}` });
    }
    const log = noteLog((await readRow(id)).metadata);
    expect(log).toHaveLength(max);
    expect(log[log.length - 1].note).toBe(`n${max + 2}`);
    expect(log[0].note).toBe('n3'); // n1 and n2 aged out, in that order
  });
});

describe('the REPLACE is still a replace — but it is recoverable now', () => {
  test('replacing description preserves the text it replaced', async () => {
    const id = await makeTask();
    expect((await readRow(id)).description).toBe(SPEC);

    await viaPublicTool('task_update', { taskId: id, description: 'done, merged' });

    const after = await readRow(id);
    expect(after.description).toBe('done, merged'); // the replace still happens
    const history = descHistory(after.metadata);
    expect(history).toHaveLength(1);
    // The destroyed text — verbatim. This is the exact byte string that used to exist
    // nowhere afterwards.
    expect(history[0].description).toBe(SPEC);
    expect(typeof history[0].at).toBe('string');
  });

  test('the route TELLS the caller where the replaced text went, and names the alternative', async () => {
    const id = await makeTask();
    const res: any = await viaPublicTool('task_update', { taskId: id, description: 'clobbered' });
    const text = res.content?.[0]?.text ?? '';
    // The instruction delivered at the moment of need. "Description updated" alone is what
    // let a full replace read as a harmless edit.
    expect(text).toContain(TASK_DESCRIPTION_HISTORY_KEY);
    expect(text).toContain('notes=');
    expect(res.structuredContent?.task?.descriptionPreserved).toBe(true);
  });

  test('replacing a description with the IDENTICAL text records nothing', async () => {
    const id = await makeTask();
    await viaPublicTool('task_update', { taskId: id, description: SPEC });
    const md = (await readRow(id)).metadata;
    // Nothing was destroyed, so nothing is preserved — and the key is not even created.
    expect(md?.[TASK_DESCRIPTION_HISTORY_KEY]).toBeUndefined();
  });

  test('replacing an EMPTY description records nothing', async () => {
    // The zero/empty population C3 asks for: there is no prior text to lose.
    const id = await makeTask('');
    await viaPublicTool('task_update', { taskId: id, description: 'now it has one' });
    const md = (await readRow(id)).metadata;
    expect(md?.[TASK_DESCRIPTION_HISTORY_KEY]).toBeUndefined();
  });

  test('description history is bounded too', async () => {
    const id = await makeTask();
    const max = TASK_NOTES_CONFIG.maxDescriptionHistory;
    for (let i = 1; i <= max + 1; i++) {
      await viaPublicTool('task_update', { taskId: id, description: `v${i}` });
    }
    const history = descHistory((await readRow(id)).metadata);
    expect(history).toHaveLength(max);
    // The most recently destroyed text is the one you are most likely to want back.
    expect(history[history.length - 1].description).toBe(`v${max}`);
  });
});
