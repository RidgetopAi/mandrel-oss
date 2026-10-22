/**
 * THE BELIEF HOOK ARMS ONCE, OR IT IS OFF — regression contract for an earlier task.
 *
 * ── THE DEFECT THIS LOCKS OUT (measured on the tenant fleet, 2026-08-28) ─────────────
 * `beliefEnabled` defaults TRUE and the adjudicator provider defaults to 'anthropic', whose
 * constructor throws when its API key env var is unset. An instance in that state armed a hook
 * that fired on EVERY store, threw at provider construction, and lost the record's whole
 * candidate neighbourhood — leaving one WARN per record reading "store unaffected". Across 7
 * instances in one 6h window: 23 whole-neighbourhood failures, ZERO successful adjudications,
 * and no count anywhere went down. "Store unaffected" was true, and it is exactly why nobody
 * noticed.
 *
 * The per-instance env and the tracked compose default fixed the FLEET. They cannot fix the
 * CODE PATH: systemd prod, a bare `docker run`, a dev process and any future deployment path
 * still get the code default. This file guards the code-layer rule — a feature that is asked
 * for and cannot run must be OFF and LOUD, not attempting-and-failing quietly.
 *
 * ── WHAT IS ASSERTED, AND WHY EACH ONE ──────────────────────────────────────────────
 *  1. ARMED   — a provider that constructs lets the record through (the CONTROL: without this
 *               the gate could be closed for everyone and every other assertion would pass).
 *  2. DISARMED— a provider that throws means NOTHING is enqueued. That is the property.
 *  3. ONCE    — a second, third, fourth store does NOT re-resolve and does NOT re-log. The old
 *               shape was one failure per record forever; "quieter but still trying" would not
 *               be a fix, so the resolver's CALL COUNT is asserted, not just the log count.
 *  4. STICKY  — once disarmed it stays disarmed even if a later resolver would succeed. Config
 *               is read at module load, so a credential cannot appear without a restart; a gate
 *               that re-opened mid-process would be claiming something it cannot know.
 *  5. FLAG FIRST — with the feature flag off the resolver is never even called (no provider
 *               construction, no cost, no log) — the flag gate must still short-circuit first.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  BeliefAdjudicationQueue,
  triggerBeliefAdjudication,
  __resetBeliefArmStateForTest,
  __getBeliefArmStateForTest,
} from '../services/belief/beliefHook.js';
import { BELIEF_CONFIG } from '../config/beliefConfig.js';
import { logger } from '../utils/logger.js';

/** A queue that records what reached it and NEVER drains (defer is a no-op) — no DB, no provider. */
function inertQueue(): BeliefAdjudicationQueue {
  return new BeliefAdjudicationQueue({
    maxDepth: 10,
    concurrency: 1,
    adjudicate: async () => undefined,
    defer: () => {
      /* never drain: this file is about what gets ENQUEUED, not what happens after */
    },
  });
}

const source = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'context' as const,
  projectId: null,
  content: 'a record that wants adjudicating',
};

const enabled = { ...BELIEF_CONFIG, beliefEnabled: true };

describe('belief hook arm gate (an earlier task — enabled-but-unable is not enabled)', () => {
  beforeEach(() => {
    __resetBeliefArmStateForTest();
  });

  test('ARMED: a provider that constructs lets the record through', () => {
    const queue = inertQueue();
    const resolveProvider = vi.fn(() => ({ name: 'fake', model: 'fake' }));
    triggerBeliefAdjudication(source, { cfg: enabled, queue, resolveProvider });
    expect(resolveProvider).toHaveBeenCalledTimes(1);
    expect(__getBeliefArmStateForTest()).toBe('armed');
    expect(queue.size, 'the record must reach the queue when the provider constructs').toBe(1);
  });

  test('DISARMED: a provider that throws enqueues NOTHING, and says so at ERROR exactly once', () => {
    const queue = inertQueue();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const resolveProvider = vi.fn(() => {
      throw new Error('Anthropic adjudicator needs an API key: env var "ANTHROPIC_API_KEY" is not set.');
    });
    try {
      triggerBeliefAdjudication(source, { cfg: enabled, queue, resolveProvider });
      expect(__getBeliefArmStateForTest()).toBe('disarmed');
      expect(queue.size, 'nothing may be enqueued when no provider can be constructed').toBe(0);

      // ONCE: four more stores must neither re-resolve nor re-log. The pre-fix behaviour was one
      // failure per record, forever — a quieter version of that is not a fix.
      for (let i = 0; i < 4; i++) {
        triggerBeliefAdjudication({ ...source, id: `1111111${i}-1111-4111-8111-111111111111` }, {
          cfg: enabled,
          queue,
          resolveProvider,
        });
      }
      expect(resolveProvider, 'the provider is resolved ONCE per process, not per record').toHaveBeenCalledTimes(1);
      expect(queue.size).toBe(0);

      const disarmLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes('DISARMED'));
      expect(disarmLogs.length, 'exactly one operator-actionable ERROR, not one per record').toBe(1);
      expect(
        String(disarmLogs[0][0]),
        'the message must name BOTH remedies, or it is an alarm with no action'
      ).toContain('MANDREL_BELIEF_ENABLED=false');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('STICKY: once disarmed, a later provider that WOULD construct does not silently re-arm', () => {
    const queue = inertQueue();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      triggerBeliefAdjudication(source, {
        cfg: enabled,
        queue,
        resolveProvider: () => {
          throw new Error('no key');
        },
      });
      expect(__getBeliefArmStateForTest()).toBe('disarmed');

      const wouldSucceed = vi.fn(() => ({ name: 'fake', model: 'fake' }));
      triggerBeliefAdjudication(source, { cfg: enabled, queue, resolveProvider: wouldSucceed });
      expect(wouldSucceed, 'the arm state is decided once; nothing re-resolves').not.toHaveBeenCalled();
      expect(queue.size).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('FLAG FIRST: with the feature off, the provider is never even constructed', () => {
    const queue = inertQueue();
    const resolveProvider = vi.fn(() => ({ name: 'fake', model: 'fake' }));
    triggerBeliefAdjudication(source, {
      cfg: { ...BELIEF_CONFIG, beliefEnabled: false },
      queue,
      resolveProvider,
    });
    expect(resolveProvider, 'the flag gate must short-circuit BEFORE any provider construction').not.toHaveBeenCalled();
    expect(__getBeliefArmStateForTest()).toBe('unchecked');
    expect(queue.size).toBe(0);
  });
});
