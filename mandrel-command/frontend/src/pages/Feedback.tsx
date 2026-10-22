/**
 * Feedback — rebuilt on the P0.2 tokens + P0.3 primitives. Follows the
 * Settings/Decisions/Contexts rebuild pattern: a thin composition here + a `feedback/`
 * module owning config (all tunables), the data hook, and a token-only stylesheet.
 *
 * NOT "the last antd screen" — measured, not assumed. After this rebuild, 29 non-test
 * source files still import antd or @ant-design: 5 routed pages (Embedding,
 * ForcePasswordChange, Login, Profile, ResolveRedirectPage), AuthContext/ThemeContext,
 * every error boundary, the analytics + embedding component families, and App.tsx's
 * ConfigProvider. The dependency stays; see the task report for the enumerating command
 * (deliberately not pasted here — a grep for the antd import string would then match this
 * comment and inflate its own count).
 *
 * WHAT CHANGED FROM THE LEGACY PAGE
 *  1. ZERO antd. antd `Form`/`Select`/`Input.TextArea`/`message` → `Form`/`Field`/`Select`/
 *     `Textarea`/`Alert` from components/ui. Feedback is INLINE (an Alert), not a floating
 *     toast — same as every other rebuilt screen.
 *  2. The write rides the UNIFIED client (`api.feedback.submit` via useSubmitFeedback).
 *     The old page hand-rolled `fetch(`${apiBaseUrl}/feedback`)` with a bearer token it read
 *     out of localStorage itself, bypassing the shared axios instance — so it missed the
 *     X-Correlation-ID, the Sentry breadcrumbs and, most importantly, the discriminating
 *     401 force-logout. Auth now works here exactly as it does on every other screen.
 *  3. The auto-captured `page` is now THE SCREEN THE USER CAME FROM, not `/feedback`.
 *     `window.location.pathname` was read at submit time, by which point the user is on the
 *     feedback route — so every row this code path WOULD write carried `page = '/feedback'`,
 *     and the field that exists to make a report actionable would have said nothing.
 *     SCOPE OF THAT CLAIM, measured across the WHOLE population (not one instance):
 *     prod systemd holds 0 feedback rows, but the tenant fleet — where testers actually
 *     use this UI — holds 4, and ALL 4 carry `page = '/feedback'`:
 *       mandrel-operator 3 rows (2026-06-12, 06-19 ×2), mandrel-contoso 1 row (2026-06-14);
 *       every other tenant 0. Counted per-container the way an out-of-band feedback report
 *       walks the fleet, not from prod alone.
 *     So the bad rows are real, they include a CUSTOMER tenant, and 4/4 is the empirical
 *     confirmation of this defect rather than a theory about it.
 *     (An earlier version of this comment said "every single row was being written", which
 *     reads as a claim about existing data and was unmeasured when written; the correction
 *     that followed said "0 rows / vacuous", which was measured on prod ONLY and is wrong
 *     at fleet scope. Both errors are the same one — a count without its population.
 *     RATCHET-CLASS: C2 / RATCHET-ORIGIN: claim / RATCHET-CAUGHT: reviewer.)
 *     The shell now records the last non-feedback route (utils/lastVisitedPath) and this
 *     page reads that. It is shown to the user, because a field we ship to the operator should not
 *     be invisible to the person submitting it.
 *
 * NO SUBMITTED-FEEDBACK LIST HERE, DELIBERATELY. `api.feedback.list()` exists, but the
 * backend route (`GET /api/feedback`) is UNSCOPED: it selects the whole table with no
 * `WHERE username = …` and no admin check, so ANY authenticated user would see EVERY other
 * user's reports. That is a backend authorization gap, reported rather than papered over —
 * a client-side filter would still ship other users' feedback to the browser. When the
 * route grows a scope, a "your submissions" panel belongs here.
 */
import React from 'react';
import {
  Alert,
  Button,
  Card,
  Field,
  Form,
  Heading,
  Select,
  Text,
  Textarea,
} from '../components/ui';
import { apiErrorMessage } from '../api/request';
import { getLastVisitedPath } from '../utils/lastVisitedPath';
import { FEEDBACK_CONFIG, FEEDBACK_SEVERITIES, FEEDBACK_TYPES } from './feedback/config';
import { useSubmitFeedback } from './feedback/hooks';
import type { FeedbackSeverity, FeedbackType } from '../api/domains/feedback';
import styles from './feedback/Feedback.module.css';

const { copy } = FEEDBACK_CONFIG;

const Feedback: React.FC = () => {
  const submitFeedback = useSubmitFeedback();

  const [type, setType] = React.useState<FeedbackType>(FEEDBACK_CONFIG.defaultType);
  const [severity, setSeverity] = React.useState<FeedbackSeverity>(
    FEEDBACK_CONFIG.defaultSeverity,
  );
  const [message, setMessage] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);

  // Captured ONCE on mount: the screen the user was on before opening Feedback. Read on
  // mount rather than at submit time so it cannot drift while the form is open.
  const [capturedPage] = React.useState<string | null>(() => getLastVisitedPath());

  const remaining = FEEDBACK_CONFIG.maxMessageLength - message.length;
  const showCounter = message.length >= FEEDBACK_CONFIG.counterVisibleFrom;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitFeedback.reset();

    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setValidationError(copy.emptyMessage);
      return;
    }
    if (trimmed.length > FEEDBACK_CONFIG.maxMessageLength) {
      setValidationError(copy.tooLong);
      return;
    }
    setValidationError(null);

    submitFeedback.mutate(
      {
        type,
        severity,
        message: trimmed,
        // Omitted entirely when there is nothing honest to send.
        ...(capturedPage ? { page: capturedPage } : {}),
      },
      {
        onSuccess: () => {
          setMessage('');
          setType(FEEDBACK_CONFIG.defaultType);
          setSeverity(FEEDBACK_CONFIG.defaultSeverity);
        },
      },
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            {copy.title}
          </Heading>
        </div>
        <Text variant="body" tone="faint">
          {copy.subtitle}
        </Text>
      </header>

      <Card className={styles.formCol}>
        <Form onSubmit={handleSubmit} noValidate>
          {submitFeedback.isSuccess && !validationError && (
            <Alert variant="success">{copy.success}</Alert>
          )}
          {submitFeedback.isError && (
            <Alert variant="error" title={copy.errorTitle}>
              {apiErrorMessage(submitFeedback.error, copy.errorFallback)}
            </Alert>
          )}

          <div className={styles.pair}>
            <Field label="Type">
              <Select
                options={FEEDBACK_TYPES}
                value={type}
                onChange={(v) => setType(v as FeedbackType)}
                aria-label="Type"
              />
            </Field>
            <Field label="Severity">
              <Select
                options={FEEDBACK_SEVERITIES}
                value={severity}
                onChange={(v) => setSeverity(v as FeedbackSeverity)}
                aria-label="Severity"
              />
            </Field>
          </div>

          <Field label="Message" required error={validationError ?? undefined}>
            <Textarea
              rows={7}
              value={message}
              maxLength={FEEDBACK_CONFIG.maxMessageLength}
              placeholder={copy.messagePlaceholder}
              aria-label="Message"
              onChange={(e) => {
                setMessage(e.target.value);
                if (validationError) setValidationError(null);
              }}
            />
          </Field>

          <div className={styles.capture} data-testid="feedback-captured-page">
            <Text variant="label" tone="faint">
              {copy.pageLabel}
            </Text>
            {capturedPage ? (
              <span className={styles.capturePath}>{capturedPage}</span>
            ) : (
              <Text variant="body" tone="faintest">
                {copy.pageUnknown}
              </Text>
            )}
          </div>
          <Text variant="body" tone="faintest">
            {copy.pageHint}
          </Text>

          <div className={styles.actions}>
            <span
              className={showCounter ? `${styles.counter} ${styles.counterWarn}` : styles.counter}
            >
              {showCounter ? `${remaining} characters left` : ''}
            </span>
            <Button type="submit" loading={submitFeedback.isPending}>
              {submitFeedback.isPending ? copy.submitting : copy.submit}
            </Button>
          </div>
        </Form>
      </Card>
    </div>
  );
};

export default Feedback;
