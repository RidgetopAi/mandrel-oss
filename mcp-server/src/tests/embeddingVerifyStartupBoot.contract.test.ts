/**
 * BOOT-TIME EMBEDDER CHECK, PROCESS LEVEL.
 *
 * Drives the SHIPPED entry point (`src/main.ts` under tsx) with the embedder unreachable at boot
 * (gemma on an Ollama endpoint whose port nothing listens on), no database, no background
 * services, no stdio transport:
 *   strict → the process exits NON-ZERO and never reaches the stages after the check;
 *   warn → it logs the one loud line and KEEPS BOOTING (reaches the health server stage) —
 *   our fleet's setting. The child is killed once that is observed.
 *   (Unset is the strict default since an earlier task; the unit file pins that.)
 * Unit-level detail (exact line, unknown value) is embeddingVerifyStartupMode.unit.test.ts.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = path.join(MCP_DIR, 'node_modules', '.bin', 'tsx');
/** Generous: a cold tsx compile of the whole server graph on a loaded box. */
const BOOT_DEADLINE_MS = 90_000;
const WARN_LINE = 'EMBEDDER UNUSABLE AT STARTUP';
/** Logged only AFTER verifyStartup() returned (MandrelMcpServer.start). */
const PAST_THE_CHECK = 'Starting background services';

/**
 * THE CHILD IS A PROCESS GROUP, NOT A PID (measured 2026-10-25). `tsx` is a
 * wrapper: it spawns the real server as a SEPARATE node process. SIGKILL to the wrapper's PID
 * left that server running, reparented, still writing logs into the tmp dir — so afterEach's
 * rm raced it (ENOTEMPTY, 1 of 20 isolated runs) and every warn-mode run leaked one live
 * server (41 orphans found on the box). So the boot runs in its OWN process group, the
 * kill targets the group, and cleanup waits — bounded — until the group is provably empty
 * (kill(-pgid, 0) -> ESRCH) BEFORE deleting the dir. A group that will not die is a RED,
 * never a silent leak.
 */
const GROUP_GONE_DEADLINE_MS = 10_000;
const tmpDirs: string[] = [];
const groups: number[] = [];

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function reapGroup(pgid: number): Promise<boolean> {
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
  const until = Date.now() + GROUP_GONE_DEADLINE_MS;
  while (groupAlive(pgid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !groupAlive(pgid);
}

afterEach(async () => {
  const stuck: number[] = [];
  for (const g of groups.splice(0)) if (!(await reapGroup(g))) stuck.push(g);
  // Only once every process that could write into them is gone are the dirs deleted.
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  expect(stuck, 'process group(s) still alive after SIGKILL + wait — the boot leaked a server').toEqual([]);
});

interface BootResult { code: number | null; signal: NodeJS.Signals | null; out: string; killedByTest: boolean; pgid: number }

async function boot(mode: string | undefined): Promise<BootResult> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-verify-startup-'));
  tmpDirs.push(tmp);
  const dead = `http://127.0.0.1:${await reserveEphemeralPort()}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'MANDREL_EMBEDDINGS_ALLOW_MOCK', 'MANDREL_EMBEDDING_VERIFY_STARTUP']) delete env[k];
  Object.assign(env, {
    NODE_ENV: 'development',
    MANDREL_EMBEDDER: 'gemma',
    MANDREL_OLLAMA_ENDPOINT: dead,
    AIDIS_SKIP_DATABASE: 'true',
    // database.ts validates these at MODULE LOAD even when the DB is skipped; inert values on a
    // port nothing listens on, so nothing can reach a real database.
    DATABASE_NAME: 'mandrel_verify_startup_unused',
    DATABASE_USER: 'mandrel_verify_startup_unused',
    DATABASE_PASSWORD: 'unused',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(await reserveEphemeralPort()),
    AIDIS_SKIP_BACKGROUND: 'true',
    AIDIS_SKIP_STDIO: 'true',
    AIDIS_LOCK_FILE: path.join(tmp, 'aidis.pid'),
    MANDREL_MCP_PORT: String(await reserveEphemeralPort()),
    LOG_CONSOLE: 'true',
    AIDIS_LOG_CONSOLE: 'true',
    LOG_DIR: tmp,
    AIDIS_LOG_DIR: tmp,
  });
  if (mode !== undefined) env.MANDREL_EMBEDDING_VERIFY_STARTUP = mode;

  return new Promise<BootResult>((resolve) => {
    // detached: the child leads its OWN process group (pgid === pid), so the server tsx
    // spawns underneath it is killable — and checkable — as one unit.
    const child = spawn(TSX, ['src/main.ts'], { cwd: MCP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pgid = child.pid as number;
    groups.push(pgid);
    const killGroup = () => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
    let out = '';
    let killedByTest = false;
    const onData = (b: Buffer) => {
      out += b.toString();
      if (mode === 'warn' && out.includes(WARN_LINE) && out.includes(PAST_THE_CHECK) && !killedByTest) {
        killedByTest = true;
        killGroup();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { killedByTest = true; killGroup(); }, BOOT_DEADLINE_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, killedByTest, pgid });
    });
  });
}

describe('boot with the embedder unreachable', () => {
  it('strict: the shipped entry point exits non-zero before the stages after the check', async () => {
    const r = await boot('strict');
    expect(r.killedByTest, `did not exit within ${BOOT_DEADLINE_MS}ms:\n${r.out.slice(-2000)}`).toBe(false);
    expect(r.code, r.out.slice(-2000)).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.out, 'the boot reached the check (witness: its error names the endpoint)').toMatch(/not reachable/);
    expect(r.out).not.toContain(PAST_THE_CHECK);
    expect(r.out).not.toContain(WARN_LINE);
  }, BOOT_DEADLINE_MS + 15_000);

  it('warn: logs the loud line and keeps booting past the check', async () => {
    const r = await boot('warn');
    expect(r.out, r.out.slice(-2000)).toContain(WARN_LINE);
    expect(r.out, r.out.slice(-2000)).toContain(PAST_THE_CHECK);
    expect(r.signal, 'still running until this test killed it').toBe('SIGKILL');
  }, BOOT_DEADLINE_MS + 15_000);
});
