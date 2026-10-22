/**
 * Git service error utilities
 */

import { GitServiceError } from '../../../types/git';

/**
 * Create a standardized service error
 */
export function createServiceError(code: string, message: string, details?: any): GitServiceError {
  return {
    code,
    message,
    details,
    stack: new Error().stack || ''
  };
}

/**
 * Common error codes for git service operations
 */
export const GitErrorCodes = {
  INIT_REPO_FAILED: 'INIT_REPO_FAILED',
  COLLECT_COMMITS_FAILED: 'COLLECT_COMMITS_FAILED',
  GET_RECENT_COMMITS_FAILED: 'GET_RECENT_COMMITS_FAILED',
  GET_CURRENT_COMMIT_FAILED: 'GET_CURRENT_COMMIT_FAILED',
  GET_BRANCH_INFO_FAILED: 'GET_BRANCH_INFO_FAILED',
  TRACK_FILE_CHANGES_FAILED: 'TRACK_FILE_CHANGES_FAILED',
  CORRELATE_SESSIONS_FAILED: 'CORRELATE_SESSIONS_FAILED',
  QUERY_COMMITS_FAILED: 'QUERY_COMMITS_FAILED',
  COMMIT_ANALYSIS_FAILED: 'COMMIT_ANALYSIS_FAILED',
  FILE_HOTSPOTS_FAILED: 'FILE_HOTSPOTS_FAILED',
  GET_PROJECT_STATS_FAILED: 'GET_PROJECT_STATS_FAILED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  REPO_NOT_FOUND: 'REPO_NOT_FOUND',
  NOT_A_GIT_REPO: 'NOT_A_GIT_REPO'
} as const;

export type GitErrorCode = typeof GitErrorCodes[keyof typeof GitErrorCodes];
