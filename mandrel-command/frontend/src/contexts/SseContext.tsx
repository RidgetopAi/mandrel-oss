import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from './AuthContext';
import { startSse, SseHandle } from '../lib/sse';
import { AidisEntity } from '../types/events';
import { logger } from '../utils/logger';

interface SseContextValue {
  isConnected: boolean;
  isSupported: boolean;
}

const SseContext = createContext<SseContextValue>({
  isConnected: false,
  isSupported: true
});

export const useSseContext = () => useContext(SseContext);

export const SseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuthContext();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [isSupported, setIsSupported] = useState(true);

  useEffect(() => {
    if (!token) {
      setIsConnected(false);
      return;
    }

    // Subscribe to all entity types
    const entities: AidisEntity[] = ['contexts', 'tasks', 'decisions', 'projects', 'sessions'];

    // ── UNFILTERED ON PURPOSE (page-scope epic §A3) ───────────────────────────────────
    // This used to filter on the ambient `currentProject.id`. That was correct only
    // while the ambient project was also the project every page displayed. It no longer
    // is: the ambient scope is PINNED to the user's default, while each page picks its
    // own project. A filtered stream would therefore deliver live invalidations for the
    // DEFAULT project only — so every page pointed anywhere else would silently stop
    // updating. No error, no reconnect, just stale lists: the failure mode that gets
    // reported months later as "the app is flaky".
    //
    // The alternative (per-page subscription keys) means a subscription whose lifetime
    // is a page's mount, N of them for a page with several scoped panels, and a
    // reconnect on every selector change. Unfiltered costs some extra events the query
    // cache already de-duplicates by key, and is correct for every page by construction.
    // Cheap and right beats clever and conditional.
    //
    // This also removes SSE's dependency on ProjectContext entirely — one fewer consumer
    // of the ambient value we intend to delete.
    const handle: SseHandle = startSse({
      token,
      entities,
      queryClient,
      onConnect: () => setIsConnected(true),
      onDisconnect: () => setIsConnected(false),
      onError: () => setIsConnected(false)
    });

    if (handle.unsupported) {
      setIsSupported(false);
      logger.warn('SSE not supported, falling back to polling');
      // TODO: Enable React Query polling as fallback
    }

    return () => {
      handle.stop?.();
    };
  }, [token, queryClient]);

  return (
    <SseContext.Provider value={{ isConnected, isSupported }}>
      {children}
    </SseContext.Provider>
  );
};
