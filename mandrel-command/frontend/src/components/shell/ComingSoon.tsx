/**
 * ComingSoon placeholder (P0.4) — the honest landing for nav items whose real
 * screen ships in a later redesign phase (Calendar, TreeWalker). NOT a silent
 * dead link: it names the screen and states it's coming, so the nav is complete
 * and navigable end-to-end today. Built on P0.3 primitives (Empty), token-driven.
 */
import React from 'react';
import { Empty } from '../ui';
import styles from './ComingSoon.module.css';

export interface ComingSoonProps {
  /** The screen's display name (e.g. "Calendar"). */
  title: string;
  /** Optional one-line description of what will live here. */
  description?: React.ReactNode;
}

export const ComingSoon: React.FC<ComingSoonProps> = ({ title, description }) => (
  <div className={styles.wrap} data-testid="coming-soon">
    <Empty
      title={`${title} — coming in the redesign`}
      description={
        description ?? `The ${title} screen is being built in its own phase of the Command redesign.`
      }
    />
  </div>
);

/** Route element factories for the placeholder nav items. */
export const CalendarPlaceholder: React.FC = () => (
  <ComingSoon
    title="Calendar"
    description="The time view of scheduled work — the when of the Operate group."
  />
);

export const TreeWalkerPlaceholder: React.FC = () => (
  <ComingSoon
    title="TreeWalker"
    description="The graph explorer over your work & memory threads (recall_thread traversal)."
  />
);

export default ComingSoon;
