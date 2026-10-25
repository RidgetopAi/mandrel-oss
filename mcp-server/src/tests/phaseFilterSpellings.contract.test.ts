/**
 * task_list's `phase` FILTER MATCHES EVERY SPELLING OF THE PHASE.
 *
 * THE SHIPPED DEFECT THIS PINS. handlers/tasks.ts built the lookup as the single literal
 * `phase-${phase}`, so a task tagged `phase:5` or `phase5` could not be found by the filter
 * that exists to find it — and the caller got `total: 0`, which does not look like a bug.
 * Verified at the live prod tool surface before the fix:
 *   task_list(projectId:"riverbend", phase:"5")  ->  {"total":0,"returned":0}
 * with `phase:5` and `phase5` tasks sitting in that project.
 *
 * ═══ WHAT THIS ASSERTS, AND WHY IT ASSERTS `total` ═══════════════════════════════════
 * `total` comes from countTasks(), a SEPARATE query from listTasks() that shares
 * buildTaskFilter. The reported symptom was the TOTAL, not the row array, so a test that
 * only inspected `results` would have been green against the exact failure that was
 * reported. Every case below asserts the VALUE of `total` as well as the ids — a key that
 * is merely present, or a count that is merely a number, proves nothing.
 *
 * ═══ THE POPULATION, AND WHY IT IS THE WHOLE ONE ═════════════════════════════════════
 * The boundary spellings were DERIVED from prod rather than listed from memory:
 *   SELECT tag, count(*) FROM (SELECT unnest(tags) AS tag FROM tasks) s
 *    WHERE tag ILIKE '%phase%' GROUP BY tag ORDER BY tag;
 * That is what showed three live bands, not two — dash, colon, and NO separator at all
 * (phase1=12, phase2=11, phase3=8, phase4=25, phase5=1, phase6=5). The original report
 * named only dash-vs-colon because it was built from a hand-written list of spellings
 * someone had already thought of. Each of the three bands has a case below, plus the
 * dimension no spelling-pair sweep can see (a value present in ONE spelling only:
 * `phase:2c` and `phase:5` have no `phase-` counterpart anywhere in the data), plus case,
 * plus the zero population.
 *
 * ═══ IT ALSO PINS THE FILTER SHUT ═══════════════════════════════════════════════════
 * Two of these are NEGATIVE and they are the reason this file is not just a widening.
 * The obvious way to "improve" this fix is to fold BOTH sides by deleting separators —
 * which silently makes `phase:"1.2"` match a `phase-12` task, because both fold to
 * `phase12`. Only the boundary separator is flexible; the value is matched literally.
 * Mutation-probed in BOTH directions (narrowed, and over-widened) — see
 * src/tests/manual/phase-filter-mutation-probe.sh.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { phaseTagCandidates } from '../config/phaseTagConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `phase-spellings-${STAMP}`;

let projectId: string;
/** tag spelling -> the task id carrying exactly that one tag. */
const taskIds = new Map<string, string>();

/**
 * ONE task per spelling, each carrying EXACTLY ONE phase tag. Disjoint on purpose: a task
 * carrying two spellings would be found by a dash-only filter too, so it could not tell a
 * fixed filter from a broken one — the smallest input where the branches diverge is a task
 * whose ONLY spelling is the non-dash one.
 */
const SPELLINGS = [
  'phase-5',   // dash: the one spelling the old filter could see (the control)
  'phase:5',   // colon: the reported band
  'phase5',    // NO separator: the band a hand-written list could not find
  'phase_5',
  'phase.5',
  'phase-A',   // case: `phase-A` is live on prod (5 occurrences)
  'phase-1.2', // a value with its OWN punctuation
  'phase-12',  // the over-match decoy: folds to `phase12` iff separators are deleted
  'phase:2c',  // a value that exists in NO other spelling anywhere in the data
];

async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

/** ids + the GRAND TOTAL, which is the number the defect actually reported wrongly. */
function listed(resp: any): { ids: string[]; total: number } {
  return {
    ids: (resp?.structuredContent?.results ?? []).map((r: any) => r.id),
    total: resp?.structuredContent?.total,
  };
}

async function listPhase(phase: string) {
  return listed(await viaPublicTool('task_list', { phase, projectId, limit: 100 }, (a) => tasksRoutes.handleList(a)));
}

/** The task id for a spelling, or a loud failure — never `undefined` flowing into an assert. */
function idOf(spelling: string): string {
  const id = taskIds.get(spelling);
  if (!id) throw new Error(`fixture missing for spelling ${spelling}`);
  return id;
}

describe('task_list phase filter: every spelling of a phase, and only that phase', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'phase spelling guard') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    for (const spelling of SPELLINGS) {
      const { rows } = await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status, tags)
         VALUES ($1, $2, 'general', 'medium', 'todo', ARRAY[$3]::text[])
         RETURNING id::text AS id`,
        [projectId, `task tagged ${spelling}`, spelling],
      );
      taskIds.set(spelling, rows[0].id);
    }

    // THE FIXTURE IS WITNESSED, not assumed. If the inserts silently landed with different
    // tags, every assertion below would still "pass" against the wrong population.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [projectId],
    );
    expect(rows[0].n).toBe(SPELLINGS.length);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('the candidate grammar is exactly the six boundary spellings, lowercased', () => {
    // Asserted as VALUES, in order, not as "an array with some length" — the whole fix is
    // which strings are in here.
    expect(phaseTagCandidates('5')).toEqual([
      'phase-5', 'phase:5', 'phase_5', 'phase.5', 'phase 5', 'phase5',
    ]);
    // Case folds; the VALUE keeps its own punctuation.
    expect(phaseTagCandidates('A')).toEqual([
      'phase-a', 'phase:a', 'phase_a', 'phase.a', 'phase a', 'phasea',
    ]);
    expect(phaseTagCandidates('1.2')).toContain('phase-1.2');
    expect(phaseTagCandidates('1.2')).not.toContain('phase-12');
    // The empty population: no value, no candidates — and the caller must not silently
    // get the whole backlog, which is asserted end-to-end below.
    expect(phaseTagCandidates('   ')).toEqual([]);
  });

  test('phase:"5" finds the DASH spelling (the control — it must not regress)', async () => {
    const { ids } = await listPhase('5');
    expect(ids).toContain(idOf('phase-5'));
  });

  test('phase:"5" finds the COLON spelling — the reported defect, at the reported number', async () => {
    const { ids, total } = await listPhase('5');
    expect(ids).toContain(idOf('phase:5'));
    // The live symptom was `total: 0`. Assert the value, not that a `total` key exists.
    expect(total).toBe(5);
  });

  test('phase:"5" finds the NO-SEPARATOR spelling, which no spelling-pair sweep could name', async () => {
    const { ids } = await listPhase('5');
    expect(ids).toContain(idOf('phase5'));
  });

  test('phase:"5" finds the underscore and dot spellings too', async () => {
    const { ids } = await listPhase('5');
    expect(ids).toContain(idOf('phase_5'));
    expect(ids).toContain(idOf('phase.5'));
  });

  test('phase:"5" returns EXACTLY the five phase-5 tasks and nothing else', async () => {
    const { ids, total } = await listPhase('5');
    expect([...ids].sort()).toEqual(
      [idOf('phase-5'), idOf('phase:5'), idOf('phase5'), idOf('phase_5'), idOf('phase.5')].sort(),
    );
    expect(total).toBe(5);
    // phase-12 and phase-1.2 are NOT phase 5 under any fold.
    expect(ids).not.toContain(idOf('phase-12'));
    expect(ids).not.toContain(idOf('phase-1.2'));
  });

  test('case is a spelling difference: phase:"a" and phase:"A" both find phase-A', async () => {
    const lower = await listPhase('a');
    const upper = await listPhase('A');
    expect(lower.ids).toEqual([idOf('phase-A')]);
    expect(lower.total).toBe(1);
    expect(upper.ids).toEqual([idOf('phase-A')]);
    expect(upper.total).toBe(1);
  });

  test('a value present in ONE spelling only is reachable: phase:"2c" finds phase:2c', async () => {
    // This is the band a collision-based remedy structurally cannot cover — there is no
    // `phase-2c` anywhere to pair it with, so no sweep over the data would ever name it.
    const { ids, total } = await listPhase('2c');
    expect(ids).toEqual([idOf('phase:2c')]);
    expect(total).toBe(1);
  });

  test('NEGATIVE: phase:"1.2" must NOT match phase-12 — only the BOUNDARY is flexible', async () => {
    const { ids, total } = await listPhase('1.2');
    expect(ids).toEqual([idOf('phase-1.2')]);
    expect(total).toBe(1);
    expect(ids).not.toContain(idOf('phase-12'));
  });

  test('NEGATIVE: phase:"12" must NOT match phase-1.2 either — the fold is not symmetric-blind', async () => {
    const { ids, total } = await listPhase('12');
    expect(ids).toEqual([idOf('phase-12')]);
    expect(total).toBe(1);
  });

  test('the ZERO population: a phase with no tasks returns total 0, not the backlog', async () => {
    const { ids, total } = await listPhase('9999');
    expect(ids).toEqual([]);
    expect(total).toBe(0);
  });

  test('a whitespace-only phase matches NOTHING — the predicate is never dropped', async () => {
    // If the clause were omitted when no candidates are generated, this would answer
    // "tasks in phase \" \"" with all nine fixtures. That is the failure shape that makes a
    // filter dangerous rather than merely useless.
    const { ids, total } = await listPhase('   ');
    expect(ids).toEqual([]);
    expect(total).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // THE SECOND PHASE READ PATH — task_progress_summary(groupBy:'phase').
  //
  // ADDED IN REJECT ROUND 1 (review verdict, F1). The first version of this
  // file guarded the task_list FILTER and nothing else, while the same commit also changed
  // the SUMMARY's grouping SQL. That half shipped guarded by NOTHING, and it is the tool's
  // DEFAULT grouping — routes/tasks.routes.ts `args.groupBy || 'phase'` and
  // middleware/validation.ts `.optional().default('phase')` — so a bare
  // task_progress_summary({projectId}) runs it.
  //
  // REVIEWER PRODUCED THE FALSE GREEN, which is the only reason this section exists as an
  // assertion rather than as a paragraph: it reverted both helpers to the shipped dash-only
  // defect (separator class `[-_:. ]` -> `[-]`, optional-separator `?` deleted), dropping
  // 43 of 163 phase-tagged live tasks out of the summary, and the WHOLE suite still passed
  // — 313 files / 3977 tests, exit 0. The only thing executing that SQL at all was an
  // incidental emoji-cleanliness assertion in ws1ResponseShape.contract.test.ts, which
  // catches a SQL syntax error and nothing semantic.
  //
  // A guard that passes with the feature deleted is hollow by definition. These cases fix
  // that, over the SAME nine-spelling fixture, so the two read paths are held to one
  // population rather than two.
  // ══════════════════════════════════════════════════════════════════════════════════════
  describe('task_progress_summary(groupBy:"phase") — the DEFAULT grouping, over the same fixture', () => {
    /** group name -> totalTasks, from the tool's machine channel. */
    async function groups(args: any): Promise<Map<string, number>> {
      const resp = await viaPublicTool('task_progress_summary', args, (a) => tasksRoutes.handleProgressSummary(a));
      const out = new Map<string, number>();
      for (const g of resp.structuredContent.groupedProgress ?? []) out.set(g.group, g.totalTasks);
      return out;
    }

    test('the five phase-5 spellings collapse to ONE group of 5, not five groups of 1', async () => {
      const g = await groups({ groupBy: 'phase', projectId });
      // The number is the whole point: dash-only grouping yields a `phase-5` group of 1 and
      // silently drops the other four tasks out of the summary entirely.
      expect(g.get('phase-5')).toBe(5);
      // And the spellings must not survive as groups of their own.
      for (const stray of ['phase:5', 'phase5', 'phase_5', 'phase.5']) {
        expect(g.has(stray)).toBe(false);
      }
    });

    test('the DEFAULT call — no groupBy at all — runs this same path', async () => {
      // The reason F1 was a blocker rather than a nit: this is what a bare call does, and
      // every existing test of this tool passed groupBy:'status' or {}.
      const g = await groups({ projectId });
      expect(g.get('phase-5')).toBe(5);
    });

    test('every task in the fixture reaches a group — none is dropped from the summary', async () => {
      const g = await groups({ groupBy: 'phase', projectId });
      const counted = [...g.values()].reduce((a, b) => a + b, 0);
      // Nine fixture tasks, nine accounted for. Under the dash-only recogniser this is 4:
      // phase-5, phase-A, phase-1.2, phase-12 — and phase:5/phase5/phase_5/phase.5/phase:2c
      // vanish with no trace, which is exactly the 43-of-163 loss measured on prod.
      expect(counted).toBe(SPELLINGS.length);
    });

    test('the groups are exactly the canonical five, with their sizes', async () => {
      const g = await groups({ groupBy: 'phase', projectId });
      // Asserted as the whole map, so a NEW spurious group is a failure too — an assertion
      // that only checks the groups it expects cannot see one it did not.
      expect(Object.fromEntries([...g.entries()].sort())).toEqual({
        'phase-5': 5,      // phase-5, phase:5, phase5, phase_5, phase.5
        'phase-a': 1,      // phase-A, lowercased by the canonical key — see below
        'phase-1.2': 1,
        'phase-12': 1,
        'phase-2c': 1,     // from phase:2c — a value with no dash spelling anywhere
      });
    });

    test('THE CANONICAL KEY LOWERCASES, and that is customer-visible (F6)', async () => {
      // Pinned deliberately rather than left as a surprise. A project whose tasks are tagged
      // `phase-A` sees its summary row RELABELLED `phase-a`. That is the module's stated
      // "prefer the visible error" asymmetry being paid for: folding case is what makes
      // `phase-A` and a future `phase-a` one group instead of two, and the cost is a label
      // that differs from the tag as written. If this assertion is ever changed, the change
      // is a customer-visible relabel and must be treated as one.
      const g = await groups({ groupBy: 'phase', projectId });
      expect(g.has('phase-a')).toBe(true);
      expect(g.has('phase-A')).toBe(false);
    });

    test('a non-phase grouping is untouched by any of this', async () => {
      // The control. If `status` grouping also changed, the cases above would be measuring
      // something other than the phase recogniser.
      const g = await groups({ groupBy: 'status', projectId });
      expect(Object.fromEntries(g.entries())).toEqual({ todo: SPELLINGS.length });
    });
  });
});
