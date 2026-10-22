/**
 * Pure unit tests for the momentum-series request validation. No DB / no
 * HTTP — just the 400 rules the controller enforces: date validity, from ≤ to, the span
 * cap (abuse guard), tz resolution, and project-uuid authority. Deterministic + fast, so
 * the endpoint's guard rails are locked down even when Postgres is absent (tests-are-the-rock).
 */
import { parseMomentumSeriesQuery } from '../controllers/momentumSeries';

const MAX = 45;

describe('parseMomentumSeriesQuery — validation + 400 rules', () => {
  it('accepts a valid from/to/tz/project and echoes the sanitized values', () => {
    const r = parseMomentumSeriesQuery(
      { from: '2026-07-01', to: '2026-07-15', tz: 'America/New_York', project: 'all' },
      MAX,
    );
    expect(r).toEqual({ ok: true, from: '2026-07-01', to: '2026-07-15', tz: 'America/New_York', projectId: undefined });
  });

  it('rejects a missing/invalid `from` (400)', () => {
    expect(parseMomentumSeriesQuery({ to: '2026-07-15' }, MAX).ok).toBe(false);
    expect(parseMomentumSeriesQuery({ from: '2026-13-01', to: '2026-07-15' }, MAX).ok).toBe(false);
    expect(parseMomentumSeriesQuery({ from: '2026-02-31', to: '2026-07-15' }, MAX).ok).toBe(false);
    expect(parseMomentumSeriesQuery({ from: 'nope', to: '2026-07-15' }, MAX).ok).toBe(false);
  });

  it('rejects a missing/invalid `to` (400)', () => {
    expect(parseMomentumSeriesQuery({ from: '2026-07-01' }, MAX).ok).toBe(false);
    expect(parseMomentumSeriesQuery({ from: '2026-07-01', to: 'bad' }, MAX).ok).toBe(false);
  });

  it('rejects from > to (400)', () => {
    const r = parseMomentumSeriesQuery({ from: '2026-07-15', to: '2026-07-01' }, MAX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/on or before/i);
  });

  it('allows a single-day range (from == to)', () => {
    const r = parseMomentumSeriesQuery({ from: '2026-07-15', to: '2026-07-15' }, MAX);
    expect(r.ok).toBe(true);
  });

  it('allows a span exactly at the cap but rejects one day beyond it (400)', () => {
    // span == MAX (inclusive-day difference) is allowed; MAX+1 is not.
    const atCap = parseMomentumSeriesQuery({ from: '2026-06-01', to: '2026-07-16' }, MAX); // 45 days apart
    expect(atCap.ok).toBe(true);
    const overCap = parseMomentumSeriesQuery({ from: '2026-06-01', to: '2026-07-17' }, MAX); // 46 days apart
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.error).toMatch(/too large/i);
  });

  it('covers the widest Month-grid span (41 days) well within the default cap', () => {
    const r = parseMomentumSeriesQuery({ from: '2026-06-28', to: '2026-08-08' }, MAX); // 41 days apart
    expect(r.ok).toBe(true);
  });

  it('falls back to UTC on an absent/bogus tz', () => {
    const a = parseMomentumSeriesQuery({ from: '2026-07-01', to: '2026-07-02' }, MAX);
    const b = parseMomentumSeriesQuery({ from: '2026-07-01', to: '2026-07-02', tz: 'Mars/Phobos' }, MAX);
    if (a.ok) expect(a.tz).toBe('UTC');
    if (b.ok) expect(b.tz).toBe('UTC');
  });

  /**
   * PROJECT SCOPE MOVED OUT. Two cases used to live here — "the explicit
   * `project` query param is authoritative over the header" and "a non-uuid project is a
   * 400" — because this function implemented both itself. It no longer does: project
   * scope is resolved AND AUTHORIZED once, upstream, in services/projectScopeResolver.ts,
   * and handed in already-decided. Those exact assertions now live in
   * projectScopeEnforcement.test.ts ('precedence' and 'malformed value' populations),
   * where they also cover the doors this endpoint never had. They were moved, not
   * dropped — a deleted assertion is a hole, and this comment is how the next reader
   * finds them.
   */
  it('passes the already-resolved project scope straight through', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    const scoped = parseMomentumSeriesQuery({ from: '2026-07-01', to: '2026-07-02' }, MAX, uuid);
    expect(scoped.ok && scoped.projectId).toBe(uuid);

    // An unscoped request stays unscoped — including when the raw query still carries a
    // `project` param, which this function must now IGNORE (reading it here would be a
    // second, un-authorized door).
    const unscoped = parseMomentumSeriesQuery(
      { from: '2026-07-01', to: '2026-07-02', project: uuid },
      MAX,
      undefined
    );
    expect(unscoped.ok && unscoped.projectId).toBe(undefined);
  });
});
