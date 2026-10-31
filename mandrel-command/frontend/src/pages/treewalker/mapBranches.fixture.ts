/**
 * A seeded branch list for the Map view: five branches over a 45-day window —
 * two overlapping in time, one with two milestones, one ending at the window's right edge —
 * plus a handoff trunk and an unbranched share. Dates are relative to `now` so the layout is
 * the same whenever it runs. Used by the MapView test and the browser walkthrough (route
 * interception); a committed TS file, not SQL.
 */
import type { BranchListResult, BranchSummary, TrunkTimeline } from '../../api/domains/treewalker';

const DAY = 86_400_000;
const id = (n: number) => `${(0x9c00 + n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

export const MAP_FIXTURE_IDS = {
  punchList: id(1),
  backstory: id(2),
  ossPhases: id(3),
  prodToOss: id(4),
  hotfix: id(5),
} as const;

export function mapFixture(now: number): { branches: BranchListResult; trunk: TrunkTimeline } {
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const branch = (
    spineId: string,
    name: string,
    members: number,
    first: number,
    last: number,
    milestones: [string, number, string][] = [],
    open = false,
  ): BranchSummary => ({
    spineId,
    spineType: 'task',
    name,
    named: true,
    members,
    firstActiveAt: ago(first),
    lastActiveAt: ago(last),
    milestones: milestones.map(([mid, days, title]) => ({ id: mid, createdAt: ago(days), title })),
    open,
    isTopLevel: true,
    sectionCount: 0,
  });
  const branches = [
    branch(MAP_FIXTURE_IDS.punchList, 'Punch List loop', 64, 44, 6, [], false),
    branch(MAP_FIXTURE_IDS.backstory, 'Backstory build', 41, 38, 12, [
      [id(21), 30, 'Backstory ingest shipped'],
      [id(22), 18, 'Backstory reader shipped'],
    ]),
    branch(MAP_FIXTURE_IDS.ossPhases, 'Mandrel OSS phases', 27, 20, 3, [[id(23), 9, 'OSS phase 2 published']]),
    branch(MAP_FIXTURE_IDS.prodToOss, 'Mandrel prod to OSS', 19, 4, 0.2, [], true),
    branch(MAP_FIXTURE_IDS.hotfix, 'Session resolver hotfix', 6, 2, 0.1),
  ];
  return {
    branches: {
      branches,
      total: branches.length,
      cap: 30,
      sinceDays: 45,
      unbranched: { unbranched: 58, total: 140, windowDays: 60 },
    },
    trunk: {
      count: 214,
      headId: id(90),
      entries: [
        { id: id(90), title: 'Handoff — map view', createdAt: ago(0.5), superseded: false },
        { id: id(91), title: 'Handoff — timeline view', createdAt: ago(5), superseded: true },
        { id: id(92), title: 'Handoff — oss export', createdAt: ago(11), superseded: true },
        { id: id(93), title: 'Handoff — backstory', createdAt: ago(22), superseded: true },
        { id: id(94), title: 'Handoff — punch list', createdAt: ago(35), superseded: true },
      ],
    },
  };
}
