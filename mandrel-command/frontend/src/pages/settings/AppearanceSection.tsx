/**
 * Appearance section — theme (dark / light). LIVE:
 *   • persist → api.users.updatePreferences({ theme })  (PATCH /api/users/preferences)
 * The choice applies instantly via ThemeContext (no flash), then persists; a failed save
 * reverts the applied theme so the UI never lies about what's stored (data-gap discipline).
 * Dark is the locked default.
 */
import React from 'react';
import { Alert, cx } from '../../components/ui';
import { useTheme } from '../../contexts/ThemeContext';
import { Group, Row } from './parts';
import { useUpdateTheme } from './hooks';
import styles from './Settings.module.css';
import { apiErrorMessage } from '../../api/request';

const THEMES: { value: 'dark' | 'light'; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export const AppearanceSection: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();
  const mutation = useUpdateTheme();

  const choose = (next: 'dark' | 'light') => {
    if (next === themeMode) return;
    const prev = themeMode;
    setThemeMode(next); // instant feedback
    mutation.mutate(next, {
      onError: () => setThemeMode(prev), // revert on persist failure
    });
  };

  return (
    <Group title="Appearance" description="Theme and visual density. Dark is the default.">
      {mutation.isError && (
        <div className={styles.rowInset}>
          <Alert variant="error" title="Couldn't save theme">
            {apiErrorMessage(mutation.error, 'Save failed.')}
          </Alert>
        </div>
      )}
      <Row label="Theme" help="Switch between the dark and light palettes.">
        <div className={styles.seg} role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={cx(styles.segItem, themeMode === t.value && styles.segItemOn)}
              aria-pressed={themeMode === t.value}
              onClick={() => choose(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Row>
    </Group>
  );
};

export default AppearanceSection;
