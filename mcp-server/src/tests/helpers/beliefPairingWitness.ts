/**
 * PAIRING-STAGE WITNESS for the belief contract tests.
 *
 * WHY THIS EXISTS. Every belief contract test that drives adjudicateNeighbourhood opens with a
 * non-vacuity assertion of the form `expect(provider.calls).toBeGreaterThan(0)`. When the Stage-1
 * candidate query failed, that assertion was the FIRST thing to break — and its whole message was
 * "expected 0 to be greater than 0". Twice on 2026-08-31 that aborted a fleet deploy, and the
 * message named a symptom and no cause: the pairing failure was fail-open and returned the same
 * empty list a healthy empty neighbourhood returns.
 *
 * findCandidates now types that failure and adjudicateNeighbourhood BOOKS it in
 * `belief_adjudication_attempts` (scope 'neighbourhood', outcome 'failed', failed_stage 'pairing').
 * This helper reads that row and asserts on it BEFORE the count assertion, so the next occurrence
 * is diagnosable from the gate log alone — the error class and the DB's own message land in the
 * failure diff.
 *
 * IT CANNOT BE VACUOUS BY ACCIDENT. The ledger is fail-safe (a swallowed write) and killable by
 * config, so "no failed row" is exactly the ambiguous answer this whole task is about. Both are
 * therefore asserted: the ledger must be ENABLED, and it must have written a neighbourhood row for
 * this source — a WITNESS that the instrument observed this run at all. A silent ledger cannot
 * testify that the pairing stage was clean.
 */

import type { Pool } from 'pg';
import { expect } from 'vitest';
import { BELIEF_ATTEMPT_CONFIG } from '../../config/beliefConfig.js';

interface AttemptRow {
  outcome: string;
  failed_stage: string | null;
  error_class: string | null;
  error_message: string | null;
}

/**
 * Assert the pairing stage reported NO error for `sourceId`. Call this immediately before any
 * `expect(provider.calls).toBeGreaterThan(0)`.
 */
export async function expectPairingStageClean(
  pool: Pool,
  sourceId: string,
  label = 'the neighbourhood under test'
): Promise<void> {
  expect(
    BELIEF_ATTEMPT_CONFIG.enabled,
    'the attempt ledger is DISABLED, so this pairing-stage check would pass without measuring anything'
  ).toBe(true);

  const r = await pool.query<AttemptRow>(
    `SELECT outcome, failed_stage, error_class, error_message
       FROM belief_adjudication_attempts
      WHERE scope = 'neighbourhood' AND source_id = $1
      ORDER BY created_at`,
    [sourceId]
  );

  expect(
    r.rows.length,
    `no neighbourhood attempt row was written for ${label} (${sourceId}) — the attempt ledger did ` +
      'not observe this run, so it cannot testify that the pairing stage was clean'
  ).toBeGreaterThan(0);

  const pairingFailures = r.rows
    .filter((row) => row.outcome === 'failed' && row.failed_stage === 'pairing')
    .map((row) => `${row.error_class ?? 'unknown'}: ${row.error_message ?? '(no message)'}`);

  expect(
    pairingFailures.join(' | '),
    `the Stage-1 CANDIDATE PAIRING query failed for ${label} — no pair was ever reached, so the ` +
      'adjudicator could not be consulted. This is the cause of any "expected 0 to be greater ' +
      'than 0" below it; the pairing error itself is on the left of this diff'
  ).toBe('');
}
