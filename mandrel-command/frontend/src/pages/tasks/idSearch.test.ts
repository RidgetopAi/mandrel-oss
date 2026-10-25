/**
 * idSearch — id-shape DETECTION for the Tasks server-side search-by-id.
 *
 * These assertions pin the exact boundary that decides whether a query gets a SERVER
 * resolve (an id-shaped query) vs. is left to the client-side substring filter (prose).
 * The rule MIRRORS the backend `isResolvableNavId` so the frontend never fires a request
 * the backend would reject with a 400 — mutation-sensitive: change the floor or the
 * shape and a case flips red.
 */
import { describe, it, expect } from 'vitest';
import { isServerResolvableId, normalizeSearchId } from './idSearch';
import { navLinksConfig } from '../../config/navLinks';

describe('isServerResolvableId — fires a server resolve only for id-shaped queries', () => {
  it('accepts a full 8-4-4-4-12 UUID', () => {
    expect(isServerResolvableId('f2d3f00d-1929-45db-88a5-6bb927663ea1')).toBe(true);
  });

  it('accepts an 8-hex short id (the id8 form every Mandrel reference uses)', () => {
    expect(isServerResolvableId('5eadf00d')).toBe(true);
    expect(isServerResolvableId('f2d3f00d')).toBe(true);
  });

  it('accepts an id LONGER than 8 hex (a dashed partial, dashes stripped to ≥ floor)', () => {
    expect(isServerResolvableId('709af00d-44db')).toBe(true);
    expect(isServerResolvableId('f2d3f00d1929')).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding whitespace (a paste)', () => {
    expect(isServerResolvableId('  5EADF00D  ')).toBe(true);
  });

  it('rejects a hex run SHORTER than the configured floor (stays prose)', () => {
    // Below the floor a hex run must be treated as ordinary text, not a server lookup.
    expect(navLinksConfig.shortIdMinLength).toBe(8);
    expect(isServerResolvableId('5eadf00')).toBe(false); // 7 hex
    expect(isServerResolvableId('abc')).toBe(false);
  });

  it('rejects prose / tag / non-hex queries', () => {
    expect(isServerResolvableId('search')).toBe(false); // has non-hex letters
    expect(isServerResolvableId('bridge auth')).toBe(false);
    expect(isServerResolvableId('scope:product')).toBe(false);
    expect(isServerResolvableId('deploy the gate')).toBe(false);
  });

  it('rejects the empty / whitespace query (no lookup on an empty box)', () => {
    expect(isServerResolvableId('')).toBe(false);
    expect(isServerResolvableId('   ')).toBe(false);
  });

  it('guards a non-string input', () => {
    // @ts-expect-error — exercising the runtime type guard
    expect(isServerResolvableId(undefined)).toBe(false);
    // @ts-expect-error — exercising the runtime type guard
    expect(isServerResolvableId(null)).toBe(false);
  });
});

describe('normalizeSearchId — canonical dash-stripped, lowercased id for the resolve call', () => {
  it('strips dashes and lowercases (mirrors the backend normalizeShortId)', () => {
    expect(normalizeSearchId('F2D3F00D-1929')).toBe('f2d3f00d1929');
    expect(normalizeSearchId('  5EADF00D ')).toBe('5eadf00d');
  });
});
