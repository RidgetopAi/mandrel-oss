// GUARDS-CLASS: serializer-literal-recurs
/**
 * A FIELD THE TASK TOOL CAN WRITE MUST BE A FIELD THE TASK TOOL CAN READ.
 *
 * ═══ THE DEFECT THIS LOCKS SHUT ═══
 * `tasks.blocked_on` and `tasks.due_at` (migration 093) were WRITE-ONLY. task_create
 * accepted both and echoed both; task_update set both; and `task_details` returned NEITHER,
 * because its structuredContent is a hand-written field-by-field literal that nobody
 * extended when the columns landed. handlers/tasks.mapTask had mapped them correctly the
 * whole time — the omission was one layer above it, on the serializer.
 *
 * The cost was not cosmetic. The single genuinely time-boxed task in the backlog had its
 * deadline deliberately moved OFF an `expires:` tag ONTO the structured field, on the
 * correct reasoning that "a tag is not a deadline field" — and that move made the deadline
 * LESS visible, because the structured field had no reader. A deadline was visible in
 * exactly one place, project_briefing's "Waiting on a human" section, which selects
 * `WHERE blocked_on = 'human'` first; a task with a deadline and any other blocked_on was
 * unrecallable without raw SQL.
 *
 * ═══ AND THE CLASS, MADE EXECUTABLE ═══
 * `dueAt` is one instance. The same omission recurs silently for the NEXT field added to
 * the task tool, because the write path and the read path are two hand-maintained lists and
 * nothing compares them. So the first test here does not name a field: it ENUMERATES every
 * param task_create and task_update declare, sets each one through the public tool path,
 * and asserts task_details returns it.
 *
 * THE GUARD'S OWN POPULATION, stated here because a guard that does not name its scope is
 * a guard nobody can audit (CLASSES.md C3): it is exactly `Object.keys()` of the two zod
 * schemas — the same declarations validation enforces, so a param that exists only in the
 * handler is out of scope here and a param declared but unreadable cannot be. Anything in
 * that population is REQUIRED to be readable unless it appears in NOT_A_RECORD_FIELD below
 * with a written reason, and a param this file cannot supply a value for is a FAILURE
 * rather than a silent skip (an unresolvable input is a finding, not a pass).
 *
 * THE GUARD'S SURFACE BOUND: the first test asserts VALUES off `task_details` AND off the
 * matching `task_list` row (minus TASK_ROW_VIEW_OMITS, the list view's one declared
 * omission). Since an earlier task every task-returning route builds its record through ONE
 * serializer (services/serializers/taskSerializer.ts) and recordSerializer.contract.test.ts
 * asserts — over a population derived from the output-schema registry — that each of them
 * really does. So a field missing from the serializer is caught HERE by value, and a route
 * that stops using the serializer is caught THERE by identity.
 *
 * It asserts the VALUE, not the key — see the comment on the assertion itself. A presence
 * check is not enough, and that is measured rather than argued.
 *
 * Driven through the SAME public path the bridge uses (validate -> routeExecutor), on a
 * real migrated disposable ci_* database.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_LIST_SORTS } from '../config/blockedOnConfig.js';
import { TASK_ROW_VIEW_OMITS } from '../services/serializers/taskSerializer.js';

const STAMP = Date.now();
const PROJ_NAME = `taskfields-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

function shapeOf(tool: 'task_create' | 'task_update'): Record<string, any> {
  const s: any = validationSchemas[tool];
  return (s.shape ?? s._def.schema.shape) as Record<string, any>;
}

/**
 * Declared params that are NOT record fields, each with the reason it is not one. This is
 * the guard's ONLY escape hatch and it is co-located with what it excuses on purpose — a
 * central allow-list is the thing that gets appended to without anyone reading it.
 */
const NOT_A_RECORD_FIELD: Record<string, string> = {
  taskId: 'the ADDRESSING argument, not state — the record\'s own id comes back as `id`',
  projectId: 'a SCOPING argument; task_details is project-scoped already',
  notes: 'an APPEND VERB, not a column — it writes metadata.noteLog, which `metadata` returns',
  claimId: 'DELIBERATELY WITHHELD — the fencing token is a bearer capability and is redacted at the mapTask choke point; only task_claim returns it, to the caller that won it',
  force: 'an audited OVERRIDE VERB on the claim fence, not stored state',
  links: 'an EDGE-MINTING verb — the edges it creates are read by graph({action:"links"}), not off the task row',
  parentTaskId: 'an EDGE-MINTING verb — it mints a `subtask_of` edge, and there is no parent COLUMN to read back',
  punch: 'a SHALLOW-MERGE verb (migration 101) — it writes metadata.punch, which `metadata` returns',
};

/** A value for each record field, so the field is genuinely SET before we read it back. */
const VALUE_FOR: Record<string, unknown> = {
  title: 'lane C readable-fields subject',
  description: 'set so the read path has something to return',
  type: 'bug',
  priority: 'high',
  status: 'in_progress',
  // migration 101: stage is the SOURCE OF TRUTH over status, so this
  // must be the stage that DERIVES status='in_progress' above (rule b — stage wins when
  // both are set in the same call, and both create and update set stage here) or the two
  // fields would contradict each other in the same write and one of them would fail its
  // own mismatch check.
  stage: 'claimed',
  assignedTo: 'builder',
  createdBy: 'builder',
  tags: ['branch:backlog-batch-10'],
  metadata: { laneC: true },
  progress: 42,
  blockedOn: 'agent',
  dueAt: '2026-09-05T00:00:00Z',
  dependencies: [] as string[], // filled in beforeAll with a real task id
};

/**
 * The WIRE form of a value that was written — the read channel legitimately reshapes some
 * inputs, and only those. Kept to the one rule it needs (a datetime comes back normalized
 * to full ISO), because every entry added here is a place a real mismatch could be excused
 * away, which is how a value assertion decays back into a presence assertion.
 */
function expectedRead(field: string, written: unknown): unknown {
  if (field === 'dueAt' && typeof written === 'string') return new Date(written).toISOString();
  // an earlier task clause 11: `dependencies` mirrors into `metadata.punch.dependsOn` ONLY when
  // the row already carries a punch, or the call also names a punch field. This fixture's
  // `metadata` value (`{ laneC: true }`) carries no `punch` key, so the dependencies mirror
  // is deliberately suppressed here — a plain (non-punch) task gains no punch key just for
  // naming a dependency. See utils/punchMerge.ts / handlers/tasks.ts's dependsOnMirrorOnly.
  return written;
}

describe('a writable task field is a readable task field', () => {
  let depId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'lane C readable fields') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    depId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'lane C dependency', 'general', 'low', 'todo') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    VALUE_FOR.dependencies = [depId];
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('EVERY declared task write param is readable back off task_details', async () => {
    const declared = new Set([...Object.keys(shapeOf('task_create')), ...Object.keys(shapeOf('task_update'))]);

    const recordFields = [...declared].filter((p) => !(p in NOT_A_RECORD_FIELD));

    // AN INPUT THIS GUARD CANNOT DRIVE IS A FINDING, NEVER A SKIP. If someone adds a param
    // and neither classifies it as a verb nor gives it a value here, this fails and names
    // it — which is the whole point: the next field must not be able to slip past silently.
    const undriveable = recordFields.filter((p) => !(p in VALUE_FOR));
    expect(
      undriveable,
      `task write params this guard can neither classify nor set: ${undriveable.join(', ')}. ` +
        `Give each a value in VALUE_FOR, or an entry in NOT_A_RECORD_FIELD with the reason ` +
        `it is not a readable field.`,
    ).toEqual([]);

    // Some fields are create-only (createdBy, dependencies), some update-only (progress).
    // Set each through whichever path declares it, so every one is genuinely populated.
    const createShape = shapeOf('task_create');
    const updateShape = shapeOf('task_update');
    const createArgs: any = { projectId };
    const updateArgs: any = { projectId };
    for (const f of recordFields) {
      if (f in createShape) createArgs[f] = VALUE_FOR[f];
      else if (f in updateShape) updateArgs[f] = VALUE_FOR[f];
    }

    const created = await viaPublicTool('task_create', createArgs);
    const taskId = created.structuredContent.task.id;
    expect(taskId).toBeTruthy();

    if (Object.keys(updateArgs).length > 1) {
      const updated = await viaPublicTool('task_update', { ...updateArgs, taskId });
      expect(JSON.stringify(updated.structuredContent)).not.toMatch(/"ok":false/);
    }

    const details = await viaPublicTool('task_details', { taskId, projectId });
    expect(details.structuredContent.found).toBe(true);
    const readBack = details.structuredContent.task;

    // ASSERT THE VALUE, NOT THE KEY. A presence check passes on a serializer that emits
    // `newField: null` for a field that was set — and for the NEXT field, which by
    // definition has no bespoke test of its own, that is a false green and the exact
    // failure this guard exists to catch. MEASURED: replacing the two conditional spreads
    // in handleDetails with a hardcoded `blockedOn: null, dueAt: null` left the key-presence
    // version of this assertion GREEN. Comparing against the value that was written is the
    // whole difference, and the set-values map is already right here.
    const mismatches = recordFields
      .map((f) => ({ field: f, expected: expectedRead(f, VALUE_FOR[f]), actual: readBack[f] }))
      .filter((m) => JSON.stringify(m.actual) !== JSON.stringify(m.expected));
    expect(
      mismatches,
      `task_details did not return the value that was WRITTEN for: ` +
        `${mismatches.map((m) => `${m.field} (wrote ${JSON.stringify(m.expected)}, read ` +
          `${JSON.stringify(m.actual)})`).join('; ')}. ` +
        `A field the task tool can write and cannot read back is unrecallable except by SQL — ` +
        `add it to the structuredContent in routes/tasks.routes.ts handleDetails. ` +
        'An undefined here means the key is absent entirely; a null means the serializer ' +
        'emits a placeholder instead of the stored value, which reads as an answer and is not one.',
    ).toEqual([]);

    // THE LIST TOO. The row view is the same serializer minus the fields it
    // DECLARES it omits; every other written value must ride the board row unchanged.
    const listed = await viaPublicTool('task_list', { projectId, limit: 100 });
    const row = listed.structuredContent.results.find((r: any) => r.id === taskId);
    expect(row, 'the subject task is missing from its own project\'s task_list').toBeDefined();
    const rowMismatches = recordFields
      .filter((f) => !(TASK_ROW_VIEW_OMITS as readonly string[]).includes(f))
      .map((f) => ({ field: f, expected: expectedRead(f, VALUE_FOR[f]), actual: row[f] }))
      .filter((m) => JSON.stringify(m.actual) !== JSON.stringify(m.expected));
    expect(
      rowMismatches,
      `task_list's row did not return the value that was WRITTEN for: ` +
        rowMismatches.map((m) => `${m.field} (wrote ${JSON.stringify(m.expected)}, read ${JSON.stringify(m.actual)})`).join('; '),
    ).toEqual([]);
  });

  test('task_details returns the DEADLINE and the blocked-on party, in both channels', async () => {
    const created = await viaPublicTool('task_create', {
      projectId,
      title: 'lane C deadline subject',
      blockedOn: 'external',
      dueAt: '2026-09-05T00:00:00Z',
    });
    const taskId = created.structuredContent.task.id;

    const details = await viaPublicTool('task_details', { taskId, projectId });
    expect(details.structuredContent.task.dueAt).toBe('2026-09-05T00:00:00.000Z');
    expect(details.structuredContent.task.blockedOn).toBe('external');
    // The HUMAN channel too. A machine-only fix leaves the deadline invisible to the reader
    // who is actually looking at the task.
    expect(details.content[0].text).toContain('Due: 2026-09-05T00:00:00.000Z');
    expect(details.content[0].text).toContain('Blocked on: external');
  });

  test('a task with NO deadline reports null, not a fabricated one', async () => {
    const created = await viaPublicTool('task_create', { projectId, title: 'lane C undated subject' });
    const taskId = created.structuredContent.task.id;
    const details = await viaPublicTool('task_details', { taskId, projectId });
    // Present-and-null: the column exists on this database, and nothing is recorded in it.
    expect(details.structuredContent.task).toHaveProperty('dueAt');
    expect(details.structuredContent.task.dueAt).toBeNull();
    expect(details.content[0].text).not.toContain('Due:');
  });
});

describe('"what is due in the next N days" is answerable through task_list', () => {
  let soonId: string;
  let laterId: string;
  let undatedId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'lane C due filter') RETURNING id`,
        [`taskfields-list-${STAMP}`],
      )
    ).rows[0].id;
    const mk = async (title: string, due: string | null, blockedOn: string | null) =>
      (
        await db.query(
          `INSERT INTO tasks (project_id, title, type, priority, status, due_at, blocked_on)
           VALUES ($1, $2, 'general', 'low', 'todo', $3, $4) RETURNING id`,
          [projectId, title, due, blockedOn],
        )
      ).rows[0].id;
    // DELIBERATELY blocked_on='agent', not 'human': the only pre-existing reader of a
    // deadline required blocked_on='human', so a fixture that used 'human' would pass
    // against the very precondition this work removes.
    soonId = await mk('due soon', '2026-09-01T00:00:00Z', 'agent');
    laterId = await mk('due later', '2026-12-01T00:00:00Z', 'agent');
    undatedId = await mk('no deadline at all', null, null);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('dueBefore selects the tasks due by then and EXCLUDES undated ones', async () => {
    const res = await viaPublicTool('task_list', { projectId, dueBefore: '2026-09-05T00:00:00Z', limit: 50 });
    const ids = res.structuredContent.results.map((r: any) => r.id);
    expect(ids).toContain(soonId);
    expect(ids).not.toContain(laterId);
    // The population most likely to break the claim: a task with NO deadline. "Not due
    // before X" and "has no deadline" are different answers and this asserts the difference.
    expect(ids).not.toContain(undatedId);
    // The grand total is filtered by the SAME options object, so it cannot disagree with
    // the rows — a count over an unfiltered population is the confidently-wrong board.
    expect(res.structuredContent.total).toBe(1);
  });

  test('sort:dueAt orders soonest first and puts undated tasks LAST', async () => {
    const res = await viaPublicTool('task_list', { projectId, sort: 'dueAt', limit: 50 });
    const ids = res.structuredContent.results.map((r: any) => r.id);
    expect(ids.indexOf(soonId)).toBeLessThan(ids.indexOf(laterId));
    expect(ids.indexOf(laterId)).toBeLessThan(ids.indexOf(undatedId));
  });

  test('the deadline rides the LIST, so a board capture carries it', async () => {
    const res = await viaPublicTool('task_list', { projectId, sort: 'dueAt', limit: 50 });
    const soon = res.structuredContent.results.find((r: any) => r.id === soonId);
    expect(soon.dueAt).toBe('2026-09-01T00:00:00.000Z');
    expect(soon.blockedOn).toBe('agent');
    expect(res.content[0].text).toContain('Due: 2026-09-01T00:00:00.000Z');
  });

  test('the advertised sort vocabulary and the accepted one are one declaration', async () => {
    const s: any = validationSchemas.task_list;
    const shape = (s.shape ?? s._def.schema.shape) as Record<string, any>;
    let node: any = shape.sort;
    for (let i = 0; i < 8 && node?._def && !Array.isArray(node._def.values); i++) {
      node = node._def.innerType ?? node._def.schema ?? node._def.type;
    }
    expect(node._def.values).toEqual([...TASK_LIST_SORTS]);
  });
});

/**
 * BOTH BRANCH CARRIERS ARE READABLE, AND THEY ARE NOT MERGED.
 *
 * ═══ WHAT THE MEASUREMENT ACTUALLY SAID ═══
 * The task was filed as "100 of 149 open tasks carry no `branch:` tag, so the backlog is
 * two-thirds invisible", with an explicit instruction to measure first and re-scope if the
 * real problem turned out to be different and smaller. It is different.
 *
 * A task's branch is carried TWO unrelated ways: a `branch:<slug>` TAG naming a workstream,
 * and a `branch_memberships` row pointing at a SPINE RECORD. A slug is not a record id, so
 * neither implies the other. Only the tag was readable off a task — the membership had no
 * read surface anywhere — so every consumer answered "which branch?" from the tag alone.
 * MEASURED on prod 2026-08-31, one query, 157 open tasks in project riverbend:
 *   57 tag · 28 membership · 14 membership-and-NO-tag · 43 tag-and-no-membership · 86 neither.
 * The 14 are tasks the filing count called branchless that are declared members of a spine.
 *
 * ═══ WHY THIS IS NOT A RETAGGING JOB ═══
 * The two fixes the acceptance proposed already exist and were verified in place, not
 * assumed: on a task_create the write path already REPORTS the branch state on every path,
 * and the branch-board already reports an explicit unassigned bucket with a count
 * (`○ no-branch: N open … loose tasks = drift signal`, runtime/branch-board/board.ts). What
 * was missing is the READ — which is the same defect as the deadline above, and the reason
 * the task's own headline number could only ever be measured with raw SQL.
 *
 * "REPORTS on every path" is three distinct outcomes, not one — the earlier version of this
 * paragraph claimed the offer fires on every create and that is FALSE. `report.offer` is set
 * only when the record is unpositioned AND nothing refused the key
 * (`if (!report.position && report.keyRefusal === null)`, services/positionalMint.ts:1030).
 * Standing on a branch mints a membership edge and reports it; an unpositioned create
 * AUTO-OPENS one (R1) and says so, which is precisely why the offer is usually absent. The
 * conclusion is unchanged — no create leaves the branch question unsaid — but the mechanism
 * is not the one sentence, and a reader sent to look for an offer on a positioned create
 * would not find it.
 *
 * These tests assert the two carriers come back SEPARATELY. A test that accepted them
 * merged into one `branch` field would bless the exact equivalence the measurement refutes.
 */
describe('both branch carriers are readable and stay distinct', () => {
  let spineId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'lane C branch carriers') RETURNING id`,
        [`taskfields-branch-${STAMP}`],
      )
    ).rows[0].id;
    spineId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'lane C spine', 'general', 'low', 'todo') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM branch_memberships WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  /** A task carrying whichever carriers the caller asks for, and only those. */
  async function subject(title: string, opts: { tag?: string; member?: boolean }): Promise<string> {
    const id = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status, tags)
         VALUES ($1, $2, 'general', 'low', 'todo', $3) RETURNING id`,
        [projectId, title, opts.tag ? [opts.tag] : []],
      )
    ).rows[0].id;
    if (opts.member) {
      await db.query(
        `INSERT INTO branch_memberships
           (record_id, record_type, spine_id, spine_type, attached_to_id, attached_to_type, source, project_id)
         VALUES ($1, 'task', $2, 'task', $2, 'task', 'recorded', $3)`,
        [id, spineId, projectId],
      );
    }
    return id;
  }

  test('a task that is a MEMBER but carries NO tag is not reported as branchless', async () => {
    // This is the population the filing count got wrong — 14 of them on prod. Under the
    // tag-only reading these tasks "have no branch"; they are declared members of a spine.
    const id = await subject('member, untagged', { member: true });
    const d = await viaPublicTool('task_details', { taskId: id, projectId });
    expect(d.structuredContent.task.branch).not.toBeNull();
    expect(d.structuredContent.task.branch.spineId).toBe(spineId);
    expect(d.structuredContent.task.branch.source).toBe('recorded');
    expect(d.structuredContent.task.branchTags).toEqual([]);
    expect(d.content[0].text).toContain(`Branch member of: task ${spineId.substring(0, 8)}`);
  });

  test('a task that is TAGGED but a member of nothing reports exactly that', async () => {
    // The other 43. A tag is a workstream name, not a declaration of position, and the read
    // must not manufacture one from it.
    const id = await subject('tagged, no membership', { tag: 'branch:backlog-batch-10' });
    const d = await viaPublicTool('task_details', { taskId: id, projectId });
    expect(d.structuredContent.task.branch).toBeNull();
    expect(d.structuredContent.task.branchTags).toEqual(['branch:backlog-batch-10']);
    expect(d.content[0].text).not.toContain('Branch member of:');
  });

  test('carrying NEITHER is a legitimate answer, reported as such', async () => {
    // The 86, and the empty population C3 asks to probe. "Member of nothing" is a real
    // state for a standalone chore — not an error, and not a gap the read should paper over.
    const id = await subject('neither carrier', {});
    const d = await viaPublicTool('task_details', { taskId: id, projectId });
    expect(d.structuredContent.task.branch).toBeNull();
    expect(d.structuredContent.task.branchTags).toEqual([]);
  });

  test('a task carrying BOTH reports both, unmerged', async () => {
    const id = await subject('both carriers', { tag: 'branch:backlog-batch-10', member: true });
    const d = await viaPublicTool('task_details', { taskId: id, projectId });
    expect(d.structuredContent.task.branch.spineId).toBe(spineId);
    expect(d.structuredContent.task.branchTags).toEqual(['branch:backlog-batch-10']);
    // The two fields are separate keys, not one collapsed value. If a future change merges
    // them, the equivalence it asserts ("a slug is a spine") is one the prod measurement
    // refutes, and this is where that gets caught.
    expect(Object.keys(d.structuredContent.task)).toEqual(
      expect.arrayContaining(['branch', 'branchTags']),
    );
  });

  test('only `branch:`-prefixed tags are reported as branch tags', async () => {
    const id = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status, tags)
         VALUES ($1, 'decoy tags', 'general', 'low', 'todo', $2) RETURNING id`,
        [projectId, ['scope:product', 'branchless', 'rebranch:x', 'branch:real-one']],
      )
    ).rows[0].id;
    const d = await viaPublicTool('task_details', { taskId: id, projectId });
    // `branchless` and `rebranch:x` both contain the substring and are NOT branch tags —
    // the filter is a prefix match, and this is the decoy that proves it.
    expect(d.structuredContent.task.branchTags).toEqual(['branch:real-one']);
  });
});
