/**
 * TimelineView — the Timeline tab: one branch on a time axis. Lanes by role (only the roles
 * present), phase bands, long gaps folded, day ticks. All layout is the pure `timeline.ts`;
 * this file only renders it. The plot scrolls inside its own box. Colour is token-only: a
 * role's token name comes from config and reaches CSS as a custom property.
 */
import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cx } from '../../components/ui';
import type { ThreadGraph } from '../../api/domains/treewalker';
import { TIMELINE_CONFIG as C, STORY_ROLES, type StoryRoleKey } from './config';
import { storyBeatTo, whyTo } from './links';
import { buildStory } from './story';
import { buildTimeline, storyRecords } from './timeline';
import storyStyles from './Story.module.css';
import styles from './Timeline.module.css';

export interface TimelineViewProps {
  graph: ThreadGraph | undefined;
  unavailable: boolean;
  isLoading: boolean;
}

/** Marker class for a task status: filled / ring / dimmed with a strike. */
const statusClass = (state: string | undefined) => (state ? styles[`status-${state}`] : undefined);

const roleStyle = (role: StoryRoleKey): React.CSSProperties =>
  ({ '--role': `var(${STORY_ROLES[role].colorVar})` }) as React.CSSProperties;

/** The live content width of an element, re-measured on resize. 0 until the first measure. */
function useElementWidth(ref: React.RefObject<HTMLElement>, active: boolean): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return width;
}

export const TimelineView: React.FC<TimelineViewProps> = ({ graph, unavailable, isLoading }) => {
  const [params] = useSearchParams();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const hasPlot = !unavailable && !isLoading && !!graph;
  const availableWidth = useElementWidth(scrollRef, hasPlot);
  const timeline = React.useMemo(
    () => (graph ? buildTimeline(storyRecords(buildStory(graph)), { availableWidth }) : null),
    [graph, availableWidth],
  );

  if (unavailable) return <div className={styles.empty} data-testid="tw-timeline">{C.unavailableText}</div>;
  if (isLoading || !timeline) return <div className={styles.empty} data-testid="tw-timeline">{C.loadingText}</div>;
  if (timeline.points.length === 0) return <div className={styles.empty} data-testid="tw-timeline">{C.emptyText}</div>;

  const { lanes, points, gaps, bands, ticks } = timeline;
  const hasTasks = lanes.some((l) => l.role === 'task');
  const plotWidth = Math.max(timeline.width, C.minPlotPx);
  const lanesHeight = lanes.length * C.laneHeightPx;
  const frame = {
    '--tl-lane-h': `${C.laneHeightPx}px`,
    '--tl-band-h': `${timeline.labelRows * C.bandLabelRowPx}px`,
    '--tl-label-row-h': `${C.bandLabelRowPx}px`,
    '--tl-tick-h': `${C.tickStripPx}px`,
    '--tl-label-w': `${C.laneLabelPx}px`,
    '--tl-plot-w': `${plotWidth}px`,
  } as React.CSSProperties;

  return (
    <div className={styles.timeline} style={frame} data-testid="tw-timeline">
      <div className={styles.labels} aria-hidden="true">
        <div className={styles.bandSpacer} />
        {lanes.map((lane) => (
          <div key={lane.role} className={styles.laneLabel} style={roleStyle(lane.role)} data-testid="tw-tl-lane">
            <span className={cx(storyStyles.marker, storyStyles[`m-${lane.marker}`], styles.key)} />
            {lane.label}
          </div>
        ))}
      </div>
      <div ref={scrollRef} className={styles.scroller} data-testid="tw-tl-scroll" tabIndex={0} role="region" aria-label="Timeline plot">
        <div className={styles.plot} style={{ width: plotWidth }} data-testid="tw-tl-plot">
          <div className={styles.bandStrip}>
            {bands.map((b) => (
              <div
                key={b.index}
                className={cx(styles.bandHead, b.labelRow > 0 && styles.bandHeadRaised)}
                style={{ left: b.labelX, width: b.labelW, top: (timeline.labelRows - 1 - b.labelRow) * C.bandLabelRowPx }}
                data-testid="tw-tl-band"
                data-label-row={b.labelRow}
                role="note"
                aria-label={b.label}
                title={b.label}
              >
                {b.label}
              </div>
            ))}
          </div>
          <div className={styles.lanes} style={{ height: lanesHeight }}>
            {bands.map((b) => (
              <div key={b.index} className={cx(styles.band, b.index % 2 === 1 && styles.bandAlt)} style={{ left: b.x0, width: b.x1 - b.x0 }} />
            ))}
            {lanes.map((lane) => (
              <div key={lane.role} className={styles.laneLine} style={{ top: lane.row * C.laneHeightPx, height: C.laneHeightPx }} />
            ))}
            {gaps.map((g) => (
              <div key={g.beforeId} className={styles.gap} style={{ left: g.x, width: g.width }} data-testid="tw-tl-gap">
                <span className={styles.gapLabel}>{g.label}</span>
              </div>
            ))}
            {points.map((p) => (
              <Link
                key={p.id}
                to={p.role === 'task' ? whyTo(params, p.id) : storyBeatTo(params, p.id)}
                className={cx(styles.point, statusClass(p.state))}
                style={{ ...roleStyle(p.role), left: p.x, top: p.row * C.laneHeightPx, height: C.laneHeightPx }}
                aria-label={p.name}
                title={p.name}
                data-testid="tw-tl-point"
                data-role={p.role}
                data-state={p.state}
              >
                <span className={cx(storyStyles.marker, storyStyles[`m-${STORY_ROLES[p.role].marker}`], styles.glyph)} aria-hidden="true" />
                {p.labelLines.length > 0 && (
                  <span
                    className={cx(styles.pointLabel, p.labelFlip && styles.pointLabelFlip)}
                    style={{ width: p.labelW }}
                    data-testid="tw-tl-label"
                    aria-hidden="true"
                  >
                    {p.labelLines.map((line, n) => (
                      <span key={n} className={styles.pointLabelLine}>
                        {line}
                      </span>
                    ))}
                  </span>
                )}
              </Link>
            ))}
          </div>
          <div className={styles.tickStrip}>
            {ticks.map((t) => (
              <span key={t.at} className={styles.tick} style={{ left: t.x }} data-testid="tw-tl-tick">
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      {hasTasks && (
        <ul className={styles.statusKey} aria-label={C.keyHeading} data-testid="tw-tl-key">
          <li className={styles.statusKeyHead}>{C.keyHeading}</li>
          {C.statusKey.map((k) => (
            <li key={k.state} className={cx(styles.statusKeyRow, styles[`status-${k.state}`])} style={roleStyle('task')} data-state={k.state}>
              <span className={cx(storyStyles.marker, storyStyles[`m-${STORY_ROLES.task.marker}`], styles.glyph)} aria-hidden="true" />
              {k.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default TimelineView;
