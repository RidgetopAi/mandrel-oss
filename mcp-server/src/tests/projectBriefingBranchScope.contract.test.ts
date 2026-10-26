/**
 * SK5 — BRANCH-SCOPED BRIEFING SELECTION + HONEST PER-SECTION COUNTS
 * (STRONG BONES an earlier spine; an earlier decision.)
 *
 * TWO DEFECTS, PROVED SEPARATELY BECAUSE THEY HAVE SEPARATE CAUSES:
 *
 *   1. THE COUNT LIED. `renderBriefing` printed the SERVED count in the slot a reader reads
 *      as the population, and emitted the literal word `none` whenever the served set was
 *      empty — including when the cap had just evicted every record in a non-empty section.
 *      Reproduced against live prod 2026-08-16 (project riverbend): `## Open tasks (1)`,
 *      `## Decisions (0) none`, `## Conventions (0) none`, against measured populations of
 *      190 / 156 / 1. THE SMALLEST INPUT WHERE THE FIXED AND BROKEN BRANCHES DIVERGE is
 *      population > 0 with served == 0 — a test that only exercises the genuinely-empty
 *      project cannot tell the two apart, and the pre-SK5 suite only exercised that one.
 *      Both divergent samples are in the population below: (0 of N) and (k of N, 0<k<N).
 *
 *   2. SELECTION IGNORED THE READER. `projectBriefing.ts` referenced branches ZERO times, so
 *      a saturated project served the global newest no matter which branch the handoff's
 *      PATH said was being resumed. Membership is a STORED FACT since SK2 (migration 086,
 *      the `branch_membership` view), so scoping is a flat equality — NOT a graph walk, which
 *      is what rounds 1 and 2 of SK2 tried and got confidently wrong.
 *
 * PART A is behavioral through routeExecutor against the CI Postgres — the same wire a
 * SessionStart hook reads, with a REAL `branch_open` establishing the position. PART B
 * attacks the pure renderer with fabricated corpora where the census and the drop order are
 * under test control.
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
  buildProjectBriefing,
  renderBriefing,
  briefingConfig,
  type BriefingData,
  type BriefingTask,
  type BriefingBranchMember,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { censusFor, censusOf } from './helpers/briefingCensus.js';
import { MEMBERSHIP_SOURCE, type MembershipSource } from '../config/membershipSourceConfig.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';

/**
 * The fabricated corpus's ONE handoff id. Named so `handoffHead` can be DERIVED from it
 * rather than repeating the literal — a resolution naming a different id than the record
 * it is shown beside would render a header about a record the document is not serving.
 */
const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';


const STAMP = Date.now();
const CONN = `sk5-branch-conn-${STAMP}`;
const PROJ_NAME = `sk5-branch-P-${STAMP}`;

let projectId: string;
/** The two spines the test stands on, and the records written while standing there. */
let spineA = '';
let spineB = '';
let memberA = '';
let memberB = '';
let parkedTaskId = '';
let blockedTaskId = '';

const HANDOFF_BODY = `SK5-HANDOFF-${STAMP} resume point`;
const MEMBER_A_MARK = `SK5-MEMBER-A-${STAMP}`;
const MEMBER_B_MARK = `SK5-MEMBER-B-${STAMP}`;
const PARKED_TITLE = `sk5 parked task ${STAMP}`;
const BLOCKED_TITLE = `sk5 blocked task ${STAMP}`;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN });
}
const short = (id: string): string => id.slice(0, 8);

/**
 * THE SHIPPED CONFIG WITH THE SK5 FLAG ON (the operator's ruling 2026-08-16: default OFF).
 *
 * The ON-state tests go through buildProjectBriefing with this rather than through
 * routeExecutor, because the flag is read at module load and the route has no parameter for
 * it — so a route-level ON test would be testing the test harness's import order. Everything
 * below it is still REAL: the same CI Postgres, the same gather, and memberships minted by
 * the real write path in beforeAll. The route is exercised separately, at its SHIPPED
 * default, which is the state that protects tenants and therefore the one that must be
 * proved on the wire.
 */
const flagOn = () => ({ ...briefingConfig(), branchScopeEnabled: true });

/** The `- ` record lines of one `## <label>` section, read positionally. */
function sectionLines(markdown: string, headingPrefix: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l);
  }
  return out;
}
/** The one `## <label> (...)` heading line, or undefined when the section is absent. */
function headingLine(markdown: string, headingPrefix: string): string | undefined {
  return markdown.split('\n').find((l) => l.startsWith(headingPrefix));
}

describe('SK5 — PART A: the reader\'s branch selects, on the real wire', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'sk5 branch scope') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    await viaTool('context_store', { content: HANDOFF_BODY, type: 'handoff' });

    // TWO SPINES. Each is a task; a context is then written WHILE STANDING ON IT, through
    // the real write path — so membership is minted by positionalMint into
    // `branch_memberships` exactly as it is in production. Nothing is inserted by hand:
    // a hand-inserted membership row would prove the renderer reads a table, not that the
    // system records what the reader did.
    spineA = (await viaTool('task_create', { title: `sk5 spine A ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;
    spineB = (await viaTool('task_create', { title: `sk5 spine B ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;

    await viaTool('branch_open', { id: spineA });
    memberA = (await viaTool('context_store', { content: `${MEMBER_A_MARK} branch A note`, type: 'planning' }))
      .structuredContent.context.id;
    await viaTool('branch_close', {});

    await viaTool('branch_open', { id: spineB });
    memberB = (await viaTool('context_store', { content: `${MEMBER_B_MARK} branch B note`, type: 'planning' }))
      .structuredContent.context.id;
    await viaTool('branch_close', {});

    // A parked task (scope (e)) and a blocked task (scope (b), the always-surface floor).
    parkedTaskId = (
      await viaTool('task_create', {
        title: PARKED_TITLE,
        type: 'general',
        status: 'todo',
        tags: ['parked:runtime-freeze-2026-08-27'],
      })
    ).structuredContent.task.id;
    blockedTaskId = (
      await viaTool('task_create', { title: BLOCKED_TITLE, type: 'general', status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', })
    ).structuredContent.task.id;

    // PRECONDITION, asserted rather than assumed: the write path really did record the two
    // memberships. If it did not, every branch assertion below would pass vacuously against
    // an empty branch, which is the hollow-guard failure this file exists to avoid.
    const rows = await db.query(
      `SELECT record_id::text AS id, spine_id::text AS spine FROM branch_memberships
        WHERE project_id = $1 ORDER BY created_at`,
      [projectId],
    );
    expect(
      rows.rows.map((r: any) => `${r.id}@${r.spine}`).sort(),
      'fixture precondition: both positioned writes recorded a membership',
    ).toEqual([`${memberA}@${spineA}`, `${memberB}@${spineB}`].sort());
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [projectId]);
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

  test('POSITIONED on branch A: the briefing serves A\'s members, and says which spine it used', async () => {
    await viaTool('branch_open', { id: spineA });
    const b = await buildProjectBriefing(projectId, PROJ_NAME, db, flagOn(), spineA);

    // ASSERT ON THE EVENT: which spine the selection was scoped to is a FIELD, not prose.
    expect(b.spineId).toBe(spineA);

    const text = b.markdown;
    expect(headingLine(text, '## On this branch')).toContain(`[spine:${short(spineA)}]`);
    const served = sectionLines(text, '## On this branch');
    expect(served).toHaveLength(1);
    expect(served[0]).toContain(short(memberA));
    expect(served[0]).toContain(MEMBER_A_MARK);
    // ...and NOT the other branch's member. This is the assertion that fails if selection
    // reverts to "the global newest": memberB is NEWER than memberA.
    expect(served[0]).not.toContain(short(memberB));
    await viaTool('branch_close', {});
  });

  test('A SECOND branch serves ITS OWN member, not the global newest', async () => {
    await viaTool('branch_open', { id: spineB });
    const b = await buildProjectBriefing(projectId, PROJ_NAME, db, flagOn(), spineB);
    expect(b.spineId).toBe(spineB);
    const served = sectionLines(b.markdown, '## On this branch');
    expect(served).toHaveLength(1);
    expect(served[0]).toContain(short(memberB));
    expect(served[0]).not.toContain(short(memberA));
    await viaTool('branch_close', {});
  });

  test('UNPOSITIONED: no branch section, spineId null — the trunk fallback is unchanged', async () => {
    await viaTool('branch_close', {});
    const resp = await viaTool('project_briefing', {});
    expect(resp.structuredContent.briefing.spineId).toBeNull();
    const text = responseText(resp);
    expect(headingLine(text, '## On this branch')).toBeUndefined();
    // The fallback still renders the global document in full.
    expect(text).toContain(HANDOFF_BODY);
    expect(text).toContain('## Open tasks (');
    expect(text).toContain('## Dead ends (');
  });

  test('parked tasks are EXCLUDED before selection, and the exclusion is DISCLOSED', async () => {
    const resp = await buildProjectBriefing(projectId, PROJ_NAME, db, flagOn(), null);
    const text = resp.markdown;
    // The parked task is not served...
    expect(text).not.toContain(PARKED_TITLE);
    // ...and the reader is told, with the count and the config knob that did it. An
    // exclusion the reader cannot see is the same defect as the count that lied.
    const heading = headingLine(text, '## Open tasks')!;
    expect(heading).toBeDefined();
    const notes = text.split('\n')[text.split('\n').indexOf(heading) + 1];
    expect(notes).toContain('1 excluded before selection');
    expect(notes).toContain('MANDREL_BRIEFING_EXCLUDED_TASK_TAGS');
    // The census is a FIELD, not only a sentence in the markdown.
    expect(resp.data.census.tasks.excluded).toBe(1);
    // Live work is unaffected: the blocked task is still served.
    expect(text).toContain(BLOCKED_TITLE);
    expect(blockedTaskId).not.toBe(parkedTaskId); // ids are distinct records, not one row twice
  });

  /* ────────────────────────────────────────────────────────────────────────────────────
   * THE FLAG (the operator's ruling 2026-08-16: riverbend-first, DEFAULT OFF).
   *
   * THE DIVERGENT SAMPLE IS THE OFF STATE WITH A CALLER HOLDING A POSITION. A suite that
   * only exercised the ON state could not tell a working flag from an ignored one, and a
   * suite that only exercised OFF-while-unpositioned could not either — an unpositioned
   * caller renders unpositioned whatever the flag says. The case that protects tenants is
   * a caller who IS standing on a branch and must still be served the global fallback.
   * ──────────────────────────────────────────────────────────────────────────────────── */

  test('FLAG DEFAULT IS OFF WITH NO ENV SET AT ALL — absence, not an explicit false', () => {
    // Assert on ABSENCE first, or this degrades into "off when someone set it off".
    expect(
      process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED,
      'this assertion is about the ABSENT-env default; the suite must not set the var',
    ).toBeUndefined();
    expect(briefingConfig().branchScopeEnabled).toBe(false);
  });

  test('THE DIVERGENT SAMPLE — flag OFF while HOLDING a position: renders unpositioned', async () => {
    await viaTool('branch_open', { id: spineA });
    // Precondition: the position really is open, so the assertion below is about the FLAG
    // and not about an absent position.
    const pos = await db.query(
      `SELECT spine_id::text AS spine FROM branch_positions WHERE project_id = $1`,
      [projectId],
    );
    expect(pos.rows.map((r: any) => r.spine)).toContain(spineA);

    // ...and the SHIPPED route, at the SHIPPED default, serves the trunk fallback.
    const resp = await viaTool('project_briefing', {});
    const text = responseText(resp);
    expect(resp.structuredContent.briefing.spineId).toBeNull();
    expect(headingLine(text, '## On this branch')).toBeUndefined();
    expect(text).not.toContain(MEMBER_A_MARK);
    // The parked exclusion and the always-surface floor are gated by the same flag: OFF
    // means pre-SK5 selection, so the parked task is served again and nothing is excluded.
    expect(text).toContain(PARKED_TITLE);
    expect(resp.structuredContent.briefing.census.tasks.excluded).toBe(0);
    await viaTool('branch_close', {});
  });

  test('the census is NOT gated by the flag: honest counts reach everyone', async () => {
    // A correction that a knob can switch back off is a knob that can re-ship the defect.
    const resp = await viaTool('project_briefing', {});
    const text = responseText(resp);
    expect(resp.structuredContent.briefing.spineId).toBeNull(); // i.e. the flag is OFF here
    expect(resp.structuredContent.briefing.census).toBeDefined();
    for (const label of ['## Open tasks', '## Decisions', '## Conventions', '## Dead ends']) {
      const heading = headingLine(text, label);
      expect(heading, `${label} must be present with the flag OFF`).toBeDefined();
      expect(
        /^## .+ \((0|\d+ of \d+\+?)\)$/.test(heading!),
        `${label} must still carry the census with the flag OFF, got: ${heading}`,
      ).toBe(true);
    }
  });

  test('F1: spine_source reaches the render THROUGH THE REAL READ — not just the pure renderer', async () => {
    // WHY THIS TEST EXISTS, in its own words: the pure-renderer assertions for the approximate
    // marker were HOLLOW at this layer. A mutation probe that deleted `bm.spine_source` from
    // readBranchMemberSummaries' SELECT left the whole suite GREEN, because every marker
    // assertion fabricated its members and never crossed the view. The population a guard
    // enumerates has to include the query that supplies the field.
    //
    // Branch A's member was minted by the real write path, so it is 'recorded'. This flips
    // that row to 'legacy-approx' — exactly the value migration 086's backfill writes for
    // pre-086 data, which is 82% of prod — and asserts the value SURVIVES the read.
    await db.query(
      `UPDATE branch_memberships SET source = 'legacy-approx' WHERE record_id = $1`,
      [memberA],
    );
    try {
      const approxRender = await buildProjectBriefing(projectId, PROJ_NAME, db, flagOn(), spineA);
      const line = sectionLines(approxRender.markdown, '## On this branch')[0];
      expect(line, 'the approximate member must still be served').toContain(MEMBER_A_MARK);
      expect(line).toContain('[spine-source:legacy-approx]');
      expect(approxRender.markdown).toContain('1 of 1 shown are APPROXIMATE members');
      expect(approxRender.markdown).toContain('does not claim the rest is exact');
      // The FIELD reached the data, not only the string.
      expect(approxRender.data.branch!.members[0].spineSource).toBe('legacy-approx');

      // THE CONTROL, through the same read: branch B's member is untouched and 'recorded',
      // so it carries no marker and no caveat. Without this the assertions above would pass
      // against a renderer that stamped every line unconditionally.
      const recordedRender = await buildProjectBriefing(projectId, PROJ_NAME, db, flagOn(), spineB);
      const bLine = sectionLines(recordedRender.markdown, '## On this branch')[0];
      expect(bLine).toContain(MEMBER_B_MARK);
      expect(bLine).not.toContain('spine-source:');
      expect(recordedRender.markdown).not.toContain('APPROXIMATE members');
      expect(recordedRender.data.branch!.members[0].spineSource).toBe('recorded');
    } finally {
      await db.query(`UPDATE branch_memberships SET source = 'recorded' WHERE record_id = $1`, [memberA]);
    }
  });

  test('F8: THE ROUTE DERIVES THE SPINE from the held position — flag ON, real wire', async () => {
    // THE HOLE THIS CLOSES, measured by Reviewer: with the route's position wire DELETED,
    // this suite was 52/52 GREEN. Every ON-state assertion handed buildProjectBriefing a
    // spine by hand, and the one route test ran at the OFF default where spineId is null
    // whether the wire works or not — so it passed over a severed wire.
    //
    // The divergent sample is a caller HOLDING a position with the flag ON, through
    // routeExecutor, asserting nobody told the renderer which branch to use.
    //
    // This is only expressible because briefingConfig() now reads env at CALL time: the
    // route takes no config parameter, so a load-time flag could not be flipped per test at
    // all. That is why the fix was to delete the seam rather than to stub around it.
    process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED = 'true';
    try {
      expect(briefingConfig().branchScopeEnabled, 'precondition: the flag is ON for this case').toBe(true);
      await viaTool('branch_open', { id: spineA });
      const held = await db.query(
        `SELECT spine_id::text AS s FROM branch_positions WHERE project_id = $1`,
        [projectId],
      );
      expect(held.rows.map((r: any) => r.s), 'precondition: the position is really open').toContain(spineA);

      // NOTHING passes a spine here. The route must find it.
      const resp = await viaTool('project_briefing', {});
      const text = responseText(resp);
      expect(resp.structuredContent.briefing.spineId).toBe(spineA);
      expect(headingLine(text, '## On this branch')).toContain(`[spine:${short(spineA)}]`);
      expect(text).toContain(MEMBER_A_MARK);
      expect(text).not.toContain(MEMBER_B_MARK);

      // MOVING the position moves the render — so the route is reading the LIVE position
      // and not some other constant that happens to equal spineA.
      await viaTool('branch_open', { id: spineB });
      const moved = await viaTool('project_briefing', {});
      expect(moved.structuredContent.briefing.spineId).toBe(spineB);
      expect(responseText(moved)).toContain(MEMBER_B_MARK);
      expect(responseText(moved)).not.toContain(MEMBER_A_MARK);
    } finally {
      await viaTool('branch_close', {});
      delete process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED;
    }
    // The absent-env default is restored for every later case (and asserted by its own test).
    expect(process.env.MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED).toBeUndefined();
  });

  test('F5: a position held in project A leaves project B\'s briefing at TRUNK', async () => {
    // The T1 leak question — "can one project's position scope another project's briefing?"
    // — rested entirely on a human reading `readPositionAny(project.id, …)` and believing it.
    // Correct by construction is a claim; this makes it an assertion.
    const otherName = `sk5-branch-OTHER-${STAMP}`;
    const otherId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'sk5 other') RETURNING id`, [otherName])
    ).rows[0].id;
    try {
      // Stand on spine A, which lives in the FIRST project.
      await viaTool('branch_open', { id: spineA });
      const held = await db.query(
        `SELECT project_id::text AS p, spine_id::text AS s FROM branch_positions WHERE spine_id = $1`,
        [spineA],
      );
      expect(held.rows.map((r: any) => r.p), 'precondition: the position is held in project A').toContain(projectId);
      expect(held.rows.map((r: any) => r.p), 'precondition: and NOT in project B').not.toContain(otherId);

      // The renderer, asked for project B WITH THE FLAG ON so nothing else can mask a leak.
      const b = await buildProjectBriefing(otherId, otherName, db, flagOn(), null);
      expect(b.spineId).toBeNull();
      expect(headingLine(b.markdown, '## On this branch')).toBeUndefined();
      expect(b.markdown).not.toContain(MEMBER_A_MARK);

      // And the membership read itself is project-scoped: spine A's members are invisible
      // from project B even when the spine id is supplied outright.
      const leaked = await buildProjectBriefing(otherId, otherName, db, flagOn(), spineA);
      expect(leaked.included.branchMembers, 'spine A has no members inside project B').toBe(0);
      expect(leaked.markdown).not.toContain(MEMBER_A_MARK);
    } finally {
      await viaTool('branch_close', {});
      await db.query('DELETE FROM branch_positions WHERE project_id = $1', [otherId]);
      await db.query('DELETE FROM sessions WHERE project_id = $1', [otherId]);
      await db.query('DELETE FROM projects WHERE id = $1', [otherId]);
    }
  });

  test('every list section reports SERVED of POPULATION — no bare served count anywhere', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    for (const label of ['## Open tasks', '## Decisions', '## Conventions', '## Dead ends']) {
      const heading = headingLine(text, label);
      expect(heading, `${label} must be present`).toBeDefined();
      // Either the licensed empty form `(0)` — population genuinely zero — or both numbers.
      expect(
        /^## .+ \((0|\d+ of \d+\+?)\)$/.test(heading!),
        `${label} heading must be "(0)" or "(served of population)", got: ${heading}`,
      ).toBe(true);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART B — the PURE renderer: the divergent samples the old suite could not distinguish
 * ══════════════════════════════════════════════════════════════════════════════════════ */

// PART B's baseline is the flag ON: these tests assert SK5's selection behaviour, so a
// flag-off baseline would make every one of them pass vacuously. The OFF state gets its own
// named tests below rather than being the silent default here.
const CFG = { ...briefingConfig(), branchScopeEnabled: true };

function fabTask(n: number, opts: { status?: string; score?: number | null; iso?: string } = {}): BriefingTask {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `T${n}-TITLE`,
    description: `T${n}-body ${'x'.repeat(600)}`,
    status: opts.status ?? 'todo',
    priority: 'medium',
    createdAt: new Date(Date.UTC(2026, 0, 1 + n)),
    trustSignal: 'trust:test score:0.50',
    trustScore: opts.score === undefined ? 0.5 : opts.score,
    tags: [],
    metadata: null,
  };
}

function fabMember(n: number, spineSource: MembershipSource = MEMBERSHIP_SOURCE.recorded): BriefingBranchMember {
  return {
    id: `33333333-0000-0000-0000-${String(n).padStart(12, '0')}`,
    type: 'context',
    headline: `MEMBER-${n} headline`,
    spineSource,
    createdAt: new Date(Date.UTC(2026, 0, 1 + n)),
  };
}

function fab(parts: Partial<BriefingData> & { tasks: BriefingTask[] }): BriefingData {
  const tasks = parts.tasks;
  const decisions = parts.decisions ?? [];
  const conventions = parts.conventions ?? [];
  const deadEnds = parts.deadEnds ?? [];
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'sk5-fab',
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
    decisions,
    conventions,
    deadEnds,
    branch: parts.branch ?? null,
    // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
    // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
    // claim here; a fabricated EMPTY section would assert a zero nobody measured.
    waiting: null,
    census:
      parts.census ??
      censusFor({ tasks, decisions, conventions, deadEnds, branchMembers: parts.branch?.members ?? [] }),
  };
}

describe('SK5 — PART B: honest counts at the divergent samples', () => {
  test('THE DIVERGENT SAMPLE — population > 0, served == 0: no `none`, both numbers, named reason', () => {
    // 40 fat tasks against a cap that only fits the frame + handoff: every task is evicted.
    const tasks = Array.from({ length: 40 }, (_, i) => fabTask(i + 1));
    const data = fab({ tasks });
    const r = renderBriefing(data, { ...CFG, maxChars: 500 });

    expect(r.included.tasks, 'the cap must really have emptied the section').toBe(0);
    // THE FIX. Before SK5 this rendered exactly `## Open tasks (0)` followed by `none` —
    // byte-identical to a project with no open work at all.
    expect(r.markdown).toContain('## Open tasks (0 of 40)');
    // P5.1 SPLIT THIS SENTENCE IN TWO, and the split is the point of P5.1: 12 of these 40 were
    // excluded by the task QUOTA before the cap was consulted, and 28 were then evicted by the
    // cap. The old single "40 of 40 not served — the size cap" attributed all forty to the
    // budget, which sends a reader to MANDREL_BRIEFING_MAX_CHARS for twelve records that knob
    // would not have recovered. SK5's invariant — both numbers, no `none`, a NAMED reason — is
    // unchanged and is what the three assertions below still hold to.
    expect(r.markdown).toContain('12 of 40 not served — section quota (MANDREL_BRIEFING_SELECT_MAX_TASKS)');
    expect(r.markdown).toContain('28 of 40 not served — the size cap');
    expect(sectionLines(r.markdown, '## Open tasks')).toHaveLength(0);
    // `none` is an affirmative claim of an empty population and must NOT appear here.
    const heading = headingLine(r.markdown, '## Open tasks')!;
    const after = r.markdown.split('\n')[r.markdown.split('\n').indexOf(heading) + 1];
    expect(after).not.toBe('none');
  });

  test('THE OTHER DIVERGENT SAMPLE — population > served > 0 reports both numbers', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => fabTask(i + 1));
    const data = fab({ tasks });
    const uncapped = renderBriefing(data, { ...CFG, maxChars: 10_000_000 });
    expect(uncapped.included.tasks).toBe(12);
    // A cap that fits some but not all of them.
    const r = renderBriefing(data, { ...CFG, maxChars: Math.floor(uncapped.markdown.length / 2) });
    expect(r.included.tasks).toBeGreaterThan(0);
    expect(r.included.tasks).toBeLessThan(12);
    expect(r.markdown).toContain(`## Open tasks (${r.included.tasks} of 12)`);
    expect(r.markdown).toContain(`${12 - r.included.tasks} of 12 not served — the size cap`);
  });

  test('`none` is emitted ONLY for a genuinely zero population', () => {
    const empty = renderBriefing(fab({ tasks: [] }), CFG);
    expect(headingLine(empty.markdown, '## Open tasks')).toBe('## Open tasks (0)');
    expect(empty.markdown).toContain('## Open tasks (0)\nnone');

    // Population zero but something was EXCLUDED: `none` would still be a lie, because
    // open work exists — it was deliberately filtered. This is the zero-population edge
    // C3 asks for, in the direction that slips through.
    const excluded = renderBriefing(
      fab({
        tasks: [],
        census: {
          ...censusFor({ tasks: [], decisions: [], conventions: [], deadEnds: [] }),
          tasks: { fetched: 0, fetchBoundReached: false, excluded: 7, excludedReason: 'deliberately parked' },
        },
      }),
      CFG,
    );
    expect(headingLine(excluded.markdown, '## Open tasks')).toBe('## Open tasks (0 of 0)');
    expect(excluded.markdown).toContain('7 excluded before selection — deliberately parked');
    expect(excluded.markdown).not.toContain('## Open tasks (0)\nnone');
  });

  test('THE FIFTH DIVERGENT SAMPLE — population UNMEASURED: zero rows because zero were sought', () => {
    // The four samples this suite shipped with were (0 of N), (k of N), a genuine (0), and
    // population-0-with-exclusions. ALL FOUR pass against a renderer that emits `none`
    // whenever the fetch bound binds at zero — `fetched` is 0 and `excluded` is 0, so the
    // licensed-empty branch fires over a population NOBODY LOOKED AT. That is the original
    // defect.
    //
    // Zero-because-nothing-exists and zero-because-nothing-was-sought must never share a
    // branch (C1's third state). This is the sample that tells them apart.
    const unmeasured = {
      ...censusFor({ tasks: [], decisions: [], conventions: [], deadEnds: [] }),
      tasks: { fetched: 0, fetchBoundReached: true, excluded: 0, excludedReason: null },
    };
    const r = renderBriefing(fab({ tasks: [], census: unmeasured }), { ...CFG, maxChars: 10_000_000 });

    expect(headingLine(r.markdown, '## Open tasks')).toBe('## Open tasks (0 of 0+)');
    expect(r.markdown).toContain('the population is a FLOOR, not a total');
    // The affirmative claim must be ABSENT: nothing was measured, so nothing may be asserted.
    expect(r.markdown).not.toContain('## Open tasks (0)\nnone');
    const heading = headingLine(r.markdown, '## Open tasks')!;
    const after = r.markdown.split('\n')[r.markdown.split('\n').indexOf(heading) + 1];
    expect(after).not.toBe('none');
  });

  test('the UNMEASURED case holds for a direct-config caller at sectionMaxRecords 0', () => {
    // Reachable by any caller that passes a config directly. NOT via the env var: envInt
    // requires v > 0, so MANDREL_BRIEFING_SECTION_MAX_RECORDS=0 falls back to 200.
    const cfg = { ...CFG, sectionMaxRecords: 0, maxChars: 10_000_000 };
    const census = {
      ...censusFor({ tasks: [], decisions: [], conventions: [], deadEnds: [] }),
      // What censusFor() computes at max=0: rowCount 0 >= max 0 -> the bound bound.
      tasks: { fetched: 0, fetchBoundReached: 0 >= cfg.sectionMaxRecords, excluded: 0, excludedReason: null },
    };
    expect(census.tasks.fetchBoundReached, 'precondition: max=0 makes the bound bind at zero').toBe(true);
    const r = renderBriefing(fab({ tasks: [], census }), cfg);
    expect(r.markdown).not.toContain('## Open tasks (0)\nnone');
    expect(r.markdown).toContain('the fetch stopped at 0 (MANDREL_BRIEFING_SECTION_MAX_RECORDS)');
  });

  test('THE FETCH BOUND is reported as a FLOOR, and never conflated with the size cap', () => {
    // A section that hit its per-query LIMIT: the population is "at least N".
    const tasks = Array.from({ length: 3 }, (_, i) => fabTask(i + 1));
    const data = fab({
      tasks,
      census: { ...censusFor({ tasks, decisions: [], conventions: [], deadEnds: [] }), tasks: { fetched: 3, fetchBoundReached: true, excluded: 0, excludedReason: null } },
    });
    const r = renderBriefing(data, { ...CFG, maxChars: 10_000_000 });
    expect(r.markdown).toContain('## Open tasks (3 of 3+)');
    expect(r.markdown).toContain('the population is a FLOOR, not a total');
    // ...and with one dropped, the DERIVED shortfall carries the floor marker too — a
    // number derived from a lower bound is itself a lower bound.
    const capped = renderBriefing(data, { ...CFG, maxChars: 2000 });
    expect(capped.included.tasks).toBeLessThan(3);
    expect(capped.markdown).toMatch(/\d\+ of 3\+ not served/);
    expect(r.markdown).toContain('MANDREL_BRIEFING_SECTION_MAX_RECORDS');
    // Nothing was dropped by the cap here, so the cap must NOT be named as a reason —
    // the two narrowings are different facts and send the reader to different knobs.
    expect(r.markdown).not.toContain('not served — the size cap');
  });
});

describe('SK5 — PART B: the cap is the BACKSTOP, not the selector', () => {
  test('branch members are evicted LAST: the reader\'s branch survives a cap that empties the rest', () => {
    // 30 tasks, all identical in trust and all NEWER than the branch member's task, so the
    // pre-SK5 comparator (trust, createdAt) would evict the branch's task FIRST.
    const branchTask = fabTask(1); // oldest → first out under the old order
    const others = Array.from({ length: 30 }, (_, i) => fabTask(i + 2));
    const tasks = [...others, branchTask];
    const branch = {
      spineId: '44444444-0000-0000-0000-000000000000',
      members: [{ id: branchTask.id, type: 'task' as const, headline: 'the branch task', spineSource: MEMBERSHIP_SOURCE.recorded, createdAt: branchTask.createdAt }],
    };

    // CONTROL: same corpus, NO position. The branch task is the first thing dropped.
    const unpositioned = renderBriefing(fab({ tasks }), { ...CFG, maxChars: 4000 });
    expect(unpositioned.markdown).not.toContain('T1-TITLE');

    // POSITIONED: the same cap, the same records — and now the branch task survives while
    // the unrelated project-wide material is what pays for the room.
    const positioned = renderBriefing(fab({ tasks, branch }), { ...CFG, maxChars: 4000 });
    expect(positioned.markdown).toContain('T1-TITLE');
    expect(positioned.included.tasks).toBeLessThan(tasks.length);
  });

  test('THE ALWAYS-SURFACE FLOOR: a blocked task outlives unblocked ones at the same trust', () => {
    const blocked = { ...fabTask(1, { status: 'blocked' }), title: 'BLOCKED-TITLE' };
    const others = Array.from({ length: 30 }, (_, i) => fabTask(i + 2));
    const tasks = [...others, blocked];

    const r = renderBriefing(fab({ tasks }), { ...CFG, maxChars: 4000 });
    expect(r.markdown).toContain('BLOCKED-TITLE');
    expect(r.included.tasks).toBeLessThan(tasks.length);

    // MUTATION CONTROL: with the floor's vocabulary emptied, the same blocked task — oldest
    // and equal-trust — is dropped. That is what proves the assertion above is measuring the
    // floor and not something incidental about the fixture.
    const noFloor = renderBriefing(fab({ tasks }), { ...CFG, maxChars: 4000, alwaysSurfaceTaskStatuses: [] });
    expect(noFloor.markdown).not.toContain('BLOCKED-TITLE');
  });

  test('the branch section has its OWN reserved budget and reports its shortfall honestly', () => {
    const members = Array.from({ length: 60 }, (_, i) => fabMember(i + 1));
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members };
    const data = fab({ tasks: [], branch });
    const r = renderBriefing(data, { ...CFG, branchReservedChars: 200 });
    const served = sectionLines(r.markdown, '## On this branch');
    expect(served.length).toBeGreaterThan(0);
    expect(served.length).toBeLessThan(members.length);
    expect(r.markdown).toContain(`## On this branch [spine:44444444] (${served.length} of 60)`);
    expect(r.markdown).toContain('not served — the branch reserved budget');
  });

  test('APPROXIMATE members are marked FROM THE FIELD and counted, and `exact` is never claimed', () => {
    // Prod reality (measured 2026-08-16): 107 of 130 membership rows fleet-wide are
    // legacy-approx, and the worked example is 8 of 8. A section printing the
    // strongest possible count over that set, with the field in hand, is the defect this
    // whole file exists to delete.
    const members = [
      fabMember(1, MEMBERSHIP_SOURCE.legacyApprox),
      fabMember(2, MEMBERSHIP_SOURCE.legacyApprox),
      fabMember(3, MEMBERSHIP_SOURCE.recorded),
    ];
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members };
    const r = renderBriefing(fab({ tasks: [], branch }), CFG);
    const lines = sectionLines(r.markdown, '## On this branch');
    expect(lines).toHaveLength(3);

    // PER-RECORD, from the field: exactly the derived rows carry the marker.
    expect(lines.filter((l) => l.includes(`[spine-source:${MEMBERSHIP_SOURCE.legacyApprox}]`))).toHaveLength(2);
    // The RECORDED row carries no marker. Matched by headline, not by id: the renderer
    // prints short(id), and all three fabricated ids share their first 8 chars — an id match
    // here would find nothing and pass vacuously.
    const recordedLine = lines.find((l) => l.includes('MEMBER-3 headline'));
    expect(recordedLine, 'the recorded member must be rendered').toBeDefined();
    expect(recordedLine!).not.toContain('spine-source:');

    // AGGREGATE, in SK2's vocabulary, and no `exact` claim anywhere.
    expect(r.markdown).toContain('2 of 3 shown are APPROXIMATE members');
    expect(r.markdown).toContain('does not claim the rest is exact');
  });

  test('an all-RECORDED branch carries no approximate caveat (the marker is not a constant)', () => {
    // The control for the assertion above: without it, a renderer that stamps every line
    // would pass the marker count by accident.
    const members = [fabMember(1), fabMember(2)];
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members };
    const r = renderBriefing(fab({ tasks: [], branch }), CFG);
    expect(r.markdown).not.toContain('spine-source:');
    expect(r.markdown).not.toContain('APPROXIMATE members');
  });

  test('F3: the omitted footer names EVERY narrowing that dropped a record it counted', () => {
    // droppedRecords counts branch members evicted by the branch budget, so a footer naming
    // only the cap and the dead-ends budget sends the reader to the wrong knob.
    const members = Array.from({ length: 60 }, (_, i) => fabMember(i + 1));
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members };
    const r = renderBriefing(fab({ tasks: [], branch }), { ...CFG, branchReservedChars: 200 });
    expect(r.droppedRecords).toBeGreaterThan(0);
    expect(r.markdown).toContain('MANDREL_BRIEFING_BRANCH_RESERVED_CHARS');
    expect(r.markdown).toContain('branch members drop only against theirs');
  });

  test('an EMPTY branch renders the section with a zero population, never a fabricated one', () => {
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members: [] };
    const r = renderBriefing(fab({ tasks: [], branch }), CFG);
    expect(r.markdown).toContain('## On this branch [spine:44444444] (0)');
    expect(r.spineId).toBe('44444444-0000-0000-0000-000000000000');
    expect(r.included.branchMembers).toBe(0);
  });

  test('FLAG OFF at the pure renderer: a hand-supplied branch is DROPPED, not rendered', () => {
    const members = [fabMember(1)];
    const branch = { spineId: '44444444-0000-0000-0000-000000000000', members };
    const data = fab({ tasks: [], branch });

    const on = renderBriefing(data, { ...CFG, branchScopeEnabled: true });
    expect(on.spineId).toBe('44444444-0000-0000-0000-000000000000');
    expect(headingLine(on.markdown, '## On this branch')).toBeDefined();

    // Same BriefingData, flag off: the second half of the choke point. A caller that
    // assembles data by hand must not be able to obtain branch behaviour from a flag-off
    // deployment just because it supplied a branch.
    const off = renderBriefing(data, { ...CFG, branchScopeEnabled: false });
    expect(off.spineId).toBeNull();
    expect(headingLine(off.markdown, '## On this branch')).toBeUndefined();
    expect(off.included.branchMembers).toBe(0);
    expect(off.markdown).not.toContain('MEMBER-1 headline');
  });

  test('FLAG OFF collapses the SK5 selection knobs: the always-surface floor is inert', () => {
    const blocked = { ...fabTask(1, { status: 'blocked' }), title: 'BLOCKED-TITLE' };
    const tasks = [...Array.from({ length: 30 }, (_, i) => fabTask(i + 2)), blocked];
    // ON: the floor holds the blocked task (proved in the suite above).
    expect(
      renderBriefing(fab({ tasks }), { ...CFG, maxChars: 4000, branchScopeEnabled: true }).markdown,
    ).toContain('BLOCKED-TITLE');
    // OFF: pre-SK5 drop order — oldest-least-trusted first, no protection.
    expect(
      renderBriefing(fab({ tasks }), { ...CFG, maxChars: 4000, branchScopeEnabled: false }).markdown,
    ).not.toContain('BLOCKED-TITLE');
  });

  test('the census helper derives from the array it describes (fixtures cannot lie either)', () => {
    expect(censusOf([1, 2, 3]).fetched).toBe(3);
    expect(censusOf([]).fetched).toBe(0);
  });
});
