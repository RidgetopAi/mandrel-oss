/**
 * Session module - Main entry point
 * 
 * This module provides session lifecycle management, tracking, and analytics.
 * 
 * Structure:
 * - SessionTracker: Façade maintaining backward-compatible API
 * - domain/: Business logic (lifecycle, tracking, productivity, stats)
 * - infra/: Database repos and external integrations (git)
 * - state/: In-memory singleton stores
 * - types.ts: Module-specific types
 */

// Main façade and utilities
export {
  SessionTracker,
  ensureActiveSession,
  recordSessionOperation,
  getCurrentSession
} from './SessionTracker.js';

// Types
export type {
  SessionData,
  SessionStats,
  SessionActivity,
  SessionFile
} from './types.js';

export type { ProductivityConfig } from '../../types/session.js';

// Domain services (for advanced usage)
export { SessionLifecycleService } from './domain/lifecycle/index.js';
export { TokenTracker, OperationTracker } from './domain/tracking/index.js';
export { SessionStatsService } from './domain/stats/index.js';
export { calculateBasicProductivity, calculateWeightedProductivity } from './domain/productivity/index.js';

// Infrastructure (for advanced usage)
export { SessionRepo, ActivityRepo, FileRepo, AnalyticsEventsRepo } from './infra/db/index.js';
export { GitFileSync } from './infra/git/index.js';

// State stores (for advanced usage)
export { ActiveSessionStore, TokenStore, ActivityCountStore } from './state/index.js';
