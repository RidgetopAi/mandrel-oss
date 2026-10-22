/**
 * CalendarToolbar — the calendar's control bar:
 *   • a Month / Week / Day view switcher (segmented control);
 *   • prev/next arrows that step by the ACTIVE view (month/week/day) around a
 *     range label, plus a "Today" jump and a jump-to-date picker;
 * No project filter here: the calendar is scoped by the ONE switch in the topbar
 * (shell/ProjectSwitch), read by the page via `usePageProject`.
 * Token-driven, zero antd.
 */
import React from 'react';
import { Button, Label, Input, cx } from '../../components/ui';
import { ChevronLeft, ChevronRight, TargetIcon } from './icons';
import { CALENDAR_VIEWS, type CalendarView } from './config';
import { toDateKey, parseDateKey } from './dates';
import styles from './Calendar.module.css';

/** Singular noun for a view, used in the nav-arrow aria-labels. */
const STEP_NOUN: Record<CalendarView, string> = {
  month: 'month',
  week: 'week',
  day: 'day',
};

export interface CalendarToolbarProps {
  view: CalendarView;
  onViewChange: (v: CalendarView) => void;
  /** The human range label for the active view ("July 2026" / week range / day). */
  rangeLabel: string;
  /** The anchor day (seeds the jump-to-date picker). */
  anchor: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onJumpToDate: (d: Date) => void;
}

export const CalendarToolbar: React.FC<CalendarToolbarProps> = ({
  view,
  onViewChange,
  rangeLabel,
  anchor,
  onPrev,
  onNext,
  onToday,
  onJumpToDate,
}) => {
  const step = STEP_NOUN[view];

  const handleJump = (e: React.ChangeEvent<HTMLInputElement>) => {
    const d = parseDateKey(e.target.value);
    if (d) onJumpToDate(d);
  };

  return (
    <div className={styles.calbar}>
      <div className={styles.viewSwitch} role="group" aria-label="Calendar view">
        {CALENDAR_VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            className={cx(styles.viewBtn, view === v.value && styles.viewBtnOn)}
            aria-pressed={view === v.value}
            onClick={() => onViewChange(v.value)}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className={styles.navwk}>
        <button type="button" className={styles.arw} onClick={onPrev} aria-label={`Previous ${step}`}>
          <ChevronLeft size={16} />
        </button>
        <span className={styles.weekLabel}>{rangeLabel}</span>
        <button type="button" className={styles.arw} onClick={onNext} aria-label={`Next ${step}`}>
          <ChevronRight size={16} />
        </button>
      </div>

      <Button variant="subtle" size="sm" onClick={onToday}>
        <TargetIcon size={15} />
        Today
      </Button>

      <div className={styles.jump}>
        <Label as="span" tone="faint" className={styles.jumpLabel}>
          Jump to
        </Label>
        <Input
          id="cal-jump"
          type="date"
          value={toDateKey(anchor)}
          onChange={handleJump}
          aria-label="Jump to date"
          className={styles.jumpInput}
        />
      </div>
    </div>
  );
};

export default CalendarToolbar;
