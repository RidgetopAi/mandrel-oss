/**
 * an earlier Task — /healthz memory check calibration.
 *
 * Regression guard for the mis-calibrated memory health check: the old code used
 * heapUsed/heapTotal, and heapTotal (V8's lazily-grown, currently-allocated heap) is
 * ~= heapUsed right after restart, so a perfectly healthy small-heap process reported
 * >0.9 utilization -> checks.memory "down" -> /api/healthz 503 "unhealthy".
 *
 * The fix compares heapUsed against V8's REAL ceiling (heap_size_limit). These tests
 * assert a normal process is "up"/200, a genuinely near-limit heap is "down"/503, and
 * (mutation-check) that reverting to the heapTotal denominator would fail the healthy
 * case.
 */
import request from 'supertest';
import express from 'express';
import v8 from 'v8';

// Mock the DB pool so /healthz's database check is deterministically healthy and no
// real Postgres connection is required (pure unit test).
jest.mock('../database/poolManager', () => ({
  backendPool: {
    healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
  },
  getPoolStats: jest.fn().mockReturnValue({ total: 1, idle: 1, waiting: 0 }),
}));

import healthRoutes, { evaluateMemoryCheck } from '../routes/health';
import { backendPool } from '../database/poolManager';

const app = express();
app.use('/api', healthRoutes);

const MB = 1024 * 1024;
const THRESHOLD = 0.9;

describe('evaluateMemoryCheck (heap_size_limit denominator)', () => {
  test('post-restart small heap (heapUsed ~= heapTotal) reports "up"', () => {
    // Real prod repro: heapUsed 30.99MB, real V8 ceiling ~2GB default.
    const heapUsed = 30.99 * MB;
    const heapLimit = 2048 * MB; // realistic default max-old-space ceiling
    const result = evaluateMemoryCheck(heapUsed, heapLimit, THRESHOLD);
    expect(result.status).toBe('up');
    expect(result.heapLimit).toBe('2048.00 MB');
    // ~1.5% of the real ceiling, nowhere near OOM
    expect(parseFloat(result.utilization)).toBeLessThan(5);
  });

  test('genuinely near the V8 ceiling reports "down"', () => {
    const heapLimit = 2048 * MB;
    const heapUsed = 0.95 * heapLimit; // 95% of the real ceiling -> imminent OOM
    const result = evaluateMemoryCheck(heapUsed, heapLimit, THRESHOLD);
    expect(result.status).toBe('down');
  });

  test('reported shape uses heapLimit (not heapTotal) and heapUsed', () => {
    const result = evaluateMemoryCheck(32 * MB, 2048 * MB, THRESHOLD);
    expect(result).toHaveProperty('heapUsed');
    expect(result).toHaveProperty('heapLimit');
    expect(result).toHaveProperty('utilization');
    expect(result).not.toHaveProperty('heapTotal');
  });

  test('MUTATION CHECK: the old heapTotal denominator would report the healthy process "down"', () => {
    // Simulate the ORIGINAL buggy formula: heapUsed / heapTotal, where post-restart
    // heapTotal ~= heapUsed. This proves the test actually distinguishes the fix.
    const heapUsed = 30.99 * MB;
    const heapTotal = 32.61 * MB; // real prod values -> 95% ratio
    const buggy = evaluateMemoryCheck(heapUsed, heapTotal, THRESHOLD);
    expect(buggy.status).toBe('down'); // the bug we fixed

    // Same heapUsed against the real ceiling is healthy.
    const fixed = evaluateMemoryCheck(heapUsed, 2048 * MB, THRESHOLD);
    expect(fixed.status).toBe('up');
  });
});

describe('GET /api/healthz (full endpoint, real process heap)', () => {
  test('a healthy process reports checks.memory.status "up" and returns 200', async () => {
    // Sanity: the real running test process is nowhere near its V8 ceiling.
    const memUsage = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    expect(memUsage.heapUsed / heapLimit).toBeLessThan(THRESHOLD);

    const response = await request(app).get('/api/healthz').expect(200);
    expect(response.body).toHaveProperty('status', 'healthy');
    expect(response.body.checks.memory.status).toBe('up');
    expect(response.body.checks.database.status).toBe('up');
    // CHANGED 2026-08-25. `evaluateMemoryCheck` still COMPUTES
    // heapUsed/heapLimit/utilization — the unit tests above are untouched and still pin
    // that the denominator is heapLimit, not heapTotal — but /healthz is reachable with no
    // credential, so only the VERDICT is served. Absolute heap figures told any prober how
    // the process is provisioned. This assertion is inverted rather than deleted so that
    // re-adding the figures to the wire is RED.
    expect(response.body.checks.memory).not.toHaveProperty('heapLimit');
    expect(response.body.checks.memory).not.toHaveProperty('heapUsed');
    expect(response.body.checks.memory).not.toHaveProperty('utilization');
    expect(Object.keys(response.body.checks.memory)).toEqual(['status']);
    expect(response.body.checks.database).not.toHaveProperty('pool');
    // response shape stability
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('uptime');
    expect(backendPool.healthCheck).toHaveBeenCalled();
  });
});
