/**
 * AIDIS Session Analytics Handler
 * 
 * Re-exports from modular structure for backward compatibility.
 * 
 * @see ./sessionAnalytics/index.ts for the modular implementation
 * 
 * Structure:
 * - sessionAnalytics/analytics/   - Session statistics and lifecycle
 * - sessionAnalytics/management/  - Session control and assignment  
 * - sessionAnalytics/tracking/    - Activity and file tracking (Phase 2D/2E)
 */

// Re-export everything from the modular structure
export * from './sessionAnalytics/index.js';

// Also export ActivityHandler methods on SessionManagementHandler for backward compat
// (Original file had these as static methods on SessionManagementHandler)
import { SessionManagementHandler as _SessionManagementHandler } from './sessionAnalytics/management/index.js';
import { ActivityHandler } from './sessionAnalytics/tracking/index.js';

// Extend SessionManagementHandler with ActivityHandler methods for backward compatibility
export class SessionManagementHandler extends _SessionManagementHandler {
  // Phase 2D/2E methods - delegate to ActivityHandler
  static recordSessionActivity = ActivityHandler.recordSessionActivity;
  static getSessionActivitiesHandler = ActivityHandler.getSessionActivitiesHandler;
  static recordFileEdit = ActivityHandler.recordFileEdit;
  static getSessionFilesHandler = ActivityHandler.getSessionFilesHandler;
  static calculateSessionProductivity = ActivityHandler.calculateSessionProductivity;
}

// Re-export types that were defined in original file
export type { SessionAnalyticsResult, SessionDetailsResult } from './sessionAnalytics/types.js';

// Default export
import { SessionAnalyticsHandler } from './sessionAnalytics/analytics/index.js';
export default SessionAnalyticsHandler;
