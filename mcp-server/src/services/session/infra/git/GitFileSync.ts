/**
 * GitFileSync - Git integration for file change tracking
 */

import { logger } from '../../../../utils/logger.js';
import { SessionRepo } from '../db/SessionRepo.js';
import { FileRepo } from '../db/FileRepo.js';

export interface GitSyncResult {
  filesProcessed: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  error?: string;
}

export interface GitHeadInfo {
  branch: string | null;
  commitSha: string | null;
}

/**
 * Parse git diff --numstat output
 * Format: <lines-added>\t<lines-deleted>\t<filename>
 */
function parseGitDiffNumstat(diffOutput: string): Map<string, { added: number; deleted: number }> {
  const fileChanges = new Map<string, { added: number; deleted: number }>();

  const lines = diffOutput.trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const added = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
    const deleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
    const filePath = parts[2];

    // Aggregate changes for same file (in case it appears multiple times)
    const existing = fileChanges.get(filePath) || { added: 0, deleted: 0 };
    fileChanges.set(filePath, {
      added: existing.added + added,
      deleted: existing.deleted + deleted
    });
  }

  return fileChanges;
}

/**
 * Is `cwd` inside a git working tree? False for a missing dir, a dir outside any
 * repository, or a host with no git binary — every one of those means "there is
 * nothing to diff", which is a skip, not an error.
 */
function isGitWorkTree(
  execSync: typeof import('child_process').execSync,
  cwd: string
): boolean {
  try {
    const out = execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

export const GitFileSync = {
  /**
   * Capture current git HEAD information (branch and commit SHA)
   */
  async captureHeadInfo(workingDir?: string): Promise<GitHeadInfo> {
    const cwd = workingDir || process.cwd();
    let branch: string | null = null;
    let commitSha: string | null = null;

    try {
      const { execSync } = await import('child_process');

      try {
        branch = execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: 'utf8',
          cwd,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
      } catch {
        // Not in a git repository or no branch
      }

      try {
        commitSha = execSync('git rev-parse HEAD', {
          encoding: 'utf8',
          cwd,
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
      } catch {
        // Not in a git repository or no commits
      }
    } catch {
      // child_process import failed
    }

    return { branch, commitSha };
  },

  /**
   * Sync file changes from git diff into session_files table
   */
  async syncFilesFromGit(sessionId: string): Promise<GitSyncResult> {
    try {
      // Get starting commit SHA
      const startCommitSha = await SessionRepo.getStartingCommitSha(sessionId);

      // Get project root directory (falls back to process.cwd())
      const projectRootDir = await SessionRepo.getProjectRootDir(sessionId);
      const gitWorkingDir = projectRootDir || process.cwd();

      logger.info('Syncing file changes from git', {
        component: 'GitFileSync',
        operation: 'syncFilesFromGit',
        metadata: {
          sessionId: sessionId.substring(0, 8),
          startCommit: startCommitSha?.substring(0, 8) || 'none',
          workingDir: gitWorkingDir,
          usingProjectDir: !!projectRootDir
        }
      });

      // Build git diff command
      let gitDiffCommand: string;
      if (startCommitSha) {
        gitDiffCommand = `git diff ${startCommitSha} HEAD --numstat && git diff HEAD --numstat`;
      } else {
        gitDiffCommand = 'git diff HEAD --numstat';
      }

      const { execSync } = await import('child_process');

      // A working dir with no git repository is an ORDINARY state, not a failure:
      // every fleet container boots this way (the image ships no .git), and until
      // 2026-09-08 that produced exactly one ERROR line per boot — the only
      // error-class line in ~2,000 lines of post-deploy logs fleet-wide.
      // A guaranteed error trains readers to skip the error grep.
      if (!isGitWorkTree(execSync, gitWorkingDir)) {
        logger.info('No git working tree at working dir — file sync skipped', {
          component: 'GitFileSync',
          operation: 'syncFilesFromGit',
          metadata: { sessionId: sessionId.substring(0, 8), workingDir: gitWorkingDir }
        });
        return { filesProcessed: 0, totalLinesAdded: 0, totalLinesDeleted: 0 };
      }

      let diffOutput: string;

      try {
        diffOutput = execSync(gitDiffCommand, {
          encoding: 'utf8',
          cwd: gitWorkingDir,
          maxBuffer: 10 * 1024 * 1024
        });
      } catch {
        logger.warn('Git diff with commit SHA failed, trying uncommitted changes only');
        diffOutput = execSync('git diff HEAD --numstat', {
          encoding: 'utf8',
          cwd: gitWorkingDir,
          maxBuffer: 10 * 1024 * 1024
        });
      }

      if (!diffOutput.trim()) {
        logger.info('No file changes detected in git diff', {
          component: 'GitFileSync',
          operation: 'syncFilesFromGit',
          metadata: { sessionId: sessionId.substring(0, 8) }
        });
        return { filesProcessed: 0, totalLinesAdded: 0, totalLinesDeleted: 0 };
      }

      // Parse and record changes
      const fileChanges = parseGitDiffNumstat(diffOutput);

      let filesProcessed = 0;
      let totalLinesAdded = 0;
      let totalLinesDeleted = 0;

      for (const [filePath, changes] of fileChanges.entries()) {
        await FileRepo.upsert(sessionId, filePath, changes.added, changes.deleted, 'git');
        filesProcessed++;
        totalLinesAdded += changes.added;
        totalLinesDeleted += changes.deleted;
      }

      // Update session-level aggregates
      await SessionRepo.updateFileMetrics(sessionId);

      logger.info('File sync from git completed', {
        component: 'GitFileSync',
        operation: 'syncFilesFromGit',
        metadata: {
          sessionId: sessionId.substring(0, 8),
          filesProcessed,
          totalLinesAdded,
          totalLinesDeleted,
          netChange: totalLinesAdded - totalLinesDeleted
        }
      });

      return { filesProcessed, totalLinesAdded, totalLinesDeleted };

    } catch (error) {
      logger.error('Failed to sync files from git', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'GitFileSync',
        operation: 'syncFilesFromGit',
        metadata: { sessionId }
      });

      return {
        filesProcessed: 0,
        totalLinesAdded: 0,
        totalLinesDeleted: 0,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
};
