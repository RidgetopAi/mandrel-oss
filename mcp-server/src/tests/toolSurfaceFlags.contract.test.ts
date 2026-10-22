/**
 * TOOL-SURFACE CONFIG FLAGS — MCP-2026 rebuild PHASE 2.
 *
 * Guards the env parsing for the Phase-2 surface flags: every one DEFAULTS to today's behaviour
 * (surface=legacy, listMode=lazy, flatTools=accept, budget=1550), and every bad/unknown value
 * falls back to that default (fail-safe) rather than silently mis-configuring the surface. This
 * is the "dark by default" invariant expressed as a unit test.
 */

import { describe, test, expect, afterEach } from 'vitest';
import {
  getToolSurface,
  getToolListMode,
  getFlatToolsPolicy,
  getToolListTokenBudget,
} from '../config/toolSurfaceConfig.js';

const KEYS = [
  'MANDREL_TOOL_SURFACE',
  'MANDREL_TOOLLIST_MODE',
  'MANDREL_FLAT_TOOLS',
  'MANDREL_TOOLLIST_TOKEN_BUDGET',
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('surface flag defaults (dark by default)', () => {
  test('all flags default to today’s behaviour when unset', () => {
    for (const k of KEYS) delete process.env[k];
    expect(getToolSurface()).toBe('legacy');
    expect(getToolListMode()).toBe('lazy');
    expect(getFlatToolsPolicy()).toBe('accept');
    // RAISED 1100→1400 for lazy+core, then 1400→1450 (P3),
    // then 1450→1550 (reproject) when `project.move` landed and
    // lazy+core lifted its three un-guessable required params — MEASURED 1425→1494, broken
    // down step by step in getToolListTokenBudget's docblock:
    // `graph` gained branch_assign/branch_unassign and the old ceiling sat EXACTLY on the
    // measured surface (1400/1400), so it had no headroom left. Measurement in
    // toolSurfaceConfig.getToolListTokenBudget's docblock.
    expect(getToolListTokenBudget()).toBe(1550);
  });
});

describe('valid overrides are honoured (case-insensitive)', () => {
  test('MANDREL_TOOL_SURFACE=gateway', () => {
    process.env.MANDREL_TOOL_SURFACE = 'GATEWAY';
    expect(getToolSurface()).toBe('gateway');
  });
  test('MANDREL_TOOLLIST_MODE=full', () => {
    process.env.MANDREL_TOOLLIST_MODE = 'full';
    expect(getToolListMode()).toBe('full');
  });
  test('MANDREL_FLAT_TOOLS=reject', () => {
    process.env.MANDREL_FLAT_TOOLS = 'reject';
    expect(getFlatToolsPolicy()).toBe('reject');
  });
  test('MANDREL_TOOLLIST_TOKEN_BUDGET=1300', () => {
    process.env.MANDREL_TOOLLIST_TOKEN_BUDGET = '1300';
    expect(getToolListTokenBudget()).toBe(1300);
  });
});

describe('bad/unknown values fall back to the default (fail-safe)', () => {
  test.each([
    ['MANDREL_TOOL_SURFACE', 'bogus', () => getToolSurface(), 'legacy'],
    ['MANDREL_TOOLLIST_MODE', 'nope', () => getToolListMode(), 'lazy'],
    ['MANDREL_FLAT_TOOLS', 'maybe', () => getFlatToolsPolicy(), 'accept'],
    ['MANDREL_TOOLLIST_TOKEN_BUDGET', '-5', () => getToolListTokenBudget(), 1550],
    ['MANDREL_TOOLLIST_TOKEN_BUDGET', 'abc', () => getToolListTokenBudget(), 1550],
    ['MANDREL_TOOLLIST_TOKEN_BUDGET', '0', () => getToolListTokenBudget(), 1550],
  ])('%s=%s → default', (key, val, getter, expected) => {
    process.env[key as string] = val as string;
    expect((getter as () => unknown)()).toBe(expected);
  });

  test('empty string → default', () => {
    process.env.MANDREL_TOOL_SURFACE = '';
    expect(getToolSurface()).toBe('legacy');
  });
});
