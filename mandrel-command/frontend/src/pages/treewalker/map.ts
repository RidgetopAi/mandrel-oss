/**
 * Map layout — the PURE module behind the Map view (no DOM, no clock, no
 * I/O). Input: the served branch list (with each branch's first/last activity and milestone
 * stations), the handoff trunk, the window and its right edge `now`. Output: every
 * coordinate the renderer draws — x from dates on one linear scale, the trunk, one packed
 * row per branch (alternating above / below the trunk), connectors, stations, labels that
 * never leave the plot, and the unbranched strip's text. Tunables come from `MAP_CONFIG`.
 */
import { MAP_CONFIG } from './config';
import { id8, truncateTitle } from './parts';
import type { BranchSummary, TrunkTimeline, UnbranchedShare } from '../../api/domains/treewalker';

const DAY_MS = 86_400_000;

export type MapOptions = Partial<{
  [K in keyof typeof MAP_CONFIG]: (typeof MAP_CONFIG)[K];
}> & { timeZone?: string };

export interface MapInput {
  branches: readonly BranchSummary[];
  trunk: TrunkTimeline | undefined;
  /** The window served with the list, in days. */
  sinceDays: number;
  /** The window's right edge (epoch ms). Passed in so the module never reads a clock. */
  now: number;
}

export interface MapStation {
  id: string;
  title: string;
  at: string;
  x: number;
  y: number;
}

export interface MapLabel {
  text: string;
  /** Left edge of the text box, in plot px. */
  x: number;
  /** Right edge of the text box — always inside the plot. */
  right: number;
  /** y of the text baseline. */
  y: number;
  align: 'start' | 'end';
}

export interface MapBranch {
  spineId: string;
  id8: string;
  name: string;
  members: number;
  open: boolean;
  /** Packed row index: 0 is nearest the trunk on the first side, rows alternate sides. */
  row: number;
  side: 'above' | 'below';
  /** Distance of the row from the trunk, in whole rows (0-based). */
  level: number;
  y: number;
  x0: number;
  x1: number;
  /** The branch began before the window: its line is cut at the left edge. */
  clippedStart: boolean;
  colorVar: string;
  label: MapLabel;
  stations: MapStation[];
  /** Short connectors joining the line's two ends to the trunk. */
  connectors: { x: number; y0: number; y1: number }[];
}

export interface MapTick {
  x: number;
  at: string;
  label: string;
}

export interface MapTrunk {
  y: number;
  x0: number;
  x1: number;
  /** FULL handoff count served by /treewalker/trunk. */
  count: number;
  countLabel: string;
  ticks: { x: number; id: string }[];
  /** The head handoff's marker, or null when the project has no handoff. */
  head: { x: number; id: string; label: string; clamped: boolean } | null;
}

export interface MapStrip {
  /** Whole percent of records on no branch, or null when the window holds no record. */
  pct: number | null;
  text: string;
  windowDays: number;
}

export interface MapLayout {
  width: number;
  height: number;
  /** The window as epoch ms. */
  start: number;
  end: number;
  trunk: MapTrunk;
  branches: MapBranch[];
  ticks: MapTick[];
  /** Branches with a row on each side of the trunk. */
  levels: { above: number; below: number };
  plotLeft: number;
  plotRight: number;
}

/** Whole-percent text for the unbranched strip, from the SERVED counts (never recomputed beyond rounding). */
export function unbranchedStrip(share: UnbranchedShare, opts: MapOptions = {}): MapStrip {
  const noneText = opts.unbranchedNoneText ?? MAP_CONFIG.unbranchedNoneText;
  const text = opts.unbranchedText ?? MAP_CONFIG.unbranchedText;
  const fill = (t: string, pct: number | null) =>
    t.replace('{pct}', pct === null ? '' : String(pct)).replace('{days}', String(share.windowDays));
  if (share.total <= 0) return { pct: null, text: fill(noneText, null), windowDays: share.windowDays };
  const pct = Math.round((share.unbranched / share.total) * 100);
  return { pct, text: fill(text, pct), windowDays: share.windowDays };
}

const labelText = (b: BranchSummary, nameMax: number) =>
  `${truncateTitle(b.name, nameMax)} · ${b.members} · ${id8(b.spineId)}`;

export function buildMap(input: MapInput, opts: MapOptions = {}): MapLayout {
  const c = { ...MAP_CONFIG, ...opts };
  const end = input.now;
  const start = end - input.sinceDays * DAY_MS;
  const width = Math.max(c.minPlotPx, Math.round(input.sinceDays * c.pxPerDay) + c.padLeftPx + c.padRightPx);
  const plotLeft = c.padLeftPx;
  const plotRight = width - c.padRightPx;
  const span = plotRight - plotLeft;

  /** The one date → x function; every marker goes through it, clamped to the window. */
  const xAt = (ms: number): number => {
    const t = Math.min(Math.max(ms, start), end);
    return plotLeft + ((t - start) / (end - start)) * span;
  };

  // ---- rows: greedy interval packing, widest-extent aware ---------------------------------
  const sorted = [...input.branches].sort(
    (a, b) => Date.parse(a.firstActiveAt) - Date.parse(b.firstActiveAt) || a.spineId.localeCompare(b.spineId),
  );
  const rowEnds: number[] = [];
  const placed = sorted.map((b, i) => {
    const x0 = xAt(Date.parse(b.firstActiveAt));
    const x1 = Math.max(xAt(Date.parse(b.lastActiveAt)), x0 + c.minSpanPx);
    const text = labelText(b, c.nameMaxChars);
    const labelW = Math.ceil(text.length * c.labelCharPx);
    // A label that would run past the plot's right edge is right-aligned to the branch's end,
    // itself held inside the plot; either way the label's right end is <= plotRight.
    const overRight = x0 + labelW > plotRight;
    const right = overRight ? Math.min(Math.max(x1, plotLeft + labelW), plotRight) : x0 + labelW;
    const lx = overRight ? right - labelW : x0;
    const extentL = Math.min(x0, lx);
    const extentR = Math.max(x1, right);
    let row = rowEnds.findIndex((e) => e + c.rowGapPx <= extentL);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(extentR);
    } else {
      rowEnds[row] = extentR;
    }
    return { b, i, x0, x1, text, labelW, overRight, lx, right, row };
  });

  const above = Math.ceil(rowEnds.length / 2);
  const below = Math.floor(rowEnds.length / 2);
  const trunkY = c.padTopPx + above * c.rowHeightPx + c.trunkBandPx / 2;
  const height = c.padTopPx + above * c.rowHeightPx + c.trunkBandPx + below * c.rowHeightPx + c.padBottomPx;

  const branches: MapBranch[] = placed.map((p) => {
    const side: 'above' | 'below' = p.row % 2 === 0 ? 'above' : 'below';
    const level = Math.floor(p.row / 2);
    const offset = c.trunkBandPx / 2 + level * c.rowHeightPx + c.rowHeightPx / 2;
    const y = side === 'above' ? trunkY - offset : trunkY + offset;
    return {
      spineId: p.b.spineId,
      id8: id8(p.b.spineId),
      name: p.b.name,
      members: p.b.members,
      open: p.b.open,
      row: p.row,
      side,
      level,
      y,
      x0: p.x0,
      x1: p.x1,
      clippedStart: Date.parse(p.b.firstActiveAt) < start,
      colorVar: c.branchPalette[p.i % c.branchPalette.length],
      label: {
        text: p.text,
        x: p.lx,
        right: p.right,
        y: y - c.labelRaisePx,
        align: p.overRight ? 'end' : 'start',
      },
      stations: p.b.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        at: m.createdAt,
        x: xAt(Date.parse(m.createdAt)),
        y,
      })),
      connectors: [p.x0, p.x1].map((x) => ({ x, y0: y, y1: trunkY })),
    };
  });

  // ---- trunk ------------------------------------------------------------------------------
  const entries = input.trunk?.entries ?? [];
  const head = entries.find((e) => e.id === input.trunk?.headId) ?? entries[0];
  const headMs = head ? Date.parse(head.createdAt) : NaN;
  const trunkCount = input.trunk?.count ?? 0;
  const trunk: MapTrunk = {
    y: trunkY,
    x0: plotLeft,
    x1: plotRight,
    count: trunkCount,
    countLabel: `${trunkCount} ${trunkCount === 1 ? 'handoff' : 'handoffs'}`,
    ticks: entries
      .filter((e) => Date.parse(e.createdAt) >= start && Date.parse(e.createdAt) <= end)
      .map((e) => ({ x: xAt(Date.parse(e.createdAt)), id: e.id })),
    head: head
      ? { x: xAt(headMs), id: head.id, label: c.youAreHereLabel, clamped: headMs < start || headMs > end }
      : null,
  };

  // ---- day ticks --------------------------------------------------------------------------
  const fmt = new Intl.DateTimeFormat(c.locale, { ...c.tickFormat, timeZone: opts.timeZone });
  const ticks: MapTick[] = [];
  for (let d = 0; start + d * DAY_MS <= end; d += c.tickEveryDays) {
    const ms = start + d * DAY_MS;
    ticks.push({ x: xAt(ms), at: new Date(ms).toISOString(), label: fmt.format(new Date(ms)) });
  }

  return { width, height, start, end, trunk, branches, ticks, levels: { above, below }, plotLeft, plotRight };
}
