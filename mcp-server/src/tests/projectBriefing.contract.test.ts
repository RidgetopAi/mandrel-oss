/**
 * PROJECT BRIEFING — WS2 "living summary".
 *
 * Contract tests ADVERSARIAL TO THE RENDERER (the spec's list, verbatim):
 *   - full handoff, untruncated;
 *   - a superseded record appears in DEAD-ENDS and NOT in any body section;
 *   - the size cap drops WHOLE records (record-boundary assertion, not a sliced string)
 *     and drops least-protected first, least-trusted-oldest within a band;
 *   - an EMPTY project renders a valid minimal briefing (C3: the empty population);
 *   - no emoji / URL lines in output (the ONE WS1 scanner, from helpers/emojiScan).
 *
 * TWO LAYERS:
 *   PART A — behavioral: real records through routeExecutor (and the project gateway)
 *            against the CI Postgres; asserts the wire the hook injection will read.
 *   PART B — the PURE renderer (renderBriefing) attacked with fabricated corpora, where
 *            trust scores and dates are under test control (drop-order proofs).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';
import { EMOJI_RE, emojiPayloadLines } from './helpers/emojiScan.js';
import { censusFor } from './helpers/briefingCensus.js';

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
import { dispatchGateway } from '../routes/gateway.js';
import {
  renderBriefing,
  type BriefingData,
  type BriefingConfig,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';
import {
  READ_HANDOFF_HEAD_MAX_HOPS,
  READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS,
  READ_HANDOFF_HEAD_REFUSAL_REMEDY,
} from '../config/handoffHeadConfig.js';

/**
 * The fabricated corpus's ONE handoff id. Named so `handoffHead` can be DERIVED from it
 * rather than repeating the literal — a resolution naming a different id than the record
 * it is shown beside would render a header about a record the document is not serving.
 */
const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';


const __dirname = dirname(fileURLToPath(import.meta.url));

const STAMP = Date.now();
const CONN = `ws2-briefing-conn-${STAMP}`;
const PROJ_NAME = `ws2-briefing-P-${STAMP}`;
const EMPTY_PROJ_NAME = `ws2-briefing-EMPTY-${STAMP}`;

let projectId: string;
let emptyProjectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
async function viaTool(tool: string, args: any): Promise<any> {
  return routeExecutor(tool, args, { connectionId: CONN });
}

// ── Seeded fixtures (unique markers so containment assertions cannot alias) ──
const HANDOFF1_MARK = `WS2-HANDOFF-ONE-${STAMP}`;
const HANDOFF2_HEAD = `WS2-HANDOFF-TWO-${STAMP}`;
const HANDOFF2_TAIL = `WS2-HANDOFF-TWO-END-${STAMP}`;
// Comfortably long: the untruncated-handoff assertion must exercise real length.
const HANDOFF2_BODY = `${HANDOFF2_HEAD}\n` + `handoff line ${STAMP} `.repeat(150) + `\n${HANDOFF2_TAIL}`;
const TASK_DESC = `blocked on the flag-register migration ${STAMP}\nsecond description line ${STAMP}`;
const DONE_TASK_TITLE = `ws2 done task ${STAMP}`;
const DECISION_RATIONALE = `because the eval grid picked arm D ${STAMP}`;
const DEAD_DECISION_TITLE = `ws2 dead decision ${STAMP}`;
const DEAD_DECISION_REASON = `replaced by the deterministic renderer ${STAMP}`;
// R1: refuted (outcome_status='failed') + deprecated decisions.
const FAILED_TITLE = `ws2 refuted decision ${STAMP}`;
const FAILED_NOTES = `canary showed 3x latency regression ${STAMP}`;
const FAILED2_TITLE = `ws2 refuted-no-notes decision ${STAMP}`;
const FAILED2_RATIONALE = `looked cheaper on paper ${STAMP}`;
const DEPR_TITLE = `ws2 deprecated-with-reason decision ${STAMP}`;
const DEPR_NOTES = `library abandoned upstream ${STAMP}`;
const DEPR_NOREASON_TITLE = `ws2 deprecated-no-reason decision ${STAMP}`;
const CONVENTION_BODY = `all tunables live in named config ${STAMP}`;
const DEAD_CTX_HEAD = `ws2 rejected approach headline ${STAMP}`;
const DEAD_CTX_BODY_MARK = `WS2-DEAD-CTX-BODY-${STAMP}`;

describe('project_briefing — PART A: behavioral', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'ws2 briefing') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    emptyProjectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'ws2 briefing empty') RETURNING id`,
        [EMPTY_PROJ_NAME],
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // Two handoffs THROUGH THE REAL WRITE PATH — storing #2 mints the declared
    // supersedes edge onto #1 (handoffSupersession), so "latest non-superseded" is real.
    await viaTool('context_store', { content: `${HANDOFF1_MARK} old resume point`, type: 'handoff' });
    await viaTool('context_store', { content: HANDOFF2_BODY, type: 'handoff' });

    // Open + closed tasks.
    await viaTool('task_create', { title: `ws2 blocked task ${STAMP}`, type: 'general', status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', description: TASK_DESC });
    await viaTool('task_create', { title: DONE_TASK_TITLE, type: 'general', status: 'completed', description: `finished ${STAMP}` });

    // A live decision and a superseded one.
    await viaTool('decision_record', {
      decisionType: 'architecture',
      title: `ws2 live decision ${STAMP}`,
      description: 'deterministic renderer',
      rationale: DECISION_RATIONALE,
      impactLevel: 'medium',
    });
    const dead = await viaTool('decision_record', {
      decisionType: 'architecture',
      title: DEAD_DECISION_TITLE,
      description: 'model-in-the-loop summarizer',
      rationale: 'seemed clever',
      impactLevel: 'medium',
    });
    await db.query(
      `UPDATE technical_decisions SET status='superseded', superseded_reason=$2 WHERE id=$1`,
      [dead.structuredContent.decision.id, DEAD_DECISION_REASON],
    );

    // R1 seeds: refuted + deprecated decisions (statuses set via SQL, as the loop
    // evaluator / curation would; the briefing reads the same columns either way).
    const mkDecision = async (title: string, rationale: string) =>
      (
        await viaTool('decision_record', {
          decisionType: 'architecture',
          title,
          description: 'r1 seed',
          rationale,
          impactLevel: 'medium',
        })
      ).structuredContent.decision.id;
    const failedId = await mkDecision(FAILED_TITLE, 'plausible at the time');
    await db.query(`UPDATE technical_decisions SET outcome_status='failed', outcome_notes=$2 WHERE id=$1`, [failedId, FAILED_NOTES]);
    const failed2Id = await mkDecision(FAILED2_TITLE, FAILED2_RATIONALE);
    await db.query(`UPDATE technical_decisions SET outcome_status='failed' WHERE id=$1`, [failed2Id]);
    const deprId = await mkDecision(DEPR_TITLE, 'was fine once');
    await db.query(`UPDATE technical_decisions SET status='deprecated', outcome_notes=$2 WHERE id=$1`, [deprId, DEPR_NOTES]);
    const deprNoReasonId = await mkDecision(DEPR_NOREASON_TITLE, 'still a live-sounding rationale');
    await db.query(`UPDATE technical_decisions SET status='deprecated' WHERE id=$1`, [deprNoReasonId]);

    // A convention-tagged context.
    await viaTool('context_store', { content: CONVENTION_BODY, type: 'planning', tags: ['convention'] });

    // A superseded (non-handoff) context: B declared-supersedes A via an EXPLICIT edge
    // (created_by ≠ the handoff-timeline minter, so it must land in dead-ends).
    const deadCtx = await viaTool('context_store', {
      content: `${DEAD_CTX_HEAD}\n${DEAD_CTX_BODY_MARK} full body that must never render`,
      type: 'planning',
    });
    const successor = await viaTool('context_store', {
      content: `ws2 successor approach ${STAMP}`,
      type: 'planning',
    });
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via)
       VALUES ($1,'context',$2,'context','supersedes',$3,'link','link-tool')`,
      [successor.structuredContent.context.id, deadCtx.structuredContent.context.id, projectId],
    );
  });

  afterAll(async () => {
    for (const pid of [projectId, emptyProjectId]) {
      try {
        await db.query('DELETE FROM links WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
        await db.query('DELETE FROM projects WHERE id = $1', [pid]);
      } catch {
        /* ignore */
      }
    }
    await db.end();
  });

  test('the FULL handoff rides untruncated, and the superseded handoff is not in the briefing', async () => {
    const resp = await viaTool('project_briefing', {});
    const text = responseText(resp);
    // Whole body verbatim — head, tail, and the exact full string (no truncation anywhere).
    expect(text).toContain(HANDOFF2_BODY);
    // The superseded (timeline) handoff: not a body record, and NOT a dead-end either —
    // routine trunk supersession is history, not a rejected approach.
    expect(text).not.toContain(HANDOFF1_MARK);
  });

  test('open tasks carry status + FULL multi-line description; closed tasks are absent', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    expect(text).toContain('[status:blocked]');
    for (const line of TASK_DESC.split('\n')) expect(text).toContain(line);
    expect(text).not.toContain(DONE_TASK_TITLE);
  });

  test('live decisions render title + rationale grouped by decision_type', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    expect(text).toContain(`ws2 live decision ${STAMP}`);
    expect(text).toContain(`why: ${DECISION_RATIONALE}`);
    expect(text).toContain('### architecture');
  });

  test('convention-tagged context renders in Conventions with full content', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    expect(text).toContain(CONVENTION_BODY);
  });

  test('SUPERSEDED records appear ONLY in dead-ends: one line, body content absent', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    // Decision corpse: one line carrying the WHY, labelled by what actually happened to
    // it. This decision was REPLACED (status='superseded'), so the line must say so —
    // rendering it "tried and rejected" asserts a refutation nothing in the row records.
    expect(text).toContain(`superseded: ${DEAD_DECISION_TITLE} — ${DEAD_DECISION_REASON}`);
    expect(text).not.toContain(`tried and rejected: ${DEAD_DECISION_TITLE}`);
    // Context corpse: headline line present, FULL BODY absent everywhere.
    expect(text).toContain(`superseded: ${DEAD_CTX_HEAD}`);
    expect(text).not.toContain(`tried and rejected: ${DEAD_CTX_HEAD}`);
    expect(text).not.toContain(DEAD_CTX_BODY_MARK);
    // And the dead decision is not ALSO in the body Decisions section: its title must
    // appear exactly once (the dead-end line), never under a decision-type group.
    const hits = text.split(DEAD_DECISION_TITLE).length - 1;
    expect(hits).toBe(1);
  });

  test('R1: REFUTED decision (outcome_status=failed) is a dead-end, NOT live guidance', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    // Dead-end line, reason = outcome_notes (first link of the chain).
    // `outcome_status='failed'` is the ONE basis that licenses the rejection claim.
    expect(text).toContain(`tried and rejected: ${FAILED_TITLE} — ${FAILED_NOTES}`);
    // NOT in the body: the title appears exactly once (the dead-end line).
    expect(text.split(FAILED_TITLE).length - 1).toBe(1);
  });

  test('R1: refuted decision with NO notes/superseded_reason falls to rationale as the because', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    expect(text).toContain(`tried and rejected: ${FAILED2_TITLE} — ${FAILED2_RATIONALE}`);
    expect(text.split(FAILED2_TITLE).length - 1).toBe(1);
  });

  test('R1: deprecated decision WITH a reason is a dead-end; without one it is omitted entirely', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    // Retired guidance with a reason, no successor named: `deprecated`, not `rejected`.
    expect(text).toContain(`deprecated: ${DEPR_TITLE} — ${DEPR_NOTES}`);
    expect(text).not.toContain(`tried and rejected: ${DEPR_TITLE}`);
    expect(text.split(DEPR_TITLE).length - 1).toBe(1);
    // Deprecated-without-reason: history, not a rejected approach — absent everywhere
    // (its rationale must NOT be promoted to a fabricated "because").
    expect(text).not.toContain(DEPR_NOREASON_TITLE);
  });

  test('trust annotations ride inline in WS1 signal form', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    // The signal grammar from explainTrust().signal, bracketed by the renderer.
    expect(text).toMatch(/\[trust:[a-z]+ score:[0-9.]+/);
  });

  test('no emoji lines and no URL lines on the wire (machine/injection audience)', async () => {
    const text = responseText(await viaTool('project_briefing', {}));
    const emojiHit = text.split('\n').find((l) => EMOJI_RE.test(l));
    expect(emojiHit, `briefing emitted emoji: "${emojiHit}"`).toBeUndefined();
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('/r/');
  });

  test('EMPTY project renders a valid minimal briefing (C3: empty population)', async () => {
    const resp = await viaTool('project_briefing', { project: emptyProjectId });
    const text = responseText(resp);
    expect(text).toContain(`# Project briefing: ${EMPTY_PROJ_NAME}`);
    expect(text).toContain('## Handoff');
    expect(text).toContain('none recorded');
    expect(text).toContain('## Open tasks (0)');
    expect(text).toContain('## Decisions (0)');
    expect(text).toContain('## Conventions (0)');
    expect(text).toContain('## Dead ends (0)');
    expect(text).not.toContain('omitted:');
    expect(resp.structuredContent.briefing.droppedRecords).toBe(0);
  });

  test('unknown project is the LOUD typed refusal (the house projectParamContract gate)', async () => {
    // The param-contract layer intercepts an unresolvable `project` BEFORE the handler —
    // measured behavior, and the right one: refuse to run against an unresolved scope.
    const resp = await viaTool('project_briefing', { project: `no-such-project-${STAMP}` });
    expect(resp.isError).toBe(true);
    expect(responseText(resp)).toContain('[PROJECT_ARG_UNRESOLVED]');
  });

  test('reachable on BOTH surfaces: the project gateway action resolves to the same renderer', async () => {
    const gw = await dispatchGateway('project', { action: 'briefing' }, { connectionId: CONN });
    const text = responseText(gw);
    expect(text).toContain(HANDOFF2_TAIL);
    expect((gw.structuredContent as any).briefing.projectId).toBe(projectId);
  });

  test('structuredContent carries the briefing meta (size, drops, per-section counts)', async () => {
    const resp = await viaTool('project_briefing', {});
    const b = resp.structuredContent.briefing;
    expect(b.sizeChars).toBe(b.markdown.length);
    expect(b.included.tasks).toBeGreaterThanOrEqual(1);
    expect(b.included.decisions).toBeGreaterThanOrEqual(1);
    expect(b.included.conventions).toBeGreaterThanOrEqual(1);
    expect(b.included.deadEnds).toBeGreaterThanOrEqual(2);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART B — the PURE renderer under attack (fabricated corpora; trust + dates controlled)
 * ══════════════════════════════════════════════════════════════════════════════════════ */

const CFG = (maxChars: number, deadEndReservedChars = 4000): BriefingConfig => ({
  maxChars,
  conventionTags: ['convention', 'constraint'],
  openTaskStatuses: ['todo', 'in_progress', 'blocked'],
  sectionMaxRecords: 200,
  deadEndReservedChars,
  handoffHeadMaxHops: READ_HANDOFF_HEAD_MAX_HOPS(),
  handoffHeadCandidateHeadlineChars: READ_HANDOFF_HEAD_CANDIDATE_HEADLINE_CHARS(),
  handoffHeadRefusalRemedy: READ_HANDOFF_HEAD_REFUSAL_REMEDY(),
  deadEndTags: ['dead-end', 'deadend', 'rejected'],
  handoffStampEnabled: true,
  handoffStampFormat: ' [now: {status}]',
  // OFF for this suite, for the same reason backfillEnabled/altitudeEnabled are: these cases
  // assert the earlier document and its char arithmetic, and the recording directive is
  // ~1k chars of frame that would shift every cap assertion here without being what they
  // measure. The directive's own behaviour — including that it is ON by default in the
  // shipped config — is asserted by projectBriefingRecordingDirective.contract.test.ts.
  recordingDirectiveEnabled: false,
  recordingDirective: 'FAB-RECORDING-DIRECTIVE-UNUSED',
  handoffStampDeletedLabel: 'deleted',
  excludedTaskTags: ['parked'],
  branchReservedChars: 4000,
  alwaysSurfaceTaskStatuses: ['blocked'],
  // This suite predates SK5's flag and asserts the PRE-SK5 drop order, which is exactly
  // what the flag OFF preserves — so it stays off here rather than being switched on.
  branchScopeEnabled: false,
  // The protection ladder, written as LITERALS rather than imported from briefingConfig.ts.
  // An oracle that imports the value it is checking cannot fail; these are the shipped
  // defaults, restated by hand, so a change to them shows up here as a diff to review.
  protectionRankBranchMember: 4,
  protectionRankAlwaysSurface: 3,
  protectionRankConvention: 3,
  // the briefing-budget decision's measurement knob, restated at its SHIPPED default (the floor) like the ranks
  // above it: a decision gets no band of its own until a measurement says it should.
  protectionRankDecision: 0,
  protectionRankStalePriority: 2,
  protectionRankPriority: 1,
  protectedTaskPriorities: ['urgent', 'high'],
  staleTaskDays: 7,
  // OFF for this suite: it asserts WHICH records the cap drops, and the backfill's whole job
  // is to put some of them back. The backfill has its own tests; this one keeps measuring the
  // drop order in isolation.
  backfillEnabled: false,
  // P5.5: this suite asserts the CAP / DROP behaviour of the pre-P5.5 sections, so the
  // "Waiting on a human" section is switched OFF here rather than left to a default. It has
  // its own reserved budget and is not in the global drop pool, so admitting it would add a
  // section to the document these fixtures measure in chars without adding anything the
  // assertions are about. The section's own behaviour is asserted by its own suites.
  waitingSectionEnabled: false,
  waitingReservedChars: 2500,
  waitingMaxRecords: 25,
  waitingFallbackCaveat: 'FAB-FALLBACK-CAVEAT',
  waitingDueHintCaveat: 'FAB-HINT-CAVEAT',
  // OFF for this suite, for the same reason branchScopeEnabled is: PART B predates P5.1 and
  // asserts the PRE-P5.1 render — full prose for every record, and the size cap as the only
  // selector. That document is exactly what the flag OFF preserves (applyAltitudeFlag), so
  // these cases keep measuring what they were written to measure. The ON document has its own
  // suite (projectBriefingAltitude.contract.test.ts), including the byte-identity proof that
  // OFF and pre-P5.1 are the same bytes.
  altitudeEnabled: false,
  // Restated by hand rather than imported, matching the ladder literals above: an oracle that
  // imports the value it is checking cannot fail. With altitudeEnabled false every one of
  // these is collapsed to unbounded before it is read, which is itself the property under
  // test in the OFF cases.
  selectMaxTasks: 28,
  selectMaxDecisions: 16,
  selectMaxConventions: 5,
  selectMaxDeadEnds: 15,
  selectMaxBranchMembers: 26,
  fullProseSlots: 3,
  fullProseTypes: ['task', 'decision'],
  fullProseMaxChars: 1200,
  fullProseExcludeTags: [],
});

/** A fabricated task record with unique START/END markers for boundary assertions. */
function fabTask(n: number, score: number | null, iso: string) {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `T${n}-START`,
    description: `T${n}-body ${'x'.repeat(400)} T${n}-END`,
    status: 'todo',
    priority: 'medium',
    createdAt: new Date(iso),
    trustSignal: `trust:test score:${score === null ? 'n/a' : score.toFixed(2)}`,
    trustScore: score,
    metadata: null,
    // No tags: this corpus never exercises the P5.1 full-prose exclude vocabulary, and an
    // empty array is the honest fixture for "this record carries none" (the exclude
    // vocabulary's own tests live in the altitude suite).
    tags: [],
  };
}

function fabData(tasks: ReturnType<typeof fabTask>[]): BriefingData {
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'fab',
    handoffHead: resolvedHead({ id: FAB_HANDOFF_ID }),
    handoff: {
      id: FAB_HANDOFF_ID,
      content: 'HANDOFF-START resume point HANDOFF-END',
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
    deadEnds: [],
    branch: null,
    // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
    // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
    // claim here; a fabricated EMPTY section would assert a zero nobody measured.
    waiting: null,
    census: censusFor({ tasks, decisions: [], conventions: [], deadEnds: [] }),
  };
}

describe('project_briefing — PART B: the size cap drops, never truncates', () => {
  test('under the cap: nothing dropped, all records whole', () => {
    const data = fabData([fabTask(1, 0.9, '2026-08-10T00:00:00Z')]);
    const r = renderBriefing(data, CFG(100000));
    expect(r.droppedRecords).toBe(0);
    expect(r.markdown).toContain('T1-START');
    expect(r.markdown).toContain('T1-END');
    expect(r.markdown).not.toContain('omitted:');
  });

  test('over the cap: WHOLE records dropped at record boundaries — never a sliced string', () => {
    const tasks = [
      fabTask(1, 0.2, '2026-08-01T00:00:00Z'), // least trusted + oldest → drops first
      fabTask(2, 0.5, '2026-08-05T00:00:00Z'),
      fabTask(3, 0.9, '2026-08-09T00:00:00Z'), // most trusted + newest → survives longest
    ];
    const data = fabData(tasks);
    const full = renderBriefing(data, CFG(1000000)).markdown;
    // Pick a cap that forces at least one drop but can hold the frame + some records.
    const cap = full.length - 200;
    const r = renderBriefing(data, CFG(cap));
    expect(r.droppedRecords).toBeGreaterThanOrEqual(1);
    expect(r.markdown.length).toBeLessThanOrEqual(cap);
    // RECORD-BOUNDARY LAW: for every record, both markers present or both absent.
    for (const n of [1, 2, 3]) {
      const hasStart = r.markdown.includes(`T${n}-START`);
      const hasEnd = r.markdown.includes(`T${n}-END`);
      expect(hasStart, `T${n} must be whole or absent (START ${hasStart}, END ${hasEnd})`).toBe(hasEnd);
    }
    // The omitted note is honest.
    expect(r.markdown).toContain(`omitted: ${r.droppedRecords} whole records`);
  });

  test('drop ORDER within a band is least-trusted-oldest first, at EVERY cap', () => {
    const tasks = [
      fabTask(1, 0.2, '2026-08-01T00:00:00Z'), // drops first
      fabTask(2, 0.5, '2026-08-05T00:00:00Z'),
      fabTask(3, 0.9, '2026-08-09T00:00:00Z'), // survives longest
    ];
    const data = fabData(tasks);
    const full = renderBriefing(data, CFG(1000000)).markdown.length;

    // A SWEEP, NOT ONE MAGIC CAP. This used to pick `full - 10` and assert exactly one drop.
    // That worked only while one record was bigger than the `omitted:` note plus the section
    // note that a drop ADDS — a property of the FRAME's wording, not of the drop order this
    // test is about, and it broke the first time the note got a word longer. The order itself
    // is what is asserted now: at any cap, the survivors must be a SUFFIX of the drop order
    // [T1, T2, T3] — never T1 without T2, never T2 without T3.
    const seen = new Set<string>();
    for (let cap = 300; cap <= full + 17; cap += 17) {
      const r = renderBriefing(data, CFG(cap));
      const present = [1, 2, 3].map((n) => (r.markdown.includes(`T${n}-START`) ? 1 : 0));
      expect(present, `cap=${cap} survivors=${present}`).toEqual([...present].sort((a, b) => a - b));
      seen.add(present.join(''));
    }
    // The sweep must actually EXERCISE dropping, or "always a suffix" is vacuously true
    // because nothing was ever dropped. Two states are required: everything present, and
    // ONLY the newest-most-trusted record surviving — which is the drop order stated as an
    // outcome. `011` is deliberately NOT required: measured on this fabricated corpus, the
    // `omitted:` note plus the section's `note:` line cost 536 chars against a 491-char
    // record, so the first drop never frees enough to leave two survivors at any cap. That
    // is a fact about this tiny frame, not about the order, and asserting it would be
    // asserting an unreachable state.
    expect([...seen].sort()).toEqual(expect.arrayContaining(['001', '111']));
  });

  test('the HANDOFF is exempt: never dropped, never truncated, even when the cap is tiny', () => {
    const data = fabData([fabTask(1, 0.9, '2026-08-10T00:00:00Z')]);
    const r = renderBriefing(data, CFG(50)); // smaller than the handoff itself
    expect(r.markdown).toContain('HANDOFF-START resume point HANDOFF-END');
    // Every droppable went; the handoff + frame remain (over cap, honestly, not mutilated).
    expect(r.droppedRecords).toBe(1);
    expect(r.markdown).not.toContain('T1-START');
    // R1 nit 1 — HONESTY: the note must state the cap was EXCEEDED, not claim it was
    // honored (the cap-honored wording must be absent).
    expect(r.markdown).toContain('size cap exceeded: the handoff + frame alone exceed the cap');
    expect(r.markdown).toContain('output is over cap');
    expect(r.markdown).not.toContain('dropped to honor the size cap');
  });

  test('empty fabricated data renders a stable minimal document (C3 empty population)', () => {
    const data: BriefingData = { ...fabData([]), handoff: null };
    const r = renderBriefing(data, CFG(24000));
    expect(r.droppedRecords).toBe(0);
    expect(r.markdown).toContain('none recorded');
    expect(r.markdown).toContain('## Open tasks (0)');
    // Deterministic: same input, same bytes.
    expect(renderBriefing(data, CFG(24000)).markdown).toBe(r.markdown);
  });
});

describe('project_briefing — static scan: the renderer assembles no emoji', () => {
  test('services/projectBriefing.ts has zero emoji payload lines (WS1 scanner, one definition)', () => {
    const src = readFileSync(resolve(__dirname, '../services/projectBriefing.ts'), 'utf8');
    expect(emojiPayloadLines(src)).toEqual([]);
  });
});
