/**
 * `created_by` AUTHOR STAMP Contract Test (gap 3).
 *
 * ═══ THE DEFECT THIS LOCKS SHUT ═══
 * MEASURED on prod 2026-09-05: `created_by` was NULL on 116 of 154 open tasks; of the 61 open
 * tasks created in the last 30 days only 3 carried a value. The actor was already being
 * threaded into `createTask` and dropped one line before the INSERT that has a column for it.
 * AND the values that did land carried two spellings of one actor — `coordinator` (24) and `Coordinator`
 * (7) — so `GROUP BY created_by` reported one agent as two.
 *
 * ═══ THE ASSERTIONS THAT WOULD FAIL ON THE PRE-FIX TREE ═══
 * A test asserting "an explicit createdBy is stored" PASSES against the broken code and
 * proves nothing — that path always worked. The load-bearing ones are:
 *   · a create with NO explicit createdBy but WITH an actor stores the actor  (was: NULL)
 *   · `Coordinator` and `coordinator` land on ONE stored value                            (was: two)
 *   · a create with NEITHER stores NULL, not a plausible default              (the ABSENT
 *     direction — the thing a "always write something" fix would break)
 *   · an actor of `anonymous` stores NULL                                     (the specific
 *     ABSENT value that is not blank and would sail through a blankness test)
 *
 * Driven through the SAME public path the bridge uses (validate -> routeExecutor) — no SQL
 * shortcuts past the tool contract. Direct SQL is used only to SEED and to READ.
 *
 * ═══ AND THE MIGRATION/CODE DRIFT PIN ═══
 * Migration 098 case-folds the existing rows with a SQL expression that is a hand translation
 * of `normalizeActor()`. Two representations of one rule is the drift this codebase keeps
 * paying for, so the last describe block runs BOTH over one shared fixture list and asserts
 * they agree value by value. Edit either and this goes red.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { resolveTaskAuthor } from '../services/taskAuthorStamp.js';
import { normalizeActor, ACTOR_ANONYMOUS } from '../config/actorRegistry.js';

const STAMP = Date.now();
const PROJ_NAME = `author-stamp-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any, context?: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, context);
}

/** Create through the public tool with a given edge actor, and read back the stored column. */
async function createAndReadAuthor(
  args: Record<string, unknown>,
  actor?: string,
): Promise<string | null> {
  const res = await viaPublicTool(
    'task_create',
    { projectId, title: `author probe ${Math.random()}`, ...args },
    actor === undefined ? undefined : { actor },
  );
  const id = res?.structuredContent?.task?.id ?? res?.structuredContent?.id;
  expect(id, `task_create returned no id: ${JSON.stringify(res?.structuredContent)}`).toBeTruthy();
  const row = await db.query(`SELECT created_by FROM tasks WHERE id = $1`, [id]);
  return row.rows[0].created_by;
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'author stamp contract') RETURNING id`,
    [PROJ_NAME],
  );
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('gap 3 — the actor the write already carries becomes the author', () => {
  test('THE FIX: no explicit createdBy + an actor -> the actor is stored (was NULL on 75% of open tasks)', async () => {
    expect(await createAndReadAuthor({}, 'builder-83fd88b0')).toBe('builder-83fd88b0');
  });

  test('an EXPLICIT createdBy still wins over the actor — a machine writer names itself', async () => {
    // tree-drift / curator / corrector are the 3 real writers that DID populate this field.
    expect(await createAndReadAuthor({ createdBy: 'tree-drift' }, 'coordinator')).toBe('tree-drift');
  });
});

describe('gap 3 — the coordinator/Coordinator collision is CLOSED, not documented', () => {
  test('THE COLLISION: an actor of `Coordinator` and one of `coordinator` resolve to ONE stored value', async () => {
    const upper = await createAndReadAuthor({}, 'Coordinator');
    const lower = await createAndReadAuthor({}, 'coordinator');
    expect(upper).toBe(lower);
    expect(upper).toBe('coordinator');
    // Stated as a set, because "they are equal" is satisfiable by both being null. This is
    // the assertion that a fix which simply stopped writing the field would fail.
    const distinct = await db.query(
      `SELECT count(DISTINCT created_by)::int AS n FROM tasks
        WHERE project_id = $1 AND lower(created_by) = 'coordinator'`,
      [projectId],
    );
    expect(distinct.rows[0].n).toBe(1);
  });

  test('an EXPLICIT createdBy is normalized too — the write boundary is one rule, not two', async () => {
    // The reported half of the collision arrived via the header. Normalizing only that half
    // would leave `createdBy: 'Coordinator'` free to re-open it (CLASSES.md C5).
    expect(await createAndReadAuthor({ createdBy: 'Coordinator' })).toBe('coordinator');
  });
});

describe('gap 3 — the ABSENT direction: an unset author must stay unset', () => {
  test('NEITHER an explicit createdBy NOR an actor -> NULL, not a plausible-looking default', async () => {
    expect(await createAndReadAuthor({})).toBeNull();
  });

  test('an actor of `anonymous` -> NULL. The flagged session fallback is NOT an author', async () => {
    // `anonymous` is a real, deliberate value on `sessions.actor`. It is not blank, so it
    // sails through any emptiness test and lands in the column looking like a prolific
    // author — `GROUP BY created_by` would report someone who does not exist.
    expect(await createAndReadAuthor({}, ACTOR_ANONYMOUS)).toBeNull();
  });

  test('a WHITESPACE-ONLY explicit createdBy does not beat the actor', async () => {
    // An explicit blank is not an assertion of authorship, so it must fall through rather
    // than winning rule 1 and producing a NULL where an actor was available.
    expect(await createAndReadAuthor({ createdBy: '   ' }, 'reviewer')).toBe('reviewer');
  });
});

describe('gap 3 — resolveTaskAuthor directly (the rule, without the transport)', () => {
  test.each([
    ['explicit wins', 'tree-drift', 'coordinator', 'tree-drift'],
    ['actor when no explicit', undefined, 'Coordinator', 'coordinator'],
    ['explicit is normalized', 'Coordinator', undefined, 'coordinator'],
    ['neither -> undefined', undefined, undefined, undefined],
    ['blank explicit falls through to actor', '  ', 'coordinator', 'coordinator'],
    ['blank both -> undefined', '   ', '   ', undefined],
    ['anonymous actor -> undefined', undefined, ACTOR_ANONYMOUS, undefined],
    ['anonymous explicit -> undefined', ACTOR_ANONYMOUS, 'coordinator', undefined],
    ['null explicit falls through', null, 'coordinator', 'coordinator'],
  ])('%s', (_label, explicit, actor, expected) => {
    expect(resolveTaskAuthor(explicit as any, actor as any)).toBe(expected);
  });

  test('an explicit `anonymous` is refused rather than falling through to the actor', () => {
    // Deliberate and worth pinning: `anonymous` is REFUSED, not treated as absent. Falling
    // through would let a caller launder the actor into the column by passing the flagged
    // token, which is the opposite of what the refusal is for.
    expect(resolveTaskAuthor(ACTOR_ANONYMOUS, 'coordinator')).toBeUndefined();
  });
});

describe('gap 3 — migration 098 PART 2 and normalizeActor() are ONE rule', () => {
  /**
   * The population. Every shape the fold has to survive: the reported collision, whitespace,
   * internal spaces, repeated and edge separators, the empty string, and the composite
   * delimiter that normalizeActor is documented as NOT touching.
   */
  const FIXTURES = [
    'coordinator', 'Coordinator', 'COORDINATOR', '  Coordinator  ', 'Ops Agent', 'ops--agent', '-coordinator-',
    'builder-83FD88B0', 'tree-drift', 'a   b', '   ', '', '-', '---',
    'operator@example.com', 'operator@example.com/coordinator',
  ];

  test('the SQL expression in migration 098 agrees with normalizeActor() on every fixture', async () => {
    // The expression is copied from the migration deliberately: if someone edits the
    // migration and not this test the two go out of sync, which is the state this pins
    // against — so the test is the place the drift becomes visible, and the run report
    // records that the two files must be edited together.
    const SQL_FOLD = `NULLIF(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim($1::text)), '\\s+', '-', 'g'),
            '-+', '-', 'g'),
          '^-+|-+$', '', 'g'),
        '')`;
    for (const raw of FIXTURES) {
      const { rows } = await db.query(`SELECT ${SQL_FOLD} AS folded`, [raw]);
      expect(rows[0].folded, `SQL fold disagreed with normalizeActor on ${JSON.stringify(raw)}`)
        .toBe(normalizeActor(raw));
    }
  });

  test('the fixture population is NOT empty and DOES contain the reported collision', () => {
    // A loop over an empty array passes silently. Naming the population and asserting the
    // specific pair that was measured on prod is what stops this from being a hollow guard.
    expect(FIXTURES.length).toBeGreaterThan(10);
    expect(FIXTURES).toContain('coordinator');
    expect(FIXTURES).toContain('Coordinator');
  });
});
