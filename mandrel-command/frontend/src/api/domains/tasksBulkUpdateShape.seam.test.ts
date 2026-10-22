/**
 * `api.tasks.bulkUpdate` PUTS THE ROUTE'S SHAPE ON THE WIRE (part 3).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * This client posted `{ ids, updates: {...} }` — one field set applied to many ids, copied
 * by analogy from `contexts.bulkUpdate`, whose route genuinely takes that. `POST
 * /tasks/bulk-update` does not: it requires a per-item array and answers the object form
 * with `400 Updates must be an array`. MEASURED end to end before the fix — an adapter
 * capture here produced exactly
 *
 *     {"ids":["task-1","task-2"],"updates":{"status":"completed"}}
 *
 * and that literal object, handed to the REAL controller in
 * `backend/src/__tests__/bulkUpdateWireContract.test.ts`, returned 400 with the service
 * never called. Nothing in the type system saw it: the old signature typechecked, because
 * a request body's agreement with its route is not a fact TypeScript holds.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE ASSERTS THE BYTES AND NOT THE SIGNATURE
 * ════════════════════════════════════════════════════════════════════════════════════
 * A signature test would have been green through the entire life of the bug. The wire body
 * is the only artifact the route ever sees, so it is the only artifact worth pinning. The
 * adapter here is a CAPTURE POINT, not a mock server — it records the outgoing config and
 * returns a thin envelope; it never answers a question the client asked it (the same
 * technique, and the same reason, as `scopePassthrough.seam.test.ts` next door).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE POPULATION, AND ITS LIMIT, STATED
 * ════════════════════════════════════════════════════════════════════════════════════
 * One method — `tasks.bulkUpdate` — because one method is what the defect was in. The
 * OTHER half of the contract (that the route accepts these bytes and rejects the old ones)
 * cannot be asserted from this package: the frontend is a browser bundle and the backend is
 * a separate CommonJS service, so the two ends are pinned by two files, named in each
 * other's headers. That is the limit of this guard and it is written down rather than
 * implied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../index';
import { apiClient } from '../../services/api';

const captured: InternalAxiosRequestConfig[] = [];
let originalAdapter: unknown;

beforeAll(() => {
  const instance = apiClient.instance;
  originalAdapter = instance.defaults.adapter;
  instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    captured.push(config);
    return {
      data: { success: true, data: { updated: 0 } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient.instance.defaults.adapter = originalAdapter as any;
});

beforeEach(() => {
  captured.length = 0;
});

/** The parsed body of the last request the client actually issued. */
const sentBody = (): Record<string, unknown> => {
  const raw = captured.at(-1)?.data;
  expect(raw, 'no request was captured — the client never reached the adapter').toBeDefined();
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
};

describe('tasks.bulkUpdate wire shape', () => {
  it('posts to /tasks/bulk-update', async () => {
    await api.tasks.bulkUpdate([{ id: 't1', status: 'completed' }]);
    expect(captured.at(-1)?.url).toBe('/tasks/bulk-update');
  });

  it('sends `updates` as a PER-ITEM ARRAY, each item carrying id AND status', async () => {
    await api.tasks.bulkUpdate([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'in_progress' },
    ]);

    const body = sentBody();
    expect(
      Array.isArray(body.updates),
      'the route rejects a non-array `updates` with 400 "Updates must be an array"'
    ).toBe(true);
    expect(body.updates).toEqual([
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'in_progress' },
    ]);
    for (const item of body.updates as Array<Record<string, unknown>>) {
      // The route's second check: "Each update must have id and status".
      expect(item.id).toBeTruthy();
      expect(item.status).toBeTruthy();
    }
  });

  it('sends NO top-level `ids` key — that was the old, rejected shape', async () => {
    await api.tasks.bulkUpdate([{ id: 't1', status: 'completed' }]);
    expect(sentBody()).not.toHaveProperty('ids');
  });

  it('an EMPTY batch still sends a well-formed body (the empty population)', async () => {
    await api.tasks.bulkUpdate([]);
    expect(sentBody()).toEqual({ updates: [] });
  });

  it('surfaces `skipped` rather than swallowing it', async () => {
    // A task held by a live claim is NOT moved and the route says so. A
    // client that returned only `updated` would re-hide what that change exists to reveal.
    const instance = apiClient.instance;
    const saved = instance.defaults.adapter;
    instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => ({
      data: { success: true, data: { updated: 1, skipped: [{ id: 't2', reason: 'claimed' }] } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    try {
      const out = await api.tasks.bulkUpdate([
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'completed' },
      ]);
      expect(out).toEqual({ updated: 1, skipped: [{ id: 't2', reason: 'claimed' }] });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.defaults.adapter = saved as any;
    }
  });
});
