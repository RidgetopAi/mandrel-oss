/**
 * TC003: Git Commit Data Collection Service - TypeScript Types
 * Comprehensive type definitions for git tracking in AIDIS
 * Based on TC002 database schema design
 */

// Core Git Data Types

export interface GitCommit {
  id: string;
  project_id: string;
  
  // Git identifiers
  commit_sha: string;
  short_sha: string;
  
  // Commit metadata
  message: string;
  author_name: string;
  author_email: string;
  author_date: Date;
  committer_name: string;
  committer_email: string;
  committer_date: Date;
  
  // Git context
  branch_name?: string;
  parent_shas: string[];
  is_merge_commit: boolean;
  
  // Change statistics
  files_changed: number;
  insertions: number;
  deletions: number;
  
  // Classification
  commit_type: CommitType;
  tags: string[];
  
  // AIDIS metadata
  metadata: Record<string, any>;
  
  // Timestamps
  created_at: Date;
  updated_at: Date;
}

export interface GitBranch {
  id: string;
  project_id: string;
  
  // Branch identification
  branch_name: string;
  current_sha?: string;
  
  // Branch metadata
  is_default: boolean;
  is_protected: boolean;
  branch_type: BranchType;
  upstream_branch?: string;
  
  // Statistics
  commit_count: number;
  last_commit_date?: Date;
  first_commit_date?: Date;
  
  // Relationships
  base_branch?: string;
  merge_target?: string;
  
  // AIDIS integration
  session_id?: string;
  description?: string;
  metadata: Record<string, any>;
  
  // Timestamps
  created_at: Date;
  updated_at: Date;
}

export interface GitFileChange {
  id: string;
  project_id: string;
  commit_id: string;
  
  // File identification
  file_path: string;
  old_file_path?: string; // For renames
  
  // Change details
  change_type: FileChangeType;
  lines_added: number;
  lines_removed: number;
  
  // File metadata
  is_binary: boolean;
  is_generated: boolean;
  file_size_bytes?: number | undefined;
  
  // AIDIS integration
  component_id?: string;
  metadata: Record<string, any>;
  
  // Timestamps
  created_at: Date;
}

export interface CommitSessionLink {
  id: string;
  project_id: string;
  commit_id: string;
  session_id: string;
  
  // Link metadata
  link_type: SessionLinkType;
  confidence_score: number; // 0.0 to 1.0
  
  // Correlation context
  context_ids: string[];
  decision_ids: string[];
  
  // Analysis data
  time_proximity_minutes?: number;
  author_match: boolean;
  content_similarity?: number;
  
  // AIDIS metadata
  metadata: Record<string, any>;
  
  // Timestamps
  created_at: Date;
}

// Enums and Type Unions

export type CommitType = 
  | 'feature' 
  | 'fix' 
  | 'docs' 
  | 'refactor' 
  | 'test' 
  | 'style' 
  | 'chore' 
  | 'merge';

export type BranchType = 
  | 'main' 
  | 'feature' 
  | 'hotfix' 
  | 'release' 
  | 'develop';

export type FileChangeType = 
  | 'added' 
  | 'modified' 
  | 'deleted' 
  | 'renamed' 
  | 'copied' 
  | 'typechange';

export type SessionLinkType = 
  | 'contributed' 
  | 'reviewed' 
  | 'planned' 
  | 'mentioned' 
  | 'related';

// Service Input/Output Types

export interface InitializeRepositoryRequest {
  project_id: string;
  repo_path: string;
  remote_url?: string;
}

export interface InitializeRepositoryResponse {
  success: boolean;
  project_id: string;
  repo_path: string;
  branch_count: number;
  initial_commits_collected: number;
  message?: string;
}

export interface CollectCommitDataRequest {
  project_id: string;
  limit?: number;
  since?: Date;
  branch?: string;
  force_refresh?: boolean;
}

export interface CollectCommitDataResponse {
  success: boolean;
  project_id: string;
  commits_collected: number;
  branches_updated: number;
  file_changes_tracked: number;
  processing_time_ms: number;
  errors?: string[];
}

export interface GetRecentCommitsRequest {
  project_id: string;
  hours: number;
  branch?: string;
  author?: string;
}

export interface GetRecentCommitsResponse {
  commits: GitCommit[];
  total_count: number;
  time_range_hours: number;
  branch_filter?: string;
  author_filter?: string;
}

export interface GetCurrentCommitInfoResponse {
  commit_sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  branch_name: string;
  is_clean: boolean;
  uncommitted_changes?: {
    staged_files: string[];
    modified_files: string[];
    untracked_files: string[];
  };
}

export interface GetBranchInfoRequest {
  project_id: string;
  include_remote?: boolean;
  include_stats?: boolean;
}

export interface GetBranchInfoResponse {
  branches: BranchInfo[];
  current_branch: string;
  default_branch?: string;
  total_count: number;
}

export interface BranchInfo extends GitBranch {
  is_current: boolean;
  ahead_count?: number;
  behind_count?: number;
  last_commit?: {
    sha: string;
    message: string;
    author: string;
    date: Date;
  };
}

export interface TrackFileChangesRequest {
  commit_sha: string;
  project_id: string;
  include_binary?: boolean;
  enhanced_metadata?: any;
}

export interface TrackFileChangesResponse {
  commit_id: string;
  file_changes: GitFileChange[];
  total_files: number;
  processing_time_ms: number;
}

export interface CorrelateCommitsWithSessionsRequest {
  project_id: string;
  since?: Date;
  confidence_threshold?: number; // Default 0.3
}

export interface CorrelateCommitsWithSessionsResponse {
  project_id: string;
  links_created: number;
  links_updated: number;
  high_confidence_links: number; // confidence > 0.7
  processing_time_ms: number;
  correlation_stats: {
    author_matches: number;
    time_proximity_matches: number;
    content_similarity_matches: number;
  };
}

// Analysis and Statistics Types

export interface GitProjectStats {
  project_id: string;
  project_name: string;
  
  // Commit statistics
  total_commits: number;
  contributors: number;
  commits_last_week: number;
  commits_last_month: number;
  
  // Branch statistics
  total_branches: number;
  active_branches: number; // branches with commits in last 30 days
  
  // File change statistics
  total_file_changes: number;
  most_changed_files: Array<{
    file_path: string;
    change_count: number;
    last_changed: Date;
  }>;
  
  // Developer activity
  top_contributors: Array<{
    author_email: string;
    author_name: string;
    commit_count: number;
    lines_contributed: number;
  }>;
  
  // Time range
  first_commit_date?: Date;
  last_commit_date?: Date;
}

export interface DeveloperProductivity {
  author_email: string;
  author_name: string;
  project_id: string;
  
  total_commits: number;
  total_insertions: number;
  total_deletions: number;
  total_files_changed: number;
  branches_contributed: number;
  
  first_commit: Date;
  last_commit: Date;
  commits_last_week: number;
  avg_lines_per_commit: number;
}

// Error and Status Types

export interface GitServiceError {
  code: string;
  message: string;
  details?: Record<string, any>;
  stack?: string;
}

export interface GitRepositoryStatus {
  is_git_repo: boolean;
  repo_path: string;
  current_branch: string;
  is_clean: boolean;
  has_remote: boolean;
  remote_url?: string;
  total_commits: number;
  untracked_files: number;
  staged_files: number;
  modified_files: number;
}

// Utility Types for Service Implementation

export interface CommitData {
  hash: string;
  date: string;
  message: string;
  author_name: string;
  author_email: string;
  refs: string;
  body: string;
  author_date_rel: string;
}

export interface FileChangeData {
  file: string;
  changes: number;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface BranchData {
  name: string;
  commit: string;
  label: string;
  current: boolean;
}

// Database Query Result Types

export interface GitCommitRow {
  id: string;
  project_id: string;
  commit_sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  committer_date: string;
  branch_name?: string;
  parent_shas: string[];
  is_merge_commit: boolean;
  files_changed: number;
  insertions: number;
  deletions: number;
  commit_type: string;
  tags: string[];
  metadata: any;
  created_at: string;
  updated_at: string;
}

export interface GitBranchRow {
  id: string;
  project_id: string;
  branch_name: string;
  current_sha?: string;
  is_default: boolean;
  is_protected: boolean;
  branch_type: string;
  upstream_branch?: string;
  commit_count: number;
  last_commit_date?: string;
  first_commit_date?: string;
  base_branch?: string;
  merge_target?: string;
  session_id?: string;
  description?: string;
  metadata: any;
  created_at: string;
  updated_at: string;
}

// Configuration Types

export interface GitServiceConfig {
  max_commits_per_collection: number;
  default_correlation_threshold: number;
  batch_size: number;
  enable_file_tracking: boolean;
  enable_session_correlation: boolean;
  ignore_patterns: string[];
  max_file_changes_per_commit: number;
}

export const DEFAULT_GIT_SERVICE_CONFIG: GitServiceConfig = {
  max_commits_per_collection: 1000,
  default_correlation_threshold: 0.3,
  batch_size: 50,
  enable_file_tracking: true,
  enable_session_correlation: true,
  ignore_patterns: [
    'node_modules/**',
    '.git/**',
    '*.log',
    'dist/**',
    'build/**',
    '.env*',
    '*.map'
  ],
  max_file_changes_per_commit: 100
};

// Enhanced metadata query types

export interface CommitQueryRequest {
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
}

export interface CommitQueryResponse {
  commits: GitCommit[];
  total_count: number;
  metadata_summary: {
    authors: string[];
    commit_types: Record<CommitType, number>;
    branches: string[];
    avg_files_changed: number;
    avg_lines_changed: number;
  };
}

export interface CommitMetadataAnalysisResponse {
  commit: GitCommit;
  file_changes: GitFileChange[];
  analysis: {
    complexity_score: number;
    risk_assessment: string;
    file_categories: Record<string, number>;
    languages_affected: string[];
    test_coverage_impact: boolean;
  };
}

export interface FileChangeHotspot {
  file_path: string;
  change_count: number;
  contributor_count: number;
  last_changed: Date;
  file_category: string;
  languages: string[];
  avg_change_size: number;
  risk_score: number;
}

export interface FileHotspotsResponse {
  hotspots: FileChangeHotspot[];
  summary: {
    total_hotspots: number;
    high_risk_files: number;
    most_active_category: string;
  };
}

// Enhanced commit metadata structure
export interface EnhancedCommitMetadata {
  parent_shas: string[];
  is_merge_commit: boolean;
  files_changed: number;
  insertions: number;
  deletions: number;
  branches: string[];
  primary_branch: string;
  commit_size: number;
  message_analysis: {
    type: CommitType;
    scope: string | null;
    breaking_change: boolean;
    conventional_commit: boolean;
    tags: string[];
    ticket_references: string[];
    co_authors: Array<{ name: string; email: string }>;
  };
  merge_info?: {
    parent_commits: string[];
    source_branch: string | null;
    target_branch: string | null;
    merge_strategy: string;
  };
  tree_hash?: string;
  gpg_signature: {
    key_id: string | null;
    signer: string | null;
  };
  commit_stats: {
    files_changed: number;
    insertions: number;
    deletions: number;
    file_stats: Array<{
      file_path: string;
      insertions: number;
      deletions: number;
      is_binary: boolean;
    }>;
  };
  processing_timestamp: string;
}

// Enhanced file change metadata structure
export interface EnhancedFileMetadata {
  file_extension: string | null;
  file_category: string;
  change_magnitude: string;
  is_configuration: boolean;
  is_documentation: boolean;
  is_test: boolean;
  language: string | null;
  processing_timestamp: string;
  enhanced_metadata?: {
    commit_context: any;
    is_merge_commit: boolean;
  };
}