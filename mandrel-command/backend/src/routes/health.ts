/**
 * TR009-4: Enhanced Health Check Routes
 */

import v8 from 'v8';
import { Router, Request, Response } from 'express';
import { getDatabaseStatus, getVersion } from '../controllers/healthController';
import { backendPool } from '../database/poolManager';
import { config } from '../config/environment';
import { authenticateToken } from '../middleware/auth';
import { declareIntentionallyUnauthenticated } from '../middleware/authz';

const router = Router();
const startTime = Date.now();

const BYTES_PER_MB = 1024 * 1024;

export interface MemoryCheck {
  status: 'up' | 'down';
  heapUsed: string;
  heapLimit: string;
  utilization: string;
}

/**
 * Evaluate the memory-pressure health signal.
 *
 * The denominator is V8's REAL max-old-space ceiling (heap_size_limit), NOT the
 * lazily-grown heapTotal. heapTotal is only the heap V8 has ALLOCATED SO FAR — right
 * after a restart it is roughly equal to heapUsed (~32MB), so heapUsed/heapTotal is
 * ~0.95 on a perfectly healthy small process and was falsely reporting "down" (503).
 * heap_size_limit is the actual OOM ceiling (robust whether or not
 * --max-old-space-size is set), so heapUsed/heapLimit only approaches 1.0 when the
 * process is genuinely near exhaustion — a real, 503-worthy readiness signal.
 *
 * @param heapUsedBytes  process heapUsed in bytes
 * @param heapLimitBytes V8 heap_size_limit in bytes (the real ceiling)
 * @param threshold      fraction of the ceiling at/above which we report "down"
 */
export function evaluateMemoryCheck(
  heapUsedBytes: number,
  heapLimitBytes: number,
  threshold: number
): MemoryCheck {
  const heapUsedMb = heapUsedBytes / BYTES_PER_MB;
  const heapLimitMb = heapLimitBytes / BYTES_PER_MB;
  const ratio = heapLimitBytes > 0 ? heapUsedBytes / heapLimitBytes : 0;
  return {
    status: ratio > threshold ? 'down' : 'up',
    heapUsed: `${heapUsedMb.toFixed(2)} MB`,
    heapLimit: `${heapLimitMb.toFixed(2)} MB`,
    utilization: `${(ratio * 100).toFixed(1)}%`
  };
}

/**
 * ── THE POLICY FOR THIS FAMILY (decided 2026-08-25) ────────────────────
 *
 * Two buckets, and which bucket a route is in is decided by WHO HAS TO REACH IT, not by
 * how sensitive it feels:
 *
 *   PUBLIC-AND-REDUCED — something with no credential must be able to call it, so it is
 *     stripped to a bare verdict instead of authenticated. Authenticating these breaks
 *     the deploy. MEASURED consumers, not assumed:
 *       docker-compose.yml                                    command-backend container healthcheck
 *         → `wget --spider http://localhost:5000/api/health`   (status code only)
 *       deploy and rollback smoke checks                      retry until 200 on .../api/health
 *     Every one of those reads the STATUS CODE and never the body, so reducing the body
 *     costs nothing and removes the recon.
 *     No in-tree consumer of the backend's own /healthz|/livez|/readyz was found; they are
 *     kept public anyway (an unknown external prober is likelier than an unknown reader of
 *     pool internals) and reduced instead.
 *
 *   AUTHENTICATED — nothing operational needs it without a credential, and it hands an
 *     attacker free reconnaissance: `/db-status` (postgres version + live pool internals)
 *     and `/version` (node version + NODE_ENV). These were 200-with-no-credential on prod
 *     and all 7 tenants.
 *
 * The general rule this encodes: a liveness endpoint is REDUCED, not authenticated — strip
 * it to up/down and the exposure disappears without breaking any prober.
 */

// AUTHENTICATED — infra metadata, no anonymous consumer.
router.get('/db-status', authenticateToken, getDatabaseStatus);
router.get('/version', authenticateToken, getVersion);

/**
 * PUBLIC-AND-REDUCED — the container healthcheck and the deploy smoke.
 *
 * Was `getHealth`, which returned `process.memoryUsage()` and `config.nodeEnv`. It answers
 * the same question with the same status code and none of the metadata. The controller is
 * left intact and is still exercised by healthController.test.ts.
 */
router.get(
  '/health',
  declareIntentionallyUnauthenticated(
    'the command-backend container healthcheck (docker-compose.yml) and the deploy smoke checks call this with no credential and read only the status code; body reduced to a bare verdict'
  ),
  (_req: Request, res: Response) => {
    res.json({ success: true, data: { status: 'healthy', timestamp: new Date().toISOString() } });
  }
);

// New standardized health check endpoints (TR009-4)

/**
 * Full health check - /healthz
 */
router.get('/healthz', declareIntentionallyUnauthenticated(
  'readiness prober with 200/503 semantics; reduced to per-check up/down so it carries no pool internals or heap figures'
), async (_req: Request, res: Response) => {
  const checks: any = {};

  // Database check.
  // REDUCED: `pool: getPoolStats()` used to ride along here — total/idle/waiting
  // connection counts, served to anyone. The verdict is `status`; the pool numbers were
  // never part of the answer, only next to it. Likewise the caught error's `.message`,
  // which can carry a host, a port, or a role name straight out of pg.
  try {
    const dbHealth = await backendPool.healthCheck();
    checks.database = { status: dbHealth.healthy ? 'up' : 'down' };
  } catch {
    checks.database = { status: 'down' };
  }

  // Memory check — compare heapUsed against V8's REAL max-old-space ceiling
  // (heap_size_limit), NOT the lazily-grown heapTotal. See evaluateMemoryCheck.
  const memUsage = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  // REDUCED: evaluateMemoryCheck still computes heapUsed/heapLimit/utilization
  // — healthzMemoryCheck.test.ts covers that logic unchanged — but only its VERDICT is
  // served. Absolute heap figures tell a prober how the process is provisioned.
  checks.memory = {
    status: evaluateMemoryCheck(memUsage.heapUsed, heapLimit, config.healthz.heapUtilThreshold)
      .status
  };

  const allHealthy = Object.values(checks).every((c: any) => c.status === 'up');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    checks
  });
});

/**
 * Liveness probe - /livez
 */
router.get('/livez', declareIntentionallyUnauthenticated(
  'process-liveness prober; returns only alive/uptime, no build, environment or resource detail'
), (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000)
  });
});

/**
 * Readiness probe - /readyz
 */
router.get('/readyz', declareIntentionallyUnauthenticated(
  'readiness prober with 200/503 semantics; returns only ready/not-ready'
), async (_req: Request, res: Response) => {
  try {
    const dbHealth = await backendPool.healthCheck();
    const ready = dbHealth.healthy;

    res.status(ready ? 200 : 503).json({
      ready,
      timestamp: new Date().toISOString(),
      database: dbHealth.healthy ? 'ready' : 'not ready'
    });
  } catch {
    // REDUCED: the raw error message went out over the wire. A pg connection
    // failure names the host, port and role. 503 is the whole answer.
    res.status(503).json({ ready: false, timestamp: new Date().toISOString() });
  }
});

export default router;
