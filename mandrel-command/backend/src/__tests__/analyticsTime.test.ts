/**
 * Unit tests for the analytics-timezone config.
 *
 * `resolveAggTimeZone` is the read-boundary that turns an untrusted `?tz=` query param
 * into a value that is SAFE to bind into `AT TIME ZONE $n`: a real IANA zone passes
 * through; anything absent / non-string / malformed / unrecognised (incl. an injection
 * attempt) falls back to the default (UTC). No DB needed — pure logic, always runs.
 */

import { resolveAggTimeZone, DEFAULT_AGG_TIMEZONE } from '../config/analyticsTime';

describe('resolveAggTimeZone', () => {
  it('passes a valid IANA zone through unchanged', () => {
    expect(resolveAggTimeZone('America/New_York')).toBe('America/New_York');
    expect(resolveAggTimeZone('Europe/London')).toBe('Europe/London');
    expect(resolveAggTimeZone('UTC')).toBe('UTC');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(resolveAggTimeZone('  America/New_York  ')).toBe('America/New_York');
  });

  it('defaults when the param is absent / empty / non-string', () => {
    expect(resolveAggTimeZone(undefined)).toBe(DEFAULT_AGG_TIMEZONE);
    expect(resolveAggTimeZone('')).toBe(DEFAULT_AGG_TIMEZONE);
    expect(resolveAggTimeZone('   ')).toBe(DEFAULT_AGG_TIMEZONE);
    expect(resolveAggTimeZone(123 as unknown)).toBe(DEFAULT_AGG_TIMEZONE);
    expect(resolveAggTimeZone(null)).toBe(DEFAULT_AGG_TIMEZONE);
  });

  it('rejects an unrecognised zone (would otherwise 500 the AT TIME ZONE query)', () => {
    expect(resolveAggTimeZone('Not/ARealZone')).toBe(DEFAULT_AGG_TIMEZONE);
    expect(resolveAggTimeZone('Mars/Olympus_Mons')).toBe(DEFAULT_AGG_TIMEZONE);
  });

  it('rejects an injection-shaped string (defensive — even though it is param-bound)', () => {
    expect(resolveAggTimeZone("UTC'; DROP TABLE sessions; --")).toBe(DEFAULT_AGG_TIMEZONE);
  });

  it('defaults to UTC out of the box', () => {
    expect(DEFAULT_AGG_TIMEZONE).toBe('UTC');
  });
});
