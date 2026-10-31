/**
 * Timeline layout — the PURE module behind the Timeline view (no DOM, no
 * clock, no I/O). Input: the story beats the Story view already shaped. Output: lanes (one
 * per role that has a record, in the role config's order), x positions on a linear time
 * scale with long gaps folded, phase bands, and day ticks. All tunables and the role
 * vocabulary come from `config.ts`; the role config is NOT copied here.
 */
import { STORY_ROLES, STORY_ROLE_ORDER, TIMELINE_CONFIG, type MarkerShape, type StoryRoleKey } from './config';
import type { Beat, ChipState, Story, TaskChip } from './story';

/** A record the Timeline plots: a story beat, or a task carried as a chip under a decision. */
export interface TimelineRecord {
  id: string;
  id8: string;
  role: StoryRoleKey;
  title: string;
  at: string;
  /** Task status (tasks only). */
  state?: ChipState;
  /** The decision that spawned this task, when it is a chip. */
  decidedBy?: { id: string; id8: string; title: string };
}

const HOUR_MS = 3_600_000;

export interface TimelineOptions {
  /** IANA zone the day ticks are cut in; defaults to the viewer's local zone. */
  timeZone?: string;
  foldGapHours?: number;
  foldedGapPx?: number;
  /** The floor for pixels per hour; the scale that fills `availableWidth` is never below it. */
  minPxPerHour?: number;
  /** Measured width of the plot box. Absent or 0 → lay out at the floor scale. */
  availableWidth?: number;
  edgePadPx?: number;
  bandPadPx?: number;
  bandLabelCharPx?: number;
  bandLabelPadPx?: number;
  bandLabelGapPx?: number;
  markerLabelMaxLines?: number;
  markerLabelMinChars?: number;
  markerHalfPx?: number;
  markerLabelGapPx?: number;
  markerGapPx?: number;
}

export interface TimelineLane {
  role: StoryRoleKey;
  label: string;
  colorVar: string;
  marker: MarkerShape;
  /** Row index, top to bottom. */
  row: number;
}

export interface TimelinePoint {
  id: string;
  id8: string;
  role: StoryRoleKey;
  row: number;
  x: number;
  title: string;
  /** Text drawn beside the marker (Decisions and Outcomes only), else ''. The full title unless it ends in an ellipsis. */
  label: string;
  /** The label broken into lines (at most markerLabelMaxLines); [] when there is no label. */
  labelLines: string[];
  /** True when the label is drawn left of the marker: the right side had less room. */
  labelFlip: boolean;
  /** Left edge and width of the label box, in plot pixels (0 when there is no label). */
  labelX: number;
  labelW: number;
  at: string;
  /** Local "Oct 25, 14:00". */
  when: string;
  /** Accessible name: role, title and time. */
  name: string;
  /** Task status (tasks only). */
  state?: ChipState;
  /** The spawning decision's id (spawned tasks only). */
  decidedById?: string;
  /** Index of the band this record belongs to. */
  band: number;
}

export interface TimelineGap {
  /** Left edge of the folded stretch. */
  x: number;
  width: number;
  /** The real length of the gap, in hours (rounded to a whole hour for display; exact in `realHours`). */
  hours: number;
  realHours: number;
  label: string;
  /** The records either side of the fold. */
  beforeId: string;
  afterId: string;
}

export interface TimelineBand {
  index: number;
  x0: number;
  x1: number;
  /** The full band title; never truncated. */
  label: string;
  /** 0 = drawn inside the band; n > 0 = the n-th label row above the bands. */
  labelRow: number;
  /** Left edge and width of the label box, in plot pixels. */
  labelX: number;
  labelW: number;
  /** The records inside, first to last. */
  ids: string[];
  /** What closed the band: an Outcome, a folded gap, or the end of the data. */
  closedBy: 'outcome' | 'gap' | 'end';
}

export interface TimelineTick {
  x: number;
  label: string;
  /** ISO instant of the local midnight. */
  at: string;
}

export interface Timeline {
  lanes: TimelineLane[];
  points: TimelinePoint[];
  gaps: TimelineGap[];
  bands: TimelineBand[];
  ticks: TimelineTick[];
  width: number;
  /** The scale actually used. */
  pxPerHour: number;
  /** Number of label rows (1 = every label sits inside its band). */
  labelRows: number;
}

/** Break `text` into lines of at most `maxChars`, at most `maxLines` of them; `truncated` when text was dropped. */
function wrapLabel(text: string, maxChars: number, maxLines: number): { lines: string[]; truncated: boolean } {
  if (maxChars < 1) return { lines: [], truncated: true };
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (line) lines.push(line);
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
      line = '';
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return { lines, truncated: false };
  const kept = lines.slice(0, maxLines);
  const tail = kept[maxLines - 1];
  kept[maxLines - 1] = `${tail.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  return { lines: kept, truncated: true };
}

/** The beats of a story in time order (chapters are days, oldest first; groups are unfolded). */
export function storyBeats(story: Story): Beat[] {
  const out: Beat[] = [];
  for (const chapter of story.chapters) {
    for (const item of chapter.items) {
      if (item.type === 'beat') out.push(item.beat);
      else out.push(...item.group.beats);
    }
  }
  return out;
}

/** Every record of a story in time order: its beats (groups unfolded) plus every task carried as a chip, each once. */
export function storyRecords(story: Story): TimelineRecord[] {
  const out: TimelineRecord[] = [];
  const chipRecord = (chip: TaskChip, decision: Beat): TimelineRecord => ({
    id: chip.id,
    id8: chip.id8,
    role: 'task',
    title: chip.title,
    at: chip.at,
    state: chip.state,
    decidedBy: { id: decision.id, id8: decision.id8, title: decision.title },
  });
  for (const beat of storyBeats(story)) {
    out.push(beat);
    for (const chip of beat.chips) out.push(chipRecord(chip, beat));
  }
  return out;
}

function dayKeyer(timeZone: string | undefined) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (ms: number) => fmt.format(new Date(ms));
}

/** Local midnights strictly after `fromMs` and at or before `toMs`. */
function midnightsBetween(fromMs: number, toMs: number, dayKey: (ms: number) => string): number[] {
  const out: number[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const key = dayKey(cursor);
    // The next local midnight lies within a day-plus-DST-slack of any instant.
    let lo = Math.floor(cursor / 1000) * 1000;
    let hi = lo + 26 * HOUR_MS;
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (dayKey(mid) === key) lo = mid;
      else hi = mid;
    }
    if (hi > toMs) break;
    out.push(hi);
    cursor = hi;
  }
  return out;
}

export function buildTimeline(beats: readonly TimelineRecord[], options: TimelineOptions = {}): Timeline {
  const c = TIMELINE_CONFIG;
  const foldGapHours = options.foldGapHours ?? c.foldGapHours;
  const foldedGapPx = options.foldedGapPx ?? c.foldedGapPx;
  const minPxPerHour = options.minPxPerHour ?? c.minPxPerHour;
  const availableWidth = options.availableWidth ?? 0;
  const edgePad = options.edgePadPx ?? c.edgePadPx;
  const bandPad = options.bandPadPx ?? c.bandPadPx;
  const charPx = options.bandLabelCharPx ?? c.bandLabelCharPx;
  const labelPad = options.bandLabelPadPx ?? c.bandLabelPadPx;
  const labelGap = options.bandLabelGapPx ?? c.bandLabelGapPx;
  const maxLines = options.markerLabelMaxLines ?? c.markerLabelMaxLines;
  const minChars = options.markerLabelMinChars ?? c.markerLabelMinChars;
  const markerHalf = options.markerHalfPx ?? c.markerHalfPx;
  const markerLabelGap = options.markerLabelGapPx ?? c.markerLabelGapPx;
  const markerGap = options.markerGapPx ?? c.markerGapPx;
  const tz = options.timeZone;

  const sorted = [...beats].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (sorted.length === 0) return { lanes: [], points: [], gaps: [], bands: [], ticks: [], width: 0, pxPerHour: minPxPerHour, labelRows: 1 };

  const present = new Set(sorted.map((b) => b.role));
  const lanes: TimelineLane[] = STORY_ROLE_ORDER.filter((r) => present.has(r)).map((role, row) => ({
    role,
    label: STORY_ROLES[role].label,
    colorVar: STORY_ROLES[role].colorVar,
    marker: STORY_ROLES[role].marker,
    row,
  }));
  const rowOf = new Map(lanes.map((l) => [l.role, l.row]));

  const fmtWhen = new Intl.DateTimeFormat(c.locale, { ...c.whenFormat, timeZone: tz });
  const fmtDay = new Intl.DateTimeFormat(c.locale, { ...c.dayTickFormat, timeZone: tz });
  const dayKey = dayKeyer(tz);

  // x positions: linear in time, except a gap over foldGapHours advances by the folded width.
  const times = sorted.map((b) => Date.parse(b.at));
  // The scale: fill the available width with the unfolded span, never below the floor.
  let unfoldedHours = 0;
  let foldedCount = 0;
  for (let i = 1; i < sorted.length; i++) {
    const hours = (times[i] - times[i - 1]) / HOUR_MS;
    if (hours > foldGapHours) foldedCount++;
    else unfoldedHours += hours;
  }
  const fixedPx = 2 * edgePad + foldedCount * foldedGapPx;
  const fitPxPerHour = unfoldedHours > 0 && availableWidth > 0 ? (availableWidth - fixedPx) / unfoldedHours : 0;
  const pxPerHour = Math.max(minPxPerHour, fitPxPerHour);

  const xs: number[] = [edgePad];
  const gaps: TimelineGap[] = [];
  const ticks: TimelineTick[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const hours = (times[i] - times[i - 1]) / HOUR_MS;
    const x0 = xs[i - 1];
    if (hours > foldGapHours) {
      const whole = Math.round(hours);
      gaps.push({
        x: x0,
        width: foldedGapPx,
        hours: whole,
        realHours: hours,
        label: `${whole} h gap`,
        beforeId: sorted[i - 1].id,
        afterId: sorted[i].id,
      });
      xs.push(x0 + foldedGapPx);
    } else {
      xs.push(x0 + hours * pxPerHour);
      for (const m of midnightsBetween(times[i - 1], times[i], dayKey)) {
        ticks.push({ x: x0 + ((m - times[i - 1]) / HOUR_MS) * pxPerHour, label: fmtDay.format(new Date(m)), at: new Date(m).toISOString() });
      }
    }
  }
  const last = xs[xs.length - 1];

  // Bands: a boundary at every folded gap and immediately after every Outcome.
  const bandsIdx: number[][] = [[]];
  const closers: TimelineBand['closedBy'][] = [];
  sorted.forEach((b, i) => {
    bandsIdx[bandsIdx.length - 1].push(i);
    const next = i + 1 < sorted.length;
    const folded = next && (times[i + 1] - times[i]) / HOUR_MS > foldGapHours;
    if (b.role === 'outcome' && next) {
      closers.push('outcome');
      bandsIdx.push([]);
    } else if (folded) {
      closers.push('gap');
      bandsIdx.push([]);
    }
  });
  closers.push(sorted[sorted.length - 1].role === 'outcome' ? 'outcome' : 'end');

  const bands: TimelineBand[] = bandsIdx.map((idxs, index) => {
    const first = idxs[0];
    const lastI = idxs[idxs.length - 1];
    const closedBy = closers[index];
    const prevClosed = index > 0 ? closers[index - 1] : null;
    const nextStart = lastI + 1 < sorted.length ? xs[lastI + 1] : null;
    const foldedAt = (i: number) => (times[i + 1] - times[i]) / HOUR_MS > foldGapHours;
    // Abutting bands meet mid-way; a folded gap is left unshaded.
    const x0 = prevClosed === 'outcome' && !foldedAt(first - 1) ? (xs[first - 1] + xs[first]) / 2 : xs[first] - bandPad;
    const x1 = closedBy === 'outcome' && nextStart !== null && !foldedAt(lastI) ? (xs[lastI] + nextStart) / 2 : xs[lastI] + bandPad;
    const members = idxs.map((i) => sorted[i]);
    const title =
      members.find((b) => b.role === 'decision')?.title ??
      (sorted[lastI].role === 'outcome' ? sorted[lastI].title : members[0].title);
    return { index, x0, x1, label: title, labelRow: 0, labelX: x0, labelW: x1 - x0, ids: members.map((b) => b.id), closedBy };
  });
  const width = Math.max(last + edgePad, availableWidth, 0);

  // Label rows: a label that fits inside its band stays there; one that does not moves to the
  // first row above the bands where it overlaps nothing already placed.
  const placed: Array<Array<[number, number]>> = [];
  let labelRows = 1;
  for (const b of bands) {
    const need = b.label.length * charPx + labelPad;
    if (need <= b.x1 - b.x0) continue;
    const w = Math.min(need, width);
    const x = Math.max(0, Math.min(b.x0, width - w));
    let row = 1;
    while ((placed[row] ?? []).some(([l, r]) => x < r + labelGap && x + w > l - labelGap)) row++;
    (placed[row] ??= []).push([x, x + w]);
    b.labelRow = row;
    b.labelX = x;
    b.labelW = w;
    labelRows = Math.max(labelRows, row + 1);
  }
  const bandOf = new Map<string, number>();
  for (const b of bands) for (const id of b.ids) bandOf.set(id, b.index);

  // Marker labels, lane by lane in time order. A label may use the room between its marker and
  // the next labelled marker in the lane (or the plot edge); on the left it is bounded by the
  // previous marker and by the previous label's actual box. Right is preferred, then left; the
  // text wraps to maxLines and only then ends in an ellipsis.
  const labelOf = new Map<number, { lines: string[]; flip: boolean; x: number; w: number }>();
  for (const lane of lanes) {
    if (!c.labelledRoles.includes(lane.role)) continue;
    const idxs = sorted.map((_, i) => i).filter((i) => sorted[i].role === lane.role);
    let prevBoxRight = -Infinity;
    idxs.forEach((i, k) => {
      const x = xs[i];
      const rightStart = x + markerGap;
      const rightEnd = k + 1 < idxs.length ? xs[idxs[k + 1]] - markerHalf - markerLabelGap : width - markerLabelGap;
      const leftEnd = x - markerGap;
      const leftStart = Math.max(
        k > 0 ? xs[idxs[k - 1]] + markerHalf + markerLabelGap : markerLabelGap,
        prevBoxRight + markerLabelGap,
      );
      const fit = (room: number) => wrapLabel(sorted[i].title, Math.floor(room / charPx), maxLines);
      const right = fit(rightEnd - rightStart);
      const left = fit(leftEnd - leftStart);
      const rightRoom = Math.floor((rightEnd - rightStart) / charPx);
      const leftRoom = Math.floor((leftEnd - leftStart) / charPx);
      const flip = !right.truncated ? false : !left.truncated ? true : leftRoom > rightRoom;
      const room = flip ? leftRoom : rightRoom;
      if (room < Math.min(minChars, sorted[i].title.length)) return;
      const { lines } = flip ? left : right;
      const w = Math.max(...lines.map((l) => l.length)) * charPx;
      const bx = flip ? leftEnd - w : rightStart;
      labelOf.set(i, { lines, flip, x: bx, w });
      prevBoxRight = bx + w;
    });
  }

  const points: TimelinePoint[] = sorted.map((b, i) => {
    const when = fmtWhen.format(new Date(times[i]));
    const l = labelOf.get(i);
    return {
      id: b.id,
      id8: b.id8,
      role: b.role,
      row: rowOf.get(b.role)!,
      x: xs[i],
      title: b.title,
      label: l ? l.lines.join(' ') : '',
      labelLines: l ? l.lines : [],
      labelFlip: l?.flip ?? false,
      labelX: l?.x ?? 0,
      labelW: l?.w ?? 0,
      at: b.at,
      when,
      name: `${STORY_ROLES[b.role].label}: ${b.title}${b.decidedBy ? ` (${c.decidedByText} ${b.decidedBy.title})` : ''}, ${when}`,
      ...(b.state ? { state: b.state } : {}),
      ...(b.decidedBy ? { decidedById: b.decidedBy.id } : {}),
      band: bandOf.get(b.id)!,
    };
  });

  return { lanes, points, gaps, bands, ticks, width, pxPerHour, labelRows };
}
