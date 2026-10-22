/**
 * Feedback screen tunables (configs-not-hardcoded).
 *
 * The option sets and the length cap are NOT free choices — they mirror the CHECK
 * constraints on the `feedback` table (migration 044) and MAX_MESSAGE_LENGTH in
 * backend/src/routes/feedback.ts. Client-side validation here is a courtesy that keeps a
 * doomed request off the wire; the SERVER is the authority and re-validates all of it.
 */
import type { FeedbackSeverity, FeedbackType } from '../../api/domains/feedback';

export interface FeedbackOption<T extends string> {
  value: T;
  label: string;
}

/** `type` CHECK ('bug','idea','question'). */
export const FEEDBACK_TYPES: FeedbackOption<FeedbackType>[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
];

/** `severity` CHECK ('low','medium','high'). */
export const FEEDBACK_SEVERITIES: FeedbackOption<FeedbackSeverity>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** Must match MAX_MESSAGE_LENGTH in backend/src/routes/feedback.ts. */
const MAX_MESSAGE_LENGTH = 5000;

export const FEEDBACK_CONFIG = {
  defaultType: 'bug' as FeedbackType,
  defaultSeverity: 'medium' as FeedbackSeverity,
  maxMessageLength: MAX_MESSAGE_LENGTH,
  /** Show the remaining-characters counter only once the user is near the cap. */
  counterVisibleFrom: MAX_MESSAGE_LENGTH - 500,
  copy: {
    title: 'Feedback',
    subtitle: 'Found a bug, have an idea, or a question? Send it straight to the team.',
    messagePlaceholder: 'Describe the bug, idea, or question…',
    submit: 'Send feedback',
    submitting: 'Sending…',
    success: 'Thanks — got it.',
    errorTitle: "Couldn't send that",
    errorFallback: 'Failed to submit feedback. Please try again.',
    emptyMessage: 'Please write a message before sending.',
    tooLong: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
    pageLabel: 'Reporting about',
    pageHint:
      'Auto-captured — the last screen you were on before opening Feedback. It goes with your report so we can find the problem.',
    pageUnknown: 'No screen captured (you opened Feedback directly).',
  },
} as const;
