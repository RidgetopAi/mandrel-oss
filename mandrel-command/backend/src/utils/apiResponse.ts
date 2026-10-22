/**
 * apiResponse — the ONE definition of the standard JSON envelope every route returns
 * (code-health dedup).
 *
 * THE DUPLICATION THIS REPLACES: route handlers each hand-rolled the same success/error
 * envelope inline — `res.json({ success: true, data, timestamp })` and an identical catch
 * `res.status(500).json({ success: false, error: ..., timestamp })`. jscpd flagged the
 * monitoring.ts self-duplication (the same catch block repeated across ~11 handlers); the
 * pattern also recurs across many other route files. Two hand-rolled copies of the SAME
 * shape are the "one copy drifts from the other" risk: a change to the
 * envelope on one route silently diverges from the rest. Centralizing it here means the
 * envelope has ONE definition that cannot drift.
 *
 * BEHAVIOR-PRESERVING by construction: the emitted objects are byte-for-byte the shapes the
 * inline code produced (same keys, same order, `timestamp` last, same error-message
 * derivation and fallback). This is a pure extraction — no route's response changes.
 */

import type { Response } from 'express';

/**
 * Send the standard success envelope: `{ success: true, data, ...extra, timestamp }`.
 * `extra` carries the occasional sibling field an endpoint adds alongside `data` (e.g.
 * `count`) — spread BEFORE `timestamp` so `timestamp` stays last, matching the inline form.
 */
export function sendSuccess(
  res: Response,
  data: unknown,
  extra?: Record<string, unknown>,
): Response {
  return res.json({
    success: true,
    data,
    ...(extra ?? {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Send the standard error envelope: `{ success: false, error, timestamp }` at `status`.
 * Mirrors the inline catch exactly: an `Error` yields its `.message`, anything else yields
 * `fallback`. Defaults (500 / 'Unknown error') match the overwhelmingly common inline case;
 * callers pass an explicit status + fallback where they differ (e.g. 404 / 'Service not
 * found').
 */
export function sendError(
  res: Response,
  error: unknown,
  status = 500,
  fallback = 'Unknown error',
): Response {
  return res.status(status).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
    timestamp: new Date().toISOString(),
  });
}
