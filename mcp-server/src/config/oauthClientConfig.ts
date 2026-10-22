/**
 * OAUTH DCR (dynamic-client-registration) ABUSE-CONTROL CONFIG — the single source of truth
 * for the tunables that cap + rate-limit + expire self-registered OAuth clients (BA-3 arming,
 * an earlier task).
 *
 * WHY THIS EXISTS: `auth.ts` keeps `allowUnauthenticatedClientRegistration: true` — REQUIRED
 * for Claude.ai's connector to self-register via public DCR (RFC 7591). But left ungoverned,
 * the `oauthClient` table grows unbounded: anyone can POST `<basePath>/oauth2/register`
 * repeatedly, and abandoned/never-consented clients accumulate forever. This config governs
 * the THREE controls that ARM that surface for a broad fleet rollout:
 *
 *   1. RATE-LIMIT — a per-window cap on `<basePath>/oauth2/register` requests (wired into the
 *      @better-auth/oauth-provider plugin's native `rateLimit.register` rule, and the
 *      better-auth rate limiter is force-enabled regardless of NODE_ENV so the control is real
 *      in every environment — better-auth otherwise leaves rate limiting OFF outside production).
 *   2. PER-TENANT CAP — a hard ceiling on the number of rows in `oauthClient` for this instance
 *      (one instance == one tenant in the per-tenant fleet). Enforced by a middleware in front
 *      of the register endpoint (oauthClientGuard.ts) that COUNT(*)s and rejects past the cap.
 *   3. TTL-SWEEP — a scheduled, single-flight background sweep (oauthClientSweeper.ts, mirroring
 *      the re-embed self-heal worker) that DELETEs clients older than `ttlDays` that were NEVER
 *      consented AND never issued an access token (abandoned DCR noise) — sparing any client a
 *      user actually consented to / used.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. Every
 * threshold below is a NAMED value with a doc comment + an env override — never a literal
 * buried in a handler or the worker. Mirrors resilienceConfig.ts / sessionConfig.ts /
 * betterAuthConfig.ts. Env is read at MODULE LOAD (like every sibling config) with a safe
 * fallback, so a fresh process picks up an operator override at boot and the value is stable
 * for the run.
 */

/** Read a boolean env var ("true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read a positive-integer env var, else `fallback` (ignores zero/negative/garbage). */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export interface OAuthClientConfig {
  /**
   * RATE-LIMIT master switch. When true (+ OAuth enabled), `createAuth` turns on better-auth's
   * rate limiter (`rateLimit.enabled = true`) so the per-endpoint `register` rule is actually
   * applied in EVERY environment — better-auth defaults the limiter to `enabled ?? isProduction`,
   * i.e. OFF in dev/test, which would silently disable this security control off-prod. DEFAULT
   * true. env: MANDREL_OAUTH_RATELIMIT_ENABLED
   */
  rateLimitEnabled: boolean;
  /**
   * RATE-LIMIT window in SECONDS for the `<basePath>/oauth2/register` endpoint. Within one
   * window at most `registerRateMax` register attempts (per client IP) are allowed. DEFAULT 60.
   * env: MANDREL_OAUTH_DCR_RATE_WINDOW_SEC
   */
  registerRateWindowSec: number;
  /**
   * RATE-LIMIT max register attempts per window (per client IP). DEFAULT 5 (matches the
   * oauth-provider's own documented default — a legitimate connector registers ONCE). env:
   * MANDREL_OAUTH_DCR_RATE_MAX
   */
  registerRateMax: number;

  /**
   * PER-TENANT CLIENT CAP — the hard ceiling on total `oauthClient` rows for this instance.
   * A register request is rejected (429) once the table already holds this many clients. One
   * instance serves one tenant (per-tenant docker fleet), so this is effectively "max OAuth
   * clients this tenant may have". DEFAULT 100 — generous for a real tenant (a handful of
   * connectors) while bounding abuse. Raise for an instance with many legitimate integrations.
   * env: MANDREL_OAUTH_DCR_CLIENT_CAP
   */
  perTenantCap: number;

  /**
   * TTL-SWEEP master switch. When true (+ OAuth enabled), the scheduled single-flight sweep
   * (oauthClientSweeper) runs and deletes abandoned DCR clients (see ttlDays). DEFAULT true;
   * it is idempotent + a pure no-op when there is nothing to sweep. Flip to false to disable
   * the sweep for an instance. env: MANDREL_OAUTH_DCR_SWEEP_ENABLED
   */
  sweepEnabled: boolean;
  /**
   * TTL in DAYS. A DCR-registered client whose `createdAt` is older than this AND that was
   * never consented (no `oauthConsent` row) AND never issued an access token (no
   * `oauthAccessToken` row) is deleted by the sweep — it is abandoned registration noise. Any
   * client a user actually consented to / used is ALWAYS spared regardless of age. DEFAULT 30.
   * env: MANDREL_OAUTH_DCR_TTL_DAYS
   */
  ttlDays: number;
  /**
   * TTL-SWEEP interval in MINUTES. Each tick runs one single-flight sweep. DEFAULT 360 (6h) —
   * abandoned-client cleanup is not time-critical, so a low-frequency sweep keeps DB load
   * negligible. env: MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES
   */
  sweepIntervalMinutes: number;
}

export const OAUTH_CLIENT_CONFIG: OAuthClientConfig = {
  rateLimitEnabled: envBool('MANDREL_OAUTH_RATELIMIT_ENABLED', true),
  registerRateWindowSec: envInt('MANDREL_OAUTH_DCR_RATE_WINDOW_SEC', 60),
  registerRateMax: envInt('MANDREL_OAUTH_DCR_RATE_MAX', 5),

  perTenantCap: envInt('MANDREL_OAUTH_DCR_CLIENT_CAP', 100),

  sweepEnabled: envBool('MANDREL_OAUTH_DCR_SWEEP_ENABLED', true),
  ttlDays: envInt('MANDREL_OAUTH_DCR_TTL_DAYS', 30),
  sweepIntervalMinutes: envInt('MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES', 360),
};
