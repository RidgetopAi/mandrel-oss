/**
 * Small shared Settings presentational building blocks — the grouped "card + hairline
 * rows" shell from the locked mock (.group / .gh / .row). Pure + token-styled; no data
 * access here. Each section composes these so the panel stays visually consistent.
 */
import React from 'react';
import { cx } from '../../components/ui';
import styles from './Settings.module.css';

/** A titled settings group (the mock's `.group`). Set `danger` for the rose-tinted card. */
export const Group: React.FC<{
  title: string;
  description?: React.ReactNode;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ title, description, danger, children }) => (
  <section className={cx(styles.group, danger && styles.groupDanger)}>
    <header className={styles.groupHead}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {description != null && <p className={styles.groupDesc}>{description}</p>}
    </header>
    {children}
  </section>
);

/** A single hairline row: label + help on the left, control(s) on the right (the mock's `.row`). */
export const Row: React.FC<{
  label: React.ReactNode;
  help?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ label, help, children }) => (
  <div className={styles.row}>
    <div className={styles.rowLabel}>
      <div className={styles.rowLb}>{label}</div>
      {help != null && <div className={styles.rowHelp}>{help}</div>}
    </div>
    {children != null && <div className={styles.rowControl}>{children}</div>}
  </div>
);
