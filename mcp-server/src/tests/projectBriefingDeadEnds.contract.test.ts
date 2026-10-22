/**
 * PROJECT BRIEFING — DEAD-END RETENTION (STRONG BONES SK6).
 *
 * THE DEFECT THIS PINS. renderBriefing() built ONE drop pool for every record and pushed
 * dead-ends into it with a hardcoded `trustScore: null`. The comparator floors null to
 * -1 while real trust scores live in 0..1 — so a dead-end sorted below EVERY scored
 * record and was evicted FIRST whenever the 24,000-char cap bound. Measured on project
 * riverbend: 417 dead-end candidates existed and the rendered briefing said
 * `## Dead ends (0)` while reporting 534 records dropped.
 *
 * THE CONTRACT ASSERTED HERE:
 *   A. dead-ends are NOT in the global drop pool — under a cap that forces heavy
 *      dropping, every dead-end that fits the reserved sub-budget survives while live
 *      records drop;
 *   B. the sub-budget is a real bound — past it, the OLDEST dead-ends drop, and the
 *      section never exceeds its budget;
 *   C. INTAKE — a plain `discussion`/`error` context carrying a configured dead-end tag
 *      reaches the section, with no supersession edge anywhere (the canonical case: a
 *      session proves approach X impossible and writes it down).
 *
 * Caps and budgets are read from config/briefingConfig.ts, never restated as literals:
 * a test that hardcodes a config-derived value stops testing the product's own value.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import {
  renderBriefing,
  buildProjectBriefing,
  briefingConfig,
  type BriefingData,
  type BriefingDeadEnd,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';

import { censusFor } from './helpers/briefingCensus.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';

/**
 * The fabricated corpus's ONE handoff id. Named so `handoffHead` can be DERIVED from it
 * rather than repeating the literal — a resolution naming a different id than the record
 * it is shown beside would render a header about a record the document is not serving.
 */
const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';


/**
 * The SHIPPED config — cap + reserved budget + tag vocabulary — with P5.1'S THREE NARROWINGS
 * WIDENED OUT OF THE WAY, and only those.
 *
 * THIS FILE IS ABOUT ONE THING: that the dead-ends RESERVED BUDGET beats the GLOBAL SIZE CAP.
 * For that to be what is measured, the size cap has to be the narrowing that binds. P5.1 adds
 * three that would bind first and silently turn every assertion here into a test of something
 * else — a green that had stopped meaning what the file says it means:
 *   - selectMaxDeadEnds 15 < the 20-dead-end fixture -> the QUOTA, not the budget, would trim;
 *   - selectMaxTasks 28 < the 80-task fixture, and
 *   - fullProseSlots 3, which shape-renders the other 77 -> the 3x-the-cap precondition fails
 *     (measured: the uncapped render came out 7901 chars against a 24000 cap).
 * Altitude stays ON, so the machinery under P5.1 is still in the path; the knobs that would
 * pre-empt the cap are the only thing moved. Each has its own coverage in
 * projectBriefingAltitude.contract.test.ts.
 */
const CFG = {
  ...briefingConfig(),
  selectMaxDeadEnds: 100,
  selectMaxTasks: 1000,
  fullProseSlots: 1000,
};

// ── Helpers over the rendered markdown ───────────────────────────────────────

/**
 * The dead-end record lines of a rendered briefing: the `- ` items inside the `## Dead ends`
 * section. Read POSITIONALLY rather than by matching a label prefix — the label now varies
 * with the record's intake basis (SK3), and a helper that greps for one label would silently
 * stop seeing the other three.
 */
function deadEndLines(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## Dead ends'));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).filter((l) => l.startsWith('- '));
}

// ── Fabricated corpus (Part A/B: the PURE renderer, sizes under test control) ─

function fabTask(n: number) {
  return {
    id: `11111111-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `TASK-${n}-START`,
    description: `${'live task body '.repeat(60)} TASK-${n}-END`, // ~900 chars each
    status: 'todo',
    priority: 'medium',
    createdAt: new Date(Date.UTC(2026, 0, 1 + n)),
    trustSignal: 'trust:proven score:0.90',
    trustScore: 0.9, // WELL-SCORED: under the old pool these outranked every dead-end
    metadata: null,
    tags: [],
  };
}

function fabDeadEnd(n: number): BriefingDeadEnd {
  return {
    id: `22222222-0000-0000-0000-${String(n).padStart(12, '0')}`,
    kind: 'context',
    basis: 'recorded',
    headline: `DEADEND-${n} approach that cannot work`,
    reason: `proved impossible after four hours ${n}`,
    createdAt: new Date(Date.UTC(2026, 0, 1 + n)), // higher n = NEWER
  };
}

function fabData(tasks: ReturnType<typeof fabTask>[], deadEnds: BriefingDeadEnd[]): BriefingData {
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'sk6-fab',
    handoffHead: resolvedHead({ id: FAB_HANDOFF_ID }),
    handoff: {
      id: FAB_HANDOFF_ID,
      content: 'HANDOFF resume point',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      trustSignal: 'trust:unproven score:1.00',
      // No ids named in this fixture's handoff text -> nothing to stamp.
      stamps: NO_HANDOFF_STAMPS,
      // P5.4: this fixture's handoff carries no MODE/PATH prose and no stored
      // mode/spine field, so the carried-fields render is the honest empty one.
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks,
    decisions: [],
    conventions: [],
    deadEnds,
    branch: null,
    // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
    // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
    // claim here; a fabricated EMPTY section would assert a zero nobody measured.
    waiting: null,
    census: censusFor({ tasks, decisions: [], conventions: [], deadEnds }),
  };
}

describe('briefing dead-ends — A: the reserved budget beats the global cap', () => {
  test('at ~3x the cap: EVERY dead-end in the reserved budget survives while live tasks drop', () => {
    // A dead-end set small enough that ALL of it fits the reserved sub-budget — so
    // "how many survived" tests the drop pool, not the budget. The size is MEASURED off
    // the renderer's own output, never a hand-modelled char formula (a fixture that
    // models the renderer's arithmetic drifts from it silently).
    const deadEnds = Array.from({ length: 20 }, (_, i) => fabDeadEnd(i + 1));
    const deadEndOnly = renderBriefing(fabData([], deadEnds), { ...CFG, maxChars: 10_000_000 });
    const deadEndCost = deadEndLines(deadEndOnly.markdown).reduce((sum, l) => sum + l.length + 1, 0);
    expect(deadEndOnly.included.deadEnds, 'fixture precondition: all dead-ends admitted').toBe(deadEnds.length);
    expect(
      deadEndCost,
      'fixture precondition: the whole dead-end set must fit the reserved budget',
    ).toBeLessThan(CFG.deadEndReservedChars);

    // Tasks sized so the FULL render is roughly 3x the cap — the cap binds hard.
    const tasks = Array.from({ length: 80 }, (_, i) => fabTask(i + 1));
    const data = fabData(tasks, deadEnds);
    const uncapped = renderBriefing(data, { ...CFG, maxChars: 10_000_000 }).markdown;
    expect(uncapped.length).toBeGreaterThan(CFG.maxChars * 2.5);

    const r = renderBriefing(data, CFG);

    // The cap really bound, and it bound on the LIVE records.
    expect(r.markdown.length).toBeLessThanOrEqual(CFG.maxChars);
    expect(r.included.tasks).toBeLessThan(tasks.length);
    expect(r.droppedRecords).toBeGreaterThan(0);

    // THE FIX: not one dead-end was spent to buy that room.
    expect(r.included.deadEnds).toBe(deadEnds.length);
    for (const e of deadEnds) expect(r.markdown).toContain(e.headline);
    // SK5 heading: SERVED of POPULATION, both numbers, always.
    expect(r.markdown).toContain(`## Dead ends (${deadEnds.length} of ${deadEnds.length})`);
  });

  test('B: past the sub-budget the OLDEST dead-ends drop, and the section stays inside it', () => {
    // 400 dead-ends — far more than the reserved budget can hold.
    const deadEnds = Array.from({ length: 400 }, (_, i) => fabDeadEnd(i + 1));
    // The renderer is handed them newest-first, as gatherBriefingData sorts them.
    const newestFirst = [...deadEnds].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const data = fabData([], newestFirst);

    const r = renderBriefing(data, CFG);
    const lines = deadEndLines(r.markdown);

    // The budget is a real bound...
    expect(lines.length).toBeGreaterThan(0);
    const sectionChars = lines.reduce((sum, l) => sum + l.length + 1, 0);
    expect(sectionChars).toBeLessThanOrEqual(CFG.deadEndReservedChars);
    expect(lines.length).toBeLessThan(deadEnds.length);

    // ...and what it keeps is the NEWEST: the survivors are a prefix of newest-first.
    const survivorNumbers = lines.map((l) => Number(/DEADEND-(\d+)/.exec(l)![1]));
    const expectedNewest = newestFirst.slice(0, survivorNumbers.length).map((e) => Number(/DEADEND-(\d+)/.exec(e.headline)![1]));
    expect(survivorNumbers).toEqual(expectedNewest);
  });

  test('C3 empty/zero population: zero dead-ends renders the section, drops nothing, no crash', () => {
    const r = renderBriefing(fabData([fabTask(1)], []), CFG);
    expect(r.included.deadEnds).toBe(0);
    expect(r.markdown).toContain('## Dead ends (0)');
    expect(r.markdown).toContain('none');
    expect(r.droppedRecords).toBe(0);

    // A ZERO budget is the other edge: no dead-end can be admitted, and the renderer
    // still produces a valid document rather than looping or throwing.
    // A ZERO budget is the other edge, and it is now THE DIVERGENT SAMPLE for SK5's honest
    // counts: population 1, served 0. Before SK5 this rendered `## Dead ends (0)` — the
    // served count in the population's slot — which is indistinguishable from the genuinely
    // empty case above. It must now report BOTH numbers, name the budget that emptied it,
    // and NOT claim `none`.
    const zero = renderBriefing(fabData([], [fabDeadEnd(1)]), { ...CFG, deadEndReservedChars: 0 });
    expect(zero.included.deadEnds).toBe(0);
    expect(zero.markdown).toContain('## Dead ends (0 of 1)');
    expect(zero.markdown).toContain('1 of 1 not served — the dead-ends reserved budget');
    expect(zero.markdown).not.toContain('## Dead ends (0)\nnone');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * PART D — THE LABEL TELLS THE TRUTH (SK3).
 *
 * THE DEFECT THIS PINS. Every dead-end line was prefixed `tried and rejected:`, which is a
 * claim about how the record ended. Audited on the live riverbend briefing 2026-08-15: all
 * 8 rendered dead ends were superseded handoffs and superseded build reports — a handoff
 * replaced by its successor is bookkeeping, and NONE had been tried and rejected. The
 * section is user-visible boot text, so the prefix was a false statement on every boot.
 * ══════════════════════════════════════════════════════════════════════════════ */

describe('briefing dead-ends — D: the line states the record\'s actual basis', () => {
  const withBasis = (basis: BriefingDeadEnd['basis'], headline: string, reason: string): BriefingDeadEnd => ({
    id: `33333333-0000-0000-0000-00000000000${basis.length % 10}`,
    kind: 'decision',
    basis,
    headline,
    reason,
    createdAt: new Date(Date.UTC(2026, 5, 1)),
  });

  test('only a REFUTED record is rendered as rejected; the other three say what they are', () => {
    const cases: Array<[BriefingDeadEnd['basis'], string]> = [
      ['refuted', 'tried and rejected'],
      ['superseded', 'superseded'],
      ['deprecated', 'deprecated'],
      ['recorded', 'recorded dead end'],
    ];
    for (const [basis, label] of cases) {
      const e = withBasis(basis, `HEAD-${basis}`, `REASON-${basis}`);
      const md = renderBriefing(fabData([], [e]), CFG).markdown;
      const line = deadEndLines(md).find((l) => l.includes(`HEAD-${basis}`));
      expect(line, `a ${basis} dead end renders a line`).toBeTruthy();
      expect(line!.startsWith(`- ${label}: HEAD-${basis} — REASON-${basis}`)).toBe(true);
      // The specific falsehood, pinned: nothing but `refuted` may claim rejection.
      if (basis !== 'refuted') expect(line).not.toContain('tried and rejected');
    }
  });

  test('the live shape that produced the defect: a superseded handoff is not called rejected', () => {
    // Exactly the record class the audit found — a handoff whose successor replaced it.
    const handoff = withBasis(
      'superseded',
      '★ HANDOFF — 2026-08-15 (overnight build session, end state)',
      'superseded by 84ea8af0',
    );
    const md = renderBriefing(fabData([], [handoff]), CFG).markdown;
    expect(md).toContain('- superseded: ★ HANDOFF — 2026-08-15 (overnight build session, end state) — superseded by 84ea8af0');
    expect(md).not.toContain('tried and rejected');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * PART C — INTAKE, against the real database and the real write path.
 * ══════════════════════════════════════════════════════════════════════════════ */

const STAMP = Date.now();
const CONN = `sk6-deadend-conn-${STAMP}`;
const PROJ_NAME = `sk6-deadend-P-${STAMP}`;
const TAGGED_HEAD = `SK6 approach X cannot work ${STAMP}`;
const PREFIX_HEAD = `SK6 approach Y exhausted ${STAMP}`;
const CONTROL_HEAD = `SK6 ordinary untagged discussion ${STAMP}`;

let projectId: string;

describe('briefing dead-ends — C: tag intake, no supersession anywhere', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'sk6') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    const store = (content: string, tags: string[], type = 'discussion') =>
      routeExecutor('context_store', { content, type, tags }, { connectionId: CONN });

    // The canonical dead end: a plain discussion context, tagged. NO supersedes edge.
    await store(`${TAGGED_HEAD}\nfull body detail that must not render as a dead-end line`, [
      CFG.deadEndTags[0],
    ]);
    // The `<value>:` prefixed form of the same vocabulary (house ref:-style namespacing).
    await store(`${PREFIX_HEAD}\nmore body`, [`${CFG.deadEndTags[0]}:approach-y`], 'error');
    // Control: same shape, no dead-end tag — must NOT be pulled in.
    await store(`${CONTROL_HEAD}\nbody`, ['planning-note']);
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM links WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  test('a TAGGED plain context reaches Dead ends; an untagged sibling does not', async () => {
    const r = await buildProjectBriefing(projectId, PROJ_NAME, db);
    const lines = deadEndLines(r.markdown);

    // No supersession exists in this project at all — the old intake would find nothing.
    const edges = await db.query(
      `SELECT count(*)::int AS n FROM links WHERE project_id = $1 AND edge_type = 'supersedes'`,
      [projectId],
    );
    expect(edges.rows[0].n).toBe(0);

    expect(lines.some((l) => l.includes(TAGGED_HEAD))).toBe(true);
    expect(lines.some((l) => l.includes(PREFIX_HEAD))).toBe(true);
    expect(lines.some((l) => l.includes(CONTROL_HEAD))).toBe(false);
    expect(r.markdown).not.toContain(CONTROL_HEAD);

    // One-liner discipline holds: the headline rides, the body does not.
    expect(r.markdown).not.toContain('full body detail that must not render');
    // The line names the SIGNAL that admitted it, so a reader can trace the rule.
    expect(r.markdown).toContain(`recorded as a dead end [tags: ${CFG.deadEndTags[0]}]`);
    // …and the LABEL matches that signal end-to-end, through the real intake path (SK3):
    // the author declared it, nobody tried and rejected it.
    expect(lines.find((l) => l.includes(TAGGED_HEAD))!.startsWith('- recorded dead end: ')).toBe(true);
    expect(r.markdown).not.toContain('tried and rejected');
  });
});
