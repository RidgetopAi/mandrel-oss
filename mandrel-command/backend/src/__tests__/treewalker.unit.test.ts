/**
 * Unit tests for the TreeWalker thread service (services/treewalker.ts).
 *
 * Two layers, both proven WITHOUT a live Postgres (a past incident — one definition, unit-testable
 * in isolation):
 *   1. PURE builders (deriveTrust / kindOf / pickSpineNodeId / buildSpine / buildStory /
 *      buildThreadGraph) — hammered directly with in-memory rows. This is where trust mapping,
 *      story ORDER, both-direction edges, spine/current flags, and dangling-edge drop are
 *      proven deterministically.
 *   2. I/O (traverse / resolveAnchorId / getThread) — driven through an INJECTED fake pool
 *      (the same harness style as resolveNavId.unit.test.ts) so BFS depth-limiting, the
 *      maxNodes cap, empty-anchor resolution, and the explicit-anchor-not-found contract are
 *      proven without a DB. The SQL itself is proven against a real DB in treewalker.db.test.ts.
 *
 * No lying stubs: the fake pool only stands in for the pg row payload; every branch under test
 * is the service's own code.
 */
import type { Pool } from 'pg';
import {
  deriveTrust,
  kindOf,
  contextTitle,
  pickSpineNodeId,
  buildSpine,
  buildStory,
  buildThreadGraph,
  emptyThreadGraph,
  TreeWalkerService,
  AnchorNotFoundError,
  type RawRecord,
  type RawEdge,
  type GatheredTrustSignals,
  type TrustLevel,
  type ThreadNode,
} from '../services/treewalker';
import { TREEWALKER_CONFIG } from '../config/treewalkerConfig';
import { allProjects, projectsScope } from '../services/projectListScope';

const NO_SIGNALS: GatheredTrustSignals = {
  outcomes: [],
  supersededDeclared: false,
  supersededSoft: false,
};

/** ISO date N days before the fixed test clock (deterministic trust ages). */
const NOW = new Date('2026-07-15T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// PURE — trust derivation (the CANONICAL model, PHASE 2 item e). Bands here are the
// canonical vocabulary; exhaustive band-parity against the real mcp-server module lives
// in treewalkerTrustParity.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveTrust — the canonical model', () => {
  it('fresh decision with own outcome_status=successful → trusted (outcome evidence + freshness)', () => {
    expect(
      deriveTrust({ type: 'decision', outcomeStatus: 'successful', supersededBy: null, createdAt: daysAgo(5) }, NO_SIGNALS, NOW),
    ).toBe('trusted');
  });

  it('mid-age decision with mixed outcome → ok (evidence, below trusted_at)', () => {
    expect(
      deriveTrust({ type: 'decision', outcomeStatus: 'mixed', supersededBy: null, createdAt: daysAgo(15) }, NO_SIGNALS, NOW),
    ).toBe('ok');
  });

  it('a DECLARED supersession hard-caps to superseded — for any kind, over any outcome', () => {
    expect(
      deriveTrust({ type: 'context', createdAt: daysAgo(1) }, { ...NO_SIGNALS, supersededDeclared: true }, NOW),
    ).toBe('superseded');
    expect(
      deriveTrust(
        { type: 'decision', outcomeStatus: 'successful', supersededBy: null, createdAt: daysAgo(1) },
        { ...NO_SIGNALS, supersededDeclared: true },
        NOW,
      ),
    ).toBe('superseded');
  });

  it("a decision's own superseded_by column is a DECLARED supersession", () => {
    expect(
      deriveTrust({ type: 'decision', outcomeStatus: 'successful', supersededBy: 'x', createdAt: daysAgo(1) }, NO_SIGNALS, NOW),
    ).toBe('superseded');
  });

  it('a SOFT supersession demotes but never caps: a fresh cold-start record stays visible (unproven, halved score)', () => {
    expect(
      deriveTrust({ type: 'context', createdAt: daysAgo(0) }, { ...NO_SIGNALS, supersededSoft: true }, NOW),
    ).toBe('unproven');
  });

  it('old records go stale regardless of outcome (freshness < stale_below)', () => {
    expect(deriveTrust({ type: 'context', createdAt: daysAgo(200) }, NO_SIGNALS, NOW)).toBe('stale');
    expect(
      deriveTrust({ type: 'decision', outcomeStatus: 'successful', supersededBy: null, createdAt: daysAgo(200) }, NO_SIGNALS, NOW),
    ).toBe('stale');
  });

  it("a task's own status is NOT evidence (canonical): a fresh in_progress task is unproven", () => {
    expect(deriveTrust({ type: 'task', createdAt: daysAgo(2) }, NO_SIGNALS, NOW)).toBe('unproven');
  });

  it('a fresh context inheriting a successful downstream outcome → trusted (the moat path)', () => {
    expect(
      deriveTrust(
        { type: 'context', createdAt: daysAgo(2) },
        { ...NO_SIGNALS, outcomes: [{ value: 1, source: 'decision' }] },
        NOW,
      ),
    ).toBe('trusted');
  });

  it('a fresh record with no outcome evidence → unproven (cold-start, never trusted on freshness alone)', () => {
    expect(deriveTrust({ type: 'context', createdAt: daysAgo(0) }, NO_SIGNALS, NOW)).toBe('unproven');
  });

  it('a MISSING created date reads as maximally stale, not as fresh', () => {
    expect(deriveTrust({ type: 'context' }, NO_SIGNALS, NOW)).toBe('stale');
  });
});

describe('kindOf / contextTitle', () => {
  it('maps context_type=handoff → handoff, else context; decisions/tasks pass through', () => {
    expect(kindOf({ type: 'context', contextType: 'handoff' })).toBe('handoff');
    expect(kindOf({ type: 'context', contextType: 'milestone' })).toBe('context');
    expect(kindOf({ type: 'decision' })).toBe('decision');
    expect(kindOf({ type: 'task' })).toBe('task');
  });

  it('contextTitle = first non-empty line, trimmed', () => {
    expect(contextTitle('  \n\n★ Handoff — resume here\nsecond line')).toBe('★ Handoff — resume here');
    expect(contextTitle('')).toBe('(context)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PURE — a canonical little thread (mirrors the mock's shape).
// ─────────────────────────────────────────────────────────────────────────────
// anchor(resume handoff) --informs--> spine(task) <--informs-- ctxA, ctxB
// spine --decided_by--> decision(design). thread also has a next todo task.
const ANCHOR = 'a0000000-0000-4000-8000-000000000001';
const SPINE = 'b0000000-0000-4000-8000-000000000002';
const DEC = 'c0000000-0000-4000-8000-000000000003';
const CTXA = 'd0000000-0000-4000-8000-000000000004';
const CTXB = 'e0000000-0000-4000-8000-000000000005';
const NEXT = 'f0000000-0000-4000-8000-000000000006';

function sampleRecords(): Map<string, RawRecord> {
  return new Map<string, RawRecord>([
    [ANCHOR, { id: ANCHOR, type: 'context', title: '★ Handoff resume', contextType: 'handoff', tags: ['ref:resume', 'tree:mandrel-product'], createdAt: daysAgo(1) }],
    [SPINE, { id: SPINE, type: 'task', title: 'command-redesign', status: 'in_progress', createdAt: daysAgo(14) }],
    [DEC, { id: DEC, type: 'decision', title: 'design-language LOCKED', outcomeStatus: 'successful', status: 'active', supersededBy: null, createdAt: daysAgo(25) }],
    [CTXA, { id: CTXA, type: 'context', title: 'Sessions locked', contextType: 'milestone', createdAt: daysAgo(10) }],
    [CTXB, { id: CTXB, type: 'context', title: 'Decisions locked', contextType: 'milestone', createdAt: daysAgo(7) }],
    [NEXT, { id: NEXT, type: 'task', title: 'Design the TreeWalker page', status: 'todo', createdAt: daysAgo(5) }],
  ]);
}

function sampleEdges(): RawEdge[] {
  return [
    { id: 'edge-1', fromId: ANCHOR, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs' },
    { id: 'edge-2', fromId: SPINE, fromType: 'task', toId: DEC, toType: 'decision', edgeType: 'decided_by' },
    { id: 'edge-3', fromId: CTXA, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs' },
    { id: 'edge-4', fromId: CTXB, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs' },
    { id: 'edge-5', fromId: SPINE, fromType: 'task', toId: NEXT, toType: 'task', edgeType: 'informs' },
  ];
}

const TRUST_ALL: Map<string, TrustLevel> = new Map([
  [ANCHOR, 'unproven'],
  [SPINE, 'ok'],
  [DEC, 'trusted'],
  [CTXA, 'trusted'],
  [CTXB, 'trusted'],
  [NEXT, 'unproven'],
]);

describe('pickSpineNodeId', () => {
  it('picks the task the anchor `informs`', () => {
    expect(pickSpineNodeId(ANCHOR, sampleEdges(), sampleRecords())).toBe(SPINE);
  });
  it('returns undefined when the thread has no task', () => {
    const recs = new Map<string, RawRecord>([[ANCHOR, { id: ANCHOR, type: 'context', title: 'x' }]]);
    expect(pickSpineNodeId(ANCHOR, [], recs)).toBeUndefined();
  });
});

/** Data-resolved tier fixture (PHASE 2): a root doc + a 3-handoff trunk headed by ANCHOR. */
const TIERS = {
  root: { id: 'ca000000-0000-4000-8000-00000000000c', title: '★ CANONICAL — the north star', createdAt: daysAgo(30) },
  trunkHeadId: ANCHOR,
  trunkCount: 3,
};

describe('buildSpine — every tier resolved from DATA (PHASE 2 items a/b/f)', () => {
  it('emits root → tree → trunk → branch with real ids + derived labels', () => {
    const spine = buildSpine(sampleRecords().get(SPINE), 'tree:mandrel-product', TIERS);
    expect(spine.map((s) => s.tier)).toEqual(['root', 'tree', 'trunk', 'branch']);
    expect(spine[0]).toMatchObject({ label: '★ CANONICAL — the north star', id: TIERS.root.id });
    expect(spine[1].label).toBe('tree:mandrel-product');
    expect(spine[2]).toMatchObject({ label: 'handoffs · 3', id: ANCHOR });
    // Item f: NO `branch:` prefix glued onto the label — the spine's own title names it.
    expect(spine[3]).toMatchObject({ tier: 'branch', label: 'command-redesign', id: SPINE });
  });

  it('a spine carrying a once-on-the-spine `branch:<name>` tag is named by it', () => {
    const named = { ...(sampleRecords().get(SPINE) as RawRecord), tags: ['branch:command-rebuild'] };
    const spine = buildSpine(named, 'tree:x', TIERS);
    expect(spine[3].label).toBe('command-rebuild');
  });

  it('honest fallbacks: no root doc → label-only root (no id); no handoffs → empty trunk label', () => {
    const spine = buildSpine(undefined, 'tree:x', { root: null, trunkHeadId: null, trunkCount: 0 });
    expect(spine[0]).toEqual({ tier: 'root', label: 'roots' });
    expect(spine[2]).toEqual({ tier: 'trunk', label: 'no handoffs yet' });
    expect(spine[3].id).toBeUndefined();
  });
});

describe('buildStory — CANONICAL recall_thread ordering (parity-pinned in treewalkerStoryOrderParity.test.ts)', () => {
  const nodes: ThreadNode[] = [...sampleRecords().values()].map((r) => ({
    id: r.id,
    kind: kindOf(r),
    title: r.title,
    trust: TRUST_ALL.get(r.id) as TrustLevel,
  }));
  const story = buildStory(ANCHOR, SPINE, nodes, sampleEdges(), sampleRecords());

  it('orders canonically: anchor pinned FIRST, then causal rank desc, then older-first', () => {
    // Ranks over the causal DAG: feeders (CTXA/CTXB, rank 2) precede the spine (rank 1),
    // which precedes its downstream decision + next task (rank 0). Ties break older-first
    // (CTXA is older than CTXB; DEC is older than NEXT).
    expect(story.map((s) => s.id)).toEqual([ANCHOR, CTXA, CTXB, SPINE, DEC, NEXT]);
    expect(story.map((s) => s.marker)).toEqual(['now', 'default', 'default', 'informs', 'decided', 'next']);
  });

  it('the first step is the ANCHOR — canonical order pins it first', () => {
    expect(story[0]).toMatchObject({ id: ANCHOR, marker: 'now', relation: 'you are here · ', relationTerm: 'resume point', kind: 'handoff' });
  });

  it('the WHY (decided_by decision) carries the decided caption', () => {
    expect(story.find((s) => s.id === DEC)).toMatchObject({ marker: 'decided', relation: 'the why · ', relationTerm: 'decided_by', kind: 'decision' });
  });

  it('the "now" step is the anchor (resume point) carrying its real trust', () => {
    const now = story.find((s) => s.marker === 'now');
    expect(now).toMatchObject({ id: ANCHOR, relation: 'you are here · ', relationTerm: 'resume point', trust: 'unproven', kind: 'handoff' });
  });

  it('the "next" step is the open todo task (not the spine), emitted once', () => {
    const next = story.filter((s) => s.marker === 'next');
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(NEXT);
  });

  it('no node appears twice', () => {
    const ids = story.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildThreadGraph', () => {
  const graph = buildThreadGraph(ANCHOR, sampleRecords(), sampleEdges(), TRUST_ALL, 'tree:mandrel-product', TIERS);

  it('flags the spine + current nodes', () => {
    expect(graph.nodes.find((n) => n.id === SPINE)?.isSpine).toBe(true);
    expect(graph.nodes.find((n) => n.id === ANCHOR)?.isCurrent).toBe(true);
  });

  it('carries every real edge (both directions) with source/target/edgeType', () => {
    expect(graph.edges).toHaveLength(5);
    const e = graph.edges.find((x) => x.id === 'edge-2');
    expect(e).toMatchObject({ source: SPINE, target: DEC, edgeType: 'decided_by' });
  });

  it('drops a DANGLING edge whose endpoint did not resolve', () => {
    const edges = [...sampleEdges(), { id: 'dangle', fromId: SPINE, fromType: 'task' as const, toId: 'zzzzzzzz-0000-4000-8000-00000000ffff', toType: 'decision' as const, edgeType: 'caused' }];
    const g = buildThreadGraph(ANCHOR, sampleRecords(), edges, TRUST_ALL, 'tree:x', TIERS);
    expect(g.edges.find((x) => x.id === 'dangle')).toBeUndefined();
    expect(g.edges).toHaveLength(5);
  });

  it('anchor readout: branch = spine title, anchorId, recordCount = node count', () => {
    expect(graph.anchor).toEqual({ branchLabel: 'command-redesign', anchorId: ANCHOR, recordCount: 6 });
  });

  it('maps node trust from the trust map (trusted decision, ok spine, unproven handoff)', () => {
    expect(graph.nodes.find((n) => n.id === DEC)?.trust).toBe('trusted');
    expect(graph.nodes.find((n) => n.id === SPINE)?.trust).toBe('ok');
    expect(graph.nodes.find((n) => n.id === ANCHOR)?.trust).toBe('unproven');
  });
});

describe('emptyThreadGraph', () => {
  it('is honestly empty (no fabricated records)', () => {
    const g = emptyThreadGraph();
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.story).toEqual([]);
    expect(g.anchor.recordCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I/O — injected fake pool (BFS, anchor resolution, not-found contract).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A dataset-backed fake pool: answers each query shape (links traversal / contexts /
 * technical_decisions / tasks / supersession / inheritance / resume-anchor) from in-memory
 * rows. Only the pg row payload is faked; the service's traversal + shaping code runs for real.
 */
function datasetPool(data: {
  links: RawEdge[];
  contexts: Array<{ id: string; content: string; context_type: string; tags: string[]; created_at: string }>;
  decisions: Array<{ id: string; title: string; outcome_status: string; status: string; superseded_by: string | null; decision_date: string }>;
  tasks: Array<{ id: string; title: string; status: string; created_at: string }>;
  resumeAnchorId?: string | null;
}): Pool {
  const inArr = (params: unknown[]): string[] => (params[0] as string[]) ?? [];
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM links') && sql.includes('from_id = ANY') && sql.includes('to_id = ANY') && !sql.includes('edge_type IN')) {
        const ids = new Set(inArr(params));
        const rows = data.links
          .filter((e) => ids.has(e.fromId) || ids.has(e.toId))
          .map((e) => ({ id: e.id, from_id: e.fromId, from_type: e.fromType, to_id: e.toId, to_type: e.toType, edge_type: e.edgeType }));
        return { rows };
      }
      if (sql.includes('FROM contexts') && sql.includes('$2 = ANY(tags)')) {
        // resolveAnchorId
        return { rows: data.resumeAnchorId ? [{ id: data.resumeAnchorId }] : [] };
      }
      // PHASE 2 tier reads (getSpineTierData): trunk count / trunk head / root doc.
      if (sql.includes("context_type = 'handoff'") && sql.includes('count(*)')) {
        return { rows: [{ n: data.contexts.filter((c) => c.context_type === 'handoff').length }] };
      }
      if (sql.includes("context_type = 'handoff'")) {
        const handoffs = data.contexts.filter((c) => c.context_type === 'handoff');
        handoffs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
        return { rows: handoffs.slice(0, 1).map((c) => ({ id: c.id })) };
      }
      if (sql.includes('tags && $3::text[]')) {
        return { rows: [] }; // no root-tagged doc in the fixture (honest fallback path)
      }
      if (sql.includes('FROM contexts') && sql.includes('context_type')) {
        const ids = new Set(inArr(params));
        return { rows: data.contexts.filter((c) => ids.has(c.id)) };
      }
      if (sql.includes('FROM technical_decisions') && sql.includes('outcome_status') && sql.includes('superseded_by')) {
        const ids = new Set(inArr(params));
        return { rows: data.decisions.filter((d) => ids.has(d.id)) };
      }
      if (sql.includes('FROM tasks')) {
        const ids = new Set(inArr(params));
        return { rows: data.tasks.filter((t) => ids.has(t.id)) };
      }
      if (sql.includes('edge_type IN') && sql.includes('supersedes')) {
        return { rows: [] }; // no supersession in the fixture
      }
      if (sql.includes('JOIN tasks') && sql.includes('l.from_id')) {
        // task-outcome inheritance: join links → tasks (secondary ground-truth)
        const ids = new Set(inArr(params));
        const rows: Array<{ from_id: string; status: string }> = [];
        for (const e of data.links) {
          if (!ids.has(e.fromId)) continue;
          if (e.toType !== 'task') continue;
          if (!['informs', 'decided_by', 'learned_from'].includes(e.edgeType)) continue;
          const t = data.tasks.find((x) => x.id === e.toId);
          if (t) rows.push({ from_id: e.fromId, status: t.status });
        }
        return { rows };
      }
      if (sql.includes('JOIN technical_decisions') && sql.includes('l.from_id')) {
        // outcome inheritance: join links → decisions
        const ids = new Set(inArr(params));
        const rows: Array<{ from_id: string; outcome_status: string }> = [];
        for (const e of data.links) {
          if (!ids.has(e.fromId)) continue;
          if (e.toType !== 'decision') continue;
          if (!['informs', 'decided_by', 'learned_from'].includes(e.edgeType)) continue;
          const d = data.decisions.find((x) => x.id === e.toId);
          if (d) rows.push({ from_id: e.fromId, outcome_status: d.outcome_status });
        }
        return { rows };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
}

/** ISO date N days before the REAL clock — getThread derives ages from `new Date()`,
 *  so the I/O fixture must be relative to it or the expected bands would rot with time. */
const realDaysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function fixture() {
  return {
    links: sampleEdges(),
    contexts: [
      { id: ANCHOR, content: '★ Handoff resume', context_type: 'handoff', tags: ['ref:resume', 'tree:mandrel-product'], created_at: realDaysAgo(1) },
      { id: CTXA, content: 'Sessions locked', context_type: 'milestone', tags: [], created_at: realDaysAgo(10) },
      { id: CTXB, content: 'Decisions locked', context_type: 'milestone', tags: [], created_at: realDaysAgo(7) },
    ],
    decisions: [
      { id: DEC, title: 'design-language LOCKED', outcome_status: 'successful', status: 'active', superseded_by: null, decision_date: realDaysAgo(25) },
    ],
    tasks: [
      { id: SPINE, title: 'command-redesign', status: 'in_progress', created_at: realDaysAgo(14) },
      { id: NEXT, title: 'Design the TreeWalker page', status: 'todo', created_at: realDaysAgo(5) },
    ],
  };
}

describe('TreeWalkerService.traverse — BFS depth + cap', () => {
  it('walks both directions and collects every edge within maxDepth (2)', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: ANCHOR });
    const { nodeIds, edges } = await TreeWalkerService.traverse(ANCHOR, TREEWALKER_CONFIG, pool);
    // depth1 from anchor: SPINE. depth2 from SPINE: DEC, CTXA (incoming), CTXB, NEXT.
    expect(new Set(nodeIds)).toEqual(new Set([ANCHOR, SPINE, DEC, CTXA, CTXB, NEXT]));
    expect(edges).toHaveLength(5);
  });

  it('honours a maxDepth of 1 (only the anchor + its direct neighbours)', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: ANCHOR });
    const cfg = { ...TREEWALKER_CONFIG, maxDepth: 1 };
    const { nodeIds } = await TreeWalkerService.traverse(ANCHOR, cfg, pool);
    expect(new Set(nodeIds)).toEqual(new Set([ANCHOR, SPINE]));
  });

  it('respects the maxNodes cap', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: ANCHOR });
    const cfg = { ...TREEWALKER_CONFIG, maxNodes: 3 };
    const { nodeIds } = await TreeWalkerService.traverse(ANCHOR, cfg, pool);
    expect(nodeIds.length).toBeLessThanOrEqual(3);
  });
});

describe('TreeWalkerService.resolveAnchorId', () => {
  it('returns the newest resume anchor id', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: ANCHOR });
    await expect(TreeWalkerService.resolveAnchorId(projectsScope(['proj']), TREEWALKER_CONFIG, pool)).resolves.toBe(ANCHOR);
  });
  it('returns null when no resume anchor exists', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: null });
    await expect(TreeWalkerService.resolveAnchorId(projectsScope(['proj']), TREEWALKER_CONFIG, pool)).resolves.toBeNull();
  });
});

describe('TreeWalkerService.getThread — end to end over the fake pool', () => {
  it('resolves the resume anchor and returns the full grounded ThreadGraph', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: ANCHOR });
    const graph = await TreeWalkerService.getThread({ scope: projectsScope(['proj']), projectName: 'riverbend' }, TREEWALKER_CONFIG, pool);
    expect(graph.anchor.anchorId).toBe(ANCHOR);
    expect(graph.nodes).toHaveLength(6);
    // CANONICAL trust: the fresh decision's own successful outcome → trusted; the spine
    // task INHERITS that outcome over its decided_by edge (the moat path) → trusted too.
    expect(graph.nodes.find((n) => n.id === DEC)?.trust).toBe('trusted');
    expect(graph.nodes.find((n) => n.id === SPINE)?.trust).toBe('trusted');
    // The fresh anchor handoff has no outcome evidence → cold-start unproven, honest.
    expect(graph.nodes.find((n) => n.id === ANCHOR)?.trust).toBe('unproven');
    // PHASE 2 item d: the trunk head (newest handoff — here the anchor itself) rides on
    // the graph as the real jump-to-trunk target, and the trunk tier carries its id.
    expect(graph.trunkAnchorId).toBe(ANCHOR);
    expect(graph.spine.find((s) => s.tier === 'trunk')?.id).toBe(ANCHOR);
    expect(graph.story[0].id).toBe(ANCHOR); // canonical order pins the anchor first
    expect(graph.story.map((s) => s.marker)).toEqual(['now', 'default', 'default', 'informs', 'decided', 'next']);
  });

  it('returns an honest empty graph when there is no resume anchor', async () => {
    const pool = datasetPool({ ...fixture(), resumeAnchorId: null });
    const graph = await TreeWalkerService.getThread({ scope: projectsScope(['proj'])}, TREEWALKER_CONFIG, pool);
    expect(graph.nodes).toEqual([]);
    expect(graph.anchor.anchorId).toBe('');
  });

  it('throws AnchorNotFoundError for an EXPLICIT anchor that resolves to no record', async () => {
    const pool = datasetPool({ links: [], contexts: [], decisions: [], tasks: [] });
    await expect(
      TreeWalkerService.getThread({ scope: allProjects, anchorId: 'deadbeef-0000-4000-8000-000000000000' }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
  });
});
