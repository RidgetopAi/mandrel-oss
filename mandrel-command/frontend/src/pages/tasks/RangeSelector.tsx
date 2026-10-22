/**
 * RangeSelector — the Analytics view's 7d / 30d / 90d / All range control (mock's
 * `.range`). A small segmented control mirroring the ViewToggle treatment. It scopes the
 * TIME-BASED analytics panels (throughput trend, cycle time, completed-by-actor); the
 * snapshot panels ignore it. Token-only, zero antd.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { RANGE_OPTIONS, type RangeValue } from './config';
import styles from './Tasks.module.css';

export interface RangeSelectorProps {
  range: RangeValue;
  onChange: (r: RangeValue) => void;
}

export const RangeSelector: React.FC<RangeSelectorProps> = ({ range, onChange }) => (
  <div className={styles.range} role="group" aria-label="Range">
    {RANGE_OPTIONS.map((opt) => (
      <button
        key={opt.value}
        type="button"
        className={cx(styles.rangeItem, range === opt.value && styles.rangeOn)}
        aria-pressed={range === opt.value}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export default RangeSelector;
