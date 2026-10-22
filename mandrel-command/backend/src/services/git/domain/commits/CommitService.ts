/**
 * Commit domain service
 * Handles commit collection, analysis, and queries
 */

import { SimpleGit } from 'simple-git';
import { GitServiceConfig, DEFAULT_GIT_SERVICE_CONFIG } from '../../../../types/git';
import { GitClient } from '../../infra/git/GitClient';
import { CommitRepo } from '../../infra/db/CommitRepo';
import {
  classifyCommitType, 
  analyzeCommitMessage, 
  parseCommitStats,
  extractBranches,
  determineMergeStrategy 
} from '../../utils/messageAnalysis';
import { createServiceError } from '../../utils/errors';
import { FileChangeService } from '../changes/ChangeService';
import { logger } from '../../../../config/logger';

export class CommitService {
  private static config: GitServiceConfig = DEFAULT_GIT_SERVICE_CONFIG;

  /**
   * Collect commit data from git repository and store in database
   */
  static async collectCommitData(request: {
    project_id: string;
    limit?: number;
    since?: Date;
    branch?: string;
    force_refresh?: boolean;
  }): Promise<{
    success: boolean;
    project_id: string;
    commits_collected: number;
    branches_updated: number;
    file_changes_tracked: number;
    processing_time_ms: number;
    errors: string[];
  }> {
    const { project_id, limit = 500, since, branch } = request;
    const startTime = Date.now();
    const errors: string[] = [];
    
    try {
      logger.info(`📊 CommitService.collectCommitData - Project: ${project_id}, Limit: ${limit}`);
      
      const git = await GitClient.getGitInstance(project_id);
      
      const logOptions: any = {
        maxCount: limit,
        format: {
          hash: '%H',
          short_hash: '%h',
          date: '%ai',
          author_date: '%ad',
          committer_date: '%cd',
          message: '%s',
          body: '%b',
          author_name: '%an',
          author_email: '%ae',
          committer_name: '%cn',
          committer_email: '%ce',
          refs: '%D',
          parent_hashes: '%P',
          tree_hash: '%T'
        }
      };

      if (since) logOptions.since = since.toISOString();
      if (branch) logOptions.from = branch;

      const log = await git.log(logOptions);
      logger.info(`📈 Found ${log.all.length} commits to process`);

      let commitsCollected = 0;
      let branchesUpdated = 0;
      let fileChangesTracked = 0;

      const batchSize = this.config.batch_size;
      for (let i = 0; i < log.all.length; i += batchSize) {
        const batch = log.all.slice(i, i + batchSize);
        
        try {
          const batchResult = await this.processBatch(project_id, batch, git);
          commitsCollected += batchResult.commitsProcessed;
          branchesUpdated += batchResult.branchesUpdated;
          fileChangesTracked += batchResult.fileChangesTracked;
        } catch (error) {
          errors.push(`Batch ${i}-${i + batchSize}: ${error}`);
          logger.error(`❌ Error processing batch ${i}-${i + batchSize}`, { error });
        }
      }

      const processingTime = Date.now() - startTime;
      logger.info(`✅ CommitService.collectCommitData completed in ${processingTime}ms`);

      return {
        success: true,
        project_id,
        commits_collected: commitsCollected,
        branches_updated: branchesUpdated,
        file_changes_tracked: fileChangesTracked,
        processing_time_ms: processingTime,
        errors
      };
    } catch (error) {
      throw createServiceError('COLLECT_COMMITS_FAILED', `Failed to collect commits: ${error}`, request);
    }
  }

  /**
   * Process a batch of commits
   */
  private static async processBatch(
    project_id: string,
    commits: any[],
    git: SimpleGit
  ): Promise<{ commitsProcessed: number; branchesUpdated: number; fileChangesTracked: number }> {
    let commitsProcessed = 0;
    const branchesUpdated = 0;
    let fileChangesTracked = 0;

    for (const commit of commits) {
      try {
        const exists = await CommitRepo.exists(project_id, commit.hash);
        if (exists) continue;

        const metadata = await this.collectCommitMetadata(commit, git);

        if (this.isDependencyCommit(metadata, commit)) {
          logger.info(`⏭️  Skipping dependency commit: ${commit.hash.substring(0, 12)}`);
          continue;
        }

        const commitType = classifyCommitType(commit.message);
        await CommitRepo.create(project_id, commit, metadata, commitType);
        commitsProcessed++;

        if (this.config.enable_file_tracking) {
          try {
            const result = await FileChangeService.trackFileChanges({
              commit_sha: commit.hash,
              project_id,
              include_binary: false,
              enhanced_metadata: metadata
            });
            fileChangesTracked += result.total_files;
          } catch (error) {
            logger.warn(`Failed to track file changes for ${commit.hash}`, { error });
          }
        }
      } catch (error) {
        logger.error(`Failed to process commit ${commit.hash}`, { error });
        throw error;
      }
    }

    return { commitsProcessed, branchesUpdated, fileChangesTracked };
  }

  /**
   * Collect comprehensive metadata for a commit
   */
  static async collectCommitMetadata(commit: any, git: SimpleGit): Promise<any> {
    try {
      const commitDetails = await git.show([commit.hash, '--stat', '--numstat', '--shortstat']);
      const parents = commit.parent_hashes ? commit.parent_hashes.split(' ').filter(Boolean) : [];
      const isMergeCommit = parents.length > 1;
      const stats = parseCommitStats(commitDetails);
      
      let branches: string[] = [];
      try {
        const branchInfo = await git.branch(['--contains', commit.hash]);
        branches = Object.keys(branchInfo.branches).filter(branch => !branch.startsWith('remotes/'));
      } catch {
        branches = commit.refs ? extractBranches(commit.refs) : ['main'];
      }
      
      const messageAnalysis = analyzeCommitMessage(commit.message, commit.body);
      
      let mergeInfo = null;
      if (isMergeCommit) {
        mergeInfo = await this.getMergeInfo(commit, git, parents);
      }
      
      return {
        parent_shas: parents,
        is_merge_commit: isMergeCommit,
        files_changed: stats.files_changed || 0,
        insertions: stats.insertions || 0,
        deletions: stats.deletions || 0,
        branches,
        primary_branch: branches[0] || 'main',
        commit_size: (stats.insertions || 0) + (stats.deletions || 0),
        message_analysis: messageAnalysis,
        merge_info: mergeInfo,
        tree_hash: commit.tree_hash,
        commit_stats: stats,
        processing_timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      logger.warn(`Failed to collect metadata for ${commit.hash}`, { error });
      return {
        parent_shas: [],
        is_merge_commit: false,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        branches: ['main'],
        primary_branch: 'main',
        error: error.message
      };
    }
  }

  /**
   * Get merge commit information
   */
  private static async getMergeInfo(commit: any, git: SimpleGit, parents: string[]): Promise<any> {
    if (parents.length < 2) return null;

    let sourceBranch = null;
    let targetBranch = null;
    
    try {
      const targetBranchInfo = await git.branch(['--contains', parents[0]]);
      const targetBranches = Object.keys(targetBranchInfo.branches).filter(b => !b.startsWith('remotes/'));
      targetBranch = targetBranches[0] || null;
      
      const sourceBranchInfo = await git.branch(['--contains', parents[1]]);
      const sourceBranches = Object.keys(sourceBranchInfo.branches).filter(b => !b.startsWith('remotes/'));
      sourceBranch = sourceBranches[0] || null;
    } catch (error) {
      logger.warn(`Could not determine merge branches for ${commit.hash}`, { error });
    }

    return {
      parent_commits: parents,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      merge_strategy: determineMergeStrategy(commit.message)
    };
  }

  /**
   * Check if a commit is primarily dependency-related
   */
  private static isDependencyCommit(metadata: any, commit: any): boolean {
    const insertions = metadata.insertions || 0;
    const filesChanged = metadata.files_changed || 0;
    const message = commit.message.toLowerCase();

    if (insertions > 10000 || filesChanged > 1000) return true;

    const fileStats = metadata.commit_stats?.file_stats || [];
    if (fileStats.length > 0) {
      const dependencyPatterns = [
        /^node_modules\//, /^package-lock\.json$/, /^yarn\.lock$/,
        /^pnpm-lock\.yaml$/, /^Cargo\.lock$/, /^Gemfile\.lock$/,
        /^composer\.lock$/, /^Pipfile\.lock$/, /\.min\.(js|css)$/,
        /^vendor\//, /^dist\/.*\.(js|css)$/
      ];

      let dependencyCount = 0;
      for (const stat of fileStats) {
        if (dependencyPatterns.some(p => p.test(stat.file_path))) dependencyCount++;
      }

      if (dependencyCount / fileStats.length > 0.5) return true;
    }

    const keywords = ['package-lock', 'yarn.lock', 'npm install', 'yarn add', 'update dependencies'];
    if (keywords.some(k => message.includes(k)) && insertions > 1000) return true;

    return false;
  }
}
