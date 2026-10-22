/**
 * Branch analysis utilities
 * Pure functions for classifying and analyzing git branches
 */

import { BranchType, BranchInfo } from '../../../types/git';

/**
 * Classify branch type from name
 */
export function classifyBranchType(branchName: string): BranchType {
  if (branchName.match(/^(main|master)$/)) return 'main';
  if (branchName.match(/^(feature|feat)\//)) return 'feature';
  if (branchName.match(/^(hotfix|fix)\//)) return 'hotfix';
  if (branchName.match(/^release\//)) return 'release';
  if (branchName.match(/^develop$/)) return 'develop';
  
  return 'feature';
}

/**
 * Find the default branch from a list of branches
 */
export function findDefaultBranch(branches: BranchInfo[]): string | undefined {
  return branches.find(b => b.is_default)?.branch_name ||
         branches.find(b => b.branch_name === 'main')?.branch_name ||
         branches.find(b => b.branch_name === 'master')?.branch_name;
}

/**
 * Get the most active file category from hotspots
 */
export function getMostActiveCategory(hotspots: Array<{ file_category: string; change_count: number }>): string {
  const categoryTotals: Record<string, number> = {};
  
  for (const hotspot of hotspots) {
    categoryTotals[hotspot.file_category] = 
      (categoryTotals[hotspot.file_category] || 0) + hotspot.change_count;
  }
  
  return Object.entries(categoryTotals)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'unknown';
}
