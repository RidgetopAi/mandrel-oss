/**
 * Theme toggle (P0.4) — dark default, light option.
 * Wired to the existing ThemeContext, whose setThemeMode persists the choice
 * (localStorage) AND sets `data-theme` on <html>, which is what re-themes the
 * token layer. Antd-free, token-driven.
 */
import React from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { SunIcon, MoonIcon } from './icons';
import styles from './Topbar.module.css';

export const ThemeToggle: React.FC = () => {
  const { themeMode, setThemeMode } = useTheme();
  const isDark = themeMode === 'dark';
  const next = isDark ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={() => setThemeMode(next)}
      aria-label={`Switch to ${next} theme`}
      aria-pressed={isDark}
      title={`Switch to ${next} theme`}
      data-testid="theme-toggle"
    >
      {isDark ? <MoonIcon size={17} /> : <SunIcon size={17} />}
    </button>
  );
};

export default ThemeToggle;
