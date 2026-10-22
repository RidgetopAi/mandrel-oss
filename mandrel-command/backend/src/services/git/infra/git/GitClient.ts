/**
 * Git client wrapper for simple-git operations
 * Provides a centralized interface for all git CLI operations
 */

import { simpleGit, SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs';
import { db as pool } from '../../../../database/connection';

/**
 * GitClient: Wrapper for simple-git with caching and project integration
 */
export class GitClient {
  private static repositoryCache = new Map<string, SimpleGit>();

  /**
   * Get or create a git instance for a project
   */
  static async getGitInstance(project_id: string): Promise<SimpleGit> {
    // Check cache first
    if (this.repositoryCache.has(project_id)) {
      return this.repositoryCache.get(project_id)!;
    }
    
    // Get repository path from project
    const project = await pool.query(
      'SELECT root_directory, metadata FROM projects WHERE id = $1',
      [project_id]
    );
    
    if (project.rows.length === 0) {
      throw new Error(`Project ${project_id} not found`);
    }
    
    const projectData = project.rows[0];
    const repoPath = projectData.metadata?.git_repo_path || projectData.root_directory;
    
    if (!repoPath) {
      throw new Error(`No git repository path configured for project ${project_id}`);
    }
    
    const git = simpleGit(repoPath);
    this.repositoryCache.set(project_id, git);
    
    return git;
  }

  /**
   * Create a new git instance for a specific path
   */
  static createGitInstance(repoPath: string): SimpleGit {
    const resolvedPath = path.resolve(repoPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Repository path does not exist: ${resolvedPath}`);
    }
    return simpleGit(resolvedPath);
  }

  /**
   * Cache a git instance for a project
   */
  static cacheInstance(project_id: string, git: SimpleGit): void {
    this.repositoryCache.set(project_id, git);
  }

  /**
   * Clear a cached git instance
   */
  static clearCache(project_id: string): void {
    this.repositoryCache.delete(project_id);
  }

  /**
   * Clear all cached git instances
   */
  static clearAllCaches(): void {
    this.repositoryCache.clear();
  }

  /**
   * Check if a path is a git repository
   */
  static async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      const git = simpleGit(repoPath);
      return await git.checkIsRepo();
    } catch {
      return false;
    }
  }

  /**
   * Get remote URL for a repository
   */
  static async getRemoteUrl(git: SimpleGit): Promise<string | undefined> {
    try {
      const remotes = await git.getRemotes(true);
      return remotes[0]?.refs?.fetch;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate project exists
   */
  static async validateProject(project_id: string): Promise<any> {
    const result = await pool.query('SELECT * FROM projects WHERE id = $1', [project_id]);
    return result.rows[0];
  }

  /**
   * Update project git info in metadata
   */
  static async updateProjectGitInfo(project_id: string, gitInfo: Record<string, any>): Promise<void> {
    await pool.query(`
      UPDATE projects 
      SET metadata = COALESCE(metadata, '{}') || $2::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [project_id, JSON.stringify(gitInfo)]);
  }
}
