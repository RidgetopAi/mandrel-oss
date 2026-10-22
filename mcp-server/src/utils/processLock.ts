import fs from 'fs';
import path from 'path';
import process from 'process';
import { logger } from './logger.js';

const LOCK_FILE = process.env.AIDIS_LOCK_FILE || path.join(process.cwd(), 'aidis.pid');
// Temp suffix for the atomic write-then-rename of the pid file. Keeping it next to
// LOCK_FILE guarantees the rename is same-filesystem (atomic). Not a tunable knob —
// it is an implementation detail of the atomic-write, intentionally derived from
// LOCK_FILE so the AIDIS_LOCK_FILE override still fully governs the location.
const LOCK_FILE_TMP_SUFFIX = '.tmp';

/**
 * Parse the raw contents of a lock file into a usable PID.
 *
 * A lock file is only trustworthy if it contains a positive integer PID. Anything
 * else — empty string (the 2026-06-21 ENOSPC poison-pill), whitespace, NaN, 0,
 * negative numbers, or garbage — is an INVALID/corrupt lock that must be treated as
 * stale. Returning null signals "this lock is not trustworthy; remove it and proceed".
 *
 * Why positive-only matters: process.kill(0, sig) and process.kill(-1, sig) target
 * process GROUPS and do NOT throw, so a parsed value of 0 or negative would be
 * mistaken for a live process and falsely block startup. We reject them up front,
 * before ever calling process.kill.
 */
function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Require the contents to be EXACTLY a run of digits (optionally signed) so that
  // parseInt's lenient "123abc" => 123 behaviour can't smuggle a garbage file through.
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const pid = Number(trimmed);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

/**
 * The parsed content of a lock file. A lock file is `<pid> <startTime>` (current
 * format) or just `<pid>` (legacy / non-Linux, where no start-time is available).
 *
 * `startTime` is the Linux process start-time (field 22 `starttime` of
 * /proc/<pid>/stat, in clock jiffies) recorded AT ACQUIRE. It exists to disambiguate
 * a RECYCLED pid: inside a container the PID namespace resets on restart, so the old
 * holder's pid (e.g. 48) can be reassigned to a brand-new, genuinely-live process.
 * process.kill(48,0) then succeeds and the old pid-only logic falsely concluded "still
 * running" → singleton_lock_failed → 502 "no session" storm (incident 2026-06-27,
 * an earlier decision). The start-time is the kernel-assigned identity that does NOT
 * survive that reset, so a mismatch proves the pid was recycled → stale.
 *
 * `startTime` is null when we cannot disambiguate: a legacy single-`<pid>` lock, a
 * non-Linux host (no /proc), or an unreadable /proc entry. In that case we fall back
 * to pid-liveness (the prior behavior) — see isLockHolderAlive.
 */
interface LockFileContent {
  pid: number;
  startTime: string | null;
}

/**
 * Parse a lock file's raw contents into { pid, startTime }.
 *
 * Format is whitespace-separated: the first token is the pid (validated by
 * parseLockPid — positive integer only, rejecting the empty/0/negative/garbage
 * poison-pill class from the 2026-06-21 ENOSPC incident), the optional second token
 * is the start-time (a run of digits). A missing/garbage start-time becomes null so
 * an OLD single-`<pid>` lock written by a prior version still parses (backward
 * tolerant) — it just can't be disambiguated.
 *
 * Returns null for an untrustworthy lock (no valid pid) → caller reclaims it.
 */
function parseLockFile(raw: string): LockFileContent | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const pid = parseLockPid(parts[0]);
  if (pid === null) {
    return null;
  }
  const startTime =
    parts.length >= 2 && /^\d+$/.test(parts[1]) ? parts[1] : null;
  return { pid, startTime };
}

/**
 * Read a process's start-time = field 22 (`starttime`, in clock jiffies) of
 * /proc/<pid>/stat. This is the kernel-assigned, boot-relative birth time of the
 * process; combined with the pid it uniquely identifies a process incarnation and,
 * crucially, does NOT survive a PID-namespace reset (container restart) — which is
 * exactly what lets us detect a recycled pid.
 *
 * PARSING GOTCHA (handled here): field 2 is `comm` — the executable name wrapped in
 * parentheses — and it can itself contain spaces AND parentheses (e.g. "(my (weird)
 * proc)"). Splitting the whole line on whitespace would therefore mis-index every
 * field after comm. The robust parse is to find the LAST ')' (the close of comm),
 * take everything after it, and split THAT: the first post-')' token is field 3
 * (state), so field N lives at index (N - 3). starttime is field 22 → index 19.
 *
 * Returns null (never throws) when the start-time cannot be read: non-Linux host
 * (no /proc), the process vanished (ESRCH), permission denied, or a malformed stat
 * line. Null means "can't disambiguate" and the caller falls back to pid-liveness,
 * preserving cross-platform behavior on dev machines without /proc.
 */
function readProcStartTime(pid: number): string | null {
  try {
    // Cross-platform guard: no /proc (macOS/Windows dev) → can't disambiguate.
    if (!fs.existsSync('/proc')) {
      return null;
    }
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastParen = raw.lastIndexOf(')');
    if (lastParen === -1) {
      return null;
    }
    // Everything after the close of `comm`: token[0] = field 3 (state), so
    // field 22 (starttime) is at index 22 - 3 = 19.
    const fields = raw.slice(lastParen + 1).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^\d+$/.test(startTime)) {
      return null;
    }
    return startTime;
  } catch {
    // ENOENT (process gone), EACCES, or any read/parse failure → can't disambiguate.
    return null;
  }
}

class ProcessLock {
  private static instance: ProcessLock;
  private locked = false;

  /**
   * How we read a process's start-time. Defaults to the real /proc reader; overridable
   * ONLY as a deterministic test seam (see processLock.unit.test.ts recycled-PID cases)
   * so the recycled-pid logic can be pinned without depending on a real recycled pid.
   * Not a production tunable — production always uses readProcStartTime.
   */
  private startTimeReader: (pid: number) => string | null = readProcStartTime;

  private constructor() {}

  /**
   * @internal TEST-ONLY seam. Inject a deterministic start-time reader so unit tests
   * can simulate the PID-namespace-reset (recycled pid) condition without a real
   * recycled pid. Must be called before acquire().
   */
  _setStartTimeReader(fn: (pid: number) => string | null): void {
    this.startTimeReader = fn;
  }

  static getInstance(): ProcessLock {
    if (!ProcessLock.instance) {
      ProcessLock.instance = new ProcessLock();
    }
    return ProcessLock.instance;
  }

  /**
   * Acquire process lock to ensure singleton operation
   * Throws error if another instance is already running
   */
  acquire(): void {
    try {
      // Check if lock file exists
      if (fs.existsSync(LOCK_FILE)) {
        const raw = fs.readFileSync(LOCK_FILE, 'utf8');
        const existing = parseLockFile(raw);

        if (existing === null) {
          // INVALID/corrupt lock contents (empty/whitespace/NaN/<=0/garbage).
          // This is the ENOSPC poison-pill class: a truncated 0-byte pid file left
          // behind by a disk-full write. Never trustworthy → remove and proceed.
          logger.warn(
            `Removing invalid/corrupt lock file (contents: ${JSON.stringify(raw)})`,
          );
          fs.unlinkSync(LOCK_FILE);
        } else if (this.isLockHolderAlive(existing.pid, existing.startTime)) {
          // A real, live process (verified by pid AND start-time when available) owns
          // the lock → refuse to start.
          throw new Error(
            `AIDIS is already running with PID ${existing.pid}. Only one instance allowed.`,
          );
        } else {
          // Holder is not alive — dead pid, OR a recycled pid (same number, different
          // start-time, the container PID-namespace-reset case) → stale lock, reclaim.
          logger.warn(`Removing stale lock file for PID ${existing.pid}`);
          fs.unlinkSync(LOCK_FILE);
        }
      }

      // Create lock file with current PID (atomic write — see writeLockFile).
      this.writeLockFile();
      this.locked = true;
      
      logger.info(`✅ Process lock acquired (PID: ${process.pid})`);
      
      const disableExitHandlers = process.env.AIDIS_DISABLE_PROCESS_EXIT_HANDLERS === 'true';

      // Always release lock on normal process exit
      process.on('exit', () => this.release());

      if (!disableExitHandlers) {
        // SECURITY FIX: Only release lock, don't call process.exit()
        // Let main.ts handle graceful shutdown to avoid race conditions
        process.on('SIGINT', () => {
          logger.info('\n🔄 ProcessLock: Releasing lock on SIGINT...');
          this.release();
          // DO NOT call process.exit() - let main.ts handle shutdown
        });
        process.on('SIGTERM', () => {
          logger.info('\n🔄 ProcessLock: Releasing lock on SIGTERM...');
          this.release();
          // DO NOT call process.exit() - let main.ts handle shutdown
        });
        process.on('uncaughtException', (error) => {
          logger.error('❌ Uncaught Exception', error as Error);
          this.release();
          process.exit(1);
        });
        process.on('unhandledRejection', (reason, promise) => {
          logger.error('❌ Unhandled Rejection', undefined, { metadata: { promise, reason } });
          this.release();
          process.exit(1);
        });
      }

    } catch (error) {
      throw new Error(`Failed to acquire process lock: ${error}`);
    }
  }

  /**
   * Determine whether a process with the given (already-validated, positive integer)
   * PID is alive, using signal 0 (existence probe, sends no actual signal).
   *
   * Per-errno semantics, explicit so the empty/corrupt class can never crash-loop:
   *  - no throw          → process exists and is signalable by us → ALIVE.
   *  - EPERM             → a process with that PID exists but we lack permission to
   *                        signal it (owned by another user). It IS alive → ALIVE.
   *                        We must NOT steal a lock held by a live foreign process.
   *  - ESRCH             → no such process → STALE (caller removes the lock).
   *  - any other throw   → e.g. EINVAL / TypeError(ERR_INVALID_ARG_TYPE) /
   *                        RangeError from a bad pid the parser somehow let through.
   *                        We cannot prove the process is alive, so we fail SAFE for
   *                        availability and treat it as STALE (caller removes + proceeds).
   *
   * Defaulting the unknown-error case to STALE (not ALIVE) is the deliberate choice:
   * the incident was a crash-loop caused by a corrupt lock being read as "alive". A
   * false-stale at worst risks a second instance in a truly pathological case; a
   * false-alive guarantees the outage we just fixed. Disk-full crash-loop is the
   * worse failure, so we bias toward starting.
   */
  /**
   * Decide whether the recorded lock HOLDER is genuinely still alive, disambiguating a
   * recycled pid via its start-time. This is the real class-fix for the 2026-06-27
   * container-restart outage.
   *
   * Two-stage check:
   *  1. PID-liveness (isPidAlive): if the pid is not signalable (ESRCH / unexpected) it
   *     is unambiguously DEAD → stale. (EPERM = a live foreign process → alive; we never
   *     steal a lock held by another user's running process.)
   *  2. START-TIME disambiguation: the pid IS signalable, but inside a container its PID
   *     namespace may have reset and recycled the old holder's pid onto a NEW process.
   *     Re-read the live process's start-time and compare to what was stored at acquire:
   *       - storedStartTime === null (legacy single-`<pid>` lock) OR liveStartTime ===
   *         null (no /proc / unreadable, e.g. non-Linux dev) → CANNOT disambiguate →
   *         fall back to pid-liveness and treat as ALIVE (prior behavior; safe — at worst
   *         we refuse to start, never double-start).
   *       - start-times MATCH → truly the same process incarnation → ALIVE (real
   *         singleton, refuse).
   *       - start-times MISMATCH → the pid was recycled across a namespace reset → the
   *         original holder is GONE → STALE → reclaim. This is the bug that caused the
   *         502 storm; pid-liveness alone returned a false ALIVE here.
   */
  private isLockHolderAlive(pid: number, storedStartTime: string | null): boolean {
    if (!this.isPidAlive(pid)) {
      return false; // ESRCH / unexpected → unambiguously dead.
    }

    const liveStartTime = this.startTimeReader(pid);
    if (storedStartTime === null || liveStartTime === null) {
      // Can't disambiguate (legacy lock, or no readable /proc). Fall back to the prior
      // pid-liveness behavior: the pid is signalable, so treat the holder as alive.
      return true;
    }

    if (liveStartTime === storedStartTime) {
      return true; // Same incarnation → genuine live singleton.
    }

    // Same pid number, different birth time → recycled across a PID-namespace reset.
    logger.warn(
      `Lock PID ${pid} is signalable but its start-time changed ` +
        `(stored=${storedStartTime}, live=${liveStartTime}) — recycled PID across a ` +
        `restart; treating lock as STALE and reclaiming.`,
    );
    return false;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // signal 0 = existence check only
      return true;
    } catch (err: any) {
      const code = err?.code;
      if (code === 'EPERM') {
        // Exists, just not ours to signal → still alive.
        return true;
      }
      if (code === 'ESRCH') {
        // No such process → stale.
        return false;
      }
      // EINVAL / ERR_INVALID_ARG_TYPE / RangeError / anything unexpected → treat as
      // stale and let the caller reclaim the lock rather than crash-loop.
      logger.warn(
        `Unexpected error probing PID ${pid} (code=${code ?? 'none'}); treating lock as stale`,
      );
      return false;
    }
  }

  /**
   * Write the pid file ATOMICALLY: write to a sibling temp file, then renameSync into
   * place. rename(2) is atomic on the same filesystem, so a reader can never observe a
   * half-written/0-byte lock file even if the write is interrupted (e.g. ENOSPC).
   *
   * If the write itself fails (true disk-full), we clean up any partial temp file and
   * throw a CLEAR, distinct error — never leaving a corrupt LOCK_FILE behind to become
   * the next startup's poison pill.
   */
  private writeLockFile(): void {
    const tmpFile = LOCK_FILE + LOCK_FILE_TMP_SUFFIX;
    // Record our pid AND start-time so a future startup can detect a recycled pid.
    // On a host without readable /proc (non-Linux dev) start-time is null → we fall
    // back to the legacy single-`<pid>` format, which still parses (backward tolerant).
    const startTime = this.startTimeReader(process.pid);
    const content =
      startTime !== null ? `${process.pid} ${startTime}` : `${process.pid}`;
    try {
      fs.writeFileSync(tmpFile, content, 'utf8');
      fs.renameSync(tmpFile, LOCK_FILE);
    } catch (error: any) {
      // Best-effort cleanup of the partial temp file so it can't accumulate.
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // Ignore cleanup failure — the throw below is the signal that matters.
      }
      throw new Error(
        `Failed to write lock file atomically at ${LOCK_FILE} ` +
          `(code=${error?.code ?? 'none'}): ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Release the process lock
   */
  release(): void {
    if (this.locked && fs.existsSync(LOCK_FILE)) {
      try {
        fs.unlinkSync(LOCK_FILE);
        this.locked = false;
        logger.info('✅ Process lock released');
      } catch (error) {
        logger.error('❌ Error releasing process lock', error as Error);
      }
    }
  }

  /**
   * Check if process is currently locked
   */
  isLocked(): boolean {
    return this.locked;
  }
}

export const processLock = ProcessLock.getInstance();
