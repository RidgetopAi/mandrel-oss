/**
 * The committed DEMO BRANCH as the thread API would serve it — the single source for the
 * story unit tests and the browser walkthrough (the page is driven with this payload via
 * route interception). `mandrel-command/backend/scripts/seed-treewalker-demo.ts` writes the same branch into a
 * local dev database; keep the two in step.
 *
 * Shape: three days (Oct 24 / 26 / 28 2026); one decision with three decided_by tasks (one
 * open); four consecutive reflections; a milestone; an error; a ghost cause the work leans
 * on. The guessed `related_to` neighbour is deliberately ABSENT — the API never serves
 * guessed edges, so it must not be a beat.
 */
import type { ThreadEdge, ThreadGraph, ThreadNode } from '../../api/domains/treewalker';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

const node = (n: number, over: Partial<ThreadNode> & Pick<ThreadNode, 'kind' | 'title' | 'createdAt'>): ThreadNode => ({
  id: id(n),
  trust: 'unproven',
  inBranch: true,
  ...over,
});

export const DEMO_IDS = {
  spine: id(0xa0),
  decision: id(0xd1),
  taskDone1: id(0xe1),
  taskDone2: id(0xe2),
  taskOpen: id(0xe3),
  milestone: id(0xb1),
  error: id(0xc1),
  ghost: id(0xf1),
  related: id(0xf2),
} as const;

const NODES: ThreadNode[] = [
  node(0xa0, { kind: 'context', contextType: 'planning', title: 'Move the product tree to the OSS branch', createdAt: '2026-10-24T15:00:00.000Z', isSpine: true }),
  node(0xd1, { kind: 'decision', title: 'LOCK: ship OSS from the prod tree', createdAt: '2026-10-24T16:00:00.000Z', outcomeStatus: 'successful', trust: 'trusted' }),
  node(0xe1, { kind: 'task', title: 'Strip tenant branding from the bundle', status: 'done', createdAt: '2026-10-24T17:00:00.000Z' }),
  node(0xe2, { kind: 'task', title: 'Cut the OSS release workflow', status: 'completed', createdAt: '2026-10-26T13:00:00.000Z' }),
  node(0xe3, { kind: 'task', title: 'Publish the install docs', status: 'in_progress', createdAt: '2026-10-26T13:30:00.000Z' }),
  node(0x11, { kind: 'context', contextType: 'note', title: 'Inventory of prod-only files', createdAt: '2026-10-24T18:00:00.000Z' }),
  node(0x21, { kind: 'context', contextType: 'reflections', title: 'Second opinion: licence headers', createdAt: '2026-10-26T14:00:00.000Z' }),
  node(0x22, { kind: 'context', contextType: 'reflections', title: 'Second opinion: telemetry defaults', createdAt: '2026-10-26T14:30:00.000Z' }),
  node(0x23, { kind: 'context', contextType: 'reflections', title: 'Second opinion: migration order', createdAt: '2026-10-26T15:00:00.000Z' }),
  node(0x24, { kind: 'context', contextType: 'reflections', title: 'Second opinion: rollback plan', createdAt: '2026-10-26T15:30:00.000Z' }),
  node(0xc1, { kind: 'context', contextType: 'error', title: 'Release build leaked a tenant hostname', createdAt: '2026-10-26T18:00:00.000Z' }),
  node(0xb1, { kind: 'context', contextType: 'milestone', title: 'v0.70.0 shipped to the OSS branch', createdAt: '2026-10-28T15:00:00.000Z', trust: 'trusted' }),
  node(0x31, { kind: 'context', contextType: 'note', title: 'Post-release smoke notes', createdAt: '2026-10-28T16:00:00.000Z' }),
  node(0xf1, { kind: 'decision', title: 'Earlier: keep one repo for prod and OSS', createdAt: '2026-10-01T12:00:00.000Z', inBranch: false }),
];

const edge = (n: number, source: string, target: string, edgeType: string): ThreadEdge => ({
  id: id(0x1000 + n),
  source,
  target,
  edgeType,
  mintVia: 'tag',
  provenance: 'declared',
});

const EDGES: ThreadEdge[] = [
  edge(1, DEMO_IDS.taskDone1, DEMO_IDS.decision, 'decided_by'),
  edge(2, DEMO_IDS.taskDone2, DEMO_IDS.decision, 'decided_by'),
  edge(3, DEMO_IDS.taskOpen, DEMO_IDS.decision, 'decided_by'),
  edge(4, id(0x11), DEMO_IDS.ghost, 'decided_by'),
  edge(5, DEMO_IDS.decision, DEMO_IDS.spine, 'informs'),
];

export const DEMO_THREAD: ThreadGraph = {
  anchor: { branchLabel: 'oss-branch', anchorId: DEMO_IDS.spine, recordCount: NODES.length - 1 },
  spine: [
    { tier: 'tree', label: 'tree:mandrel-product' },
    { tier: 'branch', label: 'oss-branch', id: DEMO_IDS.spine },
  ],
  nodes: NODES,
  edges: EDGES,
  story: [],
  trunkAnchorId: null,
  memberTotal: NODES.length - 1,
  truncated: false,
};
