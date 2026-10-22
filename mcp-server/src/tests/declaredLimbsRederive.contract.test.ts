/**
 * DECLARED LIMBS — write-time materialisation, RE-DERIVATION ON UPDATE, and the backfill.
 * BRANCH-1 (an earlier decision Phase 1). DB-backed: real handlers,
 * real Postgres (the disposable ci_* DB).
 *
 * WHAT THIS GUARDS, AND WHY EACH PART EXISTS
 *  1. WRITE TIME — a context/task/decision written today carries its limbs immediately.
 *  2. RE-DERIVATION — the acceptance criterion. If tags change and the stored limb set does
 *     not, the column silently describes tags that are no longer on the record, and Phase 2
 *     routes traversals by a value nothing can be checked against. The probe that proves
 *     this guard is not hollow is in the commit body and reproduced in the task report:
 *     removing the `persistDeclaredLimbsForRow` call from the update path must turn the
 *     re-derivation tests RED while the create-path tests stay GREEN.
 *  3. AMBIGUITY AT LIVE SCALE — two records whose ids share their first 8 hex characters.
 *     The eval's 192-record population had zero collisions, so this behaviour has never
 *     been exercised by the measurement the rule comes from. Seeded explicitly here.
 *  4. BODY COMPOSITION vs SQL — the TypeScript composition must equal the Postgres
 *     expressions the golden fixture's bodies were pinned with. Asserted by running BOTH
 *     against the same rows, rather than by claiming it in a comment.
 *  5. THE BACKFILL — over rows that already exist, producing values identical to the write
 *     path, idempotent on re-run, and honest about the three states (NULL vs empty vs set).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub the embedder (native transformers are unavailable in CI). Every DB write path under
// test still runs for real; only the vector is synthetic.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: patternEmbedding().length,
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { contextHandler } from '../handlers/context.js';
import { tasksHandler } from '../handlers/tasks.js';
import { decisionsHandler } from '../handlers/decisions.js';
import { composeLimbBody } from '../services/declaredLimbs.js';
import { runDeclaredLimbsBackfill } from '../services/backfillDeclaredLimbs.js';
import { systemRoutes } from '../routes/system.routes.js';
import { DECLARED_LIMBS_CONFIG } from '../config/declaredLimbsConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `limbs-P-${STAMP}`;

let projectId: string;
/** A real task in this project, used as the limb every fixture record declares. */
let anchorTaskId: string;
let anchorTaskId8: string;

async function limbsOf(table: string, id: string): Promise<{ limbs: string[] | null; drops: number | null }> {
  const r = await db.query(
    `SELECT declared_limbs::text[] AS limbs, declared_limbs_ambiguous_drops AS drops
       FROM ${table} WHERE id = $1`,
    [id]
  );
  return { limbs: r.rows[0]?.limbs ?? null, drops: r.rows[0]?.drops ?? null };
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'declared limbs contract') RETURNING id`,
      [PROJ_NAME]
    )
  ).rows[0].id;
  const task = await tasksHandler.createTask(projectId, 'Anchor task for limbs', 'the limb root');
  anchorTaskId = task.id;
  anchorTaskId8 = anchorTaskId.slice(0, 8);
});

afterAll(async () => {
  if (projectId) {
    await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  }
});

describe('write time: limbs are materialised by every write path', () => {
  test('context_store: a limb TAG lands in declared_limbs', async () => {
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: 'tagged completion, no ids in the prose',
      tags: [`task:${anchorTaskId8}`],
    });
    const { limbs, drops } = await limbsOf('contexts', stored.id);
    expect(limbs).toEqual([anchorTaskId]);
    expect(drops).toBe(0);
  });

  test('context_store: an id8 in the BODY with NO tag lands too — what a tags-only rule loses', async () => {
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: `Finished the work described in ${anchorTaskId8}. No tags on this one.`,
      tags: [],
    });
    const { limbs } = await limbsOf('contexts', stored.id);
    expect(limbs).toEqual([anchorTaskId]);
  });

  test('context_store: a record declaring nothing is DERIVED-EMPTY, not NULL', async () => {
    // The three states must stay distinguishable: this is the majority population, and
    // Phase 2 treats it as terminal. NULL would mean "the backfill still owes this row".
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'discussion',
      content: 'a thought with no references at all',
      tags: ['musing'],
    });
    const { limbs } = await limbsOf('contexts', stored.id);
    expect(limbs).toEqual([]);
    expect(limbs).not.toBeNull();
  });

  test('task_create: a task declares ITSELF', async () => {
    const task = await tasksHandler.createTask(projectId, 'A second task', 'no references');
    const { limbs } = await limbsOf('tasks', task.id);
    expect(limbs).toEqual([task.id]);
  });

  test('decision_record: a decision declares itself plus what it names', async () => {
    const d = await decisionsHandler.recordDecision({
      projectId,
      decisionType: 'architecture',
      title: 'A decision that names a task',
      description: `implements ${anchorTaskId8}`,
      rationale: 'because',
      impactLevel: 'low',
    });
    const { limbs } = await limbsOf('technical_decisions', d.id);
    expect(limbs).toEqual([d.id, anchorTaskId].sort());
  });
});

describe('RE-DERIVATION: the stored set never outlives the tags it came from', () => {
  test('context_update: ADDING a limb tag re-derives', async () => {
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: 'untagged at first',
      tags: [],
    });
    expect((await limbsOf('contexts', stored.id)).limbs).toEqual([]);

    await contextHandler.updateContext({
      contextId: stored.id,
      projectId,
      tags: [`task:${anchorTaskId8}`],
    });
    expect((await limbsOf('contexts', stored.id)).limbs).toEqual([anchorTaskId]);
  });

  test('context_update: REMOVING the limb tag removes the limb — the stale-value path', async () => {
    // The direction that matters. A cache that only ever grows still lies: the record no
    // longer claims that limb, so a traversal that routes by the stored value routes by a
    // claim the record has withdrawn.
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: 'tagged at first',
      tags: [`task:${anchorTaskId8}`],
    });
    expect((await limbsOf('contexts', stored.id)).limbs).toEqual([anchorTaskId]);

    await contextHandler.updateContext({ contextId: stored.id, projectId, tags: ['unrelated'] });
    expect((await limbsOf('contexts', stored.id)).limbs).toEqual([]);
  });

  test('context_update: editing the CONTENT re-derives from the new prose', async () => {
    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: 'nothing named here',
      tags: [],
    });
    await contextHandler.updateContext({
      contextId: stored.id,
      projectId,
      content: `now it names ${anchorTaskId8}`,
    });
    expect((await limbsOf('contexts', stored.id)).limbs).toEqual([anchorTaskId]);
  });

  test('task_update: re-tagging re-derives, and the task keeps declaring itself', async () => {
    const task = await tasksHandler.createTask(projectId, 'retag me', 'no refs');
    expect((await limbsOf('tasks', task.id)).limbs).toEqual([task.id]);

    await tasksHandler.updateTaskStatus(
      task.id, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, [`task:${anchorTaskId8}`]
    );
    expect((await limbsOf('tasks', task.id)).limbs).toEqual([task.id, anchorTaskId].sort());

    await tasksHandler.updateTaskStatus(
      task.id, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, ['none']
    );
    expect((await limbsOf('tasks', task.id)).limbs).toEqual([task.id]);
  });

  test('decision_update: re-tagging re-derives', async () => {
    const d = await decisionsHandler.recordDecision({
      projectId,
      decisionType: 'architecture',
      title: 'retag me too',
      description: 'no refs',
      rationale: 'because',
      impactLevel: 'low',
    });
    expect((await limbsOf('technical_decisions', d.id)).limbs).toEqual([d.id]);

    await decisionsHandler.updateDecision({ decisionId: d.id, tags: [`task:${anchorTaskId8}`] });
    expect((await limbsOf('technical_decisions', d.id)).limbs).toEqual([d.id, anchorTaskId].sort());

    await decisionsHandler.updateDecision({ decisionId: d.id, tags: [] });
    expect((await limbsOf('technical_decisions', d.id)).limbs).toEqual([d.id]);
  });
});

describe('AMBIGUITY at live scale: dropped, counted, never guessed', () => {
  test('two records sharing an 8-hex prefix make every mention of it resolve to nothing', async () => {
    // Seeded explicitly because the measured population had NO collisions — this behaviour
    // is unexercised by the golden fixture and only appears against a real corpus.
    const shared = 'facef00d';
    const twinA = `${shared}-1111-4111-8111-111111111111`;
    const twinB = `${shared}-2222-4222-8222-222222222222`;
    await db.query(
      `INSERT INTO tasks (id, project_id, title) VALUES ($1, $3, 'twin A'), ($2, $3, 'twin B')`,
      [twinA, twinB, projectId]
    );

    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: `references ${shared} in prose`,
      tags: [`task:${shared}`],
    });
    const { limbs, drops } = await limbsOf('contexts', stored.id);
    expect(limbs).toEqual([]);
    expect(drops).toBe(2); // one tag mention + one body mention, both dropped and counted
  });
});

describe('BODY COMPOSITION: the TypeScript equals the SQL the fixture was pinned with', () => {
  test('context / task / decision bodies match the pin_bodies.sh expressions, including NULLs', async () => {
    // NULL and empty-string segments are the cases where coalesce() and concat_ws() differ,
    // so the fixtures are chosen to contain both.
    const t = await db.query(
      `INSERT INTO tasks (project_id, title, description) VALUES ($1,'title only',NULL) RETURNING *`,
      [projectId]
    );
    const d = await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, problem_statement, outcome_notes)
       VALUES ($1,'architecture','T','', 'R', NULL, NULL) RETURNING *`,
      [projectId]
    );
    const c = await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1,'discussion','body') RETURNING *`,
      [projectId]
    );

    const sql = await db.query(
      `SELECT
         (SELECT coalesce(title,'')||E'\n'||coalesce(description,'') FROM tasks WHERE id=$1) AS task_body,
         (SELECT concat_ws(E'\n', title, description, rationale, problem_statement, outcome_notes)
            FROM technical_decisions WHERE id=$2) AS decision_body,
         (SELECT content FROM contexts WHERE id=$3) AS context_body`,
      [t.rows[0].id, d.rows[0].id, c.rows[0].id]
    );

    expect(composeLimbBody('task', t.rows[0])).toBe(sql.rows[0].task_body);
    expect(composeLimbBody('decision', d.rows[0])).toBe(sql.rows[0].decision_body);
    expect(composeLimbBody('context', c.rows[0])).toBe(sql.rows[0].context_body);
  });
});

describe('BACKFILL: existing rows get the same values a fresh write would produce', () => {
  test('a row inserted behind the handlers is NULL, and the backfill derives it', async () => {
    // Direct INSERT = a record that predates this feature. NULL is the honest "not derived".
    const pre = await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags)
       VALUES ($1,'completion',$2,$3) RETURNING id::text AS id`,
      [projectId, `legacy record naming ${anchorTaskId8}`, ['legacy']]
    );
    const preId = pre.rows[0].id;
    expect((await limbsOf('contexts', preId)).limbs).toBeNull();

    const dry = await runDeclaredLimbsBackfill({ dryRun: true, projectName: PROJ_NAME, pool: db });
    expect(dry.rowsWritten).toBe(0);
    expect((await limbsOf('contexts', preId)).limbs).toBeNull();
    expect(dry.perType.context.scanned).toBeGreaterThan(0);

    const live = await runDeclaredLimbsBackfill({ projectName: PROJ_NAME, pool: db });
    expect(live.rowsWritten).toBeGreaterThan(0);
    expect((await limbsOf('contexts', preId)).limbs).toEqual([anchorTaskId]);

    // The census the decision pre-registered, on this project's own population.
    const c = live.perType.context;
    expect(c.scanned).toBe(c.limbTagPresent + c.bodyId8NoTag + c.neither);
    expect(c.scanned).toBe(c.withLimbs + c.empty);
    expect(c.bodyId8NoTag).toBeGreaterThan(0); // the untagged-but-named population exists
  });

  test('re-running is idempotent — same values, no drift', async () => {
    const before = await db.query(
      `SELECT id::text AS id, declared_limbs::text[] AS limbs FROM contexts
        WHERE project_id = $1 ORDER BY id`,
      [projectId]
    );
    await runDeclaredLimbsBackfill({ projectName: PROJ_NAME, pool: db });
    const after = await db.query(
      `SELECT id::text AS id, declared_limbs::text[] AS limbs FROM contexts
        WHERE project_id = $1 ORDER BY id`,
      [projectId]
    );
    expect(after.rows).toEqual(before.rows);
  });

  test('--only-missing touches ONLY rows that were never derived', async () => {
    const derived = await db.query(
      `SELECT id::text AS id FROM contexts WHERE project_id=$1 AND declared_limbs IS NOT NULL LIMIT 1`,
      [projectId]
    );
    // Corrupt a DERIVED row: --only-missing must leave it alone (it is not NULL), which is
    // what proves the filter is the NULL predicate and not "everything".
    await db.query(`UPDATE contexts SET declared_limbs = '{}'::uuid[] WHERE id = $1`, [
      derived.rows[0].id,
    ]);
    const missing = await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags)
       VALUES ($1,'completion',$2,'{}') RETURNING id::text AS id`,
      [projectId, `another legacy row naming ${anchorTaskId8}`]
    );

    const stats = await runDeclaredLimbsBackfill({
      projectName: PROJ_NAME,
      onlyMissing: true,
      pool: db,
    });
    expect(stats.rowsWritten).toBe(1);
    expect((await limbsOf('contexts', missing.rows[0].id)).limbs).toEqual([anchorTaskId]);
    expect((await limbsOf('contexts', derived.rows[0].id)).limbs).toEqual([]); // untouched
  });
});

describe('the tasks version trigger counts AUTHORED writes only (migration 078 amends 067)', () => {
  // Materialising declared_limbs writes the column back after the handler's own UPDATE, so
  // without the amendment a single logical task write bumped `version` TWICE — and `version`
  // is task_claim's expectedVersion CAS token. These assertions pin BOTH halves: authored
  // writes still bump from every surface (067's guarantee, unweakened), and a derived-only
  // write does not.
  test('a derived-column-only UPDATE does NOT bump version', async () => {
    const task = await tasksHandler.createTask(projectId, 'version probe', 'no refs');
    const v0 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;

    await db.query(`UPDATE tasks SET declared_limbs = '{}'::uuid[] WHERE id = $1`, [task.id]);
    const v1 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;
    expect(v1).toBe(v0);
  });

  test('a raw SQL write to an AUTHORED column still bumps — 067\'s guarantee is intact', async () => {
    const task = await tasksHandler.createTask(projectId, 'version probe 2', 'no refs');
    const v0 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;

    await db.query(`UPDATE tasks SET title = 'raw sql' WHERE id = $1`, [task.id]);
    const v1 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;
    expect(v1).toBe(v0 + 1);

    // The mixed case: an authored column AND the derived columns in one statement bumps once.
    await db.query(
      `UPDATE tasks SET title = 'raw sql 2', declared_limbs = '{}'::uuid[] WHERE id = $1`,
      [task.id]
    );
    const v2 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;
    expect(v2).toBe(v1 + 1);
  });

  test('one task_update through the handler = exactly ONE version bump, limbs included', async () => {
    const task = await tasksHandler.createTask(projectId, 'version probe 3', 'no refs');
    const v0 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;

    await tasksHandler.updateTaskStatus(
      task.id, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, [`task:${anchorTaskId8}`]
    );
    const v1 = (await db.query('SELECT version FROM tasks WHERE id=$1', [task.id])).rows[0].version;
    expect(v1).toBe(v0 + 1);
    // …and the limbs really were written by that same logical write.
    expect((await limbsOf('tasks', task.id)).limbs).toEqual([task.id, anchorTaskId].sort());
  });
});

describe('the flag has a PROCESS-level read-back', () => {
  test('mandrel_status reports the effective value on both channels', async () => {
    // Data-level probing cannot answer "is it on?": declared_limbs is NULL both when the
    // derivation is switched off and when it errors. So the process has to say so itself.
    const res: any = await systemRoutes.handleStatus();
    expect(res.structuredContent.featureFlags.declaredLimbsWriteTime).toBe(
      DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled
    );
    expect(res.content[0].text).toContain(
      `declared-limbs write-time derivation: ${DECLARED_LIMBS_CONFIG.writeTimeDerivationEnabled ? 'ON' : 'OFF'}`
    );
  });
});

describe('BULK: the batched write-back derives PER ROW, exactly as the single path does', () => {
  // GUARD SCOPE: these tests cover the write-back hung off `bulkUpdateTasks` — the third of
  // the three write-path hooks, and the one that had no coverage here at all until an earlier task
  // replaced its serial per-row loop with one batched statement. The population
  // that matters for a batched derivation is rows whose CORRECT ANSWERS DIFFER FROM EACH
  // OTHER: a batch that derived once and wrote the same value to every row would pass any
  // test whose rows agree. Every test below therefore puts unlike rows in one call.

  /** Three tasks in one bulk call, each declaring something different. */
  async function threeUnlikeTasks(): Promise<{ tagged: string; prose: string; bare: string }> {
    const tagged = (await tasksHandler.createTask(projectId, 'bulk tagged', 'no ids here')).id;
    const prose = (await tasksHandler.createTask(projectId, 'bulk prose', `names ${anchorTaskId8} inline`)).id;
    const bare = (await tasksHandler.createTask(projectId, 'bulk bare', 'declares nothing')).id;
    // Put the tag on directly, so the row's tags and its stored limbs are set up by
    // different writes and only the bulk call under test can reconcile them.
    await db.query(`UPDATE tasks SET tags = $2 WHERE id = $1`, [tagged, [`task:${anchorTaskId8}`]]);
    return { tagged, prose, bare };
  }

  test('one bulk call gives three rows three DIFFERENT limb sets', async () => {
    const { tagged, prose, bare } = await threeUnlikeTasks();
    await tasksHandler.bulkUpdateTasks([tagged, prose, bare], { status: 'in_progress' });

    expect((await limbsOf('tasks', tagged)).limbs).toEqual([tagged, anchorTaskId].sort());
    expect((await limbsOf('tasks', prose)).limbs).toEqual([prose, anchorTaskId].sort());
    // DERIVED-EMPTY-except-itself, not NULL: the bulk path owes this row a derivation too.
    expect((await limbsOf('tasks', bare)).limbs).toEqual([bare]);
  });

  test('bulk and single agree on the same input — the two paths are one rule', async () => {
    // The failure this catches is the one a perf change makes reachable: a batched
    // derivation that is CORRECT-LOOKING but not the same rule the single path runs.
    // Created with NO reference, so the limb can ONLY come from the write-back under test:
    // seeding the reference at create time would leave this test green with the write-back
    // deleted, which is a parity assertion that proves nothing about the bulk path.
    const viaBulk = (await tasksHandler.createTask(projectId, 'twin bulk', 'no refs yet')).id;
    const viaSingle = (await tasksHandler.createTask(projectId, 'twin single', 'no refs yet')).id;
    await db.query(`UPDATE tasks SET description = $3, tags = $2 WHERE id = ANY($1::uuid[])`,
      [[viaBulk, viaSingle], [`task:${anchorTaskId8}`, 'unrelated'], `names ${anchorTaskId8}`]);

    await tasksHandler.bulkUpdateTasks([viaBulk], { status: 'in_progress' });
    await tasksHandler.updateTaskStatus(viaSingle, 'in_progress');

    const b = await limbsOf('tasks', viaBulk);
    const s = await limbsOf('tasks', viaSingle);
    // Compare the SETS, not the ids: the rows differ only by their own self-limb.
    expect(b.limbs!.filter(x => x !== viaBulk)).toEqual(s.limbs!.filter(x => x !== viaSingle));
    expect(b.drops).toBe(s.drops);
  });

  test('ambiguous drops are counted PER ROW, not smeared across the batch', async () => {
    // Reuses the twins seeded by the AMBIGUITY block above if present; seeds its own pair
    // otherwise, so this test does not depend on file order.
    const shared = 'facef00d';
    await db.query(
      `INSERT INTO tasks (id, project_id, title) VALUES ($1, $3, 'twin A'), ($2, $3, 'twin B')
       ON CONFLICT (id) DO NOTHING`,
      [`${shared}-1111-4111-8111-111111111111`, `${shared}-2222-4222-8222-222222222222`, projectId]
    );
    const drops2 = (await tasksHandler.createTask(projectId, 'bulk ambiguous', `mentions ${shared} in prose`)).id;
    const drops0 = (await tasksHandler.createTask(projectId, 'bulk clean', `mentions ${anchorTaskId8}`)).id;
    await db.query(`UPDATE tasks SET tags = $2 WHERE id = $1`, [drops2, [`task:${shared}`]]);

    await tasksHandler.bulkUpdateTasks([drops2, drops0], { status: 'in_progress' });

    const amb = await limbsOf('tasks', drops2);
    expect(amb.drops).toBe(2);           // one tag mention + one body mention
    expect(amb.limbs).toEqual([drops2]); // ambiguous mentions resolve to NOTHING, never a guess
    const clean = await limbsOf('tasks', drops0);
    expect(clean.drops).toBe(0);
    expect(clean.limbs).toEqual([drops0, anchorTaskId].sort());
  });

  test('a bulk write REMOVES a limb the row no longer declares — the stale-value direction', async () => {
    const task = (await tasksHandler.createTask(projectId, 'bulk stale', 'x')).id;
    await db.query(`UPDATE tasks SET tags = $2 WHERE id = $1`, [task, [`task:${anchorTaskId8}`]]);
    await tasksHandler.bulkUpdateTasks([task], { status: 'in_progress' });
    expect((await limbsOf('tasks', task)).limbs).toEqual([task, anchorTaskId].sort());

    // The claim is withdrawn; a write-back that only ever ADDS would leave the old limb.
    await db.query(`UPDATE tasks SET tags = '{}'::text[] WHERE id = $1`, [task]);
    await tasksHandler.bulkUpdateTasks([task], { status: 'todo' });
    expect((await limbsOf('tasks', task)).limbs).toEqual([task]);
  });

  test('the EMPTY batch writes nothing and does not throw', async () => {
    // The zero population: `bulkUpdateTasks` can RETURN no rows (every id fenced by a live
    // claim), and an unnest-based UPDATE over empty arrays must be a no-op, not an error.
    const { persistDeclaredLimbsForRows } = await import('../services/declaredLimbsStore.js');
    await expect(persistDeclaredLimbsForRows('task', [])).resolves.toBeNull();
  });
});
