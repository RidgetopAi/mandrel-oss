/**
 * Reading lane A's `PUNCH_INCOMPLETE` rejection off the shared interceptor's `ApiError`
 * (`{ message, code, status, details }`, where `details` is the raw response body
 * `{ code:'PUNCH_INCOMPLETE', missing:[…] }`). Duck-typed on the fields, never on a class
 * (see request.ts `apiErrorMessage` for why). Tolerates the body nested under `error`
 * or `data` as well, since the envelope shape for a 400 is lane A's call.
 */
export const PUNCH_INCOMPLETE_CODE = 'PUNCH_INCOMPLETE';

export type PunchMissingField = 'doneWhen' | 'proofKind' | string;

/** The missing-field list when `err` is a PUNCH_INCOMPLETE rejection; `null` otherwise. */
export function punchIncompleteMissing(err: unknown): PunchMissingField[] | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as { code?: unknown; details?: unknown };
  const details = (e.details ?? {}) as Record<string, unknown>;
  const nested = [details, details.error, details.data].filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === 'object',
  );
  const code = [e.code, ...nested.map((n) => n.code)].find((c) => typeof c === 'string');
  if (code !== PUNCH_INCOMPLETE_CODE) return null;
  const missing = nested.map((n) => n.missing).find(Array.isArray) as unknown[] | undefined;
  return (missing ?? []).filter((m): m is string => typeof m === 'string');
}
