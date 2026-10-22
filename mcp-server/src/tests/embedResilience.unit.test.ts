/**
 * EMBED-FAILURE RESILIENCE — helper UNIT test. Hermetic: no DB, no shell-out
 * (the chat sink is spied). Proves the ONE shared degrade handler onEmbedFailure():
 *   - fires the alert sink exactly ONCE for a fresh failure (the leading-indicator alert);
 *   - RATE-LIMITS per table (a broken embedder can't spam) and re-arms after the window / reset;
 *   - respects the alertEnabled config flag (still logs, does not alert when off);
 *   - is COLUMN-AGNOSTIC — the alert names embeddingConfig.activeEmbeddingColumn(), never a hardcoded
 *     column, so the same code reports the correct plane (prod=embedding_gemma, fleet=embedding);
 *   - NEVER throws, even when the injected sink throws (guard-the-guard) — a degraded-but-
 *     persisted write must never be turned into a failed one by the alerting path.
 */
import { vi, describe, test, expect, beforeEach, afterEach, type MockInstance } from 'vitest';
import { onEmbedFailure, alertSink, resetAlertDedupe } from '../services/embedResilience.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { RESILIENCE_CONFIG } from '../config/resilienceConfig.js';

describe('onEmbedFailure — the shared degrade+alert helper', () => {
  let sendSpy: MockInstance<(title: string, body: string) => boolean>;
  let savedAlertEnabled: boolean;

  beforeEach(() => {
    // EXPLICITLY ARM THE ALERT. These cases test the ALERTING mechanism, so
    // they must state that premise rather than inherit it. `alertEnabled` now defaults to
    // `NODE_ENV === 'production'` and this suite runs under NODE_ENV=test, so without this
    // line the sink is legitimately off and every "fires the alert" assertion fails.
    //
    // Setting it here rather than widening the default back is the point: a test that needs
    // alerting on should say so, and the three cases below are now honest about what they
    // exercise. `respects the alertEnabled config flag` (further down) still flips it OFF and
    // asserts silence, so both polarities remain covered.
    savedAlertEnabled = RESILIENCE_CONFIG.alertEnabled;
    RESILIENCE_CONFIG.alertEnabled = true;
    resetAlertDedupe();
    // send() now reports dispatch success (an earlier task ruling 4); the spy models success.
    sendSpy = vi.spyOn(alertSink, 'send').mockImplementation(() => true);
  });
  afterEach(() => {
    RESILIENCE_CONFIG.alertEnabled = savedAlertEnabled;
    sendSpy.mockRestore();
    resetAlertDedupe();
  });

  test('a fresh failure fires the alert sink exactly once', () => {
    onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('embedder down') });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  test('rate-limits per table (dedupe) but alerts each table independently; reset re-arms', () => {
    // Two failures on the SAME table inside the window → only the first alerts.
    onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('down') });
    onEmbedFailure({ table: 'contexts', op: 'update', recordId: 'abc', error: new Error('down again') });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // A DIFFERENT table is a separate bucket → it alerts.
    onEmbedFailure({ table: 'technical_decisions', op: 'create', error: new Error('down') });
    expect(sendSpy).toHaveBeenCalledTimes(2);

    // Reset the dedupe state → the next contexts failure alerts again.
    resetAlertDedupe();
    onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('down') });
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });

  test('respects the alertEnabled flag: does not alert when disabled', () => {
    const prev = RESILIENCE_CONFIG.alertEnabled;
    RESILIENCE_CONFIG.alertEnabled = false;
    try {
      onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('down') });
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      RESILIENCE_CONFIG.alertEnabled = prev;
    }
  });

  test('is column-agnostic: the alert body reports the ACTIVE column from config', () => {
    onEmbedFailure({ table: 'contexts', op: 'create', error: new Error('down') });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [title, body] = sendSpy.mock.calls[0] as [string, string];
    expect(title).toContain('embed failure');
    expect(body, 'body must name the active column from activeEmbeddingColumn(), not a hardcode').toContain(
      `Active column: ${activeEmbeddingColumn()}`,
    );
  });

  test('never throws even when the sink throws (guard-the-guard)', () => {
    sendSpy.mockImplementation(() => {
      throw new Error('sink exploded');
    });
    expect(() =>
      onEmbedFailure({ table: 'technical_decisions', op: 'create', error: new Error('down') }),
    ).not.toThrow();
  });
});
