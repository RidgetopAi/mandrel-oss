/**
 * Session Analytics Types
 * 
 * Shared type definitions for session analytics handlers.
 */

import { SessionStats, SessionData } from '../../services/session/SessionTracker.js';

export interface SessionAnalyticsResult {
  success: boolean;
  data?: SessionStats;
  error?: string;
  timestamp: string;
}

export interface SessionDetailsResult {
  success: boolean;
  data?: SessionData;
  error?: string;
  timestamp: string;
}

export interface SessionOperationResult {
  success: boolean;
  sessionId?: string;
  projectName?: string;
  message: string;
}

export interface SessionStatusResult {
  success: boolean;
  session?: {
    id: string;
    type: string;
    started_at: Date;
    project_name: string;
    duration_minutes: number;
    contexts_created: number;
    decisions_created: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    tasks_created: number;
    tasks_updated: number;
    tasks_completed: number;
    contexts_created_tracked: number;
    metadata: Record<string, any>;
  };
  message: string;
}

export interface MCPToolResponse {
  content: Array<{ type: string; text: string }>;
}

export type { SessionStats, SessionData };
