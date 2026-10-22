/**
 * Settings — the Command "calm control panel", rebuilt to the LOCKED mock
 * (docs/command-settings-mock.html) on the P0 foundation: P0.3 primitives + P0.2 tokens,
 * ZERO antd, every WRITE through the unified `api` client via react-query
 * (src/pages/settings/hooks.ts). Mirrors the Decisions/Contexts rebuilds: a thin
 * composition here + a `settings/` module owning the section parts, config (all tunables),
 * data hooks, and a token-only stylesheet.
 *
 * A section rail (left) drives which grouped panel shows (right). Each section owns its
 * own state. DATA POLICY: Account / Projects / Appearance / Danger are
 * wired to REAL backend routes; Actors & identity, Notifications, and API-token rotation
 * have no Command endpoint yet and render honest, disabled "not yet available" affordances
 * that NAME the gap — never faked controls, never a new backend endpoint.
 */
import React from 'react';
import { Heading, Text } from '../components/ui';
import { SectionNav } from './settings/SectionNav';
import { AccountSection } from './settings/AccountSection';
import { ProjectsSection } from './settings/ProjectsSection';
import { IdentitySection } from './settings/IdentitySection';
import { NotificationsSection } from './settings/NotificationsSection';
import { ApiTokensSection } from './settings/ApiTokensSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DangerZoneSection } from './settings/DangerZoneSection';
import { SETTINGS_CONFIG } from './settings/config';
import { useProjectContext } from '../contexts/ProjectContext';
import styles from './settings/Settings.module.css';

const PANELS: Record<string, React.FC> = {
  account: AccountSection,
  projects: ProjectsSection,
  identity: IdentitySection,
  notifications: NotificationsSection,
  tokens: ApiTokensSection,
  appearance: AppearanceSection,
  danger: DangerZoneSection,
};

const Settings: React.FC = () => {
  const [activeId, setActiveId] = React.useState<string>(SETTINGS_CONFIG.defaultSectionId);
  const { currentProject } = useProjectContext();
  const Panel = PANELS[activeId] ?? AccountSection;

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Settings
          </Heading>
          <Text variant="data" tone="faintest">
            {currentProject ? `${currentProject.name} · workspace` : 'workspace'}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          Configure identity, notifications and access — grouped, hairline, nothing shouting.
        </Text>
      </header>

      <div className={styles.layout}>
        <SectionNav activeId={activeId} onSelect={setActiveId} />
        <div className={styles.panel}>
          <Panel />
        </div>
      </div>
    </div>
  );
};

export default Settings;
