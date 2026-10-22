/**
 * FIX A — project_briefing's EXPLICIT `spine` ARGUMENT (SK5 follow-on).
 *
 * THE MEASURED PROBLEM. SK5 made the briefing branch-scoped from the caller's OPEN POSITION.
 * A position is keyed on CONNECTION ID. The Claude Code MCP bridge mints its own connection
 * id inside its own process; the SessionStart boot hook is a SEPARATE shell client on its own
 * connection id. Same project, different slot — so the hook's project_briefing call found no
 * position and took the trunk fallback every time. SK5 worked and the client that needed it
 * could not reach it. The service's spine parameter already existed; only the TOOL SURFACE
 * did not expose it.
 *
 * EVERY TEST HERE GOES THROUGH routeExecutor — the PUBLIC tool surface, the same wire the
 * hook reads. That is deliberate and it is the point of the file: SK5's own suite proved the
 * cross-project property against `buildProjectBriefing` directly (the service), so the public
 * entry point carried no assertion at all. A property proved one layer below the caller is
 * not proved for the caller.
 *
 * THE FOUR PROPERTIES, in the order they matter:
 *   1. TENANT PROTECTION (the one that must never regress): flag OFF ⇒ an explicitly-supplied
 *      spine is REFUSED. If an argument could route around MANDREL_BRIEFING_BRANCH_SCOPE_
 *      ENABLED, the flag would not be a tenant guarantee — it would be a default, and every
 *      tenant on the shipped default could be handed SK5 selection by any caller.
 *   2. PRECEDENCE: explicit BEATS the connection's position. Declared intent over ambient.
 *   3. HONEST REFUSAL: an unresolvable / other-project spine renders trunk AND says why in a
 *      FIELD. A caller that asked for a branch and silently got the global document is the
 *      "status travels out-of-band" defect this whole program exists to remove.
 *   4. It works at all: an explicit spine renders THAT branch with NO position held.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { BRIEFING_SPINE_SOURCE, BRIEFING_SPINE_REFUSAL } from '../config/briefingSpineConfig.js';
import { SPINE_REFUSAL } from '../services/spineResolver.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const CONN = `fixa-spine-conn-${STAMP}`;
const PROJ_NAME = `fixa-spine-P-${STAMP}`;
const OTHER_NAME = `fixa-spine-OTHER-${STAMP}`;

const FLAG = 'MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED';

let projectId = '';
let otherProjectId = '';
let spineA = '';
let spineB = '';
let memberA = '';
let memberB = '';

const HANDOFF_BODY = `FIXA-HANDOFF-${STAMP} resume point`;
const MEMBER_A_MARK = `FIXA-MEMBER-A-${STAMP}`;
const MEMBER_B_MARK = `FIXA-MEMBER-B-${STAMP}`;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function viaTool(tool: string, args: any, conn: string = CONN): Promise<any> {
  return routeExecutor(tool, args, { connectionId: conn });
}
const short = (id: string): string => id.slice(0, 8);
function headingLine(markdown: string, prefix: string): string | undefined {
  return markdown.split('\n').find((l) => l.startsWith(prefix));
}
/** Turn the SK5 flag ON for one case. Restored by afterEach, asserted absent by its own test. */
function flagOn(): void {
  process.env[FLAG] = 'true';
}

describe('FIX A — project_briefing `spine` on the PUBLIC tool surface', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'fix a explicit spine') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    otherProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'fix a other project') RETURNING id`,
        [OTHER_NAME],
      )
    ).rows[0].id;
    await viaTool('project_switch', { project: projectId });
    await viaTool('context_store', { content: HANDOFF_BODY, type: 'handoff' });

    // Two real spines with real members, minted by the REAL write path while positioned —
    // nothing hand-inserted, so a passing assertion below means the system recorded what the
    // writer did, not that the renderer can read a row a test wrote for it.
    spineA = (await viaTool('task_create', { title: `fixa spine A ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;
    spineB = (await viaTool('task_create', { title: `fixa spine B ${STAMP}`, type: 'general' }))
      .structuredContent.task.id;

    await viaTool('branch_open', { id: spineA });
    memberA = (await viaTool('context_store', { content: `${MEMBER_A_MARK} A note`, type: 'planning' }))
      .structuredContent.context.id;
    await viaTool('branch_close', {});

    await viaTool('branch_open', { id: spineB });
    memberB = (await viaTool('context_store', { content: `${MEMBER_B_MARK} B note`, type: 'planning' }))
      .structuredContent.context.id;
    await viaTool('branch_close', {});

    // FIXTURE PRECONDITION, asserted rather than assumed: without these two memberships every
    // branch assertion below would pass vacuously against an empty branch.
    const rows = await db.query(
      `SELECT record_id::text AS id, spine_id::text AS spine FROM branch_memberships
        WHERE project_id = $1`,
      [projectId],
    );
    expect(
      rows.rows.map((r: any) => `${r.id}@${r.spine}`).sort(),
      'fixture precondition: both positioned writes recorded a membership',
    ).toEqual([`${memberA}@${spineA}`, `${memberB}@${spineB}`].sort());
  });

  afterEach(async () => {
    delete process.env[FLAG];
    await viaTool('branch_close', {});
  });

  afterAll(async () => {
    for (const p of [projectId, otherProjectId]) {
      try {
        await db.query('DELETE FROM branch_positions WHERE project_id = $1', [p]);
        await db.query('DELETE FROM branch_memberships WHERE project_id = $1', [p]);
        await db.query('DELETE FROM links WHERE project_id = $1', [p]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [p]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [p]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [p]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [p]);
        await db.query('DELETE FROM projects WHERE id = $1', [p]);
      } catch {
        /* ignore */
      }
    }
    await db.end();
  });

  /* ── 1. THE TENANT-PROTECTION PROPERTY ──────────────────────────────────────────────── */

  test('THE FLAG IS NOT ROUTABLE-AROUND: flag OFF + explicit spine ⇒ REFUSED, and it says so', async () => {
    // Assert on ABSENCE of the env var, not on an explicit false — otherwise this degrades
    // into "refused when someone remembered to set it off", which is not the shipped state.
    expect(
      process.env[FLAG],
      'this case is about the SHIPPED default (env absent); the suite must not set the var here',
    ).toBeUndefined();

    const resp = await viaTool('project_briefing', { spine: spineA });
    const b = resp.structuredContent.briefing;

    // The spine was refused: nothing branch-scoped happened.
    expect(b.spineId).toBeNull();
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.none);
    expect(b.included.branchMembers).toBe(0);
    expect(headingLine(responseText(resp), '## On this branch')).toBeUndefined();
    expect(responseText(resp)).not.toContain(MEMBER_A_MARK);

    // ...and the refusal is REPORTED. A caller must not have to learn this by noticing a
    // missing section — that is exactly the silent fallback this argument must not introduce.
    expect(b.spineRefusal).toBe(BRIEFING_SPINE_REFUSAL.flagOff);

    // The rest of the document is the ordinary flag-off render, unharmed.
    expect(responseText(resp)).toContain(HANDOFF_BODY);
  });

  /* ── 2. IT WORKS, WITH NO POSITION HELD ─────────────────────────────────────────────── */

  test('explicit spine renders THAT branch with NO position held anywhere', async () => {
    flagOn();
    // PRECONDITION: the position table is empty for this project, so nothing ambient can be
    // supplying the spine. Without this the next assertion cannot tell explicit from position.
    const held = await db.query(
      `SELECT spine_id::text AS s FROM branch_positions WHERE project_id = $1`,
      [projectId],
    );
    expect(held.rows, 'precondition: no branch position is held in this project').toHaveLength(0);

    const resp = await viaTool('project_briefing', { spine: spineA });
    const b = resp.structuredContent.briefing;
    const text = responseText(resp);

    expect(b.spineId).toBe(spineA);
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.explicit);
    expect(b.spineRefusal).toBeNull();
    expect(headingLine(text, '## On this branch')).toContain(`[spine:${short(spineA)}]`);
    expect(text).toContain(MEMBER_A_MARK);
    // The OTHER branch's member is NEWER; serving it is what "the global newest" looks like.
    expect(text).not.toContain(MEMBER_B_MARK);
  });

  test('an 8-hex SHORT id resolves, same contract as branch_open', async () => {
    flagOn();
    const resp = await viaTool('project_briefing', { spine: short(spineB) });
    const b = resp.structuredContent.briefing;
    // The FULL uuid comes back, not the short id that was passed — i.e. it was resolved.
    expect(b.spineId).toBe(spineB);
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.explicit);
    expect(responseText(resp)).toContain(MEMBER_B_MARK);
  });

  test('a CONTEXT is a legal spine too (all three record types resolve)', async () => {
    flagOn();
    // memberA is a context. It has no members of its own, so the branch renders EMPTY —
    // which is the honest answer, and distinguishable from "the spine was rejected" only
    // because spineId/spineSource report what happened.
    const resp = await viaTool('project_briefing', { spine: memberA });
    const b = resp.structuredContent.briefing;
    expect(b.spineId).toBe(memberA);
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.explicit);
    expect(b.spineRefusal).toBeNull();
    expect(b.included.branchMembers).toBe(0);
  });

  /* ── 3. PRECEDENCE: EXPLICIT BEATS AMBIENT ──────────────────────────────────────────── */

  test('explicit spine WINS over a held position pointing somewhere else', async () => {
    flagOn();
    await viaTool('branch_open', { id: spineB });
    const held = await db.query(
      `SELECT spine_id::text AS s FROM branch_positions WHERE project_id = $1`,
      [projectId],
    );
    expect(
      held.rows.map((r: any) => r.s),
      'precondition: a position IS open, and on the OTHER spine',
    ).toContain(spineB);

    const resp = await viaTool('project_briefing', { spine: spineA });
    const b = resp.structuredContent.briefing;
    const text = responseText(resp);
    expect(b.spineId).toBe(spineA);
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.explicit);
    expect(text).toContain(MEMBER_A_MARK);
    expect(text).not.toContain(MEMBER_B_MARK);

    // THE CONTROL that makes the line above mean something: drop the argument on the SAME
    // connection with the SAME position still held, and the position takes over. Without
    // this pair, "explicit wins" could be satisfied by a route that ignores positions.
    const ambient = await viaTool('project_briefing', {});
    expect(ambient.structuredContent.briefing.spineId).toBe(spineB);
    expect(ambient.structuredContent.briefing.spineSource).toBe(BRIEFING_SPINE_SOURCE.position);
    expect(responseText(ambient)).toContain(MEMBER_B_MARK);
  });

  /* ── 4. HONEST, TYPED REFUSALS — never a silent trunk render ─────────────────────────── */

  test('an UNRESOLVABLE spine is refused in a FIELD, and the trunk render is not silent', async () => {
    flagOn();
    // A syntactically legal id8 that names nothing. (Not garbage: a garbage value would be
    // stopped by the validator, which is a different, weaker proof.)
    const ghost = 'deadbeef';
    const exists = await db.query(
      `SELECT 1 FROM contexts WHERE id::text LIKE $1
        UNION ALL SELECT 1 FROM tasks WHERE id::text LIKE $1
        UNION ALL SELECT 1 FROM technical_decisions WHERE id::text LIKE $1`,
      [`${ghost}%`],
    );
    expect(exists.rows, 'precondition: this id really names nothing').toHaveLength(0);

    const resp = await viaTool('project_briefing', { spine: ghost });
    const b = resp.structuredContent.briefing;
    expect(b.spineId).toBeNull();
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.none);
    expect(b.spineRefusal).toBe(SPINE_REFUSAL.notFound);
    expect(headingLine(responseText(resp), '## On this branch')).toBeUndefined();
    // The caller still gets a usable document — degrading to trunk is right for a boot hook
    // holding a stale id. What must never happen is degrading WITHOUT SAYING SO.
    expect(responseText(resp)).toContain(HANDOFF_BODY);
  });

  test('CROSS-PROJECT: project A\'s spine supplied to project B serves NO members, and is refused', async () => {
    flagOn();
    // The T1 leak question at the PUBLIC entry point. SK5's F5 asserted this against
    // buildProjectBriefing (the service) — the tool surface carried no assertion at all,
    // which is the layer an attacker and the hook both actually call.
    const resp = await viaTool('project_briefing', { project: otherProjectId, spine: spineA });
    const b = resp.structuredContent.briefing;
    expect(b.projectId).toBe(otherProjectId);
    expect(b.spineId).toBeNull();
    expect(b.included.branchMembers).toBe(0);
    expect(responseText(resp)).not.toContain(MEMBER_A_MARK);
    // Project-scoped resolution is what stops it: from project B, spine A is simply not a
    // record. The refusal names that, rather than reporting a successful empty branch.
    expect(b.spineRefusal).toBe(SPINE_REFUSAL.notFound);

    // CONTROL: the very same spine id, asked for in ITS OWN project, DOES resolve. Without
    // this the assertion above would also pass if `spine` were ignored entirely.
    const control = await viaTool('project_briefing', { project: projectId, spine: spineA });
    expect(control.structuredContent.briefing.spineId).toBe(spineA);
    expect(responseText(control)).toContain(MEMBER_A_MARK);
  });

  test('an empty-string spine is not a spine: it falls through to the position path', async () => {
    flagOn();
    await viaTool('branch_open', { id: spineA });
    const resp = await viaTool('project_briefing', { spine: '   ' });
    const b = resp.structuredContent.briefing;
    // Whitespace is not a declared intent. Treating it as one would refuse every caller that
    // interpolated an empty shell variable — which is exactly how the boot hook builds it.
    expect(b.spineRefusal).toBeNull();
    expect(b.spineId).toBe(spineA);
    expect(b.spineSource).toBe(BRIEFING_SPINE_SOURCE.position);
  });

  /* ── 5. THE VALIDATOR LAYER — the param has to be DECLARED to be callable ───────────── */

  test('the input schema declares `spine`, and STRICT MODE rejects it if it does not', () => {
    // MEASURED, not assumed: routeExecutor (what every case above calls) does NOT run the
    // validators — validateToolArguments is applied one layer up, by the gateway/discover
    // dispatcher, which is the path a real MCP client takes. That layer runs in STRICT MODE,
    // so an UNDECLARED param is a hard rejection, not a passthrough. Without this case the
    // whole suite would still be green with `spine` deleted from validation.ts, and the real
    // client would get "unrecognized key" for the one argument this change exists to add.
    expect(validateToolArguments('project_briefing', { spine: 'deadbeef' })).toEqual({
      spine: 'deadbeef',
    });
    // ...and the strictness is real, so the line above is not merely "anything goes".
    expect(() => validateToolArguments('project_briefing', { bogus: 'x' })).toThrow(
      /Validation failed for project_briefing/,
    );
  });

  test('`spine` carries the uuidOrShortId contract — a non-hex value is refused at the edge', () => {
    expect(() => validateToolArguments('project_briefing', { spine: 'not-hex!!' })).toThrow(
      /Validation failed for project_briefing/,
    );
    // The full UUID form is the other half of that contract.
    expect(
      validateToolArguments('project_briefing', { spine: '00000000-0000-0000-0000-000000000000' }),
    ).toEqual({ spine: '00000000-0000-0000-0000-000000000000' });
  });

  test('the flag env var is left ABSENT by this suite', () => {
    // Guard the guard: every case above restores it via afterEach. If one leaked, the
    // tenant-protection test would silently start proving nothing.
    expect(process.env[FLAG]).toBeUndefined();
  });
});
