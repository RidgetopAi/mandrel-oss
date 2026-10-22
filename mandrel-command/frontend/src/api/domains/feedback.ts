/**
 * feedback domain — submit + list tester feedback (`/api/feedback`, Command backend).
 *
 * GROUNDED against the REAL route (backend/src/routes/feedback.ts) + the REAL table
 * (mcp-server/database/migrations/044_create_feedback_table.sql):
 *
 *   POST /api/feedback  { type, severity, message, page? } -> 201 { data: { feedback } }
 *   GET  /api/feedback  ?limit (default 100, capped 500)   -> 200 { data: { feedback[] } }
 *
 * The previous shape of `submit()` (`{ message, category, metadata }`) matched NOTHING on
 * the server: `category`/`metadata` are not columns and are silently dropped, and omitting
 * `type`/`severity` only worked because the route defaults them. It was never exercised —
 * the Feedback page hand-rolled its own `fetch`. Corrected to the route's actual contract
 *. `username` is deliberately absent: the server derives it from the JWT
 * and never trusts a client-supplied value.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';

/** The `type` column's CHECK constraint (migration 044) — the whole legal set. */
export type FeedbackType = 'bug' | 'idea' | 'question';
/** The `severity` column's CHECK constraint (migration 044) — the whole legal set. */
export type FeedbackSeverity = 'low' | 'medium' | 'high';

/** A row of the `feedback` table, as the API returns it. */
export interface FeedbackEntry {
  id: string;
  /** Server-derived from the JWT; null for rows written before auth carried a username. */
  username: string | null;
  type: FeedbackType;
  severity: FeedbackSeverity;
  message: string;
  /** The app path the reporter was on when they hit the problem. */
  page: string | null;
  created_at: string;
}

export interface FeedbackSubmission {
  type: FeedbackType;
  severity: FeedbackSeverity;
  message: string;
  /** Optional app path the report is about; server caps it at 1000 chars. */
  page?: string;
}

export const feedbackApi = {
  /** POST /api/feedback — returns the created row. */
  async submit(entry: FeedbackSubmission): Promise<FeedbackEntry> {
    const body = await http.post<ApiEnvelope<{ feedback: FeedbackEntry }>>('/feedback', entry);
    return unwrapData(body, 'Failed to submit feedback').feedback;
  },

  /**
   * GET /api/feedback — newest-first.
   *
   * ⚠️ UNSCOPED ON THE SERVER: this returns EVERY user's feedback to ANY authenticated
   * caller (the route has no `WHERE username = …` and no admin check). No UI renders it
   * for that reason — see the header of pages/Feedback.tsx. Do not build a user-facing
   * view on this until the route is scoped.
   */
  async list(params?: { limit?: number }): Promise<FeedbackEntry[]> {
    const body = await http.get<ApiEnvelope<{ feedback?: FeedbackEntry[] }>>('/feedback', {
      params,
    });
    return unwrapData(body, 'Failed to load feedback')?.feedback ?? [];
  },
};

export type FeedbackApi = typeof feedbackApi;
