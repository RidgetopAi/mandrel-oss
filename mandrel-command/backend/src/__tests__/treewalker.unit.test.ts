/**
 * Unit tests for the TreeWalker thread service (services/treewalker.ts).
 *
 * Two layers, both proven WITHOUT a live Postgres (a past incident — one definition, unit-testable
 * in isolation):
 *   1. PURE builders (deriveTrust / kindOf / buildSpine / buildStory / buildThreadGraph /
 *      selectMembers / isExcludedFromBranch) — hammered directly with in-memory rows: trust
 *      mapping, the createdAt story ORDER, node fields, edge provenance, member + ghost caps.
 *   2. I/O (getThread) — driven through an INJECTED fake pool so the member cap, the ghost
 *      cap and the explicit-anchor-not-found contract are proven without a DB. The SQL itself
 *      is proven against a real DB in treewalker.db.test.ts.
 *
 * No lying stubs: the fake pool only stands in for the pg row payload; every branch under test
 * is the service's own code.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import {
  deriveTrust,
  kindOf,
  contextTitle,
  selectMembers,
  isExcludedFromBranch,
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
    { id: 'edge-1', fromId: ANCHOR, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs', mintVia: 'tag', provenance: 'declared' },
    { id: 'edge-2', fromId: SPINE, fromType: 'task', toId: DEC, toType: 'decision', edgeType: 'decided_by', mintVia: 'tag', provenance: 'declared' },
    { id: 'edge-3', fromId: CTXA, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs', mintVia: 'tag', provenance: 'declared' },
    { id: 'edge-4', fromId: CTXB, fromType: 'context', toId: SPINE, toType: 'task', edgeType: 'informs', mintVia: 'tag', provenance: 'declared' },
    { id: 'edge-5', fromId: SPINE, fromType: 'task', toId: NEXT, toType: 'task', edgeType: 'informs', mintVia: 'tag', provenance: 'declared' },
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

describe('buildStory — createdAt ascending, id tiebreak (thread v2)', () => {
  const nodeOf = (r: RawRecord): ThreadNode => ({
    id: r.id,
    kind: kindOf(r),
    title: r.title,
    trust: TRUST_ALL.get(r.id) as TrustLevel,
    createdAt: new Date(r.createdAt as string).toISOString(),
    inBranch: true,
  });
  const nodes: ThreadNode[] = [...sampleRecords().values()].map(nodeOf);
  const story = buildStory(SPINE, SPINE, nodes, sampleEdges(), sampleRecords());

  it('orders strictly by createdAt ascending', () => {
    // DEC 25d, SPINE 14d, CTXA 10d, CTXB 7d, NEXT 5d, ANCHOR 1d ago.
    expect(story.map((s) => s.id)).toEqual([DEC, SPINE, CTXA, CTXB, NEXT, ANCHOR]);
  });

  it('a decision created BEFORE the member that is decided_by it comes FIRST (causal rank would not)', () => {
    expect(story.findIndex((s) => s.id === DEC)).toBeLessThan(story.findIndex((s) => s.id === SPINE));
  });

  it('ties on createdAt break by id', () => {
    const same = '2026-07-01T00:00:00.000Z';
    const recs = new Map<string, RawRecord>([
      ['b-id', { id: 'b-id', type: 'task', title: 'b', createdAt: same }],
      ['a-id', { id: 'a-id', type: 'task', title: 'a', createdAt: same }],
    ]);
    const ns = [...recs.values()].map(nodeOf);
    const out = buildStory('a-id', 'a-id', ns, [], recs);
    expect(out.map((x) => x.id)).toEqual(['a-id', 'b-id']);
  });

  it('keeps the markers: now (anchor), decided (the why), next (open task)', () => {
    const m = (id: string) => story.find((x) => x.id === id)?.marker;
    expect(m(SPINE)).toBe('now');
    expect(m(DEC)).toBe('decided');
    expect(m(NEXT)).toBe('next');
    expect(story.filter((x) => x.marker === 'next')).toHaveLength(1);
  });

  it('no node appears twice', () => {
    const ids = story.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildThreadGraph', () => {
  const GHOST = new Set([DEC]);
  const graph = buildThreadGraph(SPINE, sampleRecords(), sampleEdges(), TRUST_ALL, 'tree:mandrel-product', TIERS, TREEWALKER_CONFIG, {
    ghostIds: GHOST,
    memberTotal: 5,
    truncated: false,
  });

  it('flags the spine as spine + current', () => {
    const n = graph.nodes.find((x) => x.id === SPINE);
    expect(n?.isSpine).toBe(true);
    expect(n?.isCurrent).toBe(true);
  });

  it('every node carries createdAt (ISO) and inBranch; ghosts are inBranch:false', () => {
    for (const n of graph.nodes) {
      expect(new Date(n.createdAt).toISOString()).toBe(n.createdAt);
      expect(typeof n.inBranch).toBe('boolean');
    }
    expect(graph.nodes.find((n) => n.id === DEC)?.inBranch).toBe(false);
    expect(graph.nodes.filter((n) => !n.inBranch)).toHaveLength(1);
  });

  it('kind-specific fields: contextType (contexts), status (tasks), outcomeStatus (decisions, null when unset)', () => {
    const by = (id: string) => graph.nodes.find((n) => n.id === id) as ThreadNode;
    expect(by(CTXA).contextType).toBe('milestone');
    expect(by(ANCHOR).contextType).toBe('handoff');
    expect(by(SPINE).status).toBe('in_progress');
    expect(by(NEXT).status).toBe('todo');
    expect(by(DEC).outcomeStatus).toBe('successful');
    expect(by(CTXA).status).toBeUndefined();
    const unset = new Map(sampleRecords());
    unset.set(DEC, { id: DEC, type: 'decision', title: 'd', createdAt: daysAgo(25) });
    const g = buildThreadGraph(SPINE, unset, [], TRUST_ALL, 'tree:x', TIERS);
    expect(g.nodes.find((n) => n.id === DEC)?.outcomeStatus).toBeNull();
  });

  it('carries every edge with source/target/edgeType + mintVia + provenance', () => {
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges.find((x) => x.id === 'edge-2')).toMatchObject({
      source: SPINE, target: DEC, edgeType: 'decided_by', mintVia: 'tag', provenance: 'declared',
    });
  });

  it('drops a DANGLING edge whose endpoint did not resolve', () => {
    const edges = [...sampleEdges(), { id: 'dangle', fromId: SPINE, fromType: 'task' as const, toId: 'zzzzzzzz-0000-4000-8000-00000000ffff', toType: 'decision' as const, edgeType: 'caused', mintVia: 'tag', provenance: 'declared' }];
    const g = buildThreadGraph(SPINE, sampleRecords(), edges, TRUST_ALL, 'tree:x', TIERS);
    expect(g.edges.find((x) => x.id === 'dangle')).toBeUndefined();
    expect(g.edges).toHaveLength(5);
  });

  it('anchor readout + cap report', () => {
    expect(graph.anchor).toEqual({ branchLabel: 'command-redesign', anchorId: SPINE, recordCount: 6 });
    expect(graph.memberTotal).toBe(5);
    expect(graph.truncated).toBe(false);
  });

  it('maps node trust from the trust map', () => {
    expect(graph.nodes.find((n) => n.id === DEC)?.trust).toBe('trusted');
    expect(graph.nodes.find((n) => n.id === SPINE)?.trust).toBe('ok');
  });

  it('the frontend ThreadNode / ThreadEdge / ThreadGraph declare the same new fields', () => {
    const fe = fs.readFileSync(
      path.resolve(__dirname, '../../../frontend/src/api/domains/treewalker.ts'),
      'utf8',
    );
    const body = (name: string) => fe.slice(fe.indexOf(`export interface ${name}`), fe.indexOf('\n}\n', fe.indexOf(`export interface ${name}`)));
    for (const f of ['createdAt: string', 'inBranch: boolean', 'contextType?:', 'status?:', 'outcomeStatus?:']) {
      expect(body('ThreadNode')).toContain(f);
    }
    for (const f of ['mintVia: string', 'provenance: string']) expect(body('ThreadEdge')).toContain(f);
    for (const f of ['memberTotal: number', 'truncated: boolean']) expect(body('ThreadGraph')).toContain(f);
  });
});

describe('isExcludedFromBranch / selectMembers', () => {
  const ctx = (id: string, contextType: string, tags: string[], age: number): RawRecord => ({
    id, type: 'context', title: id, contextType, tags, createdAt: daysAgo(age),
  });

  it('excludes handoff contexts and any alert* tag; keeps tasks/decisions and ordinary contexts', () => {
    expect(isExcludedFromBranch(ctx('h', 'handoff', [], 1))).toBe(true);
    expect(isExcludedFromBranch(ctx('e', 'error', ['alert:test'], 1))).toBe(true);
    expect(isExcludedFromBranch(ctx('e2', 'error', ['alerting'], 1))).toBe(true);
    expect(isExcludedFromBranch(ctx('c', 'milestone', ['x'], 1))).toBe(false);
    expect(isExcludedFromBranch({ type: 'task', tags: ['alert:x'] })).toBe(false);
  });

  it('over the cap keeps the NEWEST maxMembers (spine pinned), memberTotal = true count, truncated', () => {
    const cfg = { ...TREEWALKER_CONFIG, maxMembers: 3 };
    const spine: RawRecord = { id: 'spine', type: 'task', title: 's', createdAt: daysAgo(100) };
    const rest = [1, 2, 3, 4, 5].map((n) => ctx(`m${n}`, 'note', [], n)); // m1 newest
    const r = selectMembers('spine', [spine, ...rest], cfg);
    expect(r.total).toBe(6);
    expect(r.truncated).toBe(true);
    expect(r.kept.map((k) => k.id).sort()).toEqual(['m1', 'm2', 'spine']);
  });

  it('at or under the cap nothing is dropped and truncated is false', () => {
    const cfg = { ...TREEWALKER_CONFIG, maxMembers: 3 };
    const spine: RawRecord = { id: 'spine', type: 'task', title: 's', createdAt: daysAgo(100) };
    const r = selectMembers('spine', [spine, ctx('m1', 'note', [], 1), ctx('m2', 'note', [], 2)], cfg);
    expect(r).toMatchObject({ total: 3, truncated: false });
    expect(r.kept).toHaveLength(3);
  });
});

describe('emptyThreadGraph', () => {
  it('is honestly empty (no fabricated records)', () => {
    const g = emptyThreadGraph();
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.story).toEqual([]);
    expect(g.anchor.recordCount).toBe(0);
    expect(g.memberTotal).toBe(0);
    expect(g.truncated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I/O — injected fake pool (member cap, ghost cap, not-found contract).
// ─────────────────────────────────────────────────────────────────────────────

interface FakeData {
  spineId: string;
  /** branch_membership member ids of the spine */
  members: string[];
  /** declared outbound ghost-edge targets (member → target) */
  ghostEdges: Array<{ from: string; to: string }>;
  links: RawEdge[];
  contexts: Array<{ id: string; content: string; context_type: string; tags: string[]; created_at: string }>;
  decisions: Array<{ id: string; title: string; outcome_status: string | null; status: string; superseded_by: string | null; decision_date: string; tags: string[] }>;
  tasks: Array<{ id: string; title: string; status: string; created_at: string; tags: string[] }>;
}

/** Answers each query shape the v2 service issues from in-memory rows. */
function branchPool(d: FakeData): Pool {
  const ids = (params: unknown[]): Set<string> => new Set((params[0] as string[]) ?? []);
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("context_type = 'handoff'") && sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      if (sql.includes("context_type = 'handoff'")) return { rows: [] };
      if (sql.includes('tags && $3::text[]')) return { rows: [] };
      if (sql.includes('UNION ALL') && sql.includes('project_id = ANY')) {
        const id = params[0] as string;
        const known = [...d.contexts, ...d.decisions, ...d.tasks].some((r) => r.id === id);
        return { rows: known ? [{ id, project_id: 'p1' }] : [] };
      }
      if (sql.includes('FROM branch_membership WHERE spine_id = $1 LIMIT 1')) {
        return { rows: params[0] === d.spineId ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM branch_membership WHERE member_id')) return { rows: [] };
      if (sql.includes('FROM branch_membership WHERE spine_id = $1') && sql.includes('UNION')) {
        return { rows: d.members.map((id) => ({ id })) };
      }
      if (sql.includes('SELECT DISTINCT to_id FROM links')) {
        const from = ids(params);
        return { rows: d.ghostEdges.filter((e) => from.has(e.from)).map((e) => ({ to_id: e.to })) };
      }
      if (sql.includes('SELECT id, from_id, from_type')) {
        const set = ids(params);
        return {
          rows: d.links
            .filter((e) => set.has(e.fromId) && set.has(e.toId))
            .map((e) => ({ id: e.id, from_id: e.fromId, from_type: e.fromType, to_id: e.toId, to_type: e.toType, edge_type: e.edgeType, mint_via: e.mintVia, provenance_class: e.provenance })),
        };
      }
      if (sql.includes('FROM contexts')) return { rows: d.contexts.filter((c) => ids(params).has(c.id)) };
      if (sql.includes('FROM technical_decisions') && sql.includes('superseded_by')) return { rows: d.decisions.filter((x) => ids(params).has(x.id)) };
      if (sql.includes('FROM tasks')) return { rows: d.tasks.filter((t) => ids(params).has(t.id)) };
      return { rows: [] };
    },
  } as unknown as Pool;
}

const realDaysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SP = uid(1);

function bigBranch(memberCount: number, ghostCount: number): FakeData {
  const members = Array.from({ length: memberCount }, (_, i) => uid(100 + i));
  const decisions = Array.from({ length: ghostCount }, (_, i) => ({
    id: uid(500 + i), title: `ghost ${i}`, outcome_status: null, status: 'active', superseded_by: null,
    decision_date: realDaysAgo(200 - i), tags: [] as string[],
  }));
  return {
    spineId: SP,
    members,
    ghostEdges: decisions.map((dec, i) => ({ from: members[i % members.length], to: dec.id })),
    links: [],
    // member i is i+1 days old → members[0] is the newest
    contexts: members.map((id, i) => ({ id, content: `member ${i}`, context_type: 'note', tags: [], created_at: realDaysAgo(i + 1) })),
    decisions,
    tasks: [{ id: SP, title: 'spine', status: 'in_progress', created_at: realDaysAgo(300), tags: [] }],
  };
}

describe('TreeWalkerService.getThread — branch walk over the fake pool', () => {
  it('over maxMembers: keeps the newest, memberTotal is the TRUE count, truncated:true', async () => {
    const cfg = { ...TREEWALKER_CONFIG, maxMembers: 4, maxGhosts: 100 };
    const g = await TreeWalkerService.getThread({ anchorId: SP, scope: projectsScope(['p1']) }, cfg, branchPool(bigBranch(10, 0)));
    expect(g.memberTotal).toBe(11); // spine + 10
    expect(g.truncated).toBe(true);
    expect(g.nodes.map((n) => n.id).sort()).toEqual([SP, uid(100), uid(101), uid(102)].sort());
  });

  it('at or under maxMembers: truncated is false and everything is returned', async () => {
    const cfg = { ...TREEWALKER_CONFIG, maxMembers: 11, maxGhosts: 100 };
    const g = await TreeWalkerService.getThread({ anchorId: SP, scope: projectsScope(['p1']) }, cfg, branchPool(bigBranch(10, 0)));
    expect(g.memberTotal).toBe(11);
    expect(g.truncated).toBe(false);
    expect(g.nodes).toHaveLength(11);
  });

  it('ghost causes never exceed maxGhosts, and are inBranch:false (newest ghosts first)', async () => {
    const cfg = { ...TREEWALKER_CONFIG, maxGhosts: 3 };
    const g = await TreeWalkerService.getThread({ anchorId: SP, scope: projectsScope(['p1']) }, cfg, branchPool(bigBranch(5, 9)));
    const ghosts = g.nodes.filter((n) => !n.inBranch);
    expect(ghosts).toHaveLength(3);
    expect(ghosts.map((n) => n.id).sort()).toEqual([uid(506), uid(507), uid(508)]);
    expect(g.nodes.filter((n) => n.inBranch)).toHaveLength(6);
    expect(g.memberTotal).toBe(6);
  });

  it('a decision created BEFORE the member decided_by it comes first in the story', async () => {
    const d = bigBranch(1, 1);
    d.links = [{ id: 'l1', fromId: uid(100), fromType: 'context', toId: uid(500), toType: 'decision', edgeType: 'decided_by', mintVia: 'tag', provenance: 'declared' }];
    const g = await TreeWalkerService.getThread({ anchorId: SP, scope: projectsScope(['p1']) }, TREEWALKER_CONFIG, branchPool(d));
    const order = g.story.map((s) => s.id);
    expect(order.indexOf(uid(500))).toBeLessThan(order.indexOf(uid(100)));
    expect(order).toEqual([SP, uid(500), uid(100)]); // 300d, 200d, 1d old
  });

  it('throws AnchorNotFoundError for an EXPLICIT anchor that resolves to no record', async () => {
    const pool = branchPool({ spineId: SP, members: [], ghostEdges: [], links: [], contexts: [], decisions: [], tasks: [] });
    await expect(
      TreeWalkerService.getThread({ scope: allProjects, anchorId: 'deadbeef-0000-4000-8000-000000000000' }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
    await expect(
      TreeWalkerService.getThread({ scope: allProjects, anchorId: 'not-a-uuid' }, TREEWALKER_CONFIG, pool),
    ).rejects.toBeInstanceOf(AnchorNotFoundError);
  });
});

describe('treewalkerConfig — caps live in config', () => {
  it('maxMembers / maxGhosts exist with the documented defaults; the v1 walk knobs are gone', () => {
    expect(TREEWALKER_CONFIG.maxMembers).toBe(500);
    expect(TREEWALKER_CONFIG.maxGhosts).toBe(25);
    expect('maxDepth' in TREEWALKER_CONFIG).toBe(false);
    expect('maxNodes' in TREEWALKER_CONFIG).toBe(false);
    expect(typeof (TreeWalkerService as unknown as Record<string, unknown>).traverse).toBe('undefined');
  });
});
