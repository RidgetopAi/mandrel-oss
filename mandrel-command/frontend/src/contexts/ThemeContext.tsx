import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import { logger } from '../utils/logger';

type ThemeMode = 'light' | 'dark';

interface ThemeContextType {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  antdThemeConfig: ThemeConfig;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Light theme configuration
const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1890ff',
    borderRadius: 8,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: '#001529',
      headerBg: '#ffffff',
    },
  },
};

// Dark theme configuration
const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: '#1890ff',
    borderRadius: 8,
    wireframe: false,
    colorBgContainer: '#1f1f1f',
    colorBgElevated: '#262626',
    colorBgLayout: '#141414',
  },
  components: {
    Layout: {
      siderBg: '#141414',
      headerBg: '#1f1f1f',
      bodyBg: '#141414',
      triggerBg: '#262626',
    },
    Menu: {
      // Override dark menu selected item to prevent blue background
      // Using all possible token names to ensure coverage
      itemSelectedBg: 'rgba(255, 255, 255, 0.08)',
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemSelectedColor: '#fff',
      itemHoverBg: 'rgba(255, 255, 255, 0.05)',
      itemActiveBg: 'rgba(255, 255, 255, 0.12)',
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.08)',
      darkSubMenuItemBg: 'transparent',
      darkItemSelectedColor: '#fff',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.05)',
      itemColor: 'rgba(255, 255, 255, 0.85)',
      darkItemColor: 'rgba(255, 255, 255, 0.85)',
    },
    Typography: {
      colorText: 'rgba(255, 255, 255, 0.85)',
      colorTextHeading: 'rgba(255, 255, 255, 0.85)',
    },
  },
};

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  // Initialize theme from localStorage for immediate persistence (eliminates race condition)
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem('app_theme');
      if (stored === 'light' || stored === 'dark') {
        // Apply theme immediately to prevent flash
        document.documentElement.setAttribute('data-theme', stored);
        return stored;
      }
    } catch (error) {
      logger.error('Failed to read theme from localStorage:', error);
    }
    // Dark is the LOCKED default (an earlier decision — dark-first design language,
    // light is opt-in). With no stored preference we fall back to dark and pin
    // data-theme="dark" explicitly, keeping the attribute the single source of
    // truth for the active theme. tokens.css is dark-first (dark values live on
    // the bare `:root`), so dark holds regardless of the OS `prefers-color-scheme`;
    // light is reached ONLY via an explicit data-theme="light" toggle.
    try {
      document.documentElement.setAttribute('data-theme', 'dark');
    } catch {
      /* SSR/no-DOM guard */
    }
    return 'dark';
  });
  const [isInitialized, setIsInitialized] = useState(false);

  // Single source of truth for the data-theme attribute: keep it synced to
  // themeMode on mount AND on every change (covers the backend-sync path and any
  // future setter), so the attribute can never drift from state or be left unset.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  // Sync with user profile data from backend on mount
  useEffect(() => {
    const loadThemePreference = async () => {
      try {
        const token = localStorage.getItem('aidis_token');
        if (!token) {
          setIsInitialized(true);
          return;
        }

        const apiBaseUrl = import.meta.env.VITE_API_URL || '/api';
        const response = await fetch(`${apiBaseUrl}/auth/profile`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          // Dark default when the backend has no stored theme.
          const savedTheme = data.data?.user?.theme || 'dark';

          // Sync localStorage with backend if different
          if (savedTheme !== themeMode) {
            setThemeModeState(savedTheme);
            localStorage.setItem('app_theme', savedTheme);
            document.documentElement.setAttribute('data-theme', savedTheme);
          }
        }
      } catch (error) {
        logger.error('Failed to load theme preference:', error);
      } finally {
        setIsInitialized(true);
      }
    };

    loadThemePreference();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount to avoid infinite loop. themeMode is intentionally excluded.

  // Update theme mode, persist to localStorage, and apply to document root
  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);

    // Persist to localStorage for immediate persistence
    try {
      localStorage.setItem('app_theme', mode);
    } catch (error) {
      logger.error('Failed to save theme to localStorage:', error);
    }

    // Apply theme to document root
    document.documentElement.setAttribute('data-theme', mode);
  };

  // Get the current Ant Design theme configuration
  const antdThemeConfig = themeMode === 'dark' ? darkTheme : lightTheme;

  // Don't render children until theme is loaded to prevent flash
  if (!isInitialized) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ themeMode, setThemeMode, antdThemeConfig }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
