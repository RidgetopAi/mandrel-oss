/**
 * Unit test: parseActorParam / normalizeActor (config/sessionActor.ts).
 *
 * The read-boundary validation for the session ACTOR slice (`?actor=<slug>`). No DB.
 * Guards the contract that a bad/oversized/odd-cased actor param is normalized or
 * safely DROPPED (→ undefined = no filter), never thrown and never passed through raw.
 */
import {
  parseActorParam,
  normalizeActor,
  SESSION_ACTOR_CONFIG,
} from '../config/sessionActor';

describe('normalizeActor', () => {
  test('lowercases + hyphenates whitespace + collapses/strips hyphens', () => {
    expect(normalizeActor('  Coordinator  ')).toBe('coordinator');
    expect(normalizeActor('Deploy Smoke')).toBe('deploy-smoke');
    expect(normalizeActor('builder--281e810a')).toBe('builder-281e810a');
    expect(normalizeActor('-tick-')).toBe('tick');
  });

  test('empty / blank / nullish → undefined', () => {
    expect(normalizeActor('')).toBeUndefined();
    expect(normalizeActor('   ')).toBeUndefined();
    expect(normalizeActor(undefined)).toBeUndefined();
    expect(normalizeActor(null)).toBeUndefined();
  });

  test('is idempotent on already-normalized slugs', () => {
    for (const s of ['coordinator', 'tick', 'builder-281e810a', 'deploy-smoke', 'anonymous']) {
      expect(normalizeActor(s)).toBe(s);
    }
  });
});

describe('parseActorParam', () => {
  test('accepts + normalizes valid actor slugs', () => {
    expect(parseActorParam('coordinator')).toBe('coordinator');
    expect(parseActorParam('  Tick ')).toBe('tick');
    expect(parseActorParam('builder-281e810a')).toBe('builder-281e810a');
  });

  test('absent param → undefined (no filter)', () => {
    expect(parseActorParam(undefined)).toBeUndefined();
    expect(parseActorParam('')).toBeUndefined();
  });

  test('DROPS an oversized slug rather than filtering on garbage', () => {
    const tooLong = 'a'.repeat(SESSION_ACTOR_CONFIG.maxLength + 1);
    expect(parseActorParam(tooLong)).toBeUndefined();
  });

  test('DROPS values with illegal characters (shape guard)', () => {
    expect(parseActorParam("coordinator'; DROP TABLE sessions;--")).toBeUndefined();
    expect(parseActorParam('has space')).toBe('has-space'); // whitespace normalizes to a valid slug
    expect(parseActorParam('under_score')).toBeUndefined();
    expect(parseActorParam('slash/actor')).toBeUndefined();
  });

  test('a non-string (array) param does not throw', () => {
    // Express can hand `req.query.actor` as string[] when repeated; must not crash.
    expect(() => parseActorParam(['coordinator', 'tick'])).not.toThrow();
  });
});
