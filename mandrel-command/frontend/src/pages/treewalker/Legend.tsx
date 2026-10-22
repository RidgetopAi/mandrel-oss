/**
 * Legend — the canvas's three-row key (record kind / edge type / trust), each in its FIXED
 * categorical order. Colour is carried by the CSS-module kind/edge/trust classes (token-
 * only); the edge labels come from the shared edge vocabulary (edgeLabel) so the legend and
 * the drawn edges always read the same word.
 */
import React from 'react';
import { cx } from '../../components/ui';
import {
  KIND_ORDER,
  TRUST_ORDER,
  EDGE_LEGEND,
  kindLabel,
  trustLabel,
  edgeLabel,
} from './config';
import styles from './TreeWalker.module.css';

export const Legend: React.FC = () => (
  <div className={styles.legend} data-testid="tw-legend">
    <div className={styles.legrow}>
      <span className={styles.lt}>record</span>
      {KIND_ORDER.map((kind) => (
        <span className={styles.li} key={kind}>
          <span className={cx(styles.ld, styles[`dot-${kind}`])} aria-hidden="true" />
          {kindLabel(kind)}
        </span>
      ))}
    </div>
    <div className={styles.legrow}>
      <span className={styles.lt}>edge</span>
      {EDGE_LEGEND.map(({ edgeType, klass }) => (
        <span className={styles.li} key={edgeType}>
          <span className={cx(styles.le, styles[`le-${klass}`])} aria-hidden="true" />
          {edgeLabel(edgeType, 'outgoing')}
        </span>
      ))}
    </div>
    <div className={styles.legrow}>
      <span className={styles.lt}>trust</span>
      {TRUST_ORDER.map((trust) => (
        <span className={styles.li} key={trust}>
          <span className={cx(styles.lr, styles[`trust-${trust}`])} aria-hidden="true" />
          {trustLabel(trust)}
        </span>
      ))}
    </div>
  </div>
);

export default Legend;
