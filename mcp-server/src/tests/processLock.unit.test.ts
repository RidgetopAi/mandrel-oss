import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Regression guard for the 2026-06-21 disk-full incident (part 2).
 *
 * When the disk hit 100%, the mcp-server's PID write to its singleton lock file was
 * truncated by ENOSPC, leaving a 0-byte lock file. On every subsequent startup the old
 * code read the empty pid, called process.kill(NaN, 0), and — because that does NOT
 * yield a clean ESRCH "stale" — concluded another instance was running →
 * singleton_lock_failed → crash-loop (83 restarts).
 *
 * These tests exercise processLock's acquire() against real temp lock files to prove the
 * hardened logic: invalid/corrupt contents are treated as stale and acquire SUCCEEDS,
 * a genuinely live PID still BLOCKS, a dead PID is reclaimed, and the pid file is written
 * atomically with a valid round-trippable value.
 *
 * Also guards the 2026-06-27 container-restart outage: a lock whose
 * pid is alive but whose stored start-time MISMATCHES the live /proc start-time (a pid
 * recycled across a container PID-namespace reset) is treated as STALE and reclaimed,
 * while a MATCHING start-time is a genuine singleton and BLOCKS. These two use an injected
 * start-time reader so they are deterministic (no dependency on a real recycled pid).
 *
 * NOTE on lock-file FORMAT: acquire() now writes `<pid> <startTime>` on Linux (where
 * /proc gives a start-time). Assertions that read a file written by acquire() therefore
 * compare the FIRST whitespace-separated token to the pid, not the whole line.
 *
 * Each test gets a FRESH module instance (vi.resetModules + dynamic import) with its own
 * AIDIS_LOCK_FILE, because processLock is a stateful singleton.
 */

/** First whitespace-separated token of a lock file = the pid. */
function lockPidToken(file: string): string {
  return fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0];
}

let tempDir: string;
let lockFile: string;

async function freshProcessLock() {
  vi.resetModules();
  const mod = await import('@/utils/processLock');
  return mod.processLock;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidis-processlock-'));
  lockFile = path.join(tempDir, 'aidis.pid');
  process.env.AIDIS_LOCK_FILE = lockFile;
  // We register exit/signal handlers in acquire(); disable the SIG handlers so the test
  // process isn't littered with listeners across the many fresh instances.
  process.env.AIDIS_DISABLE_PROCESS_EXIT_HANDLERS = 'true';
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.AIDIS_LOCK_FILE;
  delete process.env.AIDIS_DISABLE_PROCESS_EXIT_HANDLERS;
});

describe('processLock singleton hardening (disk-full poison-pill class)', () => {
  it('(a) EMPTY lock file (the exact incident) is treated as stale and acquire SUCCEEDS', async () => {
    // Simulate the ENOSPC poison-pill: a truncated 0-byte lock file.
    fs.writeFileSync(lockFile, '');

    const processLock = await freshProcessLock();
    expect(() => processLock.acquire()).not.toThrow();

    expect(processLock.isLocked()).toBe(true);
    // The lock file is now owned by THIS process (first token = our pid).
    expect(lockPidToken(lockFile)).toBe(String(process.pid));

    processLock.release();
  });

  it('(a2) whitespace-only lock file is treated as stale and acquire SUCCEEDS', async () => {
    fs.writeFileSync(lockFile, '   \n\t  ');

    const processLock = await freshProcessLock();
    expect(() => processLock.acquire()).not.toThrow();
    expect(processLock.isLocked()).toBe(true);
    expect(lockPidToken(lockFile)).toBe(String(process.pid));

    processLock.release();
  });

  it('(b) garbage / NaN contents are treated as stale and acquire SUCCEEDS', async () => {
    fs.writeFileSync(lockFile, 'not-a-pid-NaN-💥');

    const processLock = await freshProcessLock();
    expect(() => processLock.acquire()).not.toThrow();
    expect(processLock.isLocked()).toBe(true);
    expect(lockPidToken(lockFile)).toBe(String(process.pid));

    processLock.release();
  });

  it('(b2) zero / negative pid (process-GROUP footgun) is treated as stale and acquire SUCCEEDS', async () => {
    // process.kill(0, 0) and process.kill(-1, 0) do NOT throw (they target groups), so
    // a naive impl would mistake these for "alive" and refuse startup. They must parse
    // as invalid and be reclaimed.
    for (const poison of ['0', '-1']) {
      fs.writeFileSync(lockFile, poison);
      const processLock = await freshProcessLock();
      expect(() => processLock.acquire(), `pid="${poison}" should be reclaimed`).not.toThrow();
      expect(processLock.isLocked()).toBe(true);
      expect(lockPidToken(lockFile)).toBe(String(process.pid));
      processLock.release();
    }
  });

  it('(c) lock file with a LIVE pid (this process) BLOCKS acquire', async () => {
    // Our own PID is unquestionably alive → must refuse and NOT steal the lock.
    fs.writeFileSync(lockFile, String(process.pid));

    const processLock = await freshProcessLock();
    expect(() => processLock.acquire()).toThrow(/already running|already acquired|Failed to acquire/i);

    // The original lock file must be left intact (not stolen / overwritten).
    expect(fs.readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
    expect(processLock.isLocked()).toBe(false);
  });

  it('(d) lock file with a definitely-dead pid is removed (stale) and acquire SUCCEEDS', async () => {
    // Find a PID that is not currently running. Probe upward from a high value.
    const deadPid = findDeadPid();
    fs.writeFileSync(lockFile, String(deadPid));

    const processLock = await freshProcessLock();
    expect(() => processLock.acquire()).not.toThrow();
    expect(processLock.isLocked()).toBe(true);
    // Reclaimed: file now holds our pid, not the dead one.
    expect(lockPidToken(lockFile)).toBe(String(process.pid));

    processLock.release();
  });

  it('(e) acquire writes an atomic, valid pid file that round-trips to process.pid', async () => {
    // No pre-existing lock file at all.
    expect(fs.existsSync(lockFile)).toBe(false);

    const processLock = await freshProcessLock();
    processLock.acquire();

    expect(fs.existsSync(lockFile)).toBe(true);
    // Round-trip: first token parses back to exactly our pid (format `<pid> <startTime>`
    // on Linux, or bare `<pid>` where /proc is unavailable), no stray temp file left.
    expect(Number(lockPidToken(lockFile))).toBe(process.pid);
    expect(fs.existsSync(lockFile + '.tmp')).toBe(false);

    processLock.release();
    // release() cleans up the lock file because we own it.
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('(f) RECYCLED PID: alive pid but stored start-time MISMATCHES live → stale, reclaimed', async () => {
    // The 2026-06-27 outage: after a container restart the old holder pid (here we use
    // our own, definitely-alive pid) is signalable, but it is a DIFFERENT incarnation —
    // its start-time differs from what was stored at the original acquire. The old
    // pid-only logic returned a false "alive" and refused startup → 502 storm. The
    // start-time mismatch must now be detected as STALE and reclaimed.
    fs.writeFileSync(lockFile, `${process.pid} 111111`); // stored start-time = 111111

    const processLock = await freshProcessLock();
    // Deterministic: the live process's start-time reads as 999999 (≠ stored 111111).
    processLock._setStartTimeReader((pid) => (pid === process.pid ? '999999' : null));

    // Against the OLD pid-only logic this would THROW ("already running"); the fix
    // reclaims and succeeds — so this assertion is non-vacuous.
    expect(() => processLock.acquire()).not.toThrow();
    expect(processLock.isLocked()).toBe(true);

    // Reclaimed and rewritten with OUR pid + the (injected) live start-time.
    const parts = fs.readFileSync(lockFile, 'utf8').trim().split(/\s+/);
    expect(parts[0]).toBe(String(process.pid));
    expect(parts[1]).toBe('999999');

    processLock.release();
  });

  it('(g) GENUINE singleton: alive pid AND stored start-time MATCHES live → BLOCKS', async () => {
    // Same pid AND same start-time = the very same running process. This must still be
    // honored as a real singleton and refuse startup (we must not reclaim a live lock).
    fs.writeFileSync(lockFile, `${process.pid} 555555`); // stored start-time = 555555

    const processLock = await freshProcessLock();
    // Live start-time reads as 555555 — MATCHES the stored value → same incarnation.
    processLock._setStartTimeReader((pid) => (pid === process.pid ? '555555' : null));

    expect(() => processLock.acquire()).toThrow(/already running|Failed to acquire/i);

    // The live holder's lock is left intact (not stolen / overwritten).
    expect(fs.readFileSync(lockFile, 'utf8').trim()).toBe(`${process.pid} 555555`);
    expect(processLock.isLocked()).toBe(false);
  });

  it('release() only removes the lock when this instance owns it', async () => {
    // A foreign lock file we never acquired must survive a release() call.
    fs.writeFileSync(lockFile, String(process.pid));
    const processLock = await freshProcessLock();
    // Never acquired → not locked → release is a no-op on the file.
    processLock.release();
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(fs.readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
  });
});

/**
 * Return a PID that is not currently alive. Starts high (well above typical live PIDs)
 * and walks down until process.kill(pid, 0) reports ESRCH.
 */
function findDeadPid(): number {
  for (let pid = 4194304; pid > 1; pid -= 9973) {
    try {
      process.kill(pid, 0);
      // alive — keep searching
    } catch (err: any) {
      if (err?.code === 'ESRCH') {
        return pid;
      }
      // EPERM means it exists but we can't signal — also alive, keep searching.
    }
  }
  // Extremely unlikely fallback.
  return 4194303;
}
