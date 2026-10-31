/**
 * MapView — the Map tab: every branch as a line off the handoff trunk, milestones as
 * stations, the unbranched share stated beneath. All layout is the pure `map.ts`; this file
 * only renders it. The plot scrolls inside its own box. Colour is token-only: a branch's
 * token name comes from the layout and reaches CSS as a custom property.
 */
import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cx } from '../../components/ui';
import type { BranchSummary, TrunkTimeline, UnbranchedShare } from '../../api/domains/treewalker';
import { MAP_CONFIG as C } from './config';
import { storyTo } from './links';
import { buildMap, unbranchedStrip } from './map';
import styles from './Map.module.css';

export interface MapViewProps {
  branches: BranchSummary[] | undefined;
  trunk: TrunkTimeline | undefined;
  sinceDays: number | undefined;
  unbranched: UnbranchedShare | undefined;
  unavailable: boolean;
  isLoading: boolean;
  /** The window's right edge; injectable so tests and walkthroughs are deterministic. */
  now?: number;
}

const colorStyle = (colorVar: string): React.CSSProperties =>
  ({ '--branch': `var(${colorVar})` }) as React.CSSProperties;

export const MapView: React.FC<MapViewProps> = ({ branches, trunk, sinceDays, unbranched, unavailable, isLoading, now }) => {
  const [params] = useSearchParams();
  // The window's right edge is fixed per data load, so a re-render never shifts the scale.
  const edge = React.useMemo(() => now ?? Date.now(), [now, branches, sinceDays]); // eslint-disable-line react-hooks/exhaustive-deps
  const map = React.useMemo(
    () => (branches && sinceDays ? buildMap({ branches, trunk, sinceDays, now: edge }) : null),
    [branches, trunk, sinceDays, edge],
  );

  if (unavailable) return <div className={styles.empty} data-testid="tw-map">{C.unavailableText}</div>;
  if (isLoading || !map || !branches) return <div className={styles.empty} data-testid="tw-map">{C.loadingText}</div>;
  const strip = unbranched ? unbranchedStrip(unbranched) : null;

  return (
    <div className={styles.map} data-testid="tw-map">
      <div className={styles.scroller} data-testid="tw-map-scroll" tabIndex={0} role="region" aria-label="Branch map plot">
        <svg className={styles.plot} width={map.width} height={map.height} viewBox={`0 0 ${map.width} ${map.height}`} role="group" aria-label="Branches against the handoff trunk">
          {map.ticks.map((t) => (
            <g key={t.at} data-testid="tw-map-tick">
              <line className={styles.tickLine} x1={t.x} x2={t.x} y1={0} y2={map.height - C.padBottomPx + 8} />
              <text className={styles.tickText} x={t.x + 4} y={map.height - 12}>{t.label}</text>
            </g>
          ))}

          {map.branches.map((b) => (
            <g key={`c-${b.spineId}`} className={styles.connectors} style={colorStyle(b.colorVar)}>
              {b.connectors.map((k, i) => (
                <line key={i} x1={k.x} x2={k.x} y1={k.y0} y2={k.y1} data-testid="tw-map-connector" />
              ))}
            </g>
          ))}

          <g data-testid="tw-map-trunk">
            <line className={styles.trunkLine} x1={map.trunk.x0} x2={map.trunk.x1} y1={map.trunk.y} y2={map.trunk.y} />
            {map.trunk.ticks.map((t) => (
              <line key={t.id} className={styles.trunkTick} x1={t.x} x2={t.x} y1={map.trunk.y - 5} y2={map.trunk.y + 5} />
            ))}
            <text className={styles.trunkCount} x={map.trunk.x0} y={map.trunk.y + 22} data-testid="tw-map-trunk-count">
              trunk · {map.trunk.countLabel}
            </text>
            {map.trunk.head && (
              <g data-testid="tw-map-here" transform={`translate(${map.trunk.head.x} ${map.trunk.y})`}>
                <circle className={styles.here} r={7} />
                <text className={styles.hereText} x={-10} y={-12} textAnchor="end">{map.trunk.head.label}</text>
              </g>
            )}
          </g>

          {map.branches.map((b) => (
            <Link
              key={b.spineId}
              to={storyTo(params, b.spineId)}
              aria-label={`Open ${b.name} in Story — ${b.members} members, ${b.id8}`}
              data-testid="tw-map-branch"
              data-spine-id={b.spineId}
              data-row={b.row}
            >
              <g className={cx(styles.branch, b.open && styles.open)} style={colorStyle(b.colorVar)}>
                <title>{b.name}</title>
                <line className={styles.hit} x1={b.x0} x2={b.x1} y1={b.y} y2={b.y} />
                <line className={styles.line} x1={b.x0} x2={b.x1} y1={b.y} y2={b.y} />
                <circle className={styles.end} cx={b.x0} cy={b.y} r={3} />
                <circle className={styles.end} cx={b.x1} cy={b.y} r={3} />
                <text
                  className={styles.label}
                  x={b.label.align === 'end' ? b.label.right : b.label.x}
                  y={b.label.y}
                  textAnchor={b.label.align}
                  data-testid="tw-map-label"
                  data-align={b.label.align}
                >
                  {b.label.text}
                </text>
                {b.stations.map((s) => (
                  <g key={s.id} transform={`translate(${s.x} ${s.y})`} data-testid="tw-map-station">
                    <title>{s.title}</title>
                    <rect className={styles.station} x={-5} y={-5} width={10} height={10} transform="rotate(45)" />
                  </g>
                ))}
              </g>
            </Link>
          ))}
        </svg>
      </div>
      {map.branches.length === 0 && <div className={styles.empty}>{C.emptyText}</div>}
      {strip && (
        <div className={styles.strip} data-testid="tw-map-unbranched">
          <span className={styles.stripText}>{strip.text}</span>
          {strip.pct !== null && (
            <span className={styles.stripBar} aria-hidden="true">
              <span className={styles.stripFill} style={{ width: `${strip.pct}%` }} />
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default MapView;
