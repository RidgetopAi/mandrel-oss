import type { ErrorInfo } from 'react';
import { reportError as sentryReportError, addBreadcrumb } from '../config/sentry';
import { logger } from '../utils/logger';
import { monitoringApi } from '../api/domains/monitoring';

export interface ErrorReportContext {
  componentStack?: string;
  section?: string;
  severity?: 'low' | 'medium' | 'high';
  metadata?: Record<string, unknown>;
}

const REPORT_ENDPOINT = import.meta.env.VITE_ERROR_ENDPOINT || '/api/monitoring/errors';
/**
 * True when an operator has pointed reporting at their OWN sink. That sink may live on another
 * origin and have its own auth, so it gets raw fetch; the default in-app endpoint gets the
 * authenticated client instead (see the note in reportError). Deriving this from the same env
 * var that defines REPORT_ENDPOINT keeps the two from disagreeing.
 */
const USES_CUSTOM_ENDPOINT = Boolean(import.meta.env.VITE_ERROR_ENDPOINT);

export const reportError = async (
  error: Error,
  info?: ErrorInfo,
  context: ErrorReportContext = {}
): Promise<void> => {
  const payload = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    componentStack: info?.componentStack,
    timestamp: new Date().toISOString(),
    ...context,
  };

  // Always log locally for immediate debugging visibility
  // eslint-disable-next-line no-console
  logger.error('AIDIS UI Error Captured', payload);

  // QA Finding #3: Report to Sentry with enhanced context
  try {
    // Add breadcrumb for error context
    addBreadcrumb(
      `Error in ${context.section || 'unknown'} section`,
      'error',
      {
        severity: context.severity,
        componentStack: info?.componentStack,
        ...context.metadata,
      }
    );

    // Report to Sentry with additional context
    sentryReportError(error, {
      section: context.section,
      severity: context.severity,
      componentStack: info?.componentStack,
      ...context.metadata,
    });
  } catch (sentryError) {
    // eslint-disable-next-line no-console
    logger.warn('Failed to report error to Sentry:', sentryError);
  }

  if (!REPORT_ENDPOINT) {
    return;
  }

  // WHY THIS IS NOT sendBeacon/raw-fetch ANY MORE (the reviewer blocking finding, 2026-07-29):
  // `/api/monitoring/errors` is authenticated — backend/src/routes/monitoring.ts does
  // `router.use(authenticateToken)`, and middleware/auth.ts requires an `Authorization: Bearer`
  // header with NO cookie path. The previous implementation sent neither:
  //   * `navigator.sendBeacon` CANNOT carry an Authorization header at all, and its boolean
  //     return was discarded; and
  //   * the `fetch` fallback set only Content-Type and never checked `res.ok`, so a 401 did not
  //     throw and nothing warned.
  // Measured live against the running backend: POST with no Authorization → HTTP 401
  // {"error":"Authentication required"}. So 100% of UI error reports were dropped SILENTLY —
  // which is the exact failure mode this reporter was chosen to fix when the MCP `context_store`
  // telemetry path was removed. A reporter that cannot report is worse than no reporter, because
  // the dashboard reads as "no errors".
  try {
    if (USES_CUSTOM_ENDPOINT) {
      // An operator-supplied sink (VITE_ERROR_ENDPOINT) may be a third-party collector on another
      // origin, so it must NOT be sent through our authenticated axios client. Keep raw fetch —
      // but check the response, so a rejecting sink is visible instead of silent.
      const res = await fetch(REPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      if (!res.ok) {
        logger.warn(
          `Failed to report UI error: custom endpoint ${REPORT_ENDPOINT} returned ${res.status}`
        );
      }
      return;
    }

    // Default path: the authenticated client, which stamps Authorization and throws on non-2xx.
    await monitoringApi.recordUiError(payload);
  } catch (networkError) {
    // Still swallowed — a failed error-report must never itself break the UI — but now it is
    // swallowed LOUDLY, and only after a real attempt that could have succeeded.
    logger.warn('Failed to report UI error', networkError);
  }
};
