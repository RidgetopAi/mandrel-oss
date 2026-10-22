/**
 * GitFileSync.syncFilesFromGit in a working dir that is NOT a git repository must
 * be a skip (info), never an error. every fleet container boots
 * without a .git, and the ERROR this produced on every boot was the only
 * error-class line fleet-wide — a guaranteed error is a trained-away signal.
 *
 * Two runs, so the assertion is about the BRANCH and not about a logger that is
 * quiet for some other reason:
 *   - no repo  -> info "file sync skipped", no error, empty result, no error field
 *   - real repo (control) -> the skip line is NOT logged and there is still no error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { GitFileSync } from '../services/session/infra/git/GitFileSync.js';
import { SessionRepo } from '../services/session/infra/db/SessionRepo.js';
import { logger } from '../utils/logger.js';

const SESSION_ID = '00000000-0000-4000-8000-00000000b855';
const SKIP_MSG = /file sync skipped/;

function insideGitWorkTree(dir: string): boolean {
  try {
    return (
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

describe('GitFileSync.syncFilesFromGit without a git repository', () => {
  let noRepoDir: string;
  let repoDir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noRepoDir = mkdtempSync(join(tmpdir(), 'gfs-norepo-'));
    repoDir = mkdtempSync(join(tmpdir(), 'gfs-repo-'));
    // PRECONDITION, not assumption: a tmpdir nested inside some checkout would make
    // the "no repo" run a repo run and the test vacuous. Fail loud, do not skip.
    if (insideGitWorkTree(noRepoDir)) {
      throw new Error(`CANNOT MEASURE: ${noRepoDir} is inside a git work tree`);
    }
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
      cwd: repoDir,
      stdio: 'ignore'
    });
    vi.spyOn(SessionRepo, 'getStartingCommitSha').mockResolvedValue(null);
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(noRepoDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('is a skip (info), not an error, when the working dir has no git repository', async () => {
    vi.spyOn(SessionRepo, 'getProjectRootDir').mockResolvedValue(noRepoDir);

    const result = await GitFileSync.syncFilesFromGit(SESSION_ID);

    expect(result).toEqual({ filesProcessed: 0, totalLinesAdded: 0, totalLinesDeleted: 0 });
    expect(result.error).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    const skipLines = infoSpy.mock.calls.filter((c) => SKIP_MSG.test(String(c[0])));
    expect(skipLines).toHaveLength(1);
    expect((skipLines[0][1] as { metadata?: { workingDir?: string } })?.metadata?.workingDir).toBe(noRepoDir);
  });

  it('control: a real repository does NOT take the skip branch and still logs no error', async () => {
    vi.spyOn(SessionRepo, 'getProjectRootDir').mockResolvedValue(repoDir);

    const result = await GitFileSync.syncFilesFromGit(SESSION_ID);

    expect(result.error).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    const skipLines = infoSpy.mock.calls.filter((c) => SKIP_MSG.test(String(c[0])));
    expect(skipLines).toHaveLength(0);
  });
});
