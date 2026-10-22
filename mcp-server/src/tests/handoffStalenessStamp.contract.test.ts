/**
 * THE HANDOFF STALENESS STAMP — contract tests.
 *
 * THE DEFECT THESE PIN (finding bf1980d5). The boot package prints the latest handoff as
 * FULL frozen prose next to a LIVE walk of the same database, and marks neither as current.
 * Two independent blind readers hit it unprompted; reader B, verbatim: "Acting on the
 * handoff's list could mean rebuilding finished work."
 *
 * THE CHOKE POINT THIS GUARD ANCHORS ON (C3): the RENDERED briefing markdown produced by
 * `buildProjectBriefing` against a real Postgres — not `applyHandoffStamps` in isolation.
 * A guard on the pure function alone would stay GREEN if the gather stopped resolving, if
 * the renderer stopped applying, or if the flag defaulted off; every one of those is a
 * silent regression to the exact defect. The pure-function cases below exist only for the
 * shapes a live corpus cannot produce cheaply, and each says so.
 *
 * SCOPE OF THIS FILE'S POPULATION: the six id outcomes the feature can encounter —
 * resolvable-and-moved, resolvable-and-unchanged, ambiguous, deleted, not-an-id,
 * other-project — plus the kill switch, the over-cap path, and the archive-immutability
 * invariant. That is the whole outcome space of `resolveHandoffStamps`; there is no seventh
 * branch in that function.
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
import {
  buildProjectBriefing,
  briefingConfig,
  type BriefingConfig,
} from '../services/projectBriefing.js';
import {
  applyHandoffStamps,
  handoffStampCharCost,
  resolveHandoffStamps,
} from '../services/handoffStamp.js';

const STAMP = Date.now();
const PROJ_NAME = `stamp-P-${STAMP}`;
const OTHER_PROJ_NAME = `stamp-OTHER-${STAMP}`;

let projectId: string;
let otherProjectId: string;

/**
 * CRAFTED IDS, not gen_random_uuid(). Two of the cases under test are properties of the id
 * itself — an id8 PREFIX shared by two tasks (ambiguity) and an 8-hex word that is not an id
 * at all — and neither is reachable by seeding random uuids and hoping. The suffixes keep
 * every crafted uuid distinct while holding the first octet fixed.
 */
const ID_MOVED = 'a1a1a1a1-1111-4111-8111-111111111111';
const ID_UNCHANGED = 'b2b2b2b2-2222-4222-8222-222222222222';
const ID_DELETED = 'c3c3c3c3-3333-4333-8333-333333333333';
const ID_AMBIG_A = 'd4d4d4d4-4444-4444-8444-444444444444';
const ID_AMBIG_B = 'd4d4d4d4-5555-4555-8555-555555555555';
const ID_OTHER_PROJECT = 'e5e5e5e5-6666-4666-8666-666666666666';
/** Eight hex chars that are deliberately NOT any row's id prefix (case (c) in the service). */
const NOT_AN_ID = 'facefeed';

const id8 = (uuid: string): string => uuid.slice(0, 8);

/** The handoff text under test — written in the imperative, exactly as a real one is. */
const HANDOFF_BODY = [
  `HANDOFF-STAMP-${STAMP}`,
  'Three remain — start these:',
  `  1. P4 ${id8(ID_MOVED)} — L1 first`,
  `  2. P3b ${id8(ID_UNCHANGED)} — mutable branch membership`,
  `  3. gone ${id8(ID_DELETED)} — this one was deleted`,
  `  4. ambiguous ${id8(ID_AMBIG_A)} — two tasks share this prefix`,
  `  5. not-an-id ${NOT_AN_ID} — an ordinary hex word in prose`,
  `  6. elsewhere ${id8(ID_OTHER_PROJECT)} — lives in another project`,
  `  7. full uuid ${ID_MOVED} — the pasted form`,
  `HANDOFF-STAMP-END-${STAMP}`,
].join('\n');

async function seedTask(id: string, pid: string, status: string, archived: boolean): Promise<void> {
  await db.query(
    `INSERT INTO tasks (id, project_id, title, type, status, priority, archived_at)
     VALUES ($1,$2,$3,'general',$4,'medium',$5)`,
    [id, pid, `stamp task ${id.slice(0, 8)} ${STAMP}`, status, archived ? new Date() : null],
  );
}

/** The stored handoff row's bytes, read straight from the table. */
async function storedHandoff(): Promise<string> {
  return (
    await db.query(
      `SELECT content FROM contexts WHERE project_id = $1 AND context_type = 'handoff'`,
      [projectId],
    )
  ).rows[0].content;
}

/** The config the product ships, with only the named knob overridden. */
function cfg(over: Partial<BriefingConfig> = {}): BriefingConfig {
  return { ...briefingConfig(), ...over };
}

async function render(over: Partial<BriefingConfig> = {}): Promise<string> {
  return (await buildProjectBriefing(projectId, PROJ_NAME, db, cfg(over))).markdown;
}

describe('handoff staleness stamp', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    otherProjectId = (
      await db.query(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [OTHER_PROJ_NAME])
    ).rows[0].id;

    await seedTask(ID_MOVED, projectId, 'completed', false);
    await seedTask(ID_UNCHANGED, projectId, 'todo', false);
    await seedTask(ID_DELETED, projectId, 'todo', true);
    await seedTask(ID_AMBIG_A, projectId, 'completed', false);
    await seedTask(ID_AMBIG_B, projectId, 'todo', false);
    await seedTask(ID_OTHER_PROJECT, otherProjectId, 'completed', false);

    await db.query(
      `INSERT INTO contexts (project_id, content, context_type) VALUES ($1,$2,'handoff')`,
      [projectId, HANDOFF_BODY],
    );
  });

  afterAll(async () => {
    for (const pid of [projectId, otherProjectId]) {
      try {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      } catch {
        /* ignore */
      }
    }
    await db.end();
  });

  /* ════════════════════════════════════════════════════════════════════════════════════
   * THE DELIVERABLE — the test the task names, end to end through the real renderer.
   * ════════════════════════════════════════════════════════════════════════════════════ */

  test('a handoff naming a task that has since COMPLETED renders that task CURRENT status, and the stored row is byte-identical', async () => {
    const before = await storedHandoff();
    const text = await render();

    // THEN: the rendered handoff carries the CURRENT status next to the id.
    expect(text).toContain(`P4 ${id8(ID_MOVED)} [now: completed]`);
    // The handoff's own prose — the imperative that would send a reader to rebuild it — is
    // still there, unedited. The stamp ANNOTATES; it does not correct or remove.
    expect(text).toContain('Three remain — start these:');

    // AND: the archive is untouched. Byte equality against the row as read BEFORE the
    // render, not merely "contains the original" — a render that appended would pass that.
    const after = await storedHandoff();
    expect(after).toBe(before);
    expect(after).toBe(HANDOFF_BODY);
  });

  test('an UNCHANGED task is stamped too — uniformly, so absence never has to be interpreted', async () => {
    const text = await render();
    expect(text).toContain(`P3b ${id8(ID_UNCHANGED)} [now: todo]`);
  });

  /* ════════════════════════════════════════════════════════════════════════════════════
   * THE THREE UNRESOLVABLE CASES (constraint 3) — a wrong stamp is worse than none.
   * ════════════════════════════════════════════════════════════════════════════════════ */

  test('an AMBIGUOUS id8 gets NO stamp — never first-match — and the token still renders', async () => {
    const text = await render();
    expect(text).toContain(`ambiguous ${id8(ID_AMBIG_A)} — two tasks share this prefix`);
    expect(text).not.toContain(`${id8(ID_AMBIG_A)} [now:`);
  });

  test('a DELETED task is stamped [now: deleted], not with the status frozen on its archived row', async () => {
    const text = await render();
    expect(text).toContain(`gone ${id8(ID_DELETED)} [now: deleted]`);
    // The archived row still says `todo`; stamping THAT would tell the reader to go do it.
    expect(text).not.toContain(`${id8(ID_DELETED)} [now: todo]`);
  });

  test('a hex word that is not an id, and an id from ANOTHER project, are both left untouched', async () => {
    const text = await render();
    expect(text).toContain(`not-an-id ${NOT_AN_ID} — an ordinary hex word in prose`);
    expect(text).toContain(`elsewhere ${id8(ID_OTHER_PROJECT)} — lives in another project`);
    expect(text).not.toContain(`${NOT_AN_ID} [now:`);
    expect(text).not.toContain(`${id8(ID_OTHER_PROJECT)} [now:`);
  });

  test('a PASTED FULL UUID is stamped once, as a whole — its leading octet is not stamped again', async () => {
    const text = await render();
    expect(text).toContain(`full uuid ${ID_MOVED} [now: completed]`);
    // The failure this excludes: a rewrite whose boundaries disagree with the scan's, which
    // would produce `a1a1a1a1 [now: completed]-1111-...` inside the pasted uuid.
    expect(text).not.toContain(`${id8(ID_MOVED)} [now: completed]-`);
  });

  /* ════════════════════════════════════════════════════════════════════════════════════
   * THE SWITCH, THE COST, AND THE CAP.
   * ════════════════════════════════════════════════════════════════════════════════════ */

  test('the kill switch OFF renders the handoff byte-identical to the stored row', async () => {
    const off = await render({ handoffStampEnabled: false });
    expect(off).toContain(HANDOFF_BODY);
    expect(off).not.toContain('[now:');
  });

  test('the stamp format is CONFIG, not a literal in the renderer', async () => {
    const text = await render({ handoffStampFormat: ' <<{status}>>' });
    expect(text).toContain(`P4 ${id8(ID_MOVED)} <<completed>>`);
    expect(text).not.toContain('[now: completed]');
  });

  test('the added char cost is MEASURABLE and is exactly the stamps, nothing else', async () => {
    const c = briefingConfig();
    const { stamps } = await resolveHandoffStamps(
      HANDOFF_BODY,
      projectId,
      c.handoffStampDeletedLabel,
      db,
    );
    const cost = handoffStampCharCost(HANDOFF_BODY, stamps, c.handoffStampFormat);
    // Five stamped OCCURRENCES in this fixture: moved (id8 + the pasted uuid), unchanged,
    // deleted, and nothing for the three unresolvable ones. ` [now: completed]` is 17,
    // ` [now: todo]` is 12, ` [now: deleted]` is 15.
    expect(cost).toBe(17 + 17 + 12 + 15);
    // And the whole render grows by exactly that much — the cost is not absorbed or doubled
    // somewhere else in the document.
    const on = await render();
    const off = await render({ handoffStampEnabled: false });
    expect(on.length - off.length).toBe(cost);
  });

  test('OVER CAP: the handoff is still stamped and still whole, and the over-cap line still fires', async () => {
    // maxChars far below the handoff alone -> the documented over-cap path: every droppable
    // is gone and the render is STILL over cap. The stamp must not change that behaviour,
    // and must not be quietly dropped by it either (the handoff is EXEMPT from the cap, so
    // the chars it adds are precisely the ones nothing can trim).
    const text = await render({ maxChars: 50 });
    expect(text).toContain(`P4 ${id8(ID_MOVED)} [now: completed]`);
    expect(text).toContain(`HANDOFF-STAMP-END-${STAMP}`); // whole, not truncated
    expect(text.toLowerCase()).toContain('size cap exceeded');
  });

  /* ════════════════════════════════════════════════════════════════════════════════════
   * PURE-FUNCTION CASES — only for shapes a live corpus cannot produce cheaply.
   * ════════════════════════════════════════════════════════════════════════════════════ */

  test('the EMPTY population: no ids named, or nothing resolvable, returns the text unchanged', () => {
    const plain = 'no ids here at all, just prose';
    expect(applyHandoffStamps(plain, {}, ' [now: {status}]')).toBe(plain);
    expect(handoffStampCharCost(plain, {}, ' [now: {status}]')).toBe(0);
  });
});
