/**
 * Shared Session Types
 *
 * Extracted to break circular dependency between:
 * - services/session/SessionTracker.ts
 * - utils/sessionFormatters.ts
 */

/**
 * SessionStats - Aggregate statistics for multiple sessions
 */
export interface SessionStats {
  totalSessions: number;
  avgDuration: number;
  productivityScore: number;
  retentionRate: number;
  sessionsByDay: Array<{date: string, count: number}>;
}

/**
 * SessionActivity - Represents discrete activity events within a session
 * Maps to: session_activities table
 */
export interface SessionActivity {
  id: number;
  session_id: string;
  activity_type: string;                          // e.g., 'file_edit', 'context_create', 'decision_record'
  activity_data: Record<string, any>;             // JSONB - flexible metadata
  occurred_at: Date;                              // When the activity occurred
  created_at: Date;                               // When the record was created
}

/**
 * SessionFile - Tracks file modifications within a session
 * Maps to: session_files table
 */
export interface SessionFile {
  id: number;
  session_id: string;
  file_path: string;                              // Absolute or relative file path
  lines_added: number;                            // Lines added to this file
  lines_deleted: number;                          // Lines deleted from this file
  source: 'tool' | 'git' | 'manual';              // How modification was detected
  first_modified: Date;                           // First time file was touched
  last_modified: Date;                            // Most recent modification
}

/**
 * ProductivityConfig - Configurable productivity scoring formulas
 * Maps to: productivity_config table
 */
export interface ProductivityConfig {
  id: number;
  config_name: string;                            // Unique config identifier
  formula_weights: {
    tasks?: number;                               // Weight for tasks completed
    context?: number;                             // Weight for contexts created
    decisions?: number;                           // Weight for decisions made
    loc?: number;                                 // Weight for lines of code
    time?: number;                                // Weight for time efficiency
    [key: string]: number | undefined;            // Allow additional weights
  };
  created_at: Date;
  updated_at: Date;
}
