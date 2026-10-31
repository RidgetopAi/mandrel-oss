/**
 * Story shaping — the PURE module behind the Story view (no DOM, no clock,
 * no I/O). Input: the ThreadGraph the API serves. Output: header counts, chapters (calendar
 * days in the viewer's time zone, oldest first) of beats, and the sidebar data.
 *
 * Every vocabulary and threshold (roles, markers, the collapse threshold, which edge makes a
 * task a chip) is read from `config.ts`; nothing here is a tunable.
 */
import type { ThreadEdge, ThreadGraph, ThreadNode } from '../../api/domains/treewalker';
import {
  CONTEXT_TYPE_ROLE,
  STORY_CONFIG,
  STORY_ROLES,
  STORY_ROLE_ORDER,
  type StoryRoleKey,
} from './config';
import { id8 } from './parts';

export type ChipState = 'done' | 'open' | 'cancelled';

export interface TaskChip {
  id: string;
  id8: string;
  title: string;
  state: ChipState;
  /** ISO creation time — the Timeline plots the chip at it. */
  at: string;
}

export interface LeansOn {
  id: string;
  id8: string;
  title: string;
}

export interface Beat {
  id: string;
  id8: string;
  role: StoryRoleKey;
  title: string;
  /** ISO creation time. */
  at: string;
  /** Local wall-clock time label. */
  time: string;
  /** A task beat's status as a chip state; absent for every other role. */
  state?: ChipState;
  /** Spawned tasks rendered as chips under this (decision) beat. */
  chips: TaskChip[];
  /** Declared edges from this beat to ghost causes (inBranch:false) — never beats themselves. */
  leansOn: LeansOn[];
}

export interface BeatGroup {
  role: StoryRoleKey;
  count: number;
  firstTime: string;
  lastTime: string;
  beats: Beat[];
}

export type ChapterItem =
  | { type: 'beat'; beat: Beat }
  | { type: 'group'; group: BeatGroup };

export interface Chapter {
  /** Local calendar day, YYYY-MM-DD. */
  dayKey: string;
  /** Local date label, e.g. "Oct 24". */
  date: string;
  title: string;
  /** Records in the chapter (beats plus the chips under them). */
  recordCount: number;
  items: ChapterItem[];
}

export interface StoryRef {
  id: string;
  id8: string;
  title: string;
}

export interface OpenTask extends StoryRef {
  status: string;
}

export interface StoryHeader {
  title: string;
  recordCount: number;
  /** "Oct 24 – Oct 28", or a single date; '' with no records. */
  span: string;
  decisions: number;
  outcomes: number;
  problems: number;
  openTasks: number;
}

export interface StorySidebar {
  newestOutcome: StoryRef | null;
  newestRecord: StoryRef | null;
  stillOpen: OpenTask[];
  key: { role: StoryRoleKey; label: string; colorVar: string; marker: string }[];
}

export interface Story {
  header: StoryHeader;
  summary: string;
  chapters: Chapter[];
  sidebar: StorySidebar;
  /** Set when the API served only the newest members of a larger branch. */
  truncated: { shown: number; total: number } | null;
}

export interface StoryOptions {
  /** IANA zone the days are cut in; defaults to the viewer's local zone. */
  timeZone?: string;
}

/** The role a node plays in the story. */
export function roleOf(node: Pick<ThreadNode, 'kind' | 'contextType'>): StoryRoleKey {
  if (node.kind === 'decision') return 'decision';
  if (node.kind === 'task') return 'task';
  return (node.contextType && CONTEXT_TYPE_ROLE[node.contextType]) || STORY_CONFIG.defaultContextRole;
}

function dayKeyOf(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const byTimeThenId = (a: ThreadNode, b: ThreadNode): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const ref = (n: ThreadNode): StoryRef => ({ id: n.id, id8: id8(n.id), title: n.title });

export function buildStory(graph: ThreadGraph, options: StoryOptions = {}): Story {
  const tz = options.timeZone;
  const fmtDate = new Intl.DateTimeFormat(STORY_CONFIG.locale, { ...STORY_CONFIG.dateFormat, timeZone: tz });
  const fmtTime = new Intl.DateTimeFormat(STORY_CONFIG.locale, { ...STORY_CONFIG.timeFormat, timeZone: tz });
  const dateLabel = (iso: string) => fmtDate.format(new Date(iso));

  const members = graph.nodes.filter((n) => n.inBranch).sort(byTimeThenId);
  const memberById = new Map(members.map((n) => [n.id, n]));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // A task with a declared decided_by edge to a DECISION MEMBER is a chip, not a beat.
  const chipsByDecision = new Map<string, ThreadNode[]>();
  const chipTaskIds = new Set<string>();
  for (const e of graph.edges as ThreadEdge[]) {
    if (e.edgeType !== STORY_CONFIG.spawnEdgeType) continue;
    const task = memberById.get(e.source);
    const decision = memberById.get(e.target);
    if (!task || !decision || task.kind !== 'task' || decision.kind !== 'decision') continue;
    if (chipTaskIds.has(task.id)) continue;
    chipTaskIds.add(task.id);
    chipsByDecision.set(decision.id, [...(chipsByDecision.get(decision.id) ?? []), task]);
  }

  for (const tasks of chipsByDecision.values()) tasks.sort(byTimeThenId);

  const leansOnOf = (id: string): LeansOn[] => {
    const seen = new Set<string>();
    const out: LeansOn[] = [];
    for (const e of graph.edges) {
      if (e.source !== id || seen.has(e.target)) continue;
      const target = nodeById.get(e.target);
      if (!target || target.inBranch) continue;
      seen.add(e.target);
      out.push({ id: target.id, id8: id8(target.id), title: target.title });
    }
    return out.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  };

  const stateOf = (t: ThreadNode): ChipState => STORY_CONFIG.chipStatus[t.status ?? ''] ?? 'open';
  const chipOf = (t: ThreadNode): TaskChip => ({
    id: t.id,
    id8: id8(t.id),
    title: t.title,
    state: stateOf(t),
    at: t.createdAt,
  });

  const beatOf = (n: ThreadNode): Beat => ({
    id: n.id,
    id8: id8(n.id),
    role: roleOf(n),
    title: n.title,
    at: n.createdAt,
    ...(n.kind === 'task' ? { state: stateOf(n) } : {}),
    time: fmtTime.format(new Date(n.createdAt)),
    chips: (chipsByDecision.get(n.id) ?? []).map(chipOf),
    leansOn: leansOnOf(n.id),
  });

  // Chapters: local calendar days, oldest first.
  const beatsByDay = new Map<string, Beat[]>();
  for (const n of members) {
    if (chipTaskIds.has(n.id)) continue;
    const key = dayKeyOf(new Date(n.createdAt), tz);
    beatsByDay.set(key, [...(beatsByDay.get(key) ?? []), beatOf(n)]);
  }

  const chapters: Chapter[] = [...beatsByDay.keys()].sort().map((dayKey) => {
    const beats = beatsByDay.get(dayKey)!;
    const items: ChapterItem[] = [];
    for (let i = 0; i < beats.length; ) {
      let j = i;
      while (j < beats.length && beats[j].role === beats[i].role) j++;
      const run = beats.slice(i, j);
      if (run.length >= STORY_CONFIG.collapseThreshold) {
        items.push({
          type: 'group',
          group: {
            role: run[0].role,
            count: run.length,
            firstTime: run[0].time,
            lastTime: run[run.length - 1].time,
            beats: run,
          },
        });
      } else {
        for (const beat of run) items.push({ type: 'beat', beat });
      }
      i = j;
    }
    const titleBeat = STORY_CONFIG.chapterTitleRoles
      .map((role) => beats.find((b) => b.role === role))
      .find(Boolean) ?? beats[0];
    return {
      dayKey,
      date: dateLabel(beats[0].at),
      title: titleBeat.title,
      recordCount: beats.reduce((sum, b) => sum + 1 + b.chips.length, 0),
      items,
    };
  });

  const newest = (pred: (n: ThreadNode) => boolean): ThreadNode | undefined =>
    [...members].reverse().find(pred);
  const newestOutcome = newest((n) => roleOf(n) === 'outcome');
  const newestRecord = newest(() => true);

  const isOpen = (n: ThreadNode) => n.kind === 'task' && STORY_CONFIG.openTaskStatuses.includes(n.status ?? '');
  const openTasks = members.filter(isOpen);
  const count = (role: StoryRoleKey) => members.filter((n) => roleOf(n) === role).length;

  const spine = graph.nodes.find((n) => n.isSpine);
  const first = members[0];
  const last = members[members.length - 1];
  const firstLabel = first ? dateLabel(first.createdAt) : '';
  const lastLabel = last ? dateLabel(last.createdAt) : '';
  const header: StoryHeader = {
    title: spine?.title ?? graph.anchor.branchLabel,
    recordCount: members.length,
    span: !first ? '' : firstLabel === lastLabel ? firstLabel : `${firstLabel} – ${lastLabel}`,
    decisions: count('decision'),
    outcomes: count('outcome'),
    problems: count('problem'),
    openTasks: openTasks.length,
  };

  return {
    header,
    summary: summarize(header, newestOutcome?.title, newestRecord?.title),
    chapters,
    sidebar: {
      newestOutcome: newestOutcome ? ref(newestOutcome) : null,
      newestRecord: newestRecord ? ref(newestRecord) : null,
      stillOpen: openTasks.map((t) => ({ ...ref(t), status: t.status ?? '' })),
      key: STORY_ROLE_ORDER.map((role) => ({ role, ...STORY_ROLES[role] })),
    },
    truncated: graph.truncated ? { shown: members.length, total: graph.memberTotal } : null,
  };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The deterministic summary sentence — counts plus the newest Outcome and newest record titles. No LLM. */
export function summarize(h: StoryHeader, newestOutcome?: string, newestRecord?: string): string {
  if (h.recordCount === 0) return `${h.title} has no records yet.`;
  const parts = [
    `${h.title}: ${plural(h.recordCount, 'record')} over ${h.span}`,
    `${plural(h.decisions, 'decision')}, ${plural(h.outcomes, 'outcome')}, ${plural(h.problems, 'problem')}, ${h.openTasks} open`,
  ];
  let text = `${parts.join(' — ')}.`;
  if (newestOutcome) text += ` Latest outcome: ${newestOutcome}.`;
  if (newestRecord) text += ` Newest record: ${newestRecord}.`;
  return text;
}
