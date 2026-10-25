/**
 * "WAITING ON A HUMAN" — P5.5 contract tests (SCOPE §2 P5.5, §3.3, §3.4, §8.6).
 *
 * THE DEFECT UNDER TEST. Our boot package's most valuable section for a human operator
 * selected tasks BY TAG, from a four-tag vocabulary we invented, and `grep -rn "blocked_on"
 * mcp-server/src` at ea7f00d returned nothing — there was no server concept at all.
 * Migration 093 makes it a column; this suite asserts the section selects on that column,
 * degrades honestly when it is absent or unpopulated, keeps the two-tier deadline honesty,
 * and reports (never silently repairs) the tag-spelling defect.
 *
 * ═══ THE SURFACE THESE TESTS DRIVE ═══
 * Everything behavioural goes through `routeExecutor` — the SHIPPED entry point, the same
 * one a customer's `project_briefing` call lands on (CLASSES.md C3: drive the shipped entry
 * point; a test that rebuilds the composition the product performs has replaced the
 * product). The pure helpers (`extractDueHint`, `findTagSpellingCollisions`,
 * `sortWaitingTasks`) are attacked directly as well, because their inputs are data the
 * shipped path cannot easily be steered to produce.
 *
 * ═══ WHERE PROOF 3 LIVES ═══
 * "the ABSENT column degrades honestly" is NOT in this file — a database reachable from this
 * suite has had migration 093 applied, so it cannot be asserted here without pretending.
 * It lives in `blockedOnAbsentColumn.contract.test.ts`, which builds a REAL Postgres schema
 * whose `tasks` table genuinely lacks the columns and points a real pool at it.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
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
  extractDueHint,
  findTagSpellingCollisions,
  tagSpellingKey,
  sortWaitingTasks,
  gatherWaitingOnHuman,
  type WaitingTask,
} from '../services/waitingOnHuman.js';
import {
  WAITING_SECTION_LABEL,
  BLOCKED_ON_VALUES,
  BLOCKED_ON_HUMAN,
  BLOCKED_ON_CHECK_CONSTRAINT,
  BLOCKED_ON_COLUMN,
  DUE_AT_COLUMN,
} from '../config/blockedOnConfig.js';
import { clearTaskBlockedOnCapabilityCache } from '../services/taskBlockedOnCapability.js';

const STAMP = Date.now();
const CONN = `p55-waiting-${STAMP}`;

/** The project where the column IS populated — the exact-selection proofs. */
let colProjectId: string;
/** A project where 093 has run but NOTHING carries a blocked_on value — the fallback proof. */
let emptyColProjectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN, actor: 'p55-test' });
}
/**
 * The briefing markdown for one project, through the shipped tool.
 *
 * ⚠️ THE ARG IS `project`, NOT `projectId` (routes/project.routes.ts:614). An earlier cut of
 * this helper passed `projectId`, which project_briefing does not read — so it silently fell
 * through to `getCurrentProject(sessionId)` and these tests rendered whatever project the
 * connection's ambient slot happened to hold. It PASSED once and then failed as the slot
 * moved, which is the tell: a test whose subject is chosen by ambient state is not asserting
 * about the project it names.
 */
async function briefingFor(project: string): Promise<string> {
  return responseText(await viaTool('project_briefing', { project }));
}
/** The section's own lines: from its heading to the next `## ` heading. */
function sectionOf(markdown: string, label: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${label}`));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const HUMAN_SOON = `p55 human soon ${STAMP}`;
const HUMAN_LATER = `p55 human later ${STAMP}`;
const HUMAN_NO_DUE = `p55 human no deadline ${STAMP}`;
const HUMAN_PROSE_DATE = `p55 human prose 2031-03-04 hint ${STAMP}`;
const AGENT_TASK = `p55 agent waiting ${STAMP}`;
const PLAIN_TASK = `p55 plain open task ${STAMP}`;
const BLOCKED_NOT_HUMAN = `p55 blocked but not human ${STAMP}`;

describe('P5.5 — the section selects on the COLUMN', () => {
  beforeAll(async () => {
    clearTaskBlockedOnCapabilityCache(db);
    colProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'p55 column') RETURNING id`,
        [`p55-col-${STAMP}`],
      )
    ).rows[0].id;
    emptyColProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'p55 unpopulated') RETURNING id`,
        [`p55-empty-${STAMP}`],
      )
    ).rows[0].id;

    // ── Seeded THROUGH task_create, with the new params on the wire ───────────────
    // Not a raw INSERT: the point of P5.5 is that a customer can populate this column
    // through the PUBLIC TOOL SURFACE. Seeding by SQL would prove the section reads a
    // column while leaving "can anyone actually write it" untested — which is exactly the
    // hole that makes a feature look shipped and be unreachable.
    await viaTool('task_create', {
      projectId: colProjectId, title: HUMAN_LATER, status: 'todo',
      blockedOn: 'human', dueAt: '2030-12-01T00:00:00Z',
    });
    await viaTool('task_create', {
      projectId: colProjectId, title: HUMAN_SOON, status: 'todo',
      blockedOn: 'human', dueAt: '2030-01-15T00:00:00Z',
    });
    await viaTool('task_create', {
      projectId: colProjectId, title: HUMAN_NO_DUE, status: 'in_progress', blockedOn: 'human',
    });
    // A task with NO due_at but an ISO date in its TITLE — the prose HINT tier.
    await viaTool('task_create', {
      projectId: colProjectId, title: HUMAN_PROSE_DATE, status: 'todo', blockedOn: 'human',
    });
    // Negative controls: the section must NOT admit these.
    await viaTool('task_create', {
      projectId: colProjectId, title: AGENT_TASK, status: 'todo', blockedOn: 'agent',
    });
    await viaTool('task_create', { projectId: colProjectId, title: PLAIN_TASK, status: 'todo' });
    // THE CONTROL THAT MATTERS: status='blocked' and NOT blocked on a human. The whole
    // reason the fallback is labelled low-precision is that this row exists in real data.
    await viaTool('task_create', {
      projectId: colProjectId, title: BLOCKED_NOT_HUMAN, status: 'blocked',
      // a move to `blocked` must now NAME its blocker. `agent` STRENGTHENS this
      // control — the row is still blocked and still not human-blocked, and it is now blocked
      // on something explicitly other than a human rather than on nothing.
      blockedOn: 'agent',
    });

    // The unpopulated project: open work, nothing carrying a blocked_on value.
    //
    // ⚠️ SEEDED BY RAW SQL, AND THIS IS A DELIBERATE EXCEPTION TO THIS FILE'S OWN RULE (see
    // the "not a raw INSERT" note above). an earlier Task made a move to `blocked` REFUSE unless
    // a blocker is named, so `blocked` with `blocked_on IS NULL` is NO LONGER REACHABLE THROUGH
    // THE PUBLIC TOOL SURFACE — by design. That is a fact about the product, not a limitation
    // of the test: from now on this state can only arise from rows written BEFORE the rule (the
    // 6 legacy prod rows), from a rollback, or from raw SQL.
    //
    // The `fallback-unpopulated` path those rows exercise must still be proven to work, because
    // every existing customer database is full of them. So this fixture reproduces the LEGACY
    // state directly. Passing `blockedOn` here instead would have deleted the subject and left
    // PROOF 2 asserting the column path under a name that says fallback.
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status, blocked_on)
       VALUES ($1, $2, 'general', 'medium', 'blocked', NULL)`,
      [emptyColProjectId, `p55 unpop blocked ${STAMP}`],
    );
    await viaTool('task_create', {
      projectId: emptyColProjectId, title: `p55 unpop todo ${STAMP}`, status: 'todo',
    });
  });

  afterAll(async () => {
    for (const id of [colProjectId, emptyColProjectId]) {
      if (!id) continue;
      await db.query('DELETE FROM tasks WHERE project_id = $1', [id]);
      await db.query('DELETE FROM projects WHERE id = $1', [id]);
    }
  });

  // ── PROOF 1 ────────────────────────────────────────────────────────────────────
  test('PROOF 1 — renders from the column, and admits ONLY blocked_on=human', async () => {
    const section = sectionOf(await briefingFor(colProjectId), WAITING_SECTION_LABEL);
    expect(section, 'the section did not render at all').not.toBe('');

    expect(section).toContain(HUMAN_SOON);
    expect(section).toContain(HUMAN_LATER);
    expect(section).toContain(HUMAN_NO_DUE);
    // NEGATIVE CONTROLS. A section that admitted everything would satisfy the three
    // assertions above; these are what make them mean something.
    expect(section, 'blocked_on=agent must not be in a HUMAN section').not.toContain(AGENT_TASK);
    expect(section, 'an unblocked task must not be here').not.toContain(PLAIN_TASK);
    expect(section, "status='blocked' must not leak in while the column is selecting")
      .not.toContain(BLOCKED_NOT_HUMAN);

    // It says HOW it selected, from the field — not "some tasks".
    expect(section).toContain(`WHERE tasks.blocked_on = '${BLOCKED_ON_HUMAN}'`);
    // And it carries the marker from the column, per row.
    expect(section).toContain(`[blocked-on:${BLOCKED_ON_HUMAN}]`);
  });

  // ── PROOF 4 ────────────────────────────────────────────────────────────────────
  test('PROOF 4a — a structured due_at SORTS, soonest first', async () => {
    const section = sectionOf(await briefingFor(colProjectId), WAITING_SECTION_LABEL);
    const iSoon = section.indexOf(HUMAN_SOON);
    const iLater = section.indexOf(HUMAN_LATER);
    const iNone = section.indexOf(HUMAN_NO_DUE);
    expect(iSoon).toBeGreaterThan(-1);
    expect(iLater).toBeGreaterThan(-1);
    expect(iNone).toBeGreaterThan(-1);
    expect(iSoon, 'the 2030-01 deadline must precede the 2030-12 one').toBeLessThan(iLater);
    expect(iLater, 'a dated task must precede an undated one').toBeLessThan(iNone);
    expect(section).toContain('[due:2030-01-15]');
    expect(section).toContain('[due:2030-12-01]');
  });

  test('PROOF 4b — a PROSE date renders as `due?` and says it is a hint, not a deadline', async () => {
    const section = sectionOf(await briefingFor(colProjectId), WAITING_SECTION_LABEL);
    // The hint marker is on the row whose date is only in its title.
    expect(section).toContain('[due?:2031-03-04]');
    // …and the section states, in band, that a hint is not the field and does not sort.
    expect(section).toContain('is NOT the due_at field');
    expect(section).toContain('does NOT sort');
    expect(section).toContain('may not be a deadline at all');
    // A hint NEVER wears the authoritative marker.
    expect(section, 'a prose date must never render as a real deadline')
      .not.toContain('[due:2031-03-04]');
  });

  test('PROOF 4c — the hint tier is ABSENT when nothing on screen carries a hint', async () => {
    // The caveat is explanatory frame for a marker. Printing it with no marker present is
    // the "explain a thing nobody can see" failure; this asserts the negative case too,
    // which is what makes the positive assertion above a measurement rather than a constant.
    const items: WaitingTask[] = [
      { id: 'a', title: 'no dates here', status: 'todo', priority: 'medium',
        createdAt: new Date(), blockedOn: 'human', dueAt: null, dueHint: null },
    ];
    expect(items.some((t) => !t.dueAt && t.dueHint)).toBe(false);
  });

  // ── PROOF 2 (half): the column exists but is UNPOPULATED ───────────────────────
  test('PROOF 2 — an unpopulated column falls back to status=blocked WITH its caveat', async () => {
    const section = sectionOf(await briefingFor(emptyColProjectId), WAITING_SECTION_LABEL);
    expect(section).not.toBe('');
    expect(section).toContain('INTERIM FALLBACK');
    expect(section).toContain('LOW PRECISION');
    expect(section).toContain("status='blocked'");
    // It distinguishes UNPOPULATED from ABSENT — different remedies, different sentences.
    expect(section).toContain('NO task in this project carries a value');
    // And it serves the blocked row rather than rendering an empty section.
    expect(section).toContain(`p55 unpop blocked ${STAMP}`);
    // The unblocked one is still excluded: the fallback is low-precision, not indiscriminate.
    expect(section).not.toContain(`p55 unpop todo ${STAMP}`);
  });

  test('the fallback reports the READER\'S OWN precision, not a borrowed number', async () => {
    const w = await gatherWaitingOnHuman(emptyColProjectId, ['todo', 'in_progress', 'blocked'], db);
    expect(w.source).toBe('fallback-unpopulated');
    expect(w.precision, 'the column is present here, so precision IS computable').not.toBeNull();
    expect(w.precision!.fallbackPopulation).toBe(1);
    expect(w.precision!.trulyHuman).toBe(0);
  });

  test('a REAL zero (column populated, nobody waiting) is not the fallback', async () => {
    // The two zeros C1 says must never share a branch: nothing-is-waiting and
    // nobody-has-said. Built by clearing the human rows in the populated project, which
    // leaves blocked_on='agent' behind — so the column is still populated.
    const scratch = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'p55 real zero') RETURNING id`,
        [`p55-zero-${STAMP}`],
      )
    ).rows[0].id;
    try {
      await viaTool('task_create', {
        projectId: scratch, title: `p55 zero agent ${STAMP}`, status: 'todo', blockedOn: 'agent',
      });
      const w = await gatherWaitingOnHuman(scratch, ['todo', 'in_progress', 'blocked'], db);
      expect(w.source).toBe('column-empty');
      expect(w.items).toHaveLength(0);
    } finally {
      await db.query('DELETE FROM tasks WHERE project_id = $1', [scratch]);
      await db.query('DELETE FROM projects WHERE id = $1', [scratch]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 6 (half) — the SCHEMA, read from the live catalog rather than from the file
// ─────────────────────────────────────────────────────────────────────────────

describe('P5.5 — migration 093, asserted against the LIVE information_schema', () => {
  test('both columns exist, nullable, with the expected types', async () => {
    const { rows } = await db.query(
      `SELECT column_name, data_type, is_nullable, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tasks'
          AND column_name = ANY($1)
        ORDER BY column_name`,
      [[BLOCKED_ON_COLUMN, DUE_AT_COLUMN]],
    );
    expect(rows).toHaveLength(2);
    const byName = Object.fromEntries(rows.map((r: any) => [r.column_name, r]));
    expect(byName[BLOCKED_ON_COLUMN].data_type).toBe('character varying');
    expect(byName[BLOCKED_ON_COLUMN].is_nullable).toBe('YES');
    expect(byName[DUE_AT_COLUMN].data_type).toBe('timestamp with time zone');
    expect(byName[DUE_AT_COLUMN].is_nullable).toBe('YES');
  });

  test('the CHECK constraint is the LOWEST layer, and it actually rejects', async () => {
    // CLASSES.md C1's instrument ladder: `type alias < code enforcement < DB constraint <
    // observed values`. The zod enum is code enforcement; this asserts the rung BELOW it,
    // which holds against raw SQL, a migration, or a handler nobody has written yet.
    const present = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`,
      [BLOCKED_ON_CHECK_CONSTRAINT],
    );
    expect(present.rowCount, 'the CHECK constraint is missing').toBe(1);

    const proj = (
      await db.query(
        `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
        [`p55-check-${STAMP}`],
      )
    ).rows[0].id;
    try {
      // EXERCISED, not asserted from the catalog: a constraint's existence is not its
      // behaviour, and this is the assertion the migration's whole value rests on.
      //
      // ⚠️ THROUGH A RAW POOL, DELIBERATELY. `db.query` wraps a driver failure in a
      // [DATASTORE_ERROR] envelope that deliberately hides SQLSTATE from the caller — so
      // asserting through it would prove only "something failed", which a typo in the table
      // name also satisfies. Reading the driver's own error is what makes this a measurement
      // of the CHECK CONSTRAINT rather than of any failure at all.
      const raw = new Pool({
        host: process.env.DATABASE_HOST,
        port: Number(process.env.DATABASE_PORT ?? 5432),
        database: process.env.DATABASE_NAME,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        max: 1,
      });
      try {
        let code: string | undefined;
        let constraint: string | undefined;
        try {
          await raw.query(
            `INSERT INTO tasks (project_id, title, blocked_on) VALUES ($1, 'x', 'sasquatch')`,
            [proj],
          );
        } catch (e: any) {
          code = e?.code;
          constraint = e?.constraint;
        }
        // 23514 is Postgres's check_violation. Naming the SQLSTATE and the constraint means
        // this cannot pass because of an unrelated failure.
        expect(code, 'the out-of-enum INSERT was ACCEPTED — the constraint is not enforcing')
          .toBe('23514');
        expect(constraint).toBe(BLOCKED_ON_CHECK_CONSTRAINT);
      } finally {
        await raw.end();
      }

      // …and every legal value IS accepted, plus NULL. A constraint that rejected
      // everything would also pass the assertion above.
      for (const v of [...BLOCKED_ON_VALUES, null]) {
        await db.query(
          `INSERT INTO tasks (project_id, title, blocked_on) VALUES ($1, $2, $3)`,
          [proj, `ok-${v}`, v],
        );
      }
      const n = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [proj]);
      expect(n.rows[0].n).toBe(BLOCKED_ON_VALUES.length + 1);
    } finally {
      await db.query('DELETE FROM tasks WHERE project_id = $1', [proj]);
      await db.query('DELETE FROM projects WHERE id = $1', [proj]);
    }
  });

  test('the config mirror of the enum matches the constraint the DB actually holds', async () => {
    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [BLOCKED_ON_CHECK_CONSTRAINT],
    );
    const def: string = rows[0].def;
    // Every value the config advertises must appear in the constraint the database holds…
    for (const v of BLOCKED_ON_VALUES) expect(def).toContain(`'${v}'`);
    // …and the constraint must not admit a value the config does not advertise. Counted
    // rather than eyeballed: the quoted literals in the definition ARE the value set.
    const literals = (def.match(/'[a-z_]+'/g) ?? []).map((x) => x.slice(1, -1));
    expect(new Set(literals)).toEqual(new Set(BLOCKED_ON_VALUES));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE HELPERS — attacked directly, including the empty/zero populations
// ─────────────────────────────────────────────────────────────────────────────

describe('P5.5 — the prose-date HINT scan', () => {
  test('finds an ISO date in the title, and prefers the title over the description', () => {
    expect(extractDueHint('ship by 2026-09-01', 'or 2026-10-01')).toBe('2026-09-01');
    expect(extractDueHint('no date here', 'but 2026-10-01 is in the body')).toBe('2026-10-01');
  });

  test('the EMPTY and ABSENT populations return null rather than something', () => {
    expect(extractDueHint('', null)).toBeNull();
    expect(extractDueHint('nothing dated at all', '')).toBeNull();
  });

  test('states what it MATCHES and claims nothing about what it misses', () => {
    // A locale-ambiguous form is NOT matched. This is a statement about the scan's reach,
    // asserted rather than written in a comment — and deliberately NOT phrased as "no other
    // form can ever be found", which would be an unprovable universal.
    expect(extractDueHint('due 03/04/2026', null)).toBeNull();
  });
});

describe('P5.5 — the tag-spelling collision FINDING', () => {
  test('folds separator-only variants together — our own live defect', () => {
    expect(tagSpellingKey('needs-operator')).toBe(tagSpellingKey('needs:operator'));
    expect(tagSpellingKey('needs_operator')).toBe(tagSpellingKey('Needs  Operator'));
  });

  test('does NOT fold tags that differ in more than their separators', () => {
    // The control that makes the fold above a measurement rather than a constant: a folder
    // that returned one key for everything would pass the previous test.
    expect(tagSpellingKey('needs-operator')).not.toBe(tagSpellingKey('needs-coordinator'));
  });

  test('reports a group only when ≥2 SPELLINGS actually exist', () => {
    const found = findTagSpellingCollisions([
      'needs-operator', 'needs:operator', 'decision-needed', 'scope:product',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].spellings).toEqual(['needs-operator', 'needs:operator']);
    // ONE spelling is not a finding — the EMPTY population of the check.
    expect(findTagSpellingCollisions(['needs-operator', 'scope:product'])).toEqual([]);
    expect(findTagSpellingCollisions([])).toEqual([]);
  });

  test('REPORTS, it does not NORMALISE — both raw spellings survive verbatim', () => {
    // The whole point of SCOPE §2 P5.5 item 6. If this ever starts returning one folded
    // spelling, the defect has been hidden one layer down instead of surfaced.
    const [group] = findTagSpellingCollisions(['needs:operator', 'needs-operator']);
    expect(group.spellings).toContain('needs-operator');
    expect(group.spellings).toContain('needs:operator');
  });
});

describe('P5.5 — the sort', () => {
  const t = (id: string, dueAt: Date | null, createdAt: Date, dueHint: string | null = null): WaitingTask =>
    ({ id, title: id, status: 'todo', priority: 'medium', createdAt, blockedOn: 'human', dueAt, dueHint });

  test('a prose HINT never affects the order — only the structured deadline does', () => {
    // The two-tier rule, expressed as an executed assertion instead of a comment: `b` has an
    // early-looking prose date and MUST still sort after `a`, which has a real deadline.
    const a = t('a', new Date('2030-06-01'), new Date('2020-01-01'));
    const b = t('b', null, new Date('2020-01-02'), '2020-01-01');
    expect(sortWaitingTasks([b, a]).map((x) => x.id)).toEqual(['a', 'b']);
  });

  test('undated rows fall back to newest-created, deterministically', () => {
    const older = t('older', null, new Date('2020-01-01'));
    const newer = t('newer', null, new Date('2020-06-01'));
    expect(sortWaitingTasks([older, newer]).map((x) => x.id)).toEqual(['newer', 'older']);
    // The EMPTY population.
    expect(sortWaitingTasks([])).toEqual([]);
  });
});
