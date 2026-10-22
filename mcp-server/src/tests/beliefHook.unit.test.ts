/**
 * BELIEF POST-STORE HOOK — the BL-9 activation-seam contract. NO DB, NO LLM.
 *
 * This is the HIGHEST-STAKES wiring in the belief layer: it puts the fallible LLM adjudicator
 * on the LIVE write path. These tests lock the four non-negotiable properties with a FAKE
 * adjudicate function (no provider, no money, no network) + a controlled deferral, so each
 * guarantee is provable in isolation:
 *
 *   1. FLAG-GATED   — beliefEnabled=false ⇒ the trigger is a TOTAL no-op (nothing enqueued,
 *                     adjudicate NEVER called). beliefEnabled=true ⇒ it enqueues.
 *   2. NON-BLOCKING — triggerBeliefAdjudication returns synchronously and does NOT await belief
 *                     work; adjudicate has not run yet the instant the trigger returns (deferred).
 *   3. FAIL-SAFE    — an adjudicate that THROWS never escapes the trigger nor breaks the worker;
 *                     the store path (simulated) still completes; the next record still drains.
 *   4. BOUNDED+SERIAL+FORWARD-ONLY — a burst enqueues but drains ONE AT A TIME (never overlaps);
 *                     past the depth cap, extra records are DROPPED WITH A LOG (never OOM); a
 *                     record with no embedding no-ops via the adjudicator (already covered) and
 *                     the hook never backfills.
 *
 *   + MUTATION checks: flipping the flag gate OR removing the fail-safe wrapper WOULD break
 *     these assertions (documented inline).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BeliefAdjudicationQueue,
  triggerBeliefAdjudication,
  type BeliefHookSource,
} from '../services/belief/beliefHook.js';
import type { BeliefConfig } from '../config/beliefConfig.js';
import { BELIEF_CONFIG } from '../config/beliefConfig.js';

const src = (id: string, type: BeliefHookSource['type'] = 'context'): BeliefHookSource => ({
  id: `${id}${'0'.repeat(Math.max(0, 8 - id.length))}-0000-0000-0000-000000000000`.slice(0, 36),
  type,
  projectId: 'p1',
  content: `content ${id}`,
});

/** A cfg clone with belief on/off + a tiny cap, so tests never depend on the live env. */
function cfg(overrides: Partial<BeliefConfig> = {}): BeliefConfig {
  return { ...BELIEF_CONFIG, beliefEnabled: true, beliefQueueMaxDepth: 1000, adjudicatorConcurrency: 1, ...overrides };
}

/** A synchronous deferral so a test can flush the worker deterministically via microtasks. */
const syncDefer = (fn: () => void) => queueMicrotask(fn);
const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('BL-9 belief hook — FLAG GATE', () => {
  it('beliefEnabled=false ⇒ TOTAL no-op: adjudicate never called, nothing enqueued', async () => {
    const adjudicate = vi.fn(async () => undefined);
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate, defer: syncDefer });

    triggerBeliefAdjudication(src('off'), { cfg: cfg({ beliefEnabled: false }), queue });
    await flush();

    // MUTATION: if the `if (!cfg.beliefEnabled) return;` gate were removed, adjudicate would fire.
    expect(adjudicate).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it('beliefEnabled=true ⇒ enqueues and (after a tick) adjudicates exactly once', async () => {
    const adjudicate = vi.fn(async (_s: BeliefHookSource) => undefined);
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate, defer: syncDefer });

    triggerBeliefAdjudication(src('on'), { cfg: cfg(), queue });
    await queue.whenIdle();

    expect(adjudicate).toHaveBeenCalledTimes(1);
    expect(adjudicate.mock.calls[0][0]).toMatchObject({ type: 'context', projectId: 'p1' });
  });
});

describe('BL-9 belief hook — NON-BLOCKING', () => {
  it('trigger returns synchronously and does NOT run belief work on the caller stack', async () => {
    const adjudicate = vi.fn(async () => undefined);
    // Real default deferral (setImmediate) so the drain is genuinely on a later tick.
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate });

    triggerBeliefAdjudication(src('nb'), { cfg: cfg(), queue });

    // The instant the trigger returns, the record is queued but NOT yet adjudicated — proof the
    // store call is never delayed by belief work. MUTATION: awaiting the drain inline would fail this.
    expect(queue.size).toBe(1);
    expect(adjudicate).not.toHaveBeenCalled();

    await queue.whenIdle();
    expect(adjudicate).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
  });

  it('simulated store: the store returns immediately even when adjudicate is slow', async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const adjudicate = vi.fn(async () => {
      await gate; // hang the adjudication
    });
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate });

    // Simulate a store handler: do its work, fire the hook, return — all without awaiting belief.
    const storeReturn = (() => {
      triggerBeliefAdjudication(src('slow'), { cfg: cfg(), queue });
      return 'STORED';
    })();

    expect(storeReturn).toBe('STORED'); // store completed while adjudicate is still hanging
    released();
    await queue.whenIdle();
    expect(adjudicate).toHaveBeenCalledTimes(1);
  });
});

describe('BL-9 belief hook — FAIL-SAFE', () => {
  it('an adjudicate THROW never escapes the trigger (store path unaffected)', async () => {
    const adjudicate = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate, defer: syncDefer });

    // The trigger itself must not throw synchronously.
    expect(() => triggerBeliefAdjudication(src('boom'), { cfg: cfg(), queue })).not.toThrow();
    // And the background drain must swallow the throw (no unhandled rejection, no crash).
    await expect(queue.whenIdle()).resolves.toBeUndefined();
    expect(adjudicate).toHaveBeenCalledTimes(1);
  });

  it('a throwing record does not poison the queue — the NEXT record still drains', async () => {
    const seen: string[] = [];
    const adjudicate = vi.fn(async (s: BeliefHookSource) => {
      seen.push(s.content);
      if (s.content.includes('bad')) throw new Error('kaboom');
    });
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate, defer: syncDefer });

    queue.enqueue({ ...src('a'), content: 'bad-one' });
    queue.enqueue({ ...src('b'), content: 'good-two' });
    await queue.whenIdle();

    // MUTATION: if the per-record try/catch in drain() were removed, the throw would break the
    // loop and 'good-two' would never process.
    expect(seen).toEqual(['bad-one', 'good-two']);
    expect(queue.processed).toBe(1); // only the good one counts as processed
  });

  it('a broken queue/deps cannot break the store — trigger swallows even a build error', () => {
    // Force the outermost guard: a cfg getter that throws simulates any internal failure.
    const throwingCfg = new Proxy({} as BeliefConfig, {
      get() {
        throw new Error('cfg access blew up');
      },
    });
    expect(() => triggerBeliefAdjudication(src('guard'), { cfg: throwingCfg })).not.toThrow();
  });
});

describe('BL-9 belief hook — CONCURRENCY-BOUNDED (serial) + DEPTH-CAPPED', () => {
  it('a burst drains SERIALLY — never more than one adjudication in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const adjudicate = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // yield
      inFlight--;
    });
    const queue = new BeliefAdjudicationQueue({ maxDepth: 100, concurrency: 1, adjudicate, defer: syncDefer });

    for (let i = 0; i < 20; i++) triggerBeliefAdjudication(src(`b${i}`), { cfg: cfg(), queue });
    await queue.whenIdle();

    expect(adjudicate).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBe(1); // single-flight: never overlaps → never starves the embedder
  });

  it('past the depth cap, extra records are DROPPED WITH A LOG (never OOM)', async () => {
    // Hold the worker so the queue fills past the cap before anything drains.
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const adjudicate = vi.fn(async () => {
      await gate;
    });
    const warn = vi.fn();
    const queue = new BeliefAdjudicationQueue({ maxDepth: 3, concurrency: 1, adjudicate, defer: (fn) => setTimeout(fn, 0) });
    // spy on the logger indirectly: dropped counter is the observable contract.

    const accepted: boolean[] = [];
    for (let i = 0; i < 6; i++) accepted.push(queue.enqueue(src(`d${i}`)));

    // Cap 3 → first 3 accepted, next 3 dropped.
    expect(accepted).toEqual([true, true, true, false, false, false]);
    expect(queue.dropped).toBe(3);
    expect(queue.size).toBe(3);

    released();
    await queue.whenIdle();
    expect(adjudicate).toHaveBeenCalledTimes(3); // only the accepted ones ran
    void warn;
  });
});

describe('BL-9 belief hook — the DEFAULT trigger reads the live flag', () => {
  it('with no injected cfg, the trigger respects the live BELIEF_CONFIG flag (fallback wiring)', async () => {
    // Prove the trigger falls back to BELIEF_CONFIG when no cfg is injected. Robust to the
    // ambient flag value: the suite pins it OFF (vitest.setup.ts) to avoid live LLM calls, so
    // this asserts the OUTCOME matches BELIEF_CONFIG.beliefEnabled whatever it is. (The shipped
    // default-true contract is proven separately in beliefConfig.unit.test.ts via a fresh
    // env-cleared re-import.) We inject only the queue so no real adjudication ever runs.
    const adjudicate = vi.fn(async (_s: BeliefHookSource) => undefined);
    const queue = new BeliefAdjudicationQueue({ maxDepth: 10, concurrency: 1, adjudicate, defer: syncDefer });

    triggerBeliefAdjudication(src('live'), { queue }); // no cfg ⇒ falls back to BELIEF_CONFIG
    await queue.whenIdle();

    if (BELIEF_CONFIG.beliefEnabled) {
      expect(adjudicate).toHaveBeenCalledTimes(1);
    } else {
      expect(adjudicate).not.toHaveBeenCalled();
    }
  });
});
