/**
 * A seeded branch for the Timeline Task lane: one decision that spawned three
 * tasks (done, in_progress, cancelled — each with a declared decided_by edge, so the Story view
 * renders them as chips), one plain task beat, and an Outcome. * Used by the timeline unit tests and the browser walkthrough (route interception).
 */
import type { ThreadGraph, ThreadNode } from '../../api/domains/treewalker';

const id = (n: number) => `${(0x7200 + n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const node = (n: number, over: Partial<ThreadNode> & Pick<ThreadNode, 'kind' | 'title' | 'createdAt'>): ThreadNode => ({
  id: id(n),
  trust: 'unproven',
  inBranch: true,
  ...over,
});

export const SPAWNED_IDS = {
  decision: id(1),
  done: id(2),
  inProgress: id(3),
  cancelled: id(4),
  plain: id(5),
  outcome: id(6),
} as const;

export const SPAWNED_DECISION_TITLE = 'Split the publish into three steps';

const NODES: ThreadNode[] = [
  node(0, { kind: 'context', contextType: 'planning', title: 'Publish the product tree to OSS', createdAt: '2026-10-25T08:00:00.000Z', isSpine: true }),
  node(1, { kind: 'decision', title: SPAWNED_DECISION_TITLE, createdAt: '2026-10-25T09:00:00.000Z' }),
  node(2, { kind: 'task', title: 'S0a: scrub tenant hostnames', status: 'done', createdAt: '2026-10-25T10:00:00.000Z' }),
  node(3, { kind: 'task', title: 'S0b: licence headers', status: 'in_progress', createdAt: '2026-10-25T20:00:00.000Z' }),
  node(4, { kind: 'task', title: 'S1: mirror to a second remote', status: 'cancelled', createdAt: '2026-10-26T01:00:00.000Z' }),
  node(5, { kind: 'task', title: 'Follow-up: write the release notes', status: 'todo', createdAt: '2026-10-26T06:00:00.000Z' }),
  node(6, { kind: 'context', contextType: 'milestone', title: 'v0.70.0 shipped', createdAt: '2026-10-26T09:00:00.000Z' }),
];

export const SPAWNED_THREAD: ThreadGraph = {
  anchor: { branchLabel: 'spawned-tasks-demo', anchorId: id(0), recordCount: NODES.length },
  spine: [
    { tier: 'tree', label: 'tree:mandrel-product' },
    { tier: 'branch', label: 'spawned-tasks-demo', id: id(0) },
  ],
  nodes: NODES,
  edges: [2, 3, 4].map((n) => ({
    id: id(100 + n),
    source: id(n),
    target: id(1),
    edgeType: 'decided_by',
    mintVia: 'declared',
    provenance: 'declared',
  })),
  story: [],
  trunkAnchorId: null,
  memberTotal: NODES.length,
  truncated: false,
};
