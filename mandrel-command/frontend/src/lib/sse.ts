import { QueryClient } from '@tanstack/react-query';
import { AidisDbEvent, AidisEntity } from '../types/events';
import { logger } from '../utils/logger';
import { isValidUuid } from '../utils/uuid';
import { sseConfig } from '../config/sseConfig';

export type SseOptions = {
  /**
   * The session JWT. Unchanged for callers ON PURPOSE — `SseContext` passes exactly what
   * it always did — but it is now used only as an `Authorization` HEADER when minting a
   * connect ticket. It never reaches the SSE URL.
   */
  token: string;
  projectId?: string;
  entities?: AidisEntity[];
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  queryClient: QueryClient;
};

export type SseHandle = {
  stop: () => void;
  unsupported?: boolean;
};

/**
 * Reconnect/backoff tunables for the ticketed SSE connect.
 *
 * These live here rather than in `config/sseConfig.ts` only because that file is outside
 * this change's ownership; they are still a NAMED config object rather than literals
 * scattered through the reconnect path (configs-not-hardcoded).
 */
export const sseReconnectConfig = {
  /** First retry delay after a dropped/failed connection. */
  baseDelayMs: 1_000,
  /** Ceiling for the exponential backoff. */
  maxDelayMs: 30_000,
  /** Random extra delay added to each retry so N tabs do not re-mint in lockstep. */
  jitterMs: 250,
} as const;

/** Shape of POST /api/events/ticket's success envelope, narrowed to what we read. */
type TicketResponse = { data?: { ticket?: string } };

/**
 * Resolve the API origin the same way every other caller in this file does: an absolute
 * VITE_API_URL wins, otherwise same-origin (empty base → a relative `/api/...`).
 */
function resolveApiBase(): string {
  const configuredApiUrl = import.meta.env.VITE_API_URL;
  return configuredApiUrl && /^https?:\/\//i.test(configuredApiUrl)
    ? configuredApiUrl.replace(/\/api$/, '')
    : '';
}

/**
 * Exchange the session JWT for a single-use SSE connect ticket.
 *
 * THE JWT TRAVELS IN A HEADER HERE, AND ONLY HERE. That is the entire point of the
 * endpoint: `EventSource` cannot set headers, so the credential that used to ride in the
 * SSE URL (`?token=<jwt>`, and therefore into access logs, browser history and Referer)
 * is replaced by an opaque handle that is spent on first use and dead within seconds.
 */
export async function mintSseTicket(token: string, apiBase = resolveApiBase()): Promise<string> {
  const res = await fetch(`${apiBase}/api/events/ticket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`SSE ticket mint failed with HTTP ${res.status}`);
  }

  const body = (await res.json()) as TicketResponse;
  const ticket = body?.data?.ticket;
  if (!ticket) {
    throw new Error('SSE ticket mint returned no ticket');
  }
  return ticket;
}

export function startSse(options: SseOptions): SseHandle {
  const { token, projectId, entities, onConnect, onDisconnect, onError, queryClient } = options;

  // Check browser support
  if (!('EventSource' in window)) {
    logger.warn('SSE not supported by browser');
    return { stop: () => {}, unsupported: true };
  }

  // Build the NON-CREDENTIAL query params once; the ticket is appended per connect
  // attempt because each attempt needs a fresh, unspent one.
  //
  // Defense in depth: only attach projectId when it is a real UUID. The backend SSE route
  // rejects a non-UUID projectId with a 400 ("Invalid project ID format"), which surfaces
  // as repeated "SSE connection error". A corrupt/synthetic id is dropped here so the
  // stream opens unfiltered rather than failing closed.
  const baseParams = new URLSearchParams();
  if (projectId && isValidUuid(projectId)) {
    baseParams.set('projectId', projectId);
  } else if (projectId) {
    logger.warn('Dropping non-UUID projectId from SSE subscription:', projectId);
  }
  if (entities?.length) baseParams.set('entities', entities.join(','));

  const apiBase = resolveApiBase();

  let stopped = false;
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  // Per-CONNECTION coalescing state (deliberately NOT module-global): the
  // windows live and die with this SSE connection, so a stopped/reconnected
  // stream starts clean and separate connections never share/leak windows. Keyed
  // by entity so a burst of `contexts` events cannot starve a `tasks` event.
  const invalidationWindows = new Map<string, CoalesceState>();

  const openInvalidationWindow = (key: string) => {
    const timer = setTimeout(() => {
      const state = invalidationWindows.get(key);
      if (state && state.pending) {
        const evt = state.pending;
        state.pending = null;
        // Trailing edge: flush the most recent suppressed event, then keep the
        // window open so sustained load stays throttled to ~one refetch per
        // window (rather than resuming per-event invalidation).
        invalidateCachesForEvent(evt, queryClient);
        openInvalidationWindow(key);
      } else {
        invalidationWindows.delete(key);
      }
    }, sseConfig.invalidationDebounceMs);
    invalidationWindows.set(key, { timer, pending: null });
  };

  // Leading-edge coalescer: the first event of a burst invalidates immediately
  // (UI stays responsive to a real change); further same-entity events inside
  // the window are collapsed into at most one trailing invalidation. This bounds
  // a storm of N same-entity events to at most one refetch per window instead of
  // N — the fix for the Contexts page flashing (a past incident single-flight).
  const scheduleInvalidation = (evt: AidisDbEvent) => {
    const key = evt.entity;
    const existing = invalidationWindows.get(key);
    if (!existing) {
      invalidateCachesForEvent(evt, queryClient);
      openInvalidationWindow(key);
    } else {
      existing.pending = evt;
    }
  };

  // Generic event handler for all entity types
  const handleEvent = (e: MessageEvent) => {
    try {
      const payload: AidisDbEvent = JSON.parse(e.data);
      logger.log('SSE event received:', payload);
      // Coalesce bursts of same-entity events so a storm cannot thrash the UI
      // into constant refetch/flashing (a past incident single-flight).
      scheduleInvalidation(payload);
    } catch (err) {
      logger.error('Failed to parse SSE event:', err);
    }
  };

  /**
   * RECONNECT IS OURS NOW, and it has to be.
   *
   * `EventSource` reconnects by re-requesting THE SAME URL. A connect ticket is
   * single-use, so its built-in retry would replay a spent ticket and 401 forever. So on
   * any error we close the stream ourselves and schedule a fresh attempt, which mints a
   * NEW ticket. Exponential backoff with jitter keeps a backend outage from turning every
   * open tab into a mint loop.
   */
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(
      sseReconnectConfig.baseDelayMs * 2 ** attempt,
      sseReconnectConfig.maxDelayMs
    ) + Math.floor(Math.random() * sseReconnectConfig.jitterMs);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (stopped) return;

    let ticket: string;
    try {
      ticket = await mintSseTicket(token, apiBase);
    } catch (err) {
      logger.error('SSE ticket mint failed:', err);
      scheduleReconnect();
      return;
    }

    // The await above is a suspension point: `stop()` may have been called while the mint
    // was in flight. Without this the handle would leak a live EventSource.
    if (stopped) return;

    const params = new URLSearchParams(baseParams);
    params.set('ticket', ticket);
    const url = `${apiBase}/api/events?${params.toString()}`;

    // The ticket is short-lived and single-use, but it is still a credential — keep it out
    // of the console the same way the JWT used to be kept out.
    logger.log('Starting SSE connection:', {
      projectId,
      entities,
      url: url.replace(/ticket=[^&]+/, 'ticket=***'),
    });

    const source = new EventSource(url);
    es = source;

    const entityTypes = ['contexts', 'tasks', 'decisions', 'projects', 'sessions', 'system'];
    entityTypes.forEach(name => {
      source.addEventListener(name, handleEvent as any);
    });

    source.onopen = () => {
      logger.log('SSE connection opened');
      attempt = 0; // a successful open resets the backoff
      onConnect?.();
    };

    source.onerror = (err) => {
      logger.error('SSE connection error:', err);

      // Trigger invalidation as a safety net while we are disconnected.
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });

      onError?.(err);

      // Take over the retry: close, then re-mint. See scheduleReconnect above.
      source.close();
      if (es === source) es = null;
      scheduleReconnect();
    };
  };

  void connect();

  function stop() {
    logger.log('Stopping SSE connection');
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Clear any pending trailing-invalidation timers so a stopped connection
    // leaves nothing scheduled.
    invalidationWindows.forEach((state) => clearTimeout(state.timer));
    invalidationWindows.clear();
    es?.close();
    es = null;
    onDisconnect?.();
  }

  return { stop };
}

/**
 * Per-entity coalescing state (one entry per entity, per connection). An open
 * window means "we invalidated for this entity recently"; `pending` holds the
 * latest event that arrived during the window (collapsed into a single trailing
 * invalidation when the window closes).
 */
type CoalesceState = {
  timer: ReturnType<typeof setTimeout>;
  pending: AidisDbEvent | null;
};

/**
 * Map database events to React Query cache invalidations
 */
function invalidateCachesForEvent(evt: AidisDbEvent, queryClient: QueryClient) {
  switch (evt.entity) {
    case 'tasks':
      // Invalidate all task queries
      queryClient.invalidateQueries({ 
        queryKey: ['tasks']
      });
      // Also trigger window event for non-React-Query components
      window.dispatchEvent(new CustomEvent('aidis:task-update', { detail: evt }));
      // Invalidate dashboard stats
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      break;

    case 'contexts':
      // Invalidate all context list queries (they have params in queryKey[2])
      queryClient.invalidateQueries({ 
        queryKey: ['contexts', 'list']
      });
      // Invalidate context stats
      queryClient.invalidateQueries({ 
        queryKey: ['contexts', 'stats']
      });
      // Invalidate dashboard stats
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      break;

    case 'decisions':
      // Invalidate decision queries
      queryClient.invalidateQueries({ 
        queryKey: ['decisions']
      });
      // Invalidate dashboard stats
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      break;

    case 'projects':
      // Invalidate project queries
      queryClient.invalidateQueries({ 
        queryKey: ['projects']
      });
      // Invalidate current project
      queryClient.invalidateQueries({ 
        queryKey: ['currentProject']
      });
      break;

    case 'sessions':
      // Invalidate session queries (covers React Query consumers like useSessionsList
      // ['sessions','list',...] and useAllSessions ['sessions','all']).
      queryClient.invalidateQueries({
        queryKey: ['sessions']
      });
      // Also fire a window event so imperative (non-React-Query) consumers can react —
      // notably the Sessions page's active-session list, which is fetched directly via
      // sessionsClient.getAllActiveSessions() and would otherwise show a stale frame
      // when a session is started/ended out-of-band (e.g. by an MCP agent). Mirrors the
      // 'aidis:task-update' pattern used by the Tasks page.
      window.dispatchEvent(new CustomEvent('aidis:session-update', { detail: evt }));
      // Keep dashboard session counters fresh too.
      queryClient.invalidateQueries({ queryKey: ['dashboardStats'] });
      break;

    default:
      logger.warn('Unknown entity type for cache invalidation:', evt.entity);
  }
}
