/**
 * CONTRACT: utils/monitoring.ts owns three background intervals, and they must be (1) started
 * only when a caller asks, and (2) unable to hold a process open.
 *
 * WHY (an earlier task — one defect seen from two angles). The module used to call
 * startMonitoring() at module scope and never unref the timers it created. Two consequences,
 * both measured before this guard existed:
 *   - Any process that transitively imported the module started three timers it never asked
 *     for, one of which issues `db.query('SELECT 1')` every 60 seconds. In a test process that
 *     manufactures phantom DB calls against registry-wide spies; in a script it re-opens
 *     connections to a database the script has already closed.
 *   - Because the timers were ref'd, a short-lived script could not exit at all. It waited on
 *     handles it did not own and could not clear.
 *
 * WHAT THIS GUARD'S POPULATION IS, stated rather than implied: this file asserts about
 * `src/utils/monitoring.ts` ONLY. It is not a sweep of every timer in the package, and it will
 * not notice a new import-time interval in a different module. The reason it is scoped that way
 * is that the two properties are asserted by OBSERVING A PROCESS, and a per-module child process
 * is the only way to attribute the observation to one module.
 *
 * WHAT IT DOES NOT COVER: the third assertion below advances FAKE timers, so it proves the
 * intervals are still SCHEDULED with the intended callbacks and cadence. It does not prove they
 * fire against a real clock over a real interval period — a wall-clock observation is minutes
 * long and does not belong in a unit suite.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.resolve(HERE, '../../node_modules/.bin/tsx');
const CHILD = path.join(HERE, 'fixtures', 'monitoringLifecycleChild.ts');

/**
 * The child must be allowed enough time to be UNAMBIGUOUSLY hung rather than merely slow.
 * The shortest interval the module schedules is 30s, so a ref'd timer keeps a process alive
 * for at least that long; a healthy child completes in well under a second.
 */
const CHILD_TIMEOUT_MS = 20_000;

/**
 * getMetricStats() windows by wall clock, and these tests walk a fake clock forward by more
 * than its 5-minute default. The window is widened past every advance below so a sample can
 * only be missing because it was never recorded.
 */
const METRIC_WINDOW_MS = 3_600_000;

/**
 * How long the health-check callback is given on the REAL clock to finish the work it cannot
 * do on a fake one. Generous on purpose: its database probe runs without a database here and
 * must be allowed to fail, which is a connect timeout rather than an instant refusal.
 */
const HEALTH_CHECK_SETTLE_MS = 15_000;

interface ChildResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  fields: Record<string, string>;
}

function runChild(mode: 'import-only' | 'explicit-start'): ChildResult {
  // Logs to scratch, never the tree's own logs/ — one dir per call, removed immediately.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'monitoring-lifecycle-'));
  try {
    const res = spawnSync(TSX, [CHILD, mode], {
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        AIDIS_LOG_DIR: path.join(scratch, 'logs'),
      },
    });
    const stdout = res.stdout ?? '';
    const fields: Record<string, string> = {};
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return {
      status: res.status,
      signal: res.signal,
      stdout,
      stderr: res.stderr ?? '',
      fields,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Every assertion below reads a witness the child printed from INSIDE the run. A child that
 * failed to launch prints nothing, so `BODY_COMPLETE` is checked before any verdict is drawn
 * from an exit code — bash and node both emit a plausible-looking non-empty error on stderr,
 * and an exit code alone cannot tell "the module behaved" from "the module never loaded".
 */
function expectChildRan(res: ChildResult): void {
  expect(
    res.stdout,
    `child produced no completion witness. stderr:\n${res.stderr}`,
  ).toContain('BODY_COMPLETE');
}

describe('utils/monitoring.ts background timer lifecycle', () => {
  test('importing the module starts NOTHING', () => {
    const res = runChild('import-only');
    expectChildRan(res);

    expect(res.fields.STARTED).toBe('false');
    expect(res.fields.LOOP_HOLDING_TIMEOUTS).toBe('0');
  });

  test('a process that only imports the module exits on its own', () => {
    const res = runChild('import-only');
    expectChildRan(res);

    // A timeout kill arrives as signal SIGTERM with a null status; a clean return is status 0.
    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
  });

  test('a process that explicitly STARTS monitoring still exits on its own', () => {
    const res = runChild('explicit-start');
    expectChildRan(res);

    // The timers really are running in this child — that is what makes the exit meaningful.
    expect(res.fields.STARTED).toBe('true');

    // ...and none of them is a reason for the loop to stay alive. This is the unref assertion:
    // a ref'd interval appears in getActiveResourcesInfo(); an unref'd one does not.
    expect(res.fields.LOOP_HOLDING_TIMEOUTS).toBe('0');

    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
  });
});

describe('utils/monitoring.ts timers still do their work once started', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  /**
   * THE REGRESSION THIS EXISTS TO CATCH: an unref that also stops the work is a worse defect
   * than the hang it replaced, and it is invisible to every assertion above — a module that
   * scheduled nothing at all would pass all three of them.
   */
  test('startMonitoring() schedules the collection and health-check callbacks (control)', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const { monitoring, startMonitoring, stopMonitoring, isMonitoringStarted } =
      await import('../utils/monitoring.js');

    expect(
      isMonitoringStarted(),
      'the module auto-started on import — the import-time side effect is back',
    ).toBe(false);
    expect(monitoring.getMetricStats('process_uptime_seconds', METRIC_WINDOW_MS)).toBeNull();

    startMonitoring();
    try {
      // Past two ticks of the 30s system-metrics interval and one of the 60s health check.
      await vi.advanceTimersByTimeAsync(61_000);

      const uptime = monitoring.getMetricStats('process_uptime_seconds', METRIC_WINDOW_MS);
      expect(uptime, 'the 30s system-metrics interval never fired').not.toBeNull();
      expect(uptime!.count).toBeGreaterThanOrEqual(2);

      /**
       * The health-check callback opens with `await import('../config/database.js')`. That is
       * real module-loading I/O, not a timer, so a fake clock cannot carry it to completion —
       * the callback has demonstrably STARTED at this point but its body is still suspended.
       * Hand the clock back and wait for it on real time, which is the only thing that can
       * finish it. If the interval had never been scheduled at all, nothing lands and this
       * poll times out.
       */
      vi.useRealTimers();
      const deadline = Date.now() + HEALTH_CHECK_SETTLE_MS;
      let checked: string[] = [];
      while (Date.now() < deadline) {
        checked = monitoring.getSystemHealth().checks.map((c) => c.name).sort();
        if (checked.includes('memory') && checked.includes('process')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(checked, 'the 60s health-check interval never fired').toContain('memory');
      expect(checked).toContain('process');
      expect(checked, 'the health check never attempted the database probe').toContain('database');
    } finally {
      stopMonitoring();
    }

    expect(isMonitoringStarted()).toBe(false);
  });

  test('startMonitoring() is idempotent and stopMonitoring() clears what it started', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const { monitoring, startMonitoring, stopMonitoring } = await import('../utils/monitoring.js');

    startMonitoring();
    startMonitoring(); // a double boot must not double the timers
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      const afterOneTick = monitoring.getMetricStats('process_uptime_seconds', METRIC_WINDOW_MS);
      expect(afterOneTick!.count).toBe(1);
    } finally {
      stopMonitoring();
    }

    const countAtStop = monitoring.getMetricStats('process_uptime_seconds', METRIC_WINDOW_MS)!.count;
    await vi.advanceTimersByTimeAsync(310_000);
    expect(
      monitoring.getMetricStats('process_uptime_seconds', METRIC_WINDOW_MS)!.count,
      'a timer survived stopMonitoring()',
    ).toBe(countAtStop);
  });
});
