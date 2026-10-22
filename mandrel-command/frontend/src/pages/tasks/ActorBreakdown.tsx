/**
 * ActorBreakdown — "Completed by actor" (mock's horizontal bars, over the selected range).
 * WIRED: the backend now serves a REAL `GROUP BY assigned_to`
 * count of tasks completed in the window (GET /api/tasks/completed-by-actor), count DESC,
 * with a real `unassigned` bucket. This fully closes the actor dimension for the Tasks page.
 * REUSES the shared BarChartCard (horizontal, per-bar colour via `colorKey`) like the
 * priority panel. Counts are REAL; an empty `actors` array ⇒ an HONEST empty state (nothing
 * completed in the window) — never fabricated (data policy 10397f65). Colours resolve from
 * the chart theme (no hex literals).
 */
import React from 'react';
import { BarChartCard, useChartTheme, type ChartTheme } from '../../components/charts';
import { ANALYTICS_CONFIG, type AnalyticsTone } from './config';
import { toneHex } from './analyticsParts';
import type { CompletedByActor } from '../../types/task';

export interface ActorBreakdownProps {
  actors: CompletedByActor[] | undefined;
  rangeLabel: string;
  loading?: boolean;
  responsive?: boolean;
}

/**
 * The bucket the SERVER emits for a task with no assignee — the literal produced by
 * `COALESCE(NULLIF(TRIM(t.assigned_to), ''), 'unassigned')` in the completed-by-actor
 * aggregation. Rendered verbatim so the axis label matches the word the task cards use.
 */
export const UNASSIGNED_ACTOR = 'unassigned';

/**
 * Named tones for the actor bars (token-sourced, no hex).
 *
 * `muted` is RESERVED for the unassigned bucket and is therefore NOT in the rotation:
 * "nobody" is an absence, not a participant, and it must not be painted a positive hue
 * — nor change hue as its rank moves. Every other actor takes a tone by rank, which is
 * deterministic for a given ordering but is NOT an identity: an actor's colour moves
 * when its rank moves. The colour distinguishes ADJACENT bars; the axis label is what
 * identifies them.
 */
const UNASSIGNED_TONE: AnalyticsTone = 'muted';
const ACTOR_TONES: ReadonlyArray<AnalyticsTone> = ['teal', 'violet', 'blue', 'warn', 'ok', 'crit'];

export function actorTone(actor: string, rankAmongNamed: number): AnalyticsTone {
  if (actor === UNASSIGNED_ACTOR) return UNASSIGNED_TONE;
  return ACTOR_TONES[rankAmongNamed % ACTOR_TONES.length];
}

function actorColor(ct: ChartTheme, actor: string, rankAmongNamed: number): string {
  return toneHex(ct, actorTone(actor, rankAmongNamed));
}

/**
 * Vertical geometry. Named rather than inlined (configs-not-hardcoded); local to this
 * panel because the row count is data-driven here and fixed in the sibling panels.
 */
export const ACTOR_CHART_GEOMETRY = {
  /** Px of chart height per actor row — enough for an 11px tick plus separation. */
  rowHeight: 24,
  /** Px reserved for the value axis + its labels below the bars. */
  axisChrome: 28,
  /** Axis gutter for the actor names. Wider than the shared default: assignee is a
   *  free-form string, so names like `builder (P3 Insight)` are normal, not outliers. */
  categoryWidth: 132,
} as const;

/** Height that gives every actor row a legible band, never shorter than the panel norm. */
export function actorChartHeight(rowCount: number): number {
  return Math.max(
    ANALYTICS_CONFIG.breakdownChartHeight,
    rowCount * ACTOR_CHART_GEOMETRY.rowHeight + ACTOR_CHART_GEOMETRY.axisChrome,
  );
}

export const ActorBreakdown: React.FC<ActorBreakdownProps> = ({
  actors,
  rangeLabel,
  loading = false,
  responsive = true,
}) => {
  const ct = useChartTheme();
  // Rank is counted over NAMED actors only, so the unassigned bucket's presence or
  // absence does not shift every other actor's colour by one.
  let namedRank = 0;
  const data = (actors ?? []).map((a) => ({
    label: a.actor,
    count: a.count,
    color: actorColor(ct, a.actor, a.actor === UNASSIGNED_ACTOR ? -1 : namedRank++),
  }));
  const total = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <BarChartCard
      data={data as unknown as Array<Record<string, number | string>>}
      xKey="label" /* non-date-axis: actor labels, a category axis */
      series={[{ key: 'count', name: 'Completed' }]}
      colorKey="color"
      layout="vertical"
      categoryWidth={ACTOR_CHART_GEOMETRY.categoryWidth}
      title="Completed by actor"
      caption={`completed · last ${rangeLabel}`}
      height={actorChartHeight(data.length)}
      loading={loading}
      empty={total === 0}
      responsive={responsive}
    />
  );
};

export default ActorBreakdown;
