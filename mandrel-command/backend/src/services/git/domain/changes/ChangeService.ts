/**
 * File change domain service
 * Handles tracking and analyzing file changes
 */

import { SimpleGit } from 'simple-git';
import { 
  GitFileChange, 
  FileChangeType,
  TrackFileChangesRequest,
  TrackFileChangesResponse 
} from '../../../../types/git';
import { GitClient } from '../../infra/git/GitClient';
import { CommitRepo } from '../../infra/db/CommitRepo';
import { ChangeRepo } from '../../infra/db/ChangeRepo';
import { analyzeFileChange, isGeneratedFile } from '../../utils/fileAnalysis';
import { createServiceError } from '../../utils/errors';
import { logger } from '../../../../config/logger';

export class FileChangeService {
  /**
   * Track file changes for a commit
   */
  static async trackFileChanges(request: TrackFileChangesRequest & { enhanced_metadata?: any }): Promise<TrackFileChangesResponse> {
    const { commit_sha, project_id, include_binary = false, enhanced_metadata } = request;
    const startTime = Date.now();
    
    try {
      logger.info(`📁 FileChangeService.trackFileChanges - Commit: ${commit_sha.substring(0, 12)}`);
      
      const git = await GitClient.getGitInstance(project_id);
      
      const commit_id = await CommitRepo.getIdBySha(project_id, commit_sha);
      if (!commit_id) {
        throw new Error(`Commit ${commit_sha} not found in database`);
      }
      
      let fileChanges: GitFileChange[] = [];
      
      if (enhanced_metadata?.commit_stats?.file_stats) {
        fileChanges = await this.processEnhancedStats(
          enhanced_metadata.commit_stats.file_stats,
          project_id,
          commit_id,
          commit_sha,
          git,
          include_binary
        );
      } else {
        const diffSummary = await git.diffSummary([commit_sha + '^', commit_sha]);
        
        for (const file of diffSummary.files) {
          if (file.binary && !include_binary) continue;
          
          const fileChange = await this.createFromDiff(file, project_id, commit_id, commit_sha, git);
          fileChanges.push(fileChange);
        }
      }
      
      const storedChanges = await ChangeRepo.createMany(fileChanges, enhanced_metadata);
      
      return {
        commit_id,
        file_changes: storedChanges,
        total_files: storedChanges.length,
        processing_time_ms: Date.now() - startTime
      };
    } catch (error) {
      throw createServiceError('TRACK_FILE_CHANGES_FAILED', `Failed to track file changes: ${error}`, request);
    }
  }

  /**
   * Process enhanced file stats
   */
  private static async processEnhancedStats(
    fileStats: any[],
    project_id: string,
    commit_id: string,
    commit_sha: string,
    git: SimpleGit,
    include_binary: boolean
  ): Promise<GitFileChange[]> {
    const fileChanges: GitFileChange[] = [];
    
    for (const stat of fileStats) {
      if (stat.is_binary && !include_binary) continue;
      
      const fileChange = await this.createFromStats(stat, project_id, commit_id, commit_sha, git);
      fileChanges.push(fileChange);
    }
    
    return fileChanges;
  }

  /**
   * Create file change from stats
   */
  private static async createFromStats(
    stat: any,
    project_id: string,
    commit_id: string,
    commit_sha: string,
    git: SimpleGit
  ): Promise<GitFileChange> {
    let changeType: FileChangeType = 'modified';
    if (stat.insertions > 0 && stat.deletions === 0) changeType = 'added';
    else if (stat.insertions === 0 && stat.deletions > 0) changeType = 'deleted';
    
    let oldFilePath = '';
    if (stat.file_path.includes(' => ')) {
      const parts = stat.file_path.split(' => ');
      oldFilePath = parts[0].replace(/\{.*?\}/, '');
      changeType = 'renamed';
    }
    
    const fileSizeBytes = await this.getFileSize(git, commit_sha, stat.file_path, changeType);
    const analysis = analyzeFileChange(stat.file_path, stat);
    
    return {
      id: '',
      project_id,
      commit_id,
      file_path: stat.file_path,
      old_file_path: oldFilePath,
      change_type: changeType,
      lines_added: stat.insertions,
      lines_removed: stat.deletions,
      is_binary: stat.is_binary,
      is_generated: isGeneratedFile(stat.file_path),
      file_size_bytes: fileSizeBytes,
      metadata: { ...analysis, processing_timestamp: new Date().toISOString() },
      created_at: new Date()
    };
  }

  /**
   * Create file change from diff summary
   */
  private static async createFromDiff(
    file: any,
    project_id: string,
    commit_id: string,
    commit_sha: string,
    git: SimpleGit
  ): Promise<GitFileChange> {
    const insertions = 'insertions' in file ? file.insertions : 0;
    const deletions = 'deletions' in file ? file.deletions : 0;
    
    let changeType: FileChangeType = 'modified';
    if (insertions > 0 && deletions === 0) changeType = 'added';
    else if (insertions === 0 && deletions > 0) changeType = 'deleted';
    
    let oldFilePath = '';
    if (file.file.includes(' => ')) {
      const parts = file.file.split(' => ');
      oldFilePath = parts[0].replace(/\{.*?\}/, '');
      changeType = 'renamed';
    }
    
    const fileSizeBytes = await this.getFileSize(git, commit_sha, file.file, changeType);
    const analysis = analyzeFileChange(file.file, { insertions, deletions, is_binary: file.binary });
    
    return {
      id: '',
      project_id,
      commit_id,
      file_path: file.file,
      old_file_path: oldFilePath,
      change_type: changeType,
      lines_added: insertions,
      lines_removed: deletions,
      is_binary: file.binary,
      is_generated: isGeneratedFile(file.file),
      file_size_bytes: fileSizeBytes,
      metadata: { ...analysis, processing_timestamp: new Date().toISOString() },
      created_at: new Date()
    };
  }

  /**
   * Get file size from git
   */
  private static async getFileSize(
    git: SimpleGit,
    commit_sha: string,
    filePath: string,
    changeType: FileChangeType
  ): Promise<number | undefined> {
    if (changeType === 'deleted') return undefined;
    
    try {
      const fileInfo = await git.raw(['ls-tree', '-l', commit_sha, '--', filePath]);
      const sizeMatch = fileInfo.match(/\s(\d+)\s/);
      return sizeMatch ? parseInt(sizeMatch[1]) : undefined;
    } catch {
      return undefined;
    }
  }
}
