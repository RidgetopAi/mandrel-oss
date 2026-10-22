/**
 * GitService Façade
 * Maintains backward compatibility while delegating to domain services
 * 
 * This is the primary entry point for git operations.
 * All public methods from the original GitService are preserved here.
 */

import { db as pool } from '../../database/connection';
import { logger } from '../../config/logger';
import path from 'path';
import fs from 'fs';

// Types
import {
  GitCommit,
  GitFileChange,
  InitializeRepositoryRequest,
  InitializeRepositoryResponse,
  CollectCommitDataRequest,
  CollectCommitDataResponse,
  GetRecentCommitsRequest,
  GetRecentCommitsResponse,
  GetCurrentCommitInfoResponse,
  GetBranchInfoRequest,
  GetBranchInfoResponse,
  TrackFileChangesRequest,
  TrackFileChangesResponse,
  CorrelateCommitsWithSessionsRequest,
  CorrelateCommitsWithSessionsResponse,
  GitProjectStats,
  GitRepositoryStatus,
  CommitType
} from '../../types/git';

// Domain services
import { CommitService } from './domain/commits';
import { BranchService } from './domain/branches';
import { FileChangeService } from './domain/changes';
import { CorrelationService } from './domain/correlation';

// Infrastructure
import { GitClient } from './infra/git';
import { CommitRepo, mapRowToGitCommit, ChangeRepo } from './infra/db';

// Utilities
import {
  calculateFileRiskScore
} from './utils/fileAnalysis';
import {
  getMostActiveCategory
} from './utils/branchAnalysis';
import { createServiceError } from './utils/errors';

/**
 * GitService: Façade for comprehensive git data collection and analysis
 * Delegates to domain services while maintaining the original API
 */
export class GitService {
  // ============================================
  // Repository Initialization
  // ============================================

  static async initializeRepository(request: InitializeRepositoryRequest): Promise<InitializeRepositoryResponse> {
    const { project_id, repo_path, remote_url } = request;

    try {
      logger.info(`🔧 GitService.initializeRepository - Project: ${project_id}, Path: ${repo_path}`);
      
      const project = await GitClient.validateProject(project_id);
      if (!project) throw new Error(`Project ${project_id} not found`);

      const resolvedPath = path.resolve(repo_path);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Repository path does not exist: ${resolvedPath}`);
      }

      const git = GitClient.createGitInstance(resolvedPath);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) throw new Error(`Path is not a git repository: ${resolvedPath}`);

      GitClient.cacheInstance(project_id, git);
      
      const status = await git.status();
      const branches = await git.branch(['--all']);
      const branchCount = Object.keys(branches.branches).length;

      await GitClient.updateProjectGitInfo(project_id, {
        git_repo_path: resolvedPath,
        git_repo_url: remote_url || await GitClient.getRemoteUrl(git),
        git_initialized_at: new Date().toISOString(),
        git_current_branch: status.current || 'main'
      });

      const collectResult = await this.collectCommitData({
        project_id,
        limit: 100,
        force_refresh: true
      });

      return {
        success: true,
        project_id,
        repo_path: resolvedPath,
        branch_count: branchCount,
        initial_commits_collected: collectResult.commits_collected,
        message: `Repository initialized with ${collectResult.commits_collected} commits and ${branchCount} branches`
      };
    } catch (error) {
      throw createServiceError('INIT_REPO_FAILED', `Failed to initialize repository: ${error}`, { project_id, repo_path });
    }
  }

  // ============================================
  // Commit Operations (delegated to CommitService)
  // ============================================

  static async collectCommitData(request: CollectCommitDataRequest): Promise<CollectCommitDataResponse> {
    return CommitService.collectCommitData(request);
  }

  static async getRecentCommits(request: GetRecentCommitsRequest): Promise<GetRecentCommitsResponse> {
    const { project_id, hours, branch, author } = request;
    
    try {
      const commits = await CommitRepo.getRecentCommits(project_id, hours, { branch, author });
      
      return {
        commits,
        total_count: commits.length,
        time_range_hours: hours,
        branch_filter: branch || '',
        author_filter: author || ''
      };
    } catch (error) {
      throw createServiceError('GET_RECENT_COMMITS_FAILED', `Failed to get recent commits: ${error}`, request);
    }
  }

  static async getCurrentCommitInfo(project_id: string): Promise<GetCurrentCommitInfoResponse> {
    try {
      const git = await GitClient.getGitInstance(project_id);
      const log = await git.log({ maxCount: 1 });
      const currentCommit = log.latest;
      
      if (!currentCommit) throw new Error('No commits found in repository');
      
      const status = await git.status();
      
      const response: GetCurrentCommitInfoResponse = {
        commit_sha: currentCommit.hash,
        short_sha: currentCommit.hash.substring(0, 12),
        message: currentCommit.message,
        author_name: currentCommit.author_name,
        author_email: currentCommit.author_email,
        branch_name: status.current || 'HEAD',
        is_clean: status.isClean()
      };
      
      if (!status.isClean()) {
        response.uncommitted_changes = {
          staged_files: status.staged,
          modified_files: status.modified,
          untracked_files: status.not_added
        };
      }
      
      return response;
    } catch (error) {
      throw createServiceError('GET_CURRENT_COMMIT_FAILED', `Failed to get current commit info: ${error}`, { project_id });
    }
  }

  // ============================================
  // Branch Operations (delegated to BranchService)
  // ============================================

  static async getBranchInfo(request: GetBranchInfoRequest): Promise<GetBranchInfoResponse> {
    return BranchService.getBranchInfo(request);
  }

  // ============================================
  // File Change Operations (delegated to FileChangeService)
  // ============================================

  static async trackFileChanges(request: TrackFileChangesRequest): Promise<TrackFileChangesResponse> {
    return FileChangeService.trackFileChanges(request);
  }

  static async trackFileChangesWithMetadata(request: TrackFileChangesRequest & { enhanced_metadata?: any }): Promise<TrackFileChangesResponse> {
    return FileChangeService.trackFileChanges(request);
  }

  // ============================================
  // Correlation Operations (delegated to CorrelationService)
  // ============================================

  static async correlateCommitsWithSessions(request: CorrelateCommitsWithSessionsRequest): Promise<CorrelateCommitsWithSessionsResponse> {
    return CorrelationService.correlateCommitsWithSessions(request);
  }

  // ============================================
  // Query & Analytics (kept in façade for now)
  // ============================================

  static async queryCommitsByMetadata(request: {
    project_id: string;
    author?: string;
    date_range?: { start: Date; end: Date };
    file_patterns?: string[];
    commit_types?: CommitType[];
    branches?: string[];
    has_breaking_changes?: boolean;
    is_merge_commit?: boolean;
    ticket_references?: string[];
    min_files_changed?: number;
    max_files_changed?: number;
    min_lines_changed?: number;
    max_lines_changed?: number;
    limit?: number;
    offset?: number;
  }): Promise<{
    commits: GitCommit[];
    total_count: number;
    metadata_summary: {
      authors: string[];
      commit_types: Record<CommitType, number>;
      branches: string[];
      avg_files_changed: number;
      avg_lines_changed: number;
    };
  }> {
    try {
      const whereConditions: string[] = ['gc.project_id = $1'];
      const queryParams: any[] = [request.project_id];
      let paramIndex = 2;
      
      if (request.author) {
        whereConditions.push(`(gc.author_email = $${paramIndex} OR gc.author_name ILIKE $${paramIndex + 1})`);
        queryParams.push(request.author, `%${request.author}%`);
        paramIndex += 2;
      }
      
      if (request.date_range) {
        whereConditions.push(`gc.author_date >= $${paramIndex} AND gc.author_date <= $${paramIndex + 1}`);
        queryParams.push(request.date_range.start.toISOString(), request.date_range.end.toISOString());
        paramIndex += 2;
      }
      
      if (request.commit_types?.length) {
        whereConditions.push(`gc.commit_type = ANY($${paramIndex})`);
        queryParams.push(request.commit_types);
        paramIndex++;
      }
      
      if (request.branches?.length) {
        whereConditions.push(`gc.branch_name = ANY($${paramIndex})`);
        queryParams.push(request.branches);
        paramIndex++;
      }
      
      if (request.is_merge_commit !== undefined) {
        whereConditions.push(`gc.is_merge_commit = $${paramIndex}`);
        queryParams.push(request.is_merge_commit);
        paramIndex++;
      }
      
      let fromClause = 'git_commits gc';
      if (request.file_patterns?.length) {
        fromClause = `git_commits gc INNER JOIN git_file_changes gfc ON gc.id = gfc.commit_id`;
        const patterns = request.file_patterns.map((_, i) => `gfc.file_path ILIKE $${paramIndex + i}`).join(' OR ');
        whereConditions.push(`(${patterns})`);
        queryParams.push(...request.file_patterns.map(p => `%${p}%`));
        paramIndex += request.file_patterns.length;
      }
      
      // TOTAL ORDER. `gc.author_date` is not unique — a squashed import,
      // a rebase, or any batch of commits sharing an author timestamp ties — and this query
      // is LIMIT/OFFSET paged directly below. Paging over a partial order can repeat one
      // commit on two pages and drop another entirely, with no error raised. `gc.id` is the
      // primary key: unique (the composite is total), stable under edits (a page boundary
      // must not shift under a concurrent write, which is why the tiebreaker is never a
      // timestamp), and already indexed. It is also in the SELECT list, so `SELECT DISTINCT`
      // still accepts the ORDER BY.
      let sql = `SELECT DISTINCT gc.* FROM ${fromClause} WHERE ${whereConditions.join(' AND ')} ORDER BY gc.author_date DESC, gc.id DESC`;
      
      if (request.limit) {
        sql += ` LIMIT $${paramIndex}`;
        queryParams.push(request.limit);
        paramIndex++;
      }
      
      if (request.offset) {
        sql += ` OFFSET $${paramIndex}`;
        queryParams.push(request.offset);
      }
      
      const result = await pool.query(sql, queryParams);
      const commits = result.rows.map(mapRowToGitCommit);
      
      const countResult = await pool.query(
        `SELECT COUNT(DISTINCT gc.id) as total FROM ${fromClause} WHERE ${whereConditions.join(' AND ')}`,
        queryParams.slice(0, queryParams.length - (request.limit ? 1 : 0) - (request.offset ? 1 : 0))
      );
      
      const summary = this.generateMetadataSummary(commits);
      
      return {
        commits,
        total_count: parseInt(countResult.rows[0].total),
        metadata_summary: summary
      };
    } catch (error) {
      throw createServiceError('QUERY_COMMITS_FAILED', `Failed to query commits: ${error}`, request);
    }
  }

  static async getCommitMetadataAnalysis(project_id: string, commit_sha: string) {
    try {
      const commit = await CommitRepo.findBySha(project_id, commit_sha);
      if (!commit) throw new Error(`Commit ${commit_sha} not found`);
      
      const fileChanges = await ChangeRepo.getByCommitId(project_id, commit.id);
      const analysis = this.analyzeCommitComplexity(commit, fileChanges);
      
      return { commit, file_changes: fileChanges, analysis };
    } catch (error) {
      throw createServiceError('COMMIT_ANALYSIS_FAILED', `Failed to analyze commit: ${error}`, { project_id, commit_sha });
    }
  }

  static async getFileChangeHotspots(project_id: string, options: { since?: Date; limit?: number; min_changes?: number } = {}) {
    try {
      const whereConditions = ['gfc.project_id = $1'];
      const queryParams: any[] = [project_id];
      
      if (options.since) {
        whereConditions.push(`gc.author_date >= $2`);
        queryParams.push(options.since.toISOString());
      }
      
      const result = await pool.query(`
        SELECT gfc.file_path, COUNT(*) as change_count, COUNT(DISTINCT gc.author_email) as contributor_count,
          MAX(gc.author_date) as last_changed, AVG(gfc.lines_added + gfc.lines_removed) as avg_change_size,
          STRING_AGG(DISTINCT gfc.metadata->>'language', ', ') as languages,
          STRING_AGG(DISTINCT gfc.metadata->>'file_category', ', ') as categories
        FROM git_file_changes gfc JOIN git_commits gc ON gfc.commit_id = gc.id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY gfc.file_path HAVING COUNT(*) >= ${options.min_changes || 3}
        ORDER BY change_count DESC LIMIT ${options.limit || 50}
      `, queryParams);
      
      const hotspots = result.rows.map(row => ({
        file_path: row.file_path,
        change_count: parseInt(row.change_count),
        contributor_count: parseInt(row.contributor_count),
        last_changed: new Date(row.last_changed),
        file_category: row.categories?.split(', ')[0] || 'unknown',
        languages: row.languages?.split(', ').filter(Boolean) || [],
        avg_change_size: parseFloat(row.avg_change_size) || 0,
        risk_score: calculateFileRiskScore(
          parseInt(row.change_count),
          parseInt(row.contributor_count),
          parseFloat(row.avg_change_size),
          new Date(row.last_changed)
        )
      }));
      
      return {
        hotspots,
        summary: {
          total_hotspots: hotspots.length,
          high_risk_files: hotspots.filter(h => h.risk_score > 0.7).length,
          most_active_category: getMostActiveCategory(hotspots)
        }
      };
    } catch (error) {
      throw createServiceError('FILE_HOTSPOTS_FAILED', `Failed to get hotspots: ${error}`, { project_id });
    }
  }

  static async getProjectGitStats(project_id: string): Promise<GitProjectStats> {
    try {
      const projectResult = await pool.query(`
        SELECT p.id, p.name,
          COUNT(DISTINCT gc.id) as total_commits, COUNT(DISTINCT gc.author_email) as contributors,
          COUNT(DISTINCT gc.id) FILTER (WHERE gc.author_date >= NOW() - INTERVAL '7 days') as commits_last_week,
          COUNT(DISTINCT gc.id) FILTER (WHERE gc.author_date >= NOW() - INTERVAL '30 days') as commits_last_month,
          COUNT(DISTINCT gb.id) as total_branches,
          COUNT(DISTINCT gb.id) FILTER (WHERE gb.last_commit_date >= NOW() - INTERVAL '30 days') as active_branches,
          MIN(gc.author_date) as first_commit_date, MAX(gc.author_date) as last_commit_date
        FROM projects p
        LEFT JOIN git_commits gc ON p.id = gc.project_id
        LEFT JOIN git_branches gb ON p.id = gb.project_id
        WHERE p.id = $1 GROUP BY p.id, p.name
      `, [project_id]);
      
      if (!projectResult.rows.length) throw new Error(`Project ${project_id} not found`);
      
      const data = projectResult.rows[0];
      
      const fileStatsResult = await pool.query(
        `SELECT COUNT(DISTINCT id) as total FROM git_file_changes WHERE project_id = $1`,
        [project_id]
      );
      
      const mostChangedResult = await pool.query(`
        SELECT gfc.file_path, COUNT(*) as change_count, MAX(gc.author_date) as last_changed
        FROM git_file_changes gfc JOIN git_commits gc ON gfc.commit_id = gc.id
        WHERE gfc.project_id = $1 GROUP BY gfc.file_path ORDER BY change_count DESC LIMIT 10
      `, [project_id]);
      
      const contributorsResult = await pool.query(`
        SELECT author_email, author_name, COUNT(*) as commit_count, SUM(insertions + deletions) as lines
        FROM git_commits WHERE project_id = $1
        GROUP BY author_email, author_name ORDER BY commit_count DESC LIMIT 10
      `, [project_id]);
      
      return {
        project_id,
        project_name: data.name,
        total_commits: parseInt(data.total_commits) || 0,
        contributors: parseInt(data.contributors) || 0,
        commits_last_week: parseInt(data.commits_last_week) || 0,
        commits_last_month: parseInt(data.commits_last_month) || 0,
        total_branches: parseInt(data.total_branches) || 0,
        active_branches: parseInt(data.active_branches) || 0,
        total_file_changes: parseInt(fileStatsResult.rows[0]?.total) || 0,
        most_changed_files: mostChangedResult.rows.map(r => ({
          file_path: r.file_path,
          change_count: parseInt(r.change_count),
          last_changed: new Date(r.last_changed)
        })),
        top_contributors: contributorsResult.rows.map(r => ({
          author_email: r.author_email,
          author_name: r.author_name,
          commit_count: parseInt(r.commit_count),
          lines_contributed: parseInt(r.lines) || 0
        })),
        first_commit_date: data.first_commit_date ? new Date(data.first_commit_date) : new Date(),
        last_commit_date: data.last_commit_date ? new Date(data.last_commit_date) : new Date()
      };
    } catch (error) {
      throw createServiceError('GET_PROJECT_STATS_FAILED', `Failed to get stats: ${error}`, { project_id });
    }
  }

  static async getRepositoryStatus(project_id: string): Promise<GitRepositoryStatus> {
    try {
      const git = await GitClient.getGitInstance(project_id);
      const isRepo = await git.checkIsRepo();
      if (!isRepo) throw new Error('Not a git repository');
      
      const status = await git.status();
      const remotes = await git.getRemotes(true);
      const log = await git.log({ maxCount: 1000 });
      
      return {
        is_git_repo: true,
        repo_path: await git.revparse(['--show-toplevel']),
        current_branch: status.current || 'HEAD',
        is_clean: status.isClean(),
        has_remote: remotes.length > 0,
        remote_url: remotes[0]?.refs?.fetch,
        total_commits: log.total,
        untracked_files: status.not_added.length,
        staged_files: status.staged.length,
        modified_files: status.modified.length
      };
    } catch {
      return {
        is_git_repo: false,
        repo_path: '',
        current_branch: '',
        is_clean: false,
        has_remote: false,
        total_commits: 0,
        untracked_files: 0,
        staged_files: 0,
        modified_files: 0
      };
    }
  }

  // ============================================
  // Private helpers
  // ============================================

  private static generateMetadataSummary(commits: GitCommit[]) {
    const authors = new Set<string>();
    const commitTypes: Record<CommitType, number> = {
      feature: 0, fix: 0, docs: 0, refactor: 0, test: 0, style: 0, chore: 0, merge: 0
    };
    const branches = new Set<string>();
    let totalFiles = 0, totalLines = 0;
    
    for (const commit of commits) {
      authors.add(commit.author_email);
      commitTypes[commit.commit_type]++;
      if (commit.branch_name) branches.add(commit.branch_name);
      totalFiles += commit.files_changed;
      totalLines += commit.insertions + commit.deletions;
    }
    
    return {
      authors: Array.from(authors),
      commit_types: commitTypes,
      branches: Array.from(branches),
      avg_files_changed: commits.length ? Math.round(totalFiles / commits.length * 100) / 100 : 0,
      avg_lines_changed: commits.length ? Math.round(totalLines / commits.length * 100) / 100 : 0
    };
  }

  private static analyzeCommitComplexity(commit: GitCommit, fileChanges: GitFileChange[]) {
    let score = 0;
    const categories: Record<string, number> = {};
    const languages = new Set<string>();
    let testImpact = false;
    
    score += Math.min(commit.files_changed * 0.1, 2.0);
    score += Math.min((commit.insertions + commit.deletions) * 0.001, 2.0);
    
    for (const fc of fileChanges) {
      const meta = fc.metadata || {};
      categories[meta.file_category || 'unknown'] = (categories[meta.file_category || 'unknown'] || 0) + 1;
      if (meta.language) languages.add(meta.language);
      if (meta.is_configuration) score += 0.3;
      if (meta.is_test) { testImpact = true; score += 0.1; }
      if (fc.change_type === 'deleted') score += 0.2;
      if (fc.lines_added + fc.lines_removed > 100) score += 0.2;
      if (fc.lines_added + fc.lines_removed > 500) score += 0.3;
    }
    
    if (languages.size > 1) score += 0.3;
    if (commit.is_merge_commit) score += 0.5;
    if (commit.metadata?.message_analysis?.breaking_change) score += 1.0;
    
    let risk = 'low';
    if (score > 1.5) risk = 'medium';
    if (score > 3.0) risk = 'high';
    if (score > 5.0) risk = 'critical';
    
    return {
      complexity_score: Math.round(score * 100) / 100,
      risk_assessment: risk,
      file_categories: categories,
      languages_affected: Array.from(languages),
      test_coverage_impact: testImpact
    };
  }
}
