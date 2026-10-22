import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export interface FeatureFlagContextValue {
  flags: Record<string, boolean>;
  loading: boolean;
  error: Error | null;
  isEnabled: (name: string, defaultValue?: boolean) => boolean;
}

const FeatureFlagContext = createContext<FeatureFlagContextValue | undefined>(undefined);

const FETCH_INTERVAL_MS = 10000;

async function fetchFeatureFlags(): Promise<Record<string, boolean>> {
  const response = await fetch('/api/feature-flags');
  if (!response.ok) {
    throw new Error(`Failed to load feature flags: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.flags) {
    throw new Error('Invalid feature flag payload');
  }
  return data.flags as Record<string, boolean>;
}

export const FeatureFlagProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      try {
        const data = await fetchFeatureFlags();
        if (isMounted) {
          setFlags(data);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(err as Error);
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), FETCH_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  const value = useMemo<FeatureFlagContextValue>(() => ({
    flags,
    loading,
    error,
    isEnabled: (name: string, defaultValue = false) => (name in flags ? flags[name] : defaultValue),
  }), [flags, loading, error]);

  return <FeatureFlagContext.Provider value={value}>{children}</FeatureFlagContext.Provider>;
};

export function useFeatureFlags(): FeatureFlagContextValue {
  const context = useContext(FeatureFlagContext);
  if (!context) {
    throw new Error('useFeatureFlags must be used within a FeatureFlagProvider');
  }
  return context;
}

export default FeatureFlagContext;
