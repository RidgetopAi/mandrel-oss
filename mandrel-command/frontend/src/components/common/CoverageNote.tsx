/**
 * CoverageNote — the honest line above a chart that can only describe PART of its data
 *.
 *
 * ── THE PROBLEM IT SOLVES ────────────────────────────────────────────────────────────
 * A by-actor chart is about a dimension that not every record carries. The two obvious
 * treatments are both lies:
 *   - draw "unassigned" as a bar → it is the ABSENCE of the dimension the chart is
 *     about, and as a bar it competes with, and usually dwarfs, the real actors;
 *   - filter it out silently → a tenant whose writes carry no actor sees an EMPTY chart
 *     whose empty state says "no data". They have data. They have no actor dimension.
 * So the excluded remainder is stated, in words, next to the chart.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────────────────
 * `attributed` and `total` MUST be counted in the UNIT the bars are drawn in, and `unit`
 * must be that unit's name. Bars in contexts ⇒ "1,204 of 3,013 contexts". Passing a
 * session count to a chart drawn in contexts produces a sentence that is individually
 * true and jointly false, which is worse than no sentence — this component cannot detect
 * that, so it is the caller's contract, and the caller should be reading both numbers
 * from the SAME payload as the bars.
 *
 * ── SHARED ON PURPOSE ────────────────────────────────────────────────────────────────
 * Lives in components/common, not in pages/analytics, because the Tasks
 * "Completed by actor" chart has the same shape and adopts this next. It takes numbers
 * and words — no api types, no page config — so nothing about the second caller is
 * assumed here.
 */
import React from 'react';
import styles from './CoverageNote.module.css';

export type CoverageState = 'none' | 'partial' | 'full';

export interface CoverageNoteProps {
  /** Records the chart could attribute, in the SAME unit the bars are drawn in. */
  attributed: number;
  /** Every record in the same window and scope, attributed or not, same unit. */
  total: number;
  /** The unit's name, singular and plural — e.g. `{ one: 'context', many: 'contexts' }`. */
  unit: { one: string; many: string };
  /** What the dimension is called, for the zero-coverage prompt. Default 'actor'. */
  dimension?: string;
  /**
   * The past participle the ratio sentence uses — "N of M contexts <verb> (P%)". Default
   * 'attributed'. A caller whose numerator is narrower than "has the dimension at all"
   * says so here: ActorBars counts contexts the registry CLASSIFIED, which is fewer than
   * the payload's attributed_contexts, so "attributed" would overstate its own number.
   */
  verb?: string;
  /**
   * What a customer must do to gain the dimension, for the zero-coverage prompt. Rendered
   * in a code style. Default is the Mandrel write header.
   */
  howToAttribute?: string;
  /**
   * At or above this fraction the note is rendered quietly (near-invisible): there is
   * nothing to act on. Named, not inline (configs-not-hardcoded).
   */
  fullThreshold?: number;
}

export const COVERAGE_DEFAULTS = {
  /** 99%+ attributed is "full" for display purposes — a couple of stragglers is noise. */
  fullThreshold: 0.99,
  dimension: 'actor',
  verb: 'attributed',
  howToAttribute: 'X-Actor-ID',
} as const;

/**
 * Which of the three states a coverage ratio is in. Exported so a caller can branch its
 * CHART on the same decision the note renders (an empty chart must pair with the prompt),
 * and so the boundaries are testable without a DOM.
 *
 * `total === 0` is 'none': there is genuinely nothing, and the caller's own empty state
 * owns that case — the note must not claim "0 of 0 attributed (0%)".
 */
export function coverageState(
  attributed: number,
  total: number,
  fullThreshold: number = COVERAGE_DEFAULTS.fullThreshold,
): CoverageState {
  if (total <= 0 || attributed <= 0) return 'none';
  if (attributed >= total) return 'full';
  return attributed / total >= fullThreshold ? 'full' : 'partial';
}

/** Whole-percent, floored so a 99.6% never reads as a misleading "100%". */
export function coveragePercent(attributed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((attributed / total) * 100);
}

function plural(n: number, unit: { one: string; many: string }): string {
  return n === 1 ? unit.one : unit.many;
}

export const CoverageNote: React.FC<CoverageNoteProps> = ({
  attributed,
  total,
  unit,
  dimension = COVERAGE_DEFAULTS.dimension,
  verb = COVERAGE_DEFAULTS.verb,
  howToAttribute = COVERAGE_DEFAULTS.howToAttribute,
  fullThreshold = COVERAGE_DEFAULTS.fullThreshold,
}) => {
  const state = coverageState(attributed, total, fullThreshold);
  const pct = coveragePercent(attributed, total);

  // Nothing at all in the window: the caller's own empty state is the honest surface.
  if (total <= 0) return null;

  if (state === 'none') {
    return (
      <div className={[styles.note, styles.none].join(' ')} role="note">
        <span className={styles.headline}>
          No {dimension} recorded on {total.toLocaleString()} {plural(total, unit)} yet
        </span>
        <span className={styles.detail}>
          Attribution comes from the <code className={styles.code}>{howToAttribute}</code> header
          your agents send when they write. Add it and this chart fills in — the{' '}
          {plural(total, unit)} above are already here, they just have no {dimension} on them.
        </span>
      </div>
    );
  }

  if (state === 'full') {
    return (
      <div className={[styles.note, styles.full].join(' ')} role="note">
        <span>
          {attributed.toLocaleString()} of {total.toLocaleString()} {plural(total, unit)}{' '}
          {verb} ({pct}%)
        </span>
      </div>
    );
  }

  return (
    <div className={[styles.note, styles.partial].join(' ')} role="note">
      <span>
        <span className={styles.headline}>
          {attributed.toLocaleString()} of {total.toLocaleString()} {plural(total, unit)}
        </span>{' '}
        {verb} ({pct}%)
      </span>
      <span className={styles.detail}>
        — {(total - attributed).toLocaleString()} have no {dimension}
      </span>
    </div>
  );
};

export default CoverageNote;
