/**
 * GRAPH-AWARE PROJECT INSIGHTS — end-to-end contract tests.
 *
 * The pure coverage rules are covered by projectCoverage.unit.test.ts. THIS suite drives the
 * REAL tool — validate → routeExecutor, the exact path the HTTP bridge uses — against the CI
 * Postgres, building each graph with the PUBLIC tools (context_store / task_create /
 * decision_record / link) and the REAL trust service. Nothing here reaches past the tool
 * contract (no-cheating / feel-the-pain).
 *
 * WHAT IT LOCKS, on the real surface — THE EVAL'S ACCEPTANCE (report line 581):
 *   "this project reports strong task/outcome coverage, flags session attribution and
 *    unproven historical nodes, and does not recommend extra decisions merely because the
 *    absolute count is two."
 *
 *   1. A well-kept project with exactly TWO decisions and all tasks complete reports STRONG
 *      task/outcome coverage — and raises NO finding about how many decisions exist.
 *   2. The regression is pinned at the WORD level: the deleted heuristics' advice strings
 *      ("Low decision count…", "Few decisions documented…", "Limited planning context…")
 *      must not appear on either channel. Those strings are quoted from the pre-fix source
 *      here ON PURPOSE — they are the artefact under test, not a rule the product owns, and
 *      pinning them is what makes re-adding the heuristic a visible RED.
 *   3. Session attribution and unproven historical nodes are REPORTED as measured dimensions,
 *      not inferred.
 *   4. The coverage answer reads the GRAPH: minting a real edge through the public `link`
 *      tool MOVES the measured ratio. That is the difference from the count heuristics, and
 *      it is asserted against a before/after on the same project.
 *   5. Both channels carry it (a dual-channel client that drops `content` still gets it).
 *
 * Embedding service mocked → deterministic + offline (mirrors currentState.contract).
 */

import { describe, test, expect, beforeAll, vi } from 'vitest';
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

import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { COVERAGE_CONFIG } from '../config/coverageConfig.js';
import { CURRENT_STATE_CONFIG } from '../config/currentStateConfig.js';
import type { CoverageRatios } from '../services/projectCoverageCore.js';

const STAMP = Date.now();
const CONN = `graph-insights-conn-${STAMP}`;

/** Vocabulary read from the PRODUCT's config — never a literal typed into this file. */
const GROUNDING_EDGE = COVERAGE_CONFIG.groundingEdgeTypes[0];
const OUTCOME_CONTEXT_TYPE = CURRENT_STATE_CONFIG.outcomeContextTypes[0];
/** The edge type trust.ts reads as downstream OUTCOME evidence — `informs` is both an
 *  outcome edge and a grounding edge, which is what a real completion record carries. */
const EVIDENCE_EDGE = 'informs';

let healthyProjectId: string;
let sparseProjectId: string;
/** The sparse project's ungrounded task + a decision to ground it with (captured at build
 *  time rather than re-queried, so this test depends on ONE tool surface, not three). */
let sparseOpenTaskId: string;
let sparseDecisionId: string;
/** A project whose coverage is CLEAN — it exists so the renderer's zero-findings branch is
 *  actually executed by this suite. See the note on DELETED_VOLUME_ADVICE below. */
let cleanProjectId: string;

function responseText(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

async function createProject(name: string): Promise<string> {
  const r = await viaTool('project_create', { name, description: 'graph-aware insights test' });
  const id = r.structuredContent.project.id;
  await viaTool('project_switch', { project: id });
  return id;
}

async function storeContext(content: string, type: string): Promise<string> {
  const r = await viaTool('context_store', { content, type });
  return r.structuredContent.context.id;
}
async function createTask(title: string, status?: string): Promise<string> {
  const r = await viaTool('task_create', { title });
  const id = r.structuredContent.task.id;
  if (status) await viaTool('task_update', { taskId: id, status });
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
async function link(
  from: string,
  fromType: string,
  to: string,
  toType: string,
  edgeType: string
): Promise<any> {
  return viaTool('link', { from, fromType, to, toType, edgeType });
}

async function insightsFor(projectId: string): Promise<any> {
  const resp = await viaTool('project_insights', { projectId });
  expect(resp.isError, `project_insights errored: ${JSON.stringify(resp.content)}`).toBeFalsy();
  return resp;
}

/**
 * THE PRE-FIX ADVICE, quoted verbatim from the deleted identifyKnowledgeGaps() /
 * identifyDecisionGaps(). If any of these ever reappears on either channel, a volume
 * heuristic is back.
 *
 * KNOWN BOUND — state it rather than overclaim. A rendered-text scan can only
 * see the render BRANCHES the fixtures below reach. MEASURED: planting
 * `'Low decision count - consider documenting more technical choices'` in the renderer's
 * zero-findings branch left this suite GREEN, because no fixture had zero findings. Two
 * changes closed it: (1) `cleanProjectId` below has ZERO findings, so that branch is now
 * rendered here, and (2) the AUTHORITATIVE, fail-closed version of this pin lives in
 * projectCoverage.unit.test.ts, where it scans every finding the product is CAPABLE of
 * emitting and REDs on a finding code it never exercised. This suite proves the strings do
 * not reach the wire; that suite proves they cannot exist.
 */
const DELETED_VOLUME_ADVICE = [
  'Low decision count',
  'consider documenting more technical choices',
  'Few decisions documented',
  'record more architectural choices',
  'Limited planning context',
  'Limited error context',
  'No architecture decisions recorded',
  'No technology decisions recorded',
];

// ─────────────────────────────────────────────────────────────────────────────

describe('project_insights reads the GRAPH, not row counts', () => {
  beforeAll(async () => {
    // ── THE EVAL'S PROJECT: small, well-kept. Exactly TWO decisions, every task complete,
    //    every landed task backed by a SEPARATE completion record that carries real
    //    downstream outcome evidence (so the real trust service rates it, not a fixture).
    healthyProjectId = await createProject(`graph-insights-healthy-${STAMP}`);
    const d1 = await recordDecision('Use the typed-edge graph', 'successful');
    const d2 = await recordDecision('Ship the read model in three parts', 'successful');
    const t1 = await createTask('Build part B', 'completed');
    const t2 = await createTask('Build part C', 'completed');
    const c1 = await storeContext('Part B landed and was accepted.', OUTCOME_CONTEXT_TYPE);
    const c2 = await storeContext('Part C landed and was accepted.', OUTCOME_CONTEXT_TYPE);
    await link(t1, 'task', d1, 'decision', GROUNDING_EDGE);
    await link(t2, 'task', d2, 'decision', GROUNDING_EDGE);
    // The completion records point AT the completed tasks: that edge is what gives them
    // downstream outcome evidence in the real trust service AND what grounds the tasks.
    await link(c1, 'context', t1, 'task', EVIDENCE_EDGE);
    await link(c2, 'context', t2, 'task', EVIDENCE_EDGE);

    // ── A SPARSE project: the same TWO decisions, but nothing linked to anything.
    sparseProjectId = await createProject(`graph-insights-sparse-${STAMP}`);
    sparseDecisionId = await recordDecision('Decision one', 'successful');
    await recordDecision('Decision two', 'successful');
    sparseOpenTaskId = await createTask('Open work with no plan behind it');
    // A HISTORICAL record with no downstream outcome evidence — the real trust service rates
    // it cold-start, so it does not clear the floor. This is the eval's "unproven historical
    // node", produced by the product's own trust math rather than a hand-built verdict.
    await storeContext('An old side discussion nothing ever proved out.', 'discussion');

    // ── A CLEAN project: open, grounded work and nothing else. Exists purely so the
    //    renderer's ZERO-FINDINGS branch is rendered by this suite (see DELETED_VOLUME_ADVICE).
    cleanProjectId = await createProject(`graph-insights-clean-${STAMP}`);
    const cd = await recordDecision('The one decision this project needed', 'successful');
    const ct = await createTask('Open work, grounded in that decision');
    await link(ct, 'task', cd, 'decision', GROUNDING_EDGE);
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // THE ACCEPTANCE
  // ═══════════════════════════════════════════════════════════════════════════
  test('ACCEPTANCE: two decisions + complete work reports STRONG coverage, not a volume gap', async () => {
    const resp = await insightsFor(healthyProjectId);
    const cov = resp.structuredContent.coverage;

    // It really is a two-decision project — the exact shape the old heuristic punished.
    expect(resp.structuredContent.decisionsTotal).toBe(2);

    // STRONG task/outcome coverage, measured from the graph.
    expect(cov.ratios.completedTaskEvidence.of).toBe(2);
    expect(cov.ratios.completedTaskEvidence.ratio).toBe(1);
    expect(cov.ratios.completedTaskEvidence.belowFloor).toBe(false);
    expect(cov.ratios.branchConvergence.ratio).toBe(1);

    // NOTHING recommends more decisions.
    const codes = cov.findings.map((f: any) => f.code);
    expect(codes).not.toContain('unevidenced-completed-tasks');
    expect(codes).not.toContain('orphan-records');
  });

  test('ACCEPTANCE: the deleted volume advice appears on NEITHER channel, on EVERY render branch', async () => {
    // Three project shapes → the findings branch, the zero-findings branch, and the
    // truncation-free scope branch are all rendered by this assertion.
    for (const projectId of [healthyProjectId, sparseProjectId, cleanProjectId]) {
      const resp = await insightsFor(projectId);
      const text = responseText(resp);
      const machine = JSON.stringify(resp.structuredContent);

      for (const phrase of DELETED_VOLUME_ADVICE) {
        expect(
          text,
          `the human channel is still emitting volume advice ("${phrase}") for ${projectId}`
        ).not.toContain(phrase);
        expect(
          machine,
          `the machine channel is still emitting volume advice ("${phrase}") for ${projectId}`
        ).not.toContain(phrase);
      }
    }
  });

  test('the zero-findings render branch really IS exercised (or the pin above is blind)', async () => {
    const resp = await insightsFor(cleanProjectId);
    expect(
      resp.structuredContent.coverage.findings,
      'the clean fixture stopped being clean — the volume-advice pin above no longer covers ' +
        'the zero-findings render branch, which is exactly where a MEASURED mutation hid'
    ).toEqual([]);
    expect(responseText(resp)).toContain('No coverage gaps found');
  });

  test('ACCEPTANCE: unproven HISTORICAL nodes are flagged on the real surface', async () => {
    const cov = (await insightsFor(sparseProjectId)).structuredContent.coverage;

    // The population is real and the verdict came from the live trust service.
    expect(cov.ratios.historicalTrust.of).toBeGreaterThan(0);
    expect(cov.ratios.historicalTrust.ratio).toBe(0);
    expect(cov.findings.map((f: any) => f.code)).toContain('untrusted-historical-records');
  });

  test('ACCEPTANCE: session attribution and historical trust are REPORTED dimensions', async () => {
    const resp = await insightsFor(healthyProjectId);
    const cov = resp.structuredContent.coverage;
    const text = responseText(resp);

    // Both dimensions exist, are measured over a real population, and are rendered.
    for (const dim of ['sessionAttribution', 'historicalTrust'] as Array<keyof CoverageRatios>) {
      expect(cov.ratios[dim], `dimension ${dim} is missing from the answer`).toBeDefined();
      expect(typeof cov.ratios[dim].of).toBe('number');
    }
    expect(cov.ratios.sessionAttribution.of).toBeGreaterThan(0);
    expect(text).toContain('session attribution');
    expect(text).toContain('trust floor');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // IT READS EDGES — the property the count heuristics did not have
  // ═══════════════════════════════════════════════════════════════════════════
  test('minting a real edge through the public `link` tool MOVES the measured coverage', async () => {
    const before = (await insightsFor(sparseProjectId)).structuredContent.coverage;
    expect(before.ratios.activeTaskGrounding.of).toBe(1);
    expect(before.ratios.activeTaskGrounding.ratio).toBe(0);
    expect(before.findings.map((f: any) => f.code)).toContain('ungrounded-active-tasks');

    // Ground the open task in a decision — through the PUBLIC `link` tool, on the real graph.
    // The `link` tool resolves its endpoints against the ACTIVE project, so switch to the
    // one under test first, and ASSERT the mint succeeded: a silently refused edge would make
    // the assertion below fail for the wrong reason (it did, once — measured).
    await viaTool('project_switch', { project: sparseProjectId });
    const minted = await link(
      sparseOpenTaskId,
      'task',
      sparseDecisionId,
      'decision',
      GROUNDING_EDGE
    );
    expect(minted.isError, `link failed: ${JSON.stringify(minted.content)}`).toBeFalsy();

    const after = (await insightsFor(sparseProjectId)).structuredContent.coverage;
    expect(after.ratios.activeTaskGrounding.ratio).toBe(1);
    expect(after.findings.map((f: any) => f.code)).not.toContain('ungrounded-active-tasks');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PART B IS CONSUMED ON THE REAL SURFACE TOO
  // ═══════════════════════════════════════════════════════════════════════════
  test('the gate + next action come from the current-state read model, not a second one', async () => {
    const resp = await insightsFor(healthyProjectId);
    const cov = resp.structuredContent.coverage;

    // The gate must be a rung part B's config actually declares — not a token part C invented.
    expect(CURRENT_STATE_CONFIG.gateLadder).toContain(cov.gate);
    expect(typeof cov.nextAction).toBe('string');
    expect(cov.nextAction.length).toBeGreaterThan(0);

    // And the honesty signals part B owns ride along.
    expect(cov.omitted).toHaveProperty('superseded');
    expect(cov.omitted).toHaveProperty('historical');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DUAL CHANNEL + SCOPE HONESTY
  // ═══════════════════════════════════════════════════════════════════════════
  test('both channels carry the coverage answer, and the scope is stated exactly', async () => {
    const resp = await insightsFor(healthyProjectId);
    const text = responseText(resp);
    const cov = resp.structuredContent.coverage;

    expect(text).toContain('Graph coverage');
    expect(text).toContain('Coverage findings');
    expect(text).toContain('Where it stands');

    expect(cov.scope.recordsExamined).toBeGreaterThan(0);
    expect(cov.scope.recordsInProject).toBeGreaterThanOrEqual(cov.scope.recordsExamined);
    expect(cov.scope.truncated).toBe(
      cov.scope.recordsInProject > cov.scope.recordsExamined
    );
    expect(cov.scope.edgesExamined).toBeGreaterThan(0);
  });

  test('determinism: the same graph returns the same coverage across repeated tool calls', async () => {
    const a = (await insightsFor(healthyProjectId)).structuredContent.coverage;
    const b = (await insightsFor(healthyProjectId)).structuredContent.coverage;
    expect(JSON.stringify(b.ratios)).toBe(JSON.stringify(a.ratios));
    expect(JSON.stringify(b.findings)).toBe(JSON.stringify(a.findings));
  });
});
