/**
 * UUID helpers (frontend).
 *
 * The backend UUID-validated routes (e.g. GET /projects/:id/insights,
 * /projects/:id/sessions) reject any :id that is not a real UUID with a 400
 * "Bad Request". The ProjectContext can transiently hold a *synthetic* project
 * id (e.g. `aidis-my-project`, produced when a project is loaded from the AIDIS
 * V2 API by name rather than from the real projects list) or the UNASSIGNED
 * sentinel. Calling a UUID-validated endpoint with such an id is what produced
 * the customer-reported "Failed to Load Project Insights — Bad Request".
 *
 * Use `isValidUuid` to gate those calls so the UI never fires a request that is
 * guaranteed to 400, and degrades gracefully instead.
 */

export const UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

// RFC 4122 canonical form, case-insensitive. Matches what the backend Zod
// UUIDParamSchema accepts.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a real, non-nil UUID that the backend will accept on a
 * UUID-validated route. The all-zero UNASSIGNED sentinel returns false on
 * purpose: it is not a real selectable project.
 */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value === UNASSIGNED_PROJECT_ID) return false;
  return UUID_REGEX.test(value);
}

/**
 * localStorage keys the frontend uses to persist the selected project. A
 * customer (contoso) had a CORRUPT value here — a non-UUID id like
 * `session_voiceitt-bridge` — which then drove `/api/projects/{badid}` and the
 * SSE `projectId`, producing repeated 400s and wedging the dashboard on
 * "No Project Selected". These are the keys we must validate-and-clean on load.
 */
export const PROJECT_STORAGE_KEYS = [
  'aidis_selected_project',
  'aidis_current_project',
] as const;

/**
 * Remove every persisted-project localStorage key. Used to discard a corrupt
 * stored project id so the dashboard self-heals.
 */
export function clearStoredProject(): void {
  for (const key of PROJECT_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Best effort; ignore storage errors.
    }
  }
}


/**
 * Generate a correlation id for request tracing, WITHOUT requiring a secure context.
 *
 * WHY THIS EXISTS. `crypto.randomUUID()` is defined only in a SECURE CONTEXT
 * (https, or a `localhost`/`127.0.0.1` origin). Over plain http on any other host
 * it is `undefined`, and calling it throws `TypeError: crypto.randomUUID is not a
 * function`. Both call sites run inside the request path that builds the
 * correlation header, so that throw takes down EVERY request — including login,
 * which fails with a bare `status: 0` and no server-side trace.
 *
 * Measured 2026-08-11: serving this app over http on a Tailscale IP produced
 * exactly that — the login form rendered, submitted, and failed with
 * "crypto.randomUUID is not a function". This is not only a dev-server nuisance:
 * a customer self-hosting Mandrel on a LAN over plain http hits the identical
 * broken login, and the symptom (status 0, nothing in the server log) points
 * nowhere near the cause.
 *
 * `crypto.getRandomValues` IS available in insecure contexts, so the fallback
 * keeps real entropy and only degrades to `Math.random` if even that is missing.
 * That last rung is acceptable HERE and nowhere else: a correlation id is a
 * tracing label, never a credential, a session id, or anything security-bearing.
 * Do not reuse this for those — it exists to keep an observability aid from
 * being able to break authentication.
 */
export function newCorrelationId(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }

  // RFC 4122 v4 from real entropy — getRandomValues needs no secure context.
  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort. Still a well-formed v4 so downstream parsers/log tooling behave.
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-4${r().slice(1)}-${((Math.floor(Math.random() * 4) + 8).toString(16))}${r().slice(1)}-${r()}${r()}${r()}`;
}
