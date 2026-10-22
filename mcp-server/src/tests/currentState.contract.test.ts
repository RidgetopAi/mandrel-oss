/**
 * CURRENT-STATE read model — end-to-end contract tests.
 *
 * The pure classification/gate/determinism rules are covered by currentState.unit.test.ts.
 * THIS suite drives the REAL tool — validate → routeExecutor, the exact path the HTTP bridge
 * uses — against the CI Postgres, building each graph with the PUBLIC tools (context_store /
 * task_create / decision_record / link). Nothing here reaches past the tool contract: if the
 * read model cannot be exercised through the public surface, that is a finding, not a
 * workaround (no-cheating / feel-the-pain).
 *
 * WHAT IT LOCKS, on the real surface:
 *   - `altitude:"current"` is accepted by validation and returns the current-state payload,
 *   - the eval's TWO acceptance shapes (report lines 524-554): a completed/RELEASED thread and
 *     a VALIDATED-BUT-UNRELEASED one each return a gate + a next action WITHOUT repeating
 *     every historical handoff,
 *   - a DECLARED supersession minted through the public `link` tool is OMITTED from the
 *     sections but COUNTED — the honesty signal, proven against a real edge and the real
 *     trust service rather than a hand-built Trust object,
 *   - DETERMINISM across repeated tool invocations on the same stored graph,
 *   - drill-down still works: the same anchor at a content altitude returns the story shape,
 *   - NO server-side LLM is invoked anywhere in the path.
 *
 * Embedding service mocked → deterministic + offline (mirrors recallThread.contract).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, zeroEmbedding } from './helpers/embedGeometry.js';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: zeroEmbedding(),
      dimensions: embedDim(),
      model: 'stub',
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { THREAD_PROJECTION_ALTITUDES } from '../config/threadConfig.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import {
  ARTIFACT_REF_CONFIG,
  PROVIDER_RULES,
  effectiveProviders,
  effectiveArtifactTypes,
} from '../config/artifactRefConfig.js';
import { validateArtifactRef } from '../services/artifactRef.js';

const STAMP = Date.now();
const CONN = `current-state-conn-${STAMP}`;
const PROJ_NAME = `current-state-P-${STAMP}`;
/** The altitude under test, read from config — never a literal typed into this file. */
const CURRENT = THREAD_PROJECTION_ALTITUDES[0];

let projectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function storeContext(content: string, type: string, metadata?: any): Promise<string> {
  const r = await viaTool('context_store', {
    content,
    type,
    ...(metadata ? { metadata } : {}),
  });
  return r.structuredContent.context.id;
}
async function createTask(title: string, status?: string, metadata?: any): Promise<string> {
  const r = await viaTool('task_create', { title, ...(metadata ? { metadata } : {}) });
  const id = r.structuredContent.task.id;
  // a move to `blocked` must now NAME its blocker.
  if (status) await viaTool('task_update', {
    taskId: id, status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) });
  return id;
}
async function recordDecision(title: string, outcomeStatus?: string): Promise<string> {
  const r = await viaTool('decision_record', {
    decisionType: 'architecture',
    title,
    description: 'd',
    rationale: 'r',
    impactLevel: 'medium',
    ...(outcomeStatus ? { outcomeStatus } : {}),
  });
  return r.structuredContent.decision.id;
}
async function link(from: string, fromType: string, to: string, toType: string, edgeType: string) {
  return viaTool('link', { from, fromType, to, toType, edgeType });
}

/** A valid artifact reference derived from (and validated by) the product's own config. */
function artifactRef(): Record<string, unknown> {
  for (const artifactType of effectiveArtifactTypes()) {
    for (const provider of effectiveProviders()) {
      const rule = PROVIDER_RULES[provider];
      const candidate: Record<string, unknown> = {
        artifactType,
        repository: 'mandrel',
        head: 'a'.repeat(40),
        base: 'b'.repeat(40),
        sha256: 'c'.repeat(64),
        producerThread: 'T-current-state-contract',
        retrieval: {
          provider,
          [rule.locatorField]:
            rule.locatorField === 'uri'
              ? 'https://example.invalid/artifacts/thing.bundle'
              : '/srv/artifacts/thing.bundle',
        },
      };
      if (validateArtifactRef(candidate).ok) return candidate;
    }
  }
  throw new Error('no valid (artifactType × provider) combination — fixture cannot be built');
}
const artifactMetadata = () => ({ [ARTIFACT_REF_CONFIG.metadataKey]: [artifactRef()] });

/** The repeated evidence the eval measured — the exact thing that must NOT be echoed back. */
const REPEATED_EVIDENCE = 'commit 9f2c1ab; 1726 tests green; reviewed and accepted';

// ─────────────────────────────────────────────────────────────────────────────

describe('recall_thread altitude:current — the deterministic current-state read model', () => {
  /** Shape 1: completed AND released. */
  let releasedRoot: string;
  /** Shape 2: validated but UNRELEASED. */
  let unreleasedRoot: string;
  /** A thread carrying a declared supersession. */
  let supersessionRoot: string;
  let supersededCtx: string;
  /** A thread with open work + a blocker. */
  let openRoot: string;
  let blockerTask: string;
  /** A handoff-free thread with NO supersession anywhere (the honesty-at-zero anchor). */
  let zeroRoot: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'current_state contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });

    // ── SHAPE 1 — completed AND released ────────────────────────────────────
    releasedRoot = await createTask('RELEASED root — ship the thing', 'completed', artifactMetadata());
    const relWorker = await createTask('RELEASED worker task', 'completed');
    const relDecision = await recordDecision('RELEASED decision', 'successful');
    // Four historical handoffs carrying IDENTICAL evidence — the eval's measured cost.
    //
    // MEASURED, raising this loop past the recency cap (to exercise the cap at
    // the REAL surface) does not test what it looks like it tests — at 7 near-identical
    // handoffs the belief layer DECLARED-supersedes them, all 7 leave via the supersession
    // door, and the section reads 0. The cap is exercised offline instead, in
    // currentState.unit.test.ts ("the cap comes from CONFIG and reports what it dropped"),
    // where the graph is built by hand and no adjudication runs. Left at 4 deliberately.
    for (let i = 0; i < 4; i++) {
      const h = await storeContext(`handoff ${i}: ${REPEATED_EVIDENCE}`, 'handoff');
      await link(h, 'context', releasedRoot, 'task', 'informs');
    }
    await link(relWorker, 'task', releasedRoot, 'task', 'depends_on');
    await link(relDecision, 'decision', releasedRoot, 'task', 'built_by');

    // ── SHAPE 2 — validated but UNRELEASED (no artifact reference anywhere) ──
    unreleasedRoot = await createTask('UNRELEASED root — validated, not shipped', 'completed');
    const unrelWorker = await createTask('UNRELEASED worker task', 'completed');
    for (let i = 0; i < 3; i++) {
      const h = await storeContext(`handoff ${i}: ${REPEATED_EVIDENCE}`, 'handoff');
      await link(h, 'context', unreleasedRoot, 'task', 'informs');
    }
    await link(unrelWorker, 'task', unreleasedRoot, 'task', 'depends_on');

    // ── A DECLARED supersession, minted through the PUBLIC link tool ─────────
    supersessionRoot = await createTask('SUPERSESSION root', 'completed', artifactMetadata());
    supersededCtx = await storeContext('the OLD approach — replaced', 'completion');
    const newerCtx = await storeContext('the NEW approach — current', 'completion');
    await link(supersededCtx, 'context', supersessionRoot, 'task', 'informs');
    await link(newerCtx, 'context', supersessionRoot, 'task', 'informs');
    await link(newerCtx, 'context', supersededCtx, 'context', 'supersedes');

    // ── OPEN work + a blocker ───────────────────────────────────────────────
    openRoot = await createTask('OPEN root', 'in_progress');
    blockerTask = await createTask('BLOCKED dependency', 'blocked');
    await link(blockerTask, 'task', openRoot, 'task', 'depends_on');

    // ── A ZERO-supersession thread (for the honesty-at-zero case) ───────────
    // NO handoffs here, deliberately: since PHASE 2 item g every stored
    // handoff declared-supersedes the project's previous one, so "a thread with several
    // handoffs and ZERO superseded records" is no longer a state the product can be in —
    // the zero case must anchor on handoff-free threads or its precondition is
    // unsatisfiable by design.
    zeroRoot = await createTask('ZERO-supersession root', 'completed');
    const zeroCtx = await storeContext('a plain note on the zero thread', 'completion');
    await link(zeroCtx, 'context', zeroRoot, 'task', 'informs');
  }, 60000);

  afterAll(async () => {
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]).catch(() => {});
  });

  // ───────────────────────────────────────────────────────────────────────────

  test('validation ACCEPTS the projection altitude on the real tool surface', () => {
    const v = validateToolArguments('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    expect(v.altitude).toBe(CURRENT);
  });

  test('ACCEPTANCE SHAPE 1 — completed/RELEASED returns a gate + next action', async () => {
    const r = await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    expect(r.structuredContent.ok).toBe(true);
    const cs = r.structuredContent.currentState;
    expect(cs).toBeTruthy();
    expect(cs.nextAction.gate).toBe('complete');
    expect(cs.nextAction.action).toBeTruthy();
    expect(cs.artifactHead).not.toBeNull();
    expect(cs.activeTasks.total).toBe(0);
    expect(cs.blockers.total).toBe(0);
    // The text channel leads with the gate and the next action — that IS the orientation.
    const text = responseText(r);
    expect(text).toMatch(/GATE: complete/);
    expect(text).toMatch(/NEXT: /);
  });

  test('ACCEPTANCE SHAPE 2 — validated-but-UNRELEASED returns its own gate + next action', async () => {
    const r = await viaTool('recall_thread', { anchor: unreleasedRoot, altitude: CURRENT });
    const cs = r.structuredContent.currentState;
    expect(cs.nextAction.gate).toBe('awaiting-release');
    expect(cs.nextAction.action).toMatch(/artifact/i);
    expect(cs.artifactHead).toBeNull();
    expect(responseText(r)).toMatch(/GATE: awaiting-release/);
  });

  test('BOTH shapes orient WITHOUT repeating every historical handoff', async () => {
    // WHAT CHANGED, AND WHY THIS ASSERTS A BOUND RATHER THAN AN ABSENCE.
    // Before the recency door, a context that was neither a finding nor a TRUSTED outcome had
    // no door at all. That absence read as thrift here — the repeated handoff evidence simply
    // never appeared — but it was also the defect: the same rule hid a run report written five
    // minutes ago, because trust accrues after the fact and a fresh record is `unproven` by
    // construction. The property the eval actually bought was BOUNDEDNESS, not silence, so
    // that is what is asserted, against the product's OWN cap.
    //
    // WHY THIS DOES NOT ASSERT `recentContexts.total > 0` — MEASURED, not assumed. These four
    // handoffs carry IDENTICAL text, so the belief layer frequently DECLARES supersession
    // among them, and a declared-superseded record leaves through the supersession door, which
    // outranks every other disposition by design. Measured on a freshly provisioned DB:
    // omitted.superseded.count 5, recentContexts.total 0. WHICH door claims them is
    // adjudication timing, not this test's subject. (The cap itself is exercised
    // deterministically offline — currentState.unit.test.ts, "the cap comes from CONFIG and
    // reports what it dropped" — where the graph is built by hand and no adjudication runs.)
    const cap = CURRENT_STATE_CONFIG.limits.recentContexts;
    for (const anchor of [releasedRoot, unreleasedRoot]) {
      const r = await viaTool('recall_thread', { anchor, altitude: CURRENT });
      const cs = r.structuredContent.currentState;
      const text = responseText(r);

      // Every handoff was reached and ACCOUNTED FOR — none vanished silently…
      expect(cs.counts.listed + cs.counts.superseded + cs.counts.historical).toBe(
        cs.counts.examined
      );
      // …the recency section states its own boundary (nothing dropped in silence)…
      expect(cs.recentContexts.items.length + cs.recentContexts.omittedByCap).toBe(
        cs.recentContexts.total
      );
      // …and the repeated evidence appears at most CAP times in either channel — never once
      // per handoff, which is the cost this altitude exists to remove.
      const occurrences = (blob: string) => blob.split(REPEATED_EVIDENCE).length - 1;
      expect(occurrences(text)).toBeLessThanOrEqual(cap);
      expect(occurrences(JSON.stringify(cs))).toBeLessThanOrEqual(cap);
      // Tied to what was actually RENDERED, so this cannot pass by the evidence disappearing
      // for some unrelated reason: it appears exactly once per listed recency item, no more.
      expect(occurrences(text)).toBe(cs.recentContexts.items.length);
    }
  });

  test('the CONTENT altitudes still return the full story — drill-down is intact', async () => {
    const full = await viaTool('recall_thread', { anchor: releasedRoot, altitude: 'full' });
    expect(full.structuredContent.nodes.length).toBeGreaterThan(1);
    // The story altitude DOES carry the evidence — that is what it is for. The current-state
    // altitude is a different question, not a replacement.
    expect(responseText(full)).toContain(REPEATED_EVIDENCE);
    // …and it does NOT carry a current-state payload.
    expect(full.structuredContent.currentState).toBeUndefined();
    // The two answer shapes are discriminated by `altitude`, which is always present.
    expect(full.structuredContent.altitude).toBe('full');
  });

  test('THE HONESTY SIGNAL — a DECLARED supersession is omitted from sections but COUNTED', async () => {
    const r = await viaTool('recall_thread', { anchor: supersessionRoot, altitude: CURRENT });
    const cs = r.structuredContent.currentState;

    // Counted, exactly, with the id available for drill-down.
    expect(cs.omitted.superseded.count).toBeGreaterThanOrEqual(1);
    expect(cs.omitted.superseded.sampleIds).toContain(supersededCtx);
    expect(cs.counts.superseded).toBe(cs.omitted.superseded.count);

    // Omitted from EVERY section.
    const listed = [
      ...cs.activeTasks.items,
      ...cs.blockers.items,
      ...cs.latestTrustedOutcomes.items,
      ...cs.currentDecisions.items,
    ].map((n: any) => n.id);
    expect(listed).not.toContain(supersededCtx);

    // And SAID OUT LOUD in the text channel — a bounded answer must state its own boundary.
    expect(responseText(r)).toMatch(/Omitted: \d+ superseded/);
  });

  /**
   * F1 — THE ZERO CASE, in the TEXT channel (Reviewer, BLOCKING).
   *
   * The test above only ever ran against an anchor with count ≥ 1, so `/Omitted: \d+
   * superseded/` matched whether or not the line was conditional. Reviewer wrapped the
   * renderer's push in `if (sup.count > 0)` and BOTH current-state suites stayed green
   * (62 passed) — the exact regression the honesty line exists to prevent, invisible.
   *
   * The payload zero case was already guarded (currentState.unit.test.ts). The TEXT channel
   * was not, and the text channel is what an orienting agent actually reads. The whole point
   * of printing at zero is that "nothing was superseded" and "the count broke" must not look
   * the same, and they only differ if the line is UNCONDITIONAL.
   *
   * This anchors on threads with NO superseded records and demands the literal zero.
   *
   * ANCHOR CHANGE (PHASE 2 item g): this case originally anchored on
   * releasedRoot — whose fixture stores FOUR handoffs through the public path. Item g
   * makes every stored handoff declared-supersede its predecessor (the trunk timeline's
   * corroboration feed), so releasedRoot's thread now REALLY contains superseded records
   * — the count the old precondition pinned to 0 measures 5 genuine edges. That is the
   * new truth, not a broken counter; the zero case moves to threads that carry no
   * handoff timeline (zeroRoot, openRoot), where zero is still a reachable state.
   */
  test('THE HONESTY SIGNAL AT ZERO — the omission line is printed even when nothing was omitted', async () => {
    for (const anchor of [zeroRoot, openRoot]) {
      const r = await viaTool('recall_thread', { anchor, altitude: CURRENT });
      // Guard the guard: if this anchor ever GAINS a superseded record, the assertion below
      // would pass for the wrong reason (a non-zero count), so pin the precondition first.
      expect(
        r.structuredContent.currentState.omitted.superseded.count,
        'this anchor must have ZERO superseded records or the zero-case assertion is vacuous'
      ).toBe(0);
      expect(
        responseText(r),
        'the omission line must be UNCONDITIONAL — at zero it is what tells the reader ' +
          '"nothing was superseded" rather than leaving a missing line they have to notice'
      ).toMatch(/Omitted: 0 superseded/);
    }
  });

  test('the ACCOUNTING balances on a real graph (nothing vanishes silently)', async () => {
    for (const anchor of [releasedRoot, unreleasedRoot, supersessionRoot, openRoot]) {
      const cs = (await viaTool('recall_thread', { anchor, altitude: CURRENT })).structuredContent
        .currentState;
      expect(cs.counts.listed + cs.counts.superseded + cs.counts.historical).toBe(
        cs.counts.examined
      );
      expect(cs.counts.examined).toBeGreaterThan(0);
    }
  });

  /**
   * CROSS-CHANNEL AGREEMENT — neither channel gets to report a different walk.
   *
   * RE-HOMED (SEARCH P3 round 2). This property lived in
   * recallThreadStructuredTrim.contract.test.ts, which was deleted with the `full|lean`
   * structured mode it was named for. It has nothing to do with that mode: the prose has
   * emitted this count since long before lean existed (recall.routes.ts renderCurrentStateText)
   * and still does. The test above proves the structured counts balance AGAINST EACH OTHER;
   * only this one proves the number a HUMAN reads is the same number a MACHINE reads.
   *
   * Two channels that disagree about how many records a walk examined is the failure that
   * put "0 nodes for 16k chars" into a measuring harness's output — an instrument reading
   * one channel while the answer lived in the other.
   */
  test('the prose examined-count EQUALS the structured count (channels cannot disagree)', async () => {
    for (const anchor of [releasedRoot, unreleasedRoot, supersessionRoot, openRoot]) {
      const resp = await viaTool('recall_thread', { anchor, altitude: CURRENT });
      const cs = resp.structuredContent.currentState;
      const text = responseText(resp);

      const m = text.match(/(\d+) node\(s\) examined/);
      expect(m, `the prose must STATE an examined count (anchor ${anchor})`).toBeTruthy();
      expect(
        Number(m![1]),
        `prose says ${m![1]} node(s) examined, structuredContent says ${cs.counts.examined} ` +
          `(anchor ${anchor}) — the two channels are describing different walks`
      ).toBe(cs.counts.examined);
      // GUARD THE GUARD: at zero the equality would hold trivially on an empty answer.
      expect(cs.counts.examined).toBeGreaterThan(0);
    }
  });

  test('a BLOCKED dependency drives the gate, naming the blocking record', async () => {
    const cs = (await viaTool('recall_thread', { anchor: openRoot, altitude: CURRENT }))
      .structuredContent.currentState;
    expect(cs.nextAction.gate).toBe('blocked');
    expect(cs.nextAction.targetId).toBe(blockerTask);
    expect(cs.blockers.items.map((n: any) => n.id)).toContain(blockerTask);
    // The active root is still reported as open work alongside the gate.
    expect(cs.activeTasks.items.map((n: any) => n.id)).toContain(openRoot);
  });

  /**
   * Collect the JSON PATHS at which two payloads differ. Used instead of a bare equality
   * assertion so the determinism test can state EXACTLY which fields are allowed to move —
   * and go RED the day anything else starts moving.
   */
  function differingPaths(a: any, b: any, path = ''): string[] {
    if (a === b) return [];
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      return [path];
    }
    if (Array.isArray(a) !== Array.isArray(b)) return [path];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const k of keys) out.push(...differingPaths(a[k], b[k], `${path}.${k}`));
    return out;
  }

  /**
   * DETERMINISM — the honest claim, MEASURED rather than asserted.
   *
   * The PROJECTION is deterministic: classification, ordering, section membership, the gate,
   * the next action and every count are a pure function of the stored graph (proven
   * byte-identically, with fixed inputs, in currentState.unit.test.ts).
   *
   * What is NOT byte-stable over wall-clock time is the blended `trust.score`: the trust
   * model decays freshness continuously as 0.5^(age/halflife) and blends it in. That is the
   * trust model's design, not this read model's, and it is true of recall_thread at EVERY
   * altitude.
   *
   * `trust.freshness` USED TO BE ON THIS LIST and is no longer on the wire at all (SEARCH P3,
   * trust ships as band+score and nothing else). The score
   * is now also ROUNDED to a fixed precision, so two calls seconds apart will usually be
   * byte-identical — this filter permits movement, it does not require it, so a stabler
   * number cannot make the guard vacuous.
   *
   * So rather than pretend (or mask), this test names the clock-derived fields and asserts
   * they are the ONLY things that move. An unrecognized moving field is a loud RED — which is
   * what makes this a determinism guard rather than a determinism disclaimer.
   */
  test('DETERMINISM — repeated invocations differ ONLY in the clock-derived trust floats', async () => {
    const a = await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    const b = await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    const c = await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });

    const CLOCK_DERIVED = ['.trust.score'];
    for (const other of [b, c]) {
      const diffs = differingPaths(a.structuredContent, other.structuredContent);
      const unexpected = diffs.filter((p) => !CLOCK_DERIVED.some((suffix) => p.endsWith(suffix)));
      expect(
        unexpected,
        'the current-state projection moved between two identical calls in a field that is NOT ' +
          'a clock-derived trust float — the answer must be a pure function of the stored graph'
      ).toEqual([]);
    }

    // GUARD THE GUARD: if the payload carried no trust objects at all, the filter above would
    // be vacuous and this test would pass on an empty answer.
    // The sentinel is now the band key, for the same reason it was freshness before: it is a
    // field EVERY trust object carries, so its absence means the payload had no trust at all.
    expect(JSON.stringify(a.structuredContent)).toContain('"band"');
  });

  test('DETERMINISM — the whole non-trust payload is BYTE-identical across invocations', async () => {
    // The same claim as above, stated the other way round: strip the two clock-derived floats
    // and the payloads must be byte-for-byte equal. Two spellings because "differs only in X"
    // and "is identical without X" fail in different ways when a serializer changes.
    const strip = (o: any): any =>
      JSON.parse(
        JSON.stringify(o, (k, v) => (k === 'score' ? '<clock>' : v))
      );
    const a = await viaTool('recall_thread', { anchor: supersessionRoot, altitude: CURRENT });
    const b = await viaTool('recall_thread', { anchor: supersessionRoot, altitude: CURRENT });
    expect(JSON.stringify(strip(b.structuredContent))).toBe(
      JSON.stringify(strip(a.structuredContent))
    );
  });

  test('every listed node carries its permalink + lifecycle stamp (the orientation payload)', async () => {
    const cs = (await viaTool('recall_thread', { anchor: openRoot, altitude: CURRENT }))
      .structuredContent.currentState;
    expect(cs.root).not.toBeNull();
    expect(cs.root.id).toBe(openRoot);
    for (const item of [...cs.activeTasks.items, ...cs.blockers.items]) {
      expect(item.url).toMatch(/\/r\//);
      expect(item.status).toBeTruthy(); // a task always has a lifecycle status
      expect(item.trust).toBeTruthy(); // the moat rides on every node
    }
  });

  test('the default node altitude keeps the response BOUNDED (no content bodies)', async () => {
    expect(CURRENT_STATE_CONFIG.nodeAltitude).toBe('headline');
    const r = await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    for (const item of r.structuredContent.currentState.activeTasks.items) {
      expect(item.content).toBeUndefined();
    }
  });

  test('an UNRESOLVABLE anchor is an ACTIONABLE error, not a crash', async () => {
    const r = await viaTool('recall_thread', {
      anchor: 'deadbeefdeadbeefdeadbeef',
      altitude: CURRENT,
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ ok: false, found: false });
    expect(responseText(r)).toMatch(/recall_thread:/);
  });

  test('an anchor with NO edges is NOT an error — it returns its own state', async () => {
    // PHASE 1: work-start (the task_update to in_progress inside
    // createTask) now OPENS a branch position, and a task CREATED while positioned is
    // born with membership/parent edges — so a "lonely" fixture must step off the branch
    // the earlier fixtures opened, or it is not lonely by construction.
    await viaTool('branch_close', {});
    const lonely = await createTask('LONELY root', 'in_progress');
    // (that update re-opened the position ON lonely itself — irrelevant here: no further
    //  writes happen while standing there, and a position alone is not an edge.)
    await viaTool('branch_close', {});
    const r = await viaTool('recall_thread', { anchor: lonely, altitude: CURRENT });
    expect(r.structuredContent.ok).toBe(true);
    const cs = r.structuredContent.currentState;
    expect(cs.counts.examined).toBe(1);
    expect(cs.nextAction.gate).toBe('in-progress');
    expect(cs.nextAction.targetId).toBe(lonely);
  });

  /**
   * F2 — NO OUTBOUND CALL AT ALL, not "no call to a vendor I happened to list"
   * (Reviewer, BLOCKING).
   *
   * The claim this guards is a CONCEPT — "deterministic, no model call in the path" — and it
   * is the single non-negotiable of the whole feature: Mandrel runs inside customer
   * containers with no LLM/API key, so a model call here is product-breaking, not slow.
   *
   * The first version filtered for /anthropic|openai|groq|api\./ — a literal list of today's
   * vendor hostnames, i.e. an ALLOW-LIST wearing a guard's clothes. Ollama on
   * `http://127.0.0.1:11434` walks straight past it (this repo's own gate config already
   * references GATE_OLLAMA_ENDPOINT), and so do a self-hosted `https://llm.internal/v1` and
   * Bedrock. an input the guard does not recognize must be a LOUD RED, never a
   * silent pass — and a guard whose default is "pass" is not a guard.
   *
   * MEASURED: the current-state path makes ZERO fetch calls of any kind, so the strict
   * assertion costs nothing. Assert the concept, not the vendor list. If this ever goes RED
   * because a legitimate non-model fetch was added to the path, the right response is to
   * examine that call — not to reintroduce a name filter.
   */
  test('NO outbound call of ANY kind is made in the current-state path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
    await viaTool('recall_thread', { anchor: releasedRoot, altitude: CURRENT });
    expect(
      fetchSpy,
      'the current-state path made an outbound request. It must be a pure graph query — no ' +
        'model call, no network. Do NOT narrow this assertion to a vendor list: an ' +
        'unrecognized host (ollama on localhost, a self-hosted endpoint, Bedrock) is exactly ' +
        'what a name filter lets through.'
    ).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
