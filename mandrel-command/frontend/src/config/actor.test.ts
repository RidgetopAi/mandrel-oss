import { describe, it, expect } from 'vitest';
import {
  UNATTRIBUTED_ACTOR,
  ANONYMOUS_ACTOR,
  isAttributed,
  actorLabel,
  actorDotVar,
} from './actor';

/**
 * The single source of truth for how the Command UI renders the session "actor"
 * (an earlier task display part). The contract: null / undefined / '' / whitespace /
 * the `anonymous` sentinel are ALL "unattributed"; a real slug is itself.
 */
describe('actor display normalization', () => {
  describe('isAttributed', () => {
    it('is false for every no-real-who case (null, undefined, blank, anonymous)', () => {
      expect(isAttributed(null)).toBe(false);
      expect(isAttributed(undefined)).toBe(false);
      expect(isAttributed('')).toBe(false);
      expect(isAttributed('   ')).toBe(false);
      expect(isAttributed(ANONYMOUS_ACTOR)).toBe(false);
      expect(isAttributed('anonymous')).toBe(false);
      expect(isAttributed('ANONYMOUS')).toBe(false); // case-insensitive sentinel
    });

    it('is true for a real attributable principal', () => {
      expect(isAttributed('operator')).toBe(true);
      expect(isAttributed('coordinator')).toBe(true);
      expect(isAttributed('tick')).toBe(true);
    });
  });

  describe('actorLabel', () => {
    it('collapses every unattributed case to the ONE neutral label', () => {
      expect(actorLabel(null)).toBe(UNATTRIBUTED_ACTOR);
      expect(actorLabel(undefined)).toBe(UNATTRIBUTED_ACTOR);
      expect(actorLabel('')).toBe(UNATTRIBUTED_ACTOR);
      // The retired sprawl: a literal 'anonymous' must NOT render as "anonymous".
      expect(actorLabel('anonymous')).toBe(UNATTRIBUTED_ACTOR);
      expect(actorLabel('anonymous')).not.toBe('anonymous');
    });

    it('returns the real slug for an attributed actor', () => {
      expect(actorLabel('operator')).toBe('operator');
    });
  });

  describe('actorDotVar', () => {
    it('mutes non-attributed actors (null AND anonymous) to the same token', () => {
      expect(actorDotVar(null)).toBe('--tx-4');
      expect(actorDotVar('anonymous')).toBe('--tx-4');
    });

    it('gives an attributed actor a stable, deterministic accent', () => {
      const a = actorDotVar('operator');
      expect(a).not.toBe('--tx-4');
      expect(actorDotVar('operator')).toBe(a); // deterministic
    });
  });
});
