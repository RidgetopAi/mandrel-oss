/**
 * Hero — the project header: the cube icon, name, live status pill (active/dormant from
 * real recency), description, and the two actions (Edit → the edit drawer, "Set as my
 * default" → this user's default-project preference). Presentational: the page owns the
 * handlers so this stays testable without the providers.
 *
 * THE SECOND ACTION USED TO BE "Switch to project" (epic 41293984 §C). There is no
 * app-wide project to switch any more: scope is per-page and explicit, and the ambient
 * scope is PINNED to the user's default. The button was repurposed rather than deleted
 * because the intent behind it — "I want to work in this project" — is still real; it
 * now expresses that as a durable per-user preference instead of a hidden global.
 */
import React from 'react';
import { StatusPill, Button } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated';
import { ProjectIcon, EditIcon, ArrowRightIcon } from './icons';
import { statusLabel, statusTone } from './config';
import styles from './ProjectDetail.module.css';

export interface HeroProps {
  project: ProjectEntity;
  active: boolean;
  onEdit: () => void;
  /** Make this the CURRENT USER's default project (persisted preference). */
  onSetDefault: () => void;
  /** True while the preference write is in flight. */
  settingDefault?: boolean;
  /** True when this project already IS the user's default. */
  isDefault?: boolean;
}

export const Hero: React.FC<HeroProps> = ({
  project,
  active,
  onEdit,
  onSetDefault,
  settingDefault,
  isDefault,
}) => (
  <header className={styles.hero}>
    <div className={styles.picon} aria-hidden="true">
      <ProjectIcon size={23} />
    </div>
    <div className={styles.hbody}>
      <div className={styles.h1r}>
        <h1 className={styles.hname}>{project.name}</h1>
        <StatusPill tone={statusTone(active)}>{statusLabel(active)}</StatusPill>
      </div>
      <p className={styles.hdesc}>{project.description || 'No description yet.'}</p>
    </div>
    <div className={styles.hactions}>
      <Button variant="ghost" onClick={onEdit}>
        <EditIcon size={15} />
        Edit
      </Button>
      <Button
        onClick={onSetDefault}
        disabled={settingDefault || isDefault}
        title={
          isDefault
            ? 'This is already your default project'
            : 'Every project-scoped page will start here'
        }
      >
        <ArrowRightIcon size={15} />
        {settingDefault
          ? 'Saving…'
          : isDefault
            ? 'Your default project'
            : 'Set as my default'}
      </Button>
    </div>
  </header>
);

export default Hero;
