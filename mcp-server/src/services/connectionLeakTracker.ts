import type { PoolClient } from 'pg';

/** Minimal slice of pg-pool's event surface the tracker listens to. */
export interface LeakTrackedPool {
  on(event: 'acquire' | 'release' | 'remove', listener: (...args: any[]) => void): unknown;
}

/** Default age (ms) a checked-out client may stay out before it is reported as a leak. */
export const DEFAULT_CONNECTION_LEAK_THRESHOLD_MS = 60000;

/**
 * Tracks clients that are currently CHECKED OUT of a pg pool.
 *
 * Keyed by the client itself: pg-pool reuses the same client object across checkouts, so a
 * re-acquire overwrites its single entry instead of adding another. An entry is forgotten
 * when the client is released back to the pool (`release`) or destroyed (`remove`) — an
 * idle pooled connection is not a leak.
 */
export class ConnectionLeakTracker {
  private readonly checkedOut = new Map<PoolClient, number>();
  private readonly ids = new WeakMap<PoolClient, number>();
  private nextLabel = 1;

  constructor(private readonly thresholdMs: number = DEFAULT_CONNECTION_LEAK_THRESHOLD_MS) {}

  attach(pool: LeakTrackedPool): void {
    pool.on('acquire', (client: PoolClient) => this.checkedOut.set(client, Date.now()));
    pool.on('release', (_err: unknown, client: PoolClient) => this.checkedOut.delete(client));
    pool.on('remove', (client: PoolClient) => this.checkedOut.delete(client));
  }

  get size(): number {
    return this.checkedOut.size;
  }

  clear(): void {
    this.checkedOut.clear();
  }

  /** Human-readable descriptions of clients checked out longer than the threshold. */
  findLeaks(now: number = Date.now()): string[] {
    const leaks: string[] = [];
    for (const [client, since] of this.checkedOut) {
      const duration = now - since;
      if (duration > this.thresholdMs) {
        leaks.push(`Connection ${this.label(client)} active for ${Math.round(duration / 1000)}s`);
      }
    }
    return leaks;
  }

  private label(client: PoolClient): string {
    let n = this.ids.get(client);
    if (n === undefined) {
      n = this.nextLabel++;
      this.ids.set(client, n);
    }
    return `client-${n}`;
  }
}
