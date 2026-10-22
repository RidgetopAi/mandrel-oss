/**
 * Session module types
 * Re-exports shared types and defines internal types
 */

export type { SessionStats, SessionActivity, SessionFile, ProductivityConfig } from '../../types/session.js';

/**
 * Marker agent_type for sessions created by the fleet deploy SMOKE
 * (fleet-deploy script — the /api/v2/sessions/start liveness probe).
 *
 * The smoke MARKS its session with this agent_type and ends it immediately as
 * best-effort cleanup. Analytics read paths EXCLUDE sessions carrying this marker
 * so a deploy never pollutes the sessions list or session stats — even if the
 * best-effort cleanup fails on a flaky deploy. Single source of truth shared by:
 *   - migration 048 (v_session_summaries view → list/detail/compare), and
 *   - SessionStatsService.getSessionStatsEnhanced / getSessionStats (read FROM sessions directly).
 * Keep this string in lockstep with the predicate in migration 048 and the
 * SESSION_TYPE value in the deploy script.
 */
export const DEPLOY_SMOKE_AGENT_TYPE = 'deploy-smoke';

export interface SessionData {
  session_id: string;
  start_time: Date;
  end_time?: Date;
  duration_ms?: number;
  project_id?: string;
  title?: string;
  description?: string;
  contexts_created: number;
  decisions_created: number;
  operations_count: number;
  productivity_score: number;
  success_status: 'active' | 'completed' | 'abandoned';
  status: 'active' | 'inactive' | 'disconnected';
  last_activity_at?: Date;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  session_goal?: string | null;
  tags?: string[];
  lines_added?: number;
  lines_deleted?: number;
  lines_net?: number;
  ai_model?: string | null;
  files_modified_count?: number;
  activity_count?: number;
}
