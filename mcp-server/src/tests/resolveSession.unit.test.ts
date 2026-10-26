/**
 * resolveSession — PURE branch unit tests (Sessions Foundation Phase 2a).
 * NO DB, NO network — every port is a stub so each precedence branch is
 * exercised in isolation.
 *
 * Locks the ONE resolver's contract (the auditor review §4.1 / §5):
 *   (a) explicit session id (verified open, ANY actor) wins;
 *   (b) else the actor's DB pin (only if still open);
 *   (c) else the actor's newest open session — automation actors restricted to the same UTC day;
 *   (d) else the lazy-create signal;
 *   and the HARD RULE: NO global fallback — an actor with nothing open resolves to lazy-create,
 *   never to "some other session".
 */

import { describe, expect, it, vi } from 'vitest';
import {
  resolveSession,
  type ResolveSessionPorts,
} from '../services/session/domain/lifecycle/resolveSession.js';

/** Build ports with sensible "nothing found" defaults; override per test. */
function makePorts(overrides: Partial<ResolveSessionPorts> = {}): ResolveSessionPorts {
  return {
    existsActive: vi.fn(async () => false),
    getPin: vi.fn(async () => null),
    newestOpenForActor: vi.fn(async () => null),
    classify: vi.fn(() => 'agent' as const),
    ...overrides,
  };
}

const SID_EXPLICIT = '11111111-1111-1111-1111-111111111111';
const SID_PIN = '22222222-2222-2222-2222-222222222222';
const SID_NEWEST = '33333333-3333-3333-3333-333333333333';

describe('resolveSession precedence (a) explicit session id', () => {
  it('resolves an explicit OPEN session id (any actor), ahead of pin/newest', async () => {
    const ports = makePorts({
      existsActive: vi.fn(async (id) => id === SID_EXPLICIT),
      getPin: vi.fn(async () => ({ sessionId: SID_PIN })),
      newestOpenForActor: vi.fn(async () => SID_NEWEST),
    });
    const r = await resolveSession('coordinator', SID_EXPLICIT, ports);
    expect(r).toEqual({ source: 'explicit', sessionId: SID_EXPLICIT });
    // Pin/newest never consulted — explicit short-circuits.
    expect(ports.getPin).not.toHaveBeenCalled();
    expect(ports.newestOpenForActor).not.toHaveBeenCalled();
  });

  it('resolves an explicit id even with NO actor (explicit = user intent, cross-actor)', async () => {
    const ports = makePorts({ existsActive: vi.fn(async (id) => id === SID_EXPLICIT) });
    const r = await resolveSession(null, SID_EXPLICIT, ports);
    expect(r).toEqual({ source: 'explicit', sessionId: SID_EXPLICIT });
  });

  it('falls through when the explicit id is NOT open (stale/closed id is not resurrected)', async () => {
    const ports = makePorts({
      existsActive: vi.fn(async () => false), // explicit not open, pin not open
      newestOpenForActor: vi.fn(async () => SID_NEWEST),
    });
    const r = await resolveSession('coordinator', SID_EXPLICIT, ports);
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_NEWEST });
  });
});

describe('resolveSession precedence (b) actor pin', () => {
  it('resolves the actor pin when the pinned session is open', async () => {
    const ports = makePorts({
      getPin: vi.fn(async () => ({ sessionId: SID_PIN })),
      existsActive: vi.fn(async (id) => id === SID_PIN),
      newestOpenForActor: vi.fn(async () => SID_NEWEST),
    });
    const r = await resolveSession('coordinator', undefined, ports);
    expect(r).toEqual({ source: 'pin', sessionId: SID_PIN });
    expect(ports.newestOpenForActor).not.toHaveBeenCalled();
  });

  it('ignores a STALE pin (pinned session closed) and falls to newest-open', async () => {
    const ports = makePorts({
      getPin: vi.fn(async () => ({ sessionId: SID_PIN })),
      existsActive: vi.fn(async () => false), // pin no longer open
      newestOpenForActor: vi.fn(async () => SID_NEWEST),
    });
    const r = await resolveSession('coordinator', undefined, ports);
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_NEWEST });
  });
});

describe('resolveSession precedence (c) newest open for actor', () => {
  it('resolves the actor newest-open when no explicit/pin', async () => {
    const ports = makePorts({ newestOpenForActor: vi.fn(async () => SID_NEWEST) });
    const r = await resolveSession('coordinator', undefined, ports);
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_NEWEST });
  });

  it('AUTOMATION actor → queries newest-open with sameUtcDayOnly=TRUE (daily rollover)', async () => {
    const newestOpenForActor = vi.fn(async () => SID_NEWEST);
    const ports = makePorts({
      classify: vi.fn(() => 'automation' as const),
      newestOpenForActor,
    });
    const r = await resolveSession('tick', undefined, ports);
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_NEWEST });
    expect(newestOpenForActor).toHaveBeenCalledWith('tick', true);
  });

  it('HUMAN/AGENT actor → queries newest-open with sameUtcDayOnly=FALSE (no day limit)', async () => {
    const newestOpenForActor = vi.fn(async () => SID_NEWEST);
    const ports = makePorts({ classify: vi.fn(() => 'agent' as const), newestOpenForActor });
    await resolveSession('coordinator', undefined, ports);
    expect(newestOpenForActor).toHaveBeenCalledWith('coordinator', false);
  });
});

describe('resolveSession precedence (d) lazy-create + NO global fallback', () => {
  it('signals lazy-create when the actor has NOTHING open (never a global fallback)', async () => {
    const ports = makePorts(); // all defaults return nothing
    const r = await resolveSession('coordinator', undefined, ports);
    expect(r).toEqual({ source: 'lazy-create', sessionId: null });
  });

  it('signals lazy-create when NO actor and NO explicit id (never resolves someone else)', async () => {
    const ports = makePorts();
    const r = await resolveSession(undefined, undefined, ports);
    expect(r).toEqual({ source: 'lazy-create', sessionId: null });
    // With no actor, only an explicit id could resolve — pin/newest are never even queried.
    expect(ports.getPin).not.toHaveBeenCalled();
    expect(ports.newestOpenForActor).not.toHaveBeenCalled();
  });

  it('normalizes the actor before pin/newest lookups (equivalent strings collapse)', async () => {
    const getPin = vi.fn(async () => null);
    const newestOpenForActor = vi.fn(async () => null);
    const ports = makePorts({ getPin, newestOpenForActor });
    await resolveSession('  Builder ABC ', undefined, ports);
    expect(getPin).toHaveBeenCalledWith('builder-abc');
    expect(newestOpenForActor).toHaveBeenCalledWith('builder-abc', false);
  });
});
