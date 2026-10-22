/**
 * FilterRow — the mock's pivot bar. TWO controls are functional and drive real reads:
 *   • Range (7d / 30d / 90d segmented) → the window `days`;
 *   • Actor (item 6) → the "who" slice.
 * The project scope comes from the ONE switch in the topbar (shell/ProjectSwitch),
 * read by the page via `usePageProject()` — not from here.
 * TWO remain honest "not yet available" affordances (never fake behaviour): Model (no
 * model dimension on any endpoint yet) and Group by (only `date` grouping exists today).
 * Each is disabled + titled with why, so the pivot surface is legible without stubbing.
 *
 * ── WHY THE ACTOR CONTROL IS REAL NOW ────────────────────────────────────────────────
 * It used to read "Actor: all — Not yet available, needs actor serialized on read". That
 * gap had CLOSED: `/api/sessions/trends` accepts an `actor` end to end. The options come
 * from `useContextsByActor().data.actors`, which this page ALREADY fetches for the
 * "Activity by actor" panel, so the control costs no request and can never offer an actor
 * that has no data in the window.
 *
 * NOT every read accepts an actor, and this component makes no claim that they do. Each
 * panel prints the query it actually issued in its own provenance line, so which panels
 * the slice reached is READ OFF THE PANELS rather than asserted once here, where it would
 * go stale the moment another endpoint gains (or loses) the dimension.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { Segmented } from './parts';
import { ActorIcon, ChevronDown, TreeIcon } from './icons';
import { RANGE_OPTIONS, type RangeValue } from './config';
import styles from './Analytics.module.css';

/** The sentinel for "no actor slice". Not a legal actor slug, so it cannot collide. */
export const ALL_ACTORS = '';

export interface FilterRowProps {
  range: RangeValue;
  onRangeChange: (v: RangeValue) => void;
  /** The selected actor slug, or `ALL_ACTORS` for no slice. */
  actor: string;
  onActorChange: (v: string) => void;
  /**
   * The actors with data in the CURRENT window and scope, in the order the by-actor read
   * returned them (count DESC). The currently selected actor is rendered whether or not it
   * is in here — see `renderedActors` in the body.
   */
  actorOptions: string[];
  /** True while the by-actor read that fills `actorOptions` is in flight. */
  actorsLoading?: boolean;
}

/** A disabled pivot dimension that isn't wired yet — honest, not a stub. */
const WireControl: React.FC<{
  icon?: React.ReactNode;
  label: string;
  title: string;
  dashed?: boolean;
}> = ({ icon, label, title, dashed }) => (
  <span
    className={cx(styles.fsel, styles.fselWire, dashed && styles.fselDashed)}
    title={title}
    aria-disabled="true"
  >
    {icon}
    {label}
    <ChevronDown size={14} className={styles.fselChevron} />
  </span>
);

export const FilterRow: React.FC<FilterRowProps> = ({
  range,
  onRangeChange,
  actor,
  onActorChange,
  actorOptions,
  actorsLoading,
}) => {
  // `actorOptions` is WINDOWED and PROJECT-SCOPED, so a Range or Project change can drop
  // the currently selected actor out of it. A <select> whose `value` matches no <option>
  // does not error — it falls back to displaying the first one, "Actor: all" — while the
  // page keeps SENDING the old actor on every actor-aware read. The control would then
  // contradict the provenance line printed under it. Keeping the selection in the list
  // means an empty window is explained by a control that still says who it is filtering
  // by, which is the honest reading.
  const renderedActors =
    actor !== ALL_ACTORS && !actorOptions.includes(actor) ? [...actorOptions, actor] : actorOptions;

  return (
    <div className={styles.pivot}>
      <span className={styles.pvLbl}>Range</span>
      <Segmented
        options={RANGE_OPTIONS}
        value={range}
        onChange={(v) => onRangeChange(v as RangeValue)}
        ariaLabel="Time range"
      />

      <span className={styles.fselActorWrap}>
        <ActorIcon size={14} className={styles.fselActorIco} aria-hidden="true" />
        <select
          className={styles.fsel}
          aria-label="Filter by actor"
          value={actor}
          disabled={actorsLoading}
          onChange={(e) => onActorChange(e.target.value)}
        >
          <option value={ALL_ACTORS}>Actor: all</option>
          {renderedActors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </span>
      <WireControl
        label="Model: all"
        title="Not yet available — no model dimension is recorded on sessions yet"
      />
      <span className={styles.pivotSpacer} />
      <WireControl
        icon={<TreeIcon size={14} className={styles.fselGroupIco} />}
        label="Group by: date"
        title="Only date grouping is available today"
      />
    </div>
  );
};

export default FilterRow;
