/**
 * reliableThreadingConfig — PURE-logic unit tests (branch:mandrel-reliability, task ST-2
 * an earlier change, spec docs/specs/reliable-auto-threading.md §X1).
 *
 * Tests are the rock. This module reads its knobs from env AT MODULE LOAD, so every case
 * gets a FRESH module instance (vi.resetModules + dynamic import) under a controlled env —
 * exactly the pattern processLock.unit.test.ts uses for a load-time singleton. Zero DB.
 *
 * Locks the config contract the spec (§X1) + task ST-2 require:
 *   - the operator-aligned defaults are present + correct,
 *   - each env override actually takes,
 *   - a bad/unparseable env (a typo) FALLS BACK to the default (boot must not crash),
 *   - an OUT-OF-RANGE but parseable value FAILS FAST (throws at load) — the same fail-fast
 *     mechanism autoThreadConfig.ts uses, so a nonsensical threshold can't silently corrupt
 *     a trust/inference decision,
 *   - the inclusive range boundaries ([0,1] cosines; TTL > 0; candidate limit ≥ 1) are honored,
 *   - the boolean kill-switch + D2 project-fallback flag parse per the house envBool idiom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every env knob this module reads — cleared before/after each test for isolation. */
const ENV_KEYS = [
  'MANDREL_ANCHOR_TTL_MS',
  'MANDREL_ANCHOR_SIM_FLOOR',
  'MANDREL_ANCHOR_THIN_MARGIN',
  'MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED',
  'MANDREL_INFERENCE_THRESHOLD',
  'MANDREL_INFERENCE_CANDIDATE_LIMIT',
  'MANDREL_RELIABLE_THREADING_ENABLED',
] as const;

/**
 * The DEFAULTS, re-typed here ON PURPOSE. This file's job is to catch an UNINTENDED change to
 * a default, so it is a deliberate TRIPWIRE: the literals below are a second, independent copy
 * of the numbers in reliableThreadingConfig.ts and a mismatch is meant to fail. Anyone moving a
 * default must move it HERE TOO, in the same commit — that edit is the acknowledgement.
 * (Every OTHER test must derive from the live config instead; pinning a tunable elsewhere fails
 * on a knob turn rather than on a defect, which is what the 0.5 -> 0.6 raise on 2026-08-11 did
 * to three suites. This file is the single sanctioned exception, because the value IS the
 * subject under test.)
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 86_400_000
const DEFAULT_ANCHOR_SIM_FLOOR = 0.6; // raised 0.5 -> 0.6 on 2026-08-11
const DEFAULT_ANCHOR_THIN_MARGIN = 0.05;
const DEFAULT_INFERENCE_THRESHOLD = 0.6; // spec C3
const DEFAULT_INFERENCE_CANDIDATE_LIMIT = 1;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** Fresh module instance under the given env overrides (undefined = leave unset). */
async function freshConfig(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  clearEnv();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  return import('@/config/reliableThreadingConfig');
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe('reliableThreadingConfig — defaults (spec §X1 the operator-aligned)', () => {
  it('exposes the correct defaults when no env is set', async () => {
    const c = await freshConfig();
    expect(c.ANCHOR_TTL_MS).toBe(DEFAULT_TTL_MS);
    expect(c.ANCHOR_SIMILARITY_FLOOR).toBe(DEFAULT_ANCHOR_SIM_FLOOR);
    expect(c.ANCHOR_THIN_MARGIN_DELTA).toBe(DEFAULT_ANCHOR_THIN_MARGIN); // thin-admission signal
    expect(c.INFERENCE_THRESHOLD).toBe(DEFAULT_INFERENCE_THRESHOLD);
    expect(c.INFERENCE_CANDIDATE_LIMIT).toBe(DEFAULT_INFERENCE_CANDIDATE_LIMIT);
    expect(c.RELIABLE_THREADING_ENABLED).toBe(true);
    expect(c.ANCHOR_PROJECT_FALLBACK_ENABLED).toBe(false); // ST-3c: default OFF (unsafe cross-session rehydrate)
  });

  it('RELIABLE_THREADING_CONFIG mirrors the named consts (single source, no second copy)', async () => {
    const c = await freshConfig();
    expect(c.RELIABLE_THREADING_CONFIG).toEqual({
      enabled: c.RELIABLE_THREADING_ENABLED,
      anchorTtlMs: c.ANCHOR_TTL_MS,
      anchorSimilarityFloor: c.ANCHOR_SIMILARITY_FLOOR,
      anchorThinMarginDelta: c.ANCHOR_THIN_MARGIN_DELTA,
      anchorProjectFallbackEnabled: c.ANCHOR_PROJECT_FALLBACK_ENABLED,
      inferenceThreshold: c.INFERENCE_THRESHOLD,
      inferenceCandidateLimit: c.INFERENCE_CANDIDATE_LIMIT,
    });
  });
});

describe('reliableThreadingConfig — env overrides take', () => {
  it('honors a valid override for every numeric knob', async () => {
    const c = await freshConfig({
      MANDREL_ANCHOR_TTL_MS: '3600000',
      MANDREL_ANCHOR_SIM_FLOOR: '0.75',
      MANDREL_ANCHOR_THIN_MARGIN: '0.2',
      MANDREL_INFERENCE_THRESHOLD: '0.42',
      MANDREL_INFERENCE_CANDIDATE_LIMIT: '5',
    });
    expect(c.ANCHOR_TTL_MS).toBe(3_600_000);
    expect(c.ANCHOR_SIMILARITY_FLOOR).toBe(0.75);
    expect(c.ANCHOR_THIN_MARGIN_DELTA).toBe(0.2);
    expect(c.INFERENCE_THRESHOLD).toBe(0.42);
    expect(c.INFERENCE_CANDIDATE_LIMIT).toBe(5);
  });

  it('parses the boolean kill-switch + D2 fallback flag per the envBool idiom', async () => {
    const off = await freshConfig({
      MANDREL_RELIABLE_THREADING_ENABLED: 'false',
      MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED: '0',
    });
    expect(off.RELIABLE_THREADING_ENABLED).toBe(false);
    expect(off.ANCHOR_PROJECT_FALLBACK_ENABLED).toBe(false);

    const on = await freshConfig({
      MANDREL_RELIABLE_THREADING_ENABLED: 'on',
      MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED: 'yes',
    });
    expect(on.RELIABLE_THREADING_ENABLED).toBe(true);
    expect(on.ANCHOR_PROJECT_FALLBACK_ENABLED).toBe(true);
  });

  it('falls back to the default on a garbage boolean (typo must not crash)', async () => {
    const c = await freshConfig({
      MANDREL_RELIABLE_THREADING_ENABLED: 'maybe',
      MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED: 'kinda',
    });
    expect(c.RELIABLE_THREADING_ENABLED).toBe(true);
    expect(c.ANCHOR_PROJECT_FALLBACK_ENABLED).toBe(false); // ST-3c: default OFF
  });
});

describe('reliableThreadingConfig — bad/unparseable env → fallback (no crash)', () => {
  it('falls back to defaults on unparseable numeric values', async () => {
    const c = await freshConfig({
      MANDREL_ANCHOR_TTL_MS: 'not-a-number',
      MANDREL_ANCHOR_SIM_FLOOR: 'abc',
      MANDREL_ANCHOR_THIN_MARGIN: 'thin?',
      MANDREL_INFERENCE_THRESHOLD: 'xyz',
      MANDREL_INFERENCE_CANDIDATE_LIMIT: 'lots',
    });
    expect(c.ANCHOR_TTL_MS).toBe(DEFAULT_TTL_MS);
    expect(c.ANCHOR_SIMILARITY_FLOOR).toBe(DEFAULT_ANCHOR_SIM_FLOOR);
    expect(c.ANCHOR_THIN_MARGIN_DELTA).toBe(DEFAULT_ANCHOR_THIN_MARGIN);
    expect(c.INFERENCE_THRESHOLD).toBe(DEFAULT_INFERENCE_THRESHOLD);
    expect(c.INFERENCE_CANDIDATE_LIMIT).toBe(DEFAULT_INFERENCE_CANDIDATE_LIMIT);
  });

  it('treats a non-integer candidate limit / TTL as unparseable → default (not a throw)', async () => {
    const c = await freshConfig({
      MANDREL_INFERENCE_CANDIDATE_LIMIT: '2.5',
      MANDREL_ANCHOR_TTL_MS: '10.5',
    });
    expect(c.INFERENCE_CANDIDATE_LIMIT).toBe(DEFAULT_INFERENCE_CANDIDATE_LIMIT);
    expect(c.ANCHOR_TTL_MS).toBe(DEFAULT_TTL_MS);
  });
});

describe('reliableThreadingConfig — out-of-range → fail fast (throws at load)', () => {
  it('throws on a similarity floor above 1', async () => {
    await expect(freshConfig({ MANDREL_ANCHOR_SIM_FLOOR: '1.5' })).rejects.toThrow(
      /ANCHOR_SIMILARITY_FLOOR/
    );
  });

  it('throws on a negative similarity floor', async () => {
    await expect(freshConfig({ MANDREL_ANCHOR_SIM_FLOOR: '-0.1' })).rejects.toThrow(
      /ANCHOR_SIMILARITY_FLOOR/
    );
  });

  it('throws on a thin-margin delta outside [0, 1]', async () => {
    await expect(freshConfig({ MANDREL_ANCHOR_THIN_MARGIN: '1.5' })).rejects.toThrow(
      /ANCHOR_THIN_MARGIN_DELTA/
    );
    await expect(freshConfig({ MANDREL_ANCHOR_THIN_MARGIN: '-0.01' })).rejects.toThrow(
      /ANCHOR_THIN_MARGIN_DELTA/
    );
  });

  it('throws on an inference threshold above 1', async () => {
    await expect(freshConfig({ MANDREL_INFERENCE_THRESHOLD: '1.01' })).rejects.toThrow(
      /INFERENCE_THRESHOLD/
    );
  });

  it('throws on a zero / negative TTL', async () => {
    await expect(freshConfig({ MANDREL_ANCHOR_TTL_MS: '0' })).rejects.toThrow(/ANCHOR_TTL_MS/);
    await expect(freshConfig({ MANDREL_ANCHOR_TTL_MS: '-1' })).rejects.toThrow(/ANCHOR_TTL_MS/);
  });

  it('throws on a candidate limit below 1', async () => {
    await expect(freshConfig({ MANDREL_INFERENCE_CANDIDATE_LIMIT: '0' })).rejects.toThrow(
      /INFERENCE_CANDIDATE_LIMIT/
    );
    await expect(freshConfig({ MANDREL_INFERENCE_CANDIDATE_LIMIT: '-3' })).rejects.toThrow(
      /INFERENCE_CANDIDATE_LIMIT/
    );
  });
});

describe('reliableThreadingConfig — inclusive range boundaries are valid', () => {
  it('accepts cosine floors of exactly 0 and 1', async () => {
    const lo = await freshConfig({
      MANDREL_ANCHOR_SIM_FLOOR: '0',
      MANDREL_INFERENCE_THRESHOLD: '0',
    });
    expect(lo.ANCHOR_SIMILARITY_FLOOR).toBe(0);
    expect(lo.INFERENCE_THRESHOLD).toBe(0);

    const hi = await freshConfig({
      MANDREL_ANCHOR_SIM_FLOOR: '1',
      MANDREL_INFERENCE_THRESHOLD: '1',
    });
    expect(hi.ANCHOR_SIMILARITY_FLOOR).toBe(1);
    expect(hi.INFERENCE_THRESHOLD).toBe(1);
  });

  it('accepts the minimal valid TTL (1ms) and candidate limit (1)', async () => {
    const c = await freshConfig({
      MANDREL_ANCHOR_TTL_MS: '1',
      MANDREL_INFERENCE_CANDIDATE_LIMIT: '1',
    });
    expect(c.ANCHOR_TTL_MS).toBe(1);
    expect(c.INFERENCE_CANDIDATE_LIMIT).toBe(1);
  });
});
