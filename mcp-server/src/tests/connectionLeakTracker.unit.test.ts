/**
 * an earlier Task — idle released pool connections must not be reported as leaks.
 * Fake pool (EventEmitter) + fake clock; no DB.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import {
  ConnectionLeakTracker,
  DEFAULT_CONNECTION_LEAK_THRESHOLD_MS as T,
} from '../services/connectionLeakTracker.js';

const fakeClient = () => ({} as PoolClient);

describe('ConnectionLeakTracker', () => {
  let pool: EventEmitter;
  let tracker: ConnectionLeakTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new EventEmitter();
    tracker = new ConnectionLeakTracker();
    tracker.attach(pool);
  });
  afterEach(() => vi.useRealTimers());

  test('acquire then release, clock past threshold: zero leaks', () => {
    const c = fakeClient();
    pool.emit('acquire', c);
    pool.emit('release', undefined, c);
    vi.advanceTimersByTime(T * 3);
    expect(tracker.findLeaks()).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test('acquired and never released past threshold: still reported', () => {
    pool.emit('acquire', fakeClient());
    vi.advanceTimersByTime(T + 1000);
    expect(tracker.findLeaks()).toHaveLength(1);
  });

  test('not reported before the threshold', () => {
    pool.emit('acquire', fakeClient());
    vi.advanceTimersByTime(T - 1000);
    expect(tracker.findLeaks()).toEqual([]);
  });

  test('a reused client is tracked once and its age restarts on re-acquire', () => {
    const c = fakeClient();
    pool.emit('acquire', c);
    pool.emit('release', undefined, c);
    pool.emit('acquire', c);
    expect(tracker.size).toBe(1);
    pool.emit('acquire', c); // double acquire without release: still one entry
    expect(tracker.size).toBe(1);
    pool.emit('release', undefined, c);
    vi.advanceTimersByTime(T * 2);
    expect(tracker.findLeaks()).toEqual([]);
  });

  test('a released client does not mask a different leaked client', () => {
    const a = fakeClient();
    const b = fakeClient();
    pool.emit('acquire', a);
    pool.emit('acquire', b);
    pool.emit('release', undefined, a);
    vi.advanceTimersByTime(T + 1000);
    expect(tracker.findLeaks()).toHaveLength(1);
  });

  test('remove forgets the client', () => {
    const c = fakeClient();
    pool.emit('acquire', c);
    pool.emit('remove', c);
    expect(tracker.size).toBe(0);
  });
});
