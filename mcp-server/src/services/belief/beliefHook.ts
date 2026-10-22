/**
 * BELIEF POST-STORE HOOK (BL-9) — the LIVE ACTIVATION SEAM.
 *
 * This is the ONLY live caller of the belief adjudicator. After a context_store /
 * decision_record record is COMMITTED (with its embedding), the handler calls
 * `triggerBeliefAdjudication(source)` to run adjudicateNeighbourhood(source) in the
 * BACKGROUND, behind the `beliefEnabled` feature flag.
 *
 * ┌── THE FOUR NON-NEGOTIABLE PROPERTIES (spec BL-9 — this is the highest-stakes wiring) ──┐
 * │                                                                                        │
 * │ 1. FLAG-GATED — when cfg.beliefEnabled is false the trigger is a TOTAL no-op: nothing  │
 * │    is enqueued, no adjudication runs, no provider call, no cost. Env kill switch.      │
 * │                                                                                        │
 * │ 2. NON-BLOCKING — `triggerBeliefAdjudication` is SYNCHRONOUS and returns immediately.  │
 * │    It NEVER returns a promise the store could await, and the actual drain is deferred  │
 * │    to a later tick (setImmediate) so ZERO belief work runs on the caller's stack. The  │
 * │    user's store call is never delayed by belief work.                                  │
 * │                                                                                        │
 * │ 3. FAIL-SAFE — every path is wrapped. A throw in the trigger, the queue, or the        │
 * │    adjudication is CAUGHT and logged; it can NEVER break, delay, or change the store    │
 * │    result. The store is the priority; belief is best-effort.                           │
 * │                                                                                        │
 * │ 4. CONCURRENCY-BOUNDED + FORWARD-ONLY — a SINGLE-FLIGHT worker drains the queue         │
 * │    SERIALLY (honours cfg.adjudicatorConcurrency, locked at 1) so a burst of writes      │
 * │    processes belief work one-at-a-time and never spawns unbounded concurrent            │
 * │    adjudications that would starve the shared gemma embedder. The queue depth is        │
 * │    CAPPED (cfg.beliefQueueMaxDepth); a flood DROPS-with-log instead of OOM. Only NEW    │
 * │    writes call this — there is NO backfill here (see scripts/beliefBackfill.ts).        │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * QUEUE INFRA CHOICE (documented per spec): the repo HAS BullMQ (services/queueManager.ts,
 * Redis-backed) but it is initialized BEST-EFFORT (backgroundServices wraps getQueueManager
 * in a try/catch that only WARNS on failure) — Redis is effectively OPTIONAL, and the tenant
 * fleet is not guaranteed to run it. Backing a FAIL-SAFE-critical write-path hook on an
 * optional external service is the wrong trade: a Redis outage could hang enqueues
 * (maxRetriesPerRequest:null) or silently drop belief work with no local visibility, and
 * BullMQ's worker runs IN-PROCESS here anyway (no isolation benefit — the adjudicator shares
 * this box + the embedder regardless). So BL-9 uses a SELF-CONTAINED bounded in-process async
 * queue: zero external deps, cannot hang on a Redis outage, and gives EXACTLY the single-flight
 * + depth-cap + drop-with-log semantics the spec demands. Flagged for the coordinator in the return.
 */

import { BELIEF_CONFIG, SUPERSESSION_MODE, describeSupersessionMode } from '../../config/beliefConfig.js';
import type { BeliefConfig, SupersessionModeResolution } from '../../config/beliefConfig.js';
import type { EdgeNodeType } from '../../config/edgeTypes.js';
import { logger } from '../../utils/logger.js';
import { adjudicateNeighbourhood } from './beliefAdjudicator.js';
import { resolveArmableAdjudicationProvider } from './provider.js';

/** The minimal record identity the hook needs to adjudicate a freshly-stored record. */
export interface BeliefHookSource {
  id: string;
  type: EdgeNodeType;
  projectId: string | null;
  /** The record's own free-text content (contexts.content / decisions.rationale). */
  content: string;
  createdAt?: Date | string | null;
}

/** The adjudication function the queue drains with — injectable for tests (no live LLM). */
export type AdjudicateFn = (source: BeliefHookSource) => Promise<unknown>;

/**
 * A BOUNDED, SINGLE-FLIGHT, in-process async queue. One worker drains it SERIALLY; the depth
 * is capped and a flood is shed (drop-with-log). Every drain is fully wrapped so a single bad
 * adjudication can never break the loop or escape to a caller.
 */
export class BeliefAdjudicationQueue {
  private readonly queue: BeliefHookSource[] = [];
  private draining = false;
  private droppedCount = 0;
  private processedCount = 0;
  private readonly idleWaiters: Array<() => void> = [];

  private readonly maxDepth: number;
  private readonly adjudicate: AdjudicateFn;
  /** setImmediate by default; overridable in tests to control tick timing. */
  private readonly defer: (fn: () => void) => void;

  constructor(opts: {
    maxDepth: number;
    /** cfg.adjudicatorConcurrency — locked at 1; a single-flight worker honours it by construction. */
    concurrency: number;
    adjudicate: AdjudicateFn;
    defer?: (fn: () => void) => void;
  }) {
    // Depth must be a positive integer; fall back defensively so a bad config can't disable the cap.
    this.maxDepth = Number.isInteger(opts.maxDepth) && opts.maxDepth > 0 ? opts.maxDepth : 1000;
    // Concurrency is locked at 1 (design §4 + capacity recon): the adjudicator shares the box +
    // embedder, so belief work is SERIAL. A single-flight worker enforces this by construction;
    // we assert the contract loudly rather than silently honour a >1 that we don't implement.
    if (opts.concurrency !== 1) {
      logger.warn(
        `🧪 belief hook: adjudicatorConcurrency=${opts.concurrency} — the in-process queue is single-flight (serial). Values >1 are NOT parallelised here (would contend with the embedder; needs a dedicated box).`
      );
    }
    this.adjudicate = opts.adjudicate;
    this.defer = opts.defer ?? ((fn) => setImmediate(fn));
  }

  /**
   * NON-BLOCKING enqueue: pushes the source and kicks the deferred worker. Returns true if
   * accepted, false if DROPPED because the queue is at capacity (flood shedding). Never throws.
   */
  enqueue(source: BeliefHookSource): boolean {
    if (this.queue.length >= this.maxDepth) {
      this.droppedCount++;
      logger.warn(
        `🧪 belief hook: queue at cap (${this.maxDepth}) — DROPPING adjudication for ${source.type} ${source.id.slice(0, 8)} (dropped total: ${this.droppedCount}). Store already succeeded; belief is best-effort.`
      );
      return false;
    }
    this.queue.push(source);
    this.kick();
    return true;
  }

  /** Start the drain worker on a LATER tick if it isn't already running (single-flight). */
  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    // Deferred so the drain runs OFF the caller's stack — the store call has already returned.
    this.defer(() => {
      void this.drain();
    });
  }

  /**
   * The SERIAL drain loop. Processes one source at a time until the queue is empty. Each
   * adjudication is individually wrapped so a failure degrades to a skipped record, never
   * breaking the loop (belt-and-braces: adjudicateNeighbourhood is already fail-safe per-pair).
   */
  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const source = this.queue.shift()!;
        try {
          await this.adjudicate(source);
          this.processedCount++;
        } catch (e) {
          logger.warn(
            `🧪 belief hook: background adjudication for ${source.type} ${source.id.slice(0, 8)} failed — skipping (store unaffected)`,
            { metadata: { error: (e as Error)?.message } }
          );
        }
      }
    } finally {
      this.draining = false;
      // A record enqueued during the last await is caught by the while re-check above, so the
      // queue is empty here; the guard re-kicks only in the (theoretical) race where it isn't.
      if (this.queue.length > 0) {
        this.kick();
      } else {
        const waiters = this.idleWaiters.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  /** Current queued (not-yet-processed) depth. */
  get size(): number {
    return this.queue.length;
  }

  /** Total records dropped due to the depth cap (flood shedding) since construction. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Total records successfully adjudicated since construction. */
  get processed(): number {
    return this.processedCount;
  }

  /** Whether the worker is currently draining. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Resolves when the queue has fully drained (for tests + graceful shutdown). */
  whenIdle(): Promise<void> {
    if (!this.draining && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}

/**
 * The process-wide singleton queue, lazily built from BELIEF_CONFIG on first use. One queue
 * per process → one serial worker → the global concurrency bound the embedder needs.
 */
let defaultQueue: BeliefAdjudicationQueue | null = null;

/**
 * ARM STATE — has the adjudication provider been proven CONSTRUCTIBLE in this process?
 *. `unchecked` until the first record wants adjudicating.
 */
let armState: 'unchecked' | 'armed' | 'disarmed' = 'unchecked';

/**
 * THE ARM-TIME PROVIDER CHECK — "a feature that is off must be OFF, not attempting-and-failing"
 *.
 *
 * THE DEFECT THIS CLOSES. `beliefEnabled` defaults TRUE (beliefConfig.ts) and the adjudicator
 * provider defaults to 'anthropic', whose constructor THROWS when its API key env var is unset.
 * So an instance that is enabled but has no credential armed a hook that fired on EVERY store,
 * threw at provider construction inside adjudicateNeighbourhood, and lost the record's whole
 * candidate neighbourhood — leaving one WARN per record whose text ("store unaffected") reads
 * like reassurance. MEASURED on the tenant fleet 2026-08-28: 7 instances, 23 whole-neighbourhood
 * failures in a 6h window, ZERO successful adjudications, and no count anywhere went down.
 *
 * That state was cleared per-instance by an earlier decision (ON for prod + operator, honestly OFF for
 * the rest) and the tracked docker-compose.yml now defaults the tenant surface to false — but
 * BOTH of those are DEPLOYMENT-layer fixes. They hold for containers rendered from that compose
 * file and for nothing else: systemd prod, a bare `docker run` of the image, a dev process, and
 * any future deployment path still get the code default, which is still on-with-no-provider.
 * This is the CODE-layer fix, and it is the only one that covers every path.
 *
 * WHAT IT DOES: resolve the provider ONCE, before arming the queue. If it cannot be constructed,
 * log ONE ERROR naming the cause and DISARM permanently — subsequent stores are a total no-op,
 * exactly like the flag being off. The config is read at module load, so a credential cannot
 * appear without a restart; re-checking per record would only re-emit the same failure forever,
 * which is the shape being removed.
 *
 * WHY ERROR AND NOT WARN: the previous signal was a per-record WARN that said the store was
 * unaffected. It was true, and it is why nobody noticed for months. A feature that has been
 * asked for and cannot run is an operator-actionable ERROR, once, with the fix in the message.
 *
 * The attempt ledger is UNAFFECTED for instances that ARE armed: a provider that constructs and
 * then fails at call time still books its `provider` / `provider_init` failures exactly as before.
 */
function beliefIsArmed(resolveProvider: () => unknown): boolean {
  if (armState === 'unchecked') {
    try {
      resolveProvider();
      armState = 'armed';
    } catch (e) {
      armState = 'disarmed';
      logger.error(
        '🧪 belief hook: DISARMED — belief adjudication is ENABLED on this instance but its ' +
          'adjudication provider CANNOT BE CONSTRUCTED, so no record can ever be adjudicated. ' +
          'Every store would otherwise fire the hook and lose its whole candidate neighbourhood ' +
          'with only a reassuring per-record warning. The hook is now a no-op for the life of ' +
          'this process. FIX: either supply the provider credential, or set ' +
          'MANDREL_BELIEF_ENABLED=false so the feature is honestly off. ' +
          `Cause: ${(e as Error)?.message}`,
        undefined,
        { metadata: { error: (e as Error)?.message } }
      );
    }
  }
  return armState === 'armed';
}

/**
 * STARTUP POSTURE: call once at server start. Supersession OFF because the
 * operator left MANDREL_BELIEF_ENABLED unset and no credential exists ⇒ ONE info line saying so and
 * naming the env var that enables it (no ERROR, ever, on any store). Enabled ⇒ arm the hook NOW so
 * a bad configuration (e.g. tiered without a tier-1 key) errors once at startup, not at first store.
 * An explicit false is the operator's choice and needs no nagging.
 */
export function logBeliefStartupPosture(
  cfg: BeliefConfig = BELIEF_CONFIG,
  resolveProvider: () => unknown = resolveArmableAdjudicationProvider,
  mode: SupersessionModeResolution = SUPERSESSION_MODE
): void {
  if (cfg.beliefEnabled) {
    // ONE line naming the mode and why (key variable NAMES only, never a value), then arm now.
    logger.info(describeSupersessionMode(mode));
    beliefIsArmed(resolveProvider);
    return;
  }
  if (cfg.beliefEnabledExplicit) return;
  logger.info(
    `${describeSupersessionMode(mode)}. Supersession is OFF (no adjudicator credential found). To enable it set ` +
      'SUBQ_API_KEY and/or ANTHROPIC_API_KEY (or MANDREL_BELIEF_ENABLED=true with a configured provider).'
  );
}

/** Test-only reset of the arm state (it is process-wide and deliberately sticky). */
export function __resetBeliefArmStateForTest(): void {
  armState = 'unchecked';
}

/** Test-only read of the arm state. */
export function __getBeliefArmStateForTest(): 'unchecked' | 'armed' | 'disarmed' {
  return armState;
}

function getDefaultQueue(cfg: BeliefConfig): BeliefAdjudicationQueue {
  if (!defaultQueue) {
    defaultQueue = new BeliefAdjudicationQueue({
      maxDepth: cfg.beliefQueueMaxDepth,
      concurrency: cfg.adjudicatorConcurrency,
      adjudicate: (source) =>
        adjudicateNeighbourhood({
          id: source.id,
          type: source.type,
          projectId: source.projectId,
          content: source.content,
          createdAt: source.createdAt ?? null,
        }),
    });
  }
  return defaultQueue;
}

/** Test-only handle to the live singleton (or null if never built). */
export function __getDefaultBeliefQueueForTest(): BeliefAdjudicationQueue | null {
  return defaultQueue;
}

/** Test-only reset of the singleton so a test can inject a fresh/fake queue. */
export function __resetDefaultBeliefQueueForTest(): void {
  defaultQueue = null;
}

/**
 * THE PUBLIC POST-STORE HOOK. Call this AFTER a context/decision record is committed with its
 * embedding. SYNCHRONOUS + NON-BLOCKING + FAIL-SAFE + FLAG-GATED — never awaited by the store,
 * never throws into the store path. `deps` is for tests (inject a fake cfg / queue — no live LLM).
 */
export function triggerBeliefAdjudication(
  source: BeliefHookSource,
  deps?: {
    cfg?: BeliefConfig;
    queue?: BeliefAdjudicationQueue;
    /** Test seam for the arm gate: resolve (or fail to resolve) the adjudication provider. */
    resolveProvider?: () => unknown;
  }
): void {
  // OUTERMOST FAIL-SAFE: the entire body is wrapped. Nothing here — a bad cfg, a queue build
  // error, an enqueue throw — can ever propagate to the store handler that called us.
  try {
    const cfg = deps?.cfg ?? BELIEF_CONFIG;

    // FLAG GATE: off ⇒ total no-op. No enqueue, no adjudication, no provider call, no cost.
    if (!cfg.beliefEnabled) return;

    // ARM GATE: enabled-but-unable is not enabled. Checked ONCE per process,
    // and only on the DEFAULT queue path — an injected queue brings its own adjudicate fn and
    // never reaches getAdjudicationProvider, so gating it on the real provider would make the
    // injection point untestable without a credential.
    // An injected queue brings its own adjudicate fn and never reaches getAdjudicationProvider,
    // so the gate is skipped for it — UNLESS the caller explicitly supplies a resolver, which is
    // how the gate itself is tested without a live credential.
    const mustArm = deps?.resolveProvider !== undefined || !deps?.queue;
    if (mustArm && !beliefIsArmed(deps?.resolveProvider ?? resolveArmableAdjudicationProvider)) return;

    const queue = deps?.queue ?? getDefaultQueue(cfg);
    queue.enqueue(source);
  } catch (e) {
    try {
      logger.warn('🧪 belief hook: triggerBeliefAdjudication guard caught an error (store unaffected)', {
        metadata: { error: (e as Error)?.message },
      });
    } catch {
      /* never let logging failure escape either */
    }
  }
}
