/**
 * Branch domain service
 * Handles branch info and management
 */

import { 
  GetBranchInfoRequest, 
  GetBranchInfoResponse, 
  BranchInfo 
} from '../../../../types/git';
import { GitClient } from '../../infra/git/GitClient';
import { BranchRepo } from '../../infra/db/BranchRepo';
import { classifyBranchType, findDefaultBranch } from '../../utils/branchAnalysis';
import { createServiceError } from '../../utils/errors';
import { logger } from '../../../../config/logger';

export class BranchService {
  /**
   * Get comprehensive branch information with statistics
   */
  static async getBranchInfo(request: GetBranchInfoRequest): Promise<GetBranchInfoResponse> {
    const { project_id, include_remote = false, include_stats = true } = request;
    
    try {
      logger.info(`🌿 BranchService.getBranchInfo - Project: ${project_id}`);
      
      const git = await GitClient.getGitInstance(project_id);
      
      const branchOptions = include_remote ? ['-a'] : ['-l'];
      const branches = await git.branch(branchOptions);
      
      const dbBranches = await BranchRepo.getAll(project_id);
      const dbBranchMap = new Map(dbBranches.map(b => [b.branch_name, b]));
      
      const branchInfoList: BranchInfo[] = [];
      
      for (const [branchName, branchData] of Object.entries(branches.branches)) {
        const dbBranch = dbBranchMap.get(branchName);
        
        const branchInfo: BranchInfo = {
          id: dbBranch?.id || '',
          project_id,
          branch_name: branchName,
          current_sha: branchData.commit,
          is_default: branchName === 'main' || branchName === 'master',
          is_protected: false,
          branch_type: classifyBranchType(branchName),
          commit_count: 0,
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
          is_current: branchData.current,
          ...dbBranch
        };
        
        if (include_stats && branchData.commit) {
          try {
            const lastCommitLog = await git.log({ from: branchName, maxCount: 1 });
            if (lastCommitLog.latest) {
              branchInfo.last_commit = {
                sha: lastCommitLog.latest.hash,
                message: lastCommitLog.latest.message,
                author: lastCommitLog.latest.author_name,
                date: new Date(lastCommitLog.latest.date)
              };
            }
          } catch (error) {
            logger.warn(`Could not get last commit for branch ${branchName}`, { error });
          }
        }
        
        branchInfoList.push(branchInfo);
      }
      
      return {
        branches: branchInfoList,
        current_branch: branches.current,
        default_branch: findDefaultBranch(branchInfoList) || '',
        total_count: branchInfoList.length
      };
    } catch (error) {
      throw createServiceError('GET_BRANCH_INFO_FAILED', `Failed to get branch info: ${error}`, request);
    }
  }
}
