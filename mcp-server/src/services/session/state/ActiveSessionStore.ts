/**
 * In-memory store for active session state
 * Connection-scoped pattern - manages which session is active per connection
 *
 * Each MCP connection (stdio or HTTP) gets its own isolated session context.
 * This prevents one connection's project_switch from affecting other connections.
 *
 * Connection ID conventions:
 * - stdio: "stdio" (default, one per process)
 * - HTTP: extracted from X-Connection-ID header
 * - Fallback: "default" for backward compatibility
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ROLE IN ACTOR MODE — PURE READ-THROUGH CACHE, NOT A SOURCE OF TRUTH.
 * (Sessions Foundation, the auditor review §4.1 / §5.)
 *
 * In actor mode (resolverMode='actor') the SESSION OF RECORD is the DB, resolved by
 * `resolveSession(actor, …)` (explicit → pin → newest-open → lazy-create). This store is a
 * per-connection PERFORMANCE CACHE only: `getActiveSession` takes the RAM hit first (validated
 * against the DB as still-open), and on a miss falls through to resolveSession and re-populates
 * the entry. It NEVER holds targeting truth the DB doesn't — any RAM value is re-validated with
 * SessionRepo.existsActive() and evicted if stale. So it is safe to lose (a wipe/restart just
 * costs one indexed re-resolve).
 *
 * DO NOT DELETE. Legacy + shadow modes still rely on this as the connection-keyed active-session
 * map, and even actor mode uses it as the read-through cache above. Full removal (demote to
 * nothing / the "one indexed query" the DB can serve) is the DEFERRED N+1 release
 *, NOT part of this cleanup phase.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from '../../../utils/logger.js';
import { SESSION_CONFIG } from '../../../config/sessionConfig.js';

const DEFAULT_CONNECTION_ID = 'default';

interface SessionEntry {
  sessionId: string;
  lastSeen: number;
}

const sessionsByConnection = new Map<string, SessionEntry>();

// Cleanup cadence + max-idle from SESSION_CONFIG (configs-not-hardcoded);
// defaults 10 min sweep / 24 h idle.
const CLEANUP_INTERVAL_MS = SESSION_CONFIG.ramStoreCleanupIntervalSec * 1000;
const MAX_IDLE_MS = SESSION_CONFIG.ramStoreMaxIdleSec * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [connId, entry] of sessionsByConnection.entries()) {
      if (now - entry.lastSeen > MAX_IDLE_MS) {
        logger.info(`🧹 Cleaning up stale session for connection: ${connId}`);
        sessionsByConnection.delete(connId);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't prevent process exit
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

function stopCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export const ActiveSessionStore = {
  /**
   * Get active session for a connection
   * @param connectionId - Unique identifier for the connection (defaults to 'default')
   */
  get(connectionId?: string): string | null {
    const connId = connectionId ?? DEFAULT_CONNECTION_ID;
    const entry = sessionsByConnection.get(connId);
    if (entry) {
      entry.lastSeen = Date.now();
      return entry.sessionId;
    }
    return null;
  },

  /**
   * Set active session for a connection
   * @param sessionId - Session ID to set (or null to clear)
   * @param connectionId - Unique identifier for the connection (defaults to 'default')
   */
  set(sessionId: string | null, connectionId?: string): void {
    const connId = connectionId ?? DEFAULT_CONNECTION_ID;
    if (sessionId === null) {
      sessionsByConnection.delete(connId);
    } else {
      sessionsByConnection.set(connId, {
        sessionId,
        lastSeen: Date.now()
      });
      startCleanup();
    }
  },

  /**
   * Clear active session for a connection
   * @param connectionId - Unique identifier for the connection (defaults to 'default')
   */
  clear(connectionId?: string): void {
    const connId = connectionId ?? DEFAULT_CONNECTION_ID;
    sessionsByConnection.delete(connId);
  },

  /**
   * Clear session if it matches the specified sessionId
   * @param sessionId - Session ID to match
   * @param connectionId - Unique identifier for the connection (defaults to 'default')
   */
  clearIfActive(sessionId: string, connectionId?: string): void {
    const connId = connectionId ?? DEFAULT_CONNECTION_ID;
    const entry = sessionsByConnection.get(connId);
    if (entry && entry.sessionId === sessionId) {
      sessionsByConnection.delete(connId);
    }
  },

  /**
   * Check if a session is active for a connection
   * @param sessionId - Session ID to check
   * @param connectionId - Unique identifier for the connection (defaults to 'default')
   */
  isActive(sessionId: string, connectionId?: string): boolean {
    const connId = connectionId ?? DEFAULT_CONNECTION_ID;
    const entry = sessionsByConnection.get(connId);
    return entry?.sessionId === sessionId;
  },

  /**
   * Get count of active connections (for monitoring)
   */
  getConnectionCount(): number {
    return sessionsByConnection.size;
  },

  /**
   * SR-1: Evict in-RAM entries whose cached sessionId is in `sessionIds`.
   *
   * The idle reaper terminalizes sessions in the DB; without this the RAM map would
   * still route their connection to the now-DEAD session id, and the next action's
   * getActiveSession would (pre-fix) return it and write no-ops. The reaper calls
   * this with the ids it just closed so the connection falls through to re-attach /
   * mint a fresh session. Returns the number of entries evicted (for logging).
   */
  evictBySessionIds(sessionIds: string[]): number {
    if (!sessionIds || sessionIds.length === 0) return 0;
    const dead = new Set(sessionIds);
    let evicted = 0;
    for (const [connId, entry] of sessionsByConnection.entries()) {
      if (dead.has(entry.sessionId)) {
        sessionsByConnection.delete(connId);
        evicted++;
      }
    }
    return evicted;
  },

  /**
   * Clear all sessions (for testing/shutdown)
   */
  clearAll(): void {
    sessionsByConnection.clear();
    stopCleanup();
  }
};
