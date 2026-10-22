/**
 * Unit tests for the standard API response envelope helpers (utils/apiResponse.ts),
 * an earlier task (code-health dedup).
 *
 * These lock the envelope shape that the inline route code produced BEFORE the extraction,
 * so the dedup is provably behavior-preserving: same keys, same order, `timestamp` last,
 * same status codes, same error-message derivation + fallback. A fake Express Response
 * records exactly what each helper emitted — no live server needed.
 */

import type { Response } from 'express';
import { sendSuccess, sendError } from '../utils/apiResponse';

type Body = Record<string, unknown>;

/** Minimal fake Response that records status + the json body it was handed. */
function fakeRes(): {
  res: Response;
  statusCode: number | null;
  body: Body;
} {
  const rec: { statusCode: number | null; body: Body } = { statusCode: null, body: {} };
  const res = {
    status(code: number) {
      rec.statusCode = code;
      return this;
    },
    json(payload: Body) {
      rec.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, get statusCode() { return rec.statusCode; }, get body() { return rec.body; } };
}

describe('apiResponse envelope helpers', () => {
  describe('sendSuccess', () => {
    it('emits { success:true, data, timestamp } with timestamp last', () => {
      const f = fakeRes();
      sendSuccess(f.res, [{ a: 1 }]);
      expect(f.body.success).toBe(true);
      expect(f.body.data).toEqual([{ a: 1 }]);
      expect(typeof f.body.timestamp).toBe('string');
      // exact shape + key order (timestamp last) — matches the inline form it replaced
      expect(Object.keys(f.body)).toEqual(['success', 'data', 'timestamp']);
      // sendSuccess does NOT set a status → default 200 path (res.status untouched)
      expect(f.statusCode).toBeNull();
    });

    it('spreads extra sibling fields (e.g. count) BEFORE timestamp', () => {
      const f = fakeRes();
      sendSuccess(f.res, ['x', 'y'], { count: 2 });
      expect(f.body).toMatchObject({ success: true, data: ['x', 'y'], count: 2 });
      expect(Object.keys(f.body)).toEqual(['success', 'data', 'count', 'timestamp']);
    });
  });

  describe('sendError', () => {
    it('defaults to status 500 with { success:false, error, timestamp }', () => {
      const f = fakeRes();
      sendError(f.res, new Error('boom'));
      expect(f.statusCode).toBe(500);
      expect(f.body).toMatchObject({ success: false, error: 'boom' });
      expect(Object.keys(f.body)).toEqual(['success', 'error', 'timestamp']);
    });

    it('honors an explicit status + fallback (e.g. 404 / Service not found)', () => {
      const f = fakeRes();
      // a non-Error value → the fallback message is used (mirrors `instanceof Error` check)
      sendError(f.res, 'not-an-error', 404, 'Service not found');
      expect(f.statusCode).toBe(404);
      expect(f.body.error).toBe('Service not found');
    });

    it('uses the default fallback for a non-Error at the default status', () => {
      const f = fakeRes();
      sendError(f.res, { weird: true });
      expect(f.statusCode).toBe(500);
      expect(f.body.error).toBe('Unknown error');
    });
  });
});
