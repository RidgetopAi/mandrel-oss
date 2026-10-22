/**
 * Feedback data hooks — the WRITE rides the UNIFIED `api` client through react-query,
 * exactly like the Settings/Decisions/Contexts rebuilds. No axios, no generated client,
 * no raw fetch, and no hand-read `localStorage` bearer token: the shared axios instance
 * behind `api.*` already attaches auth, correlation id and the 401 force-logout.
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '../../api';
import type { FeedbackEntry, FeedbackSubmission } from '../../api/domains/feedback';

/** POST /api/feedback — append-only; nothing to invalidate (no feedback query is cached). */
export function useSubmitFeedback() {
  return useMutation<FeedbackEntry, unknown, FeedbackSubmission>({
    mutationFn: (submission) => api.feedback.submit(submission),
  });
}
