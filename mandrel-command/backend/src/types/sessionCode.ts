/**
 * TC006: Session-Code Bridge API Types
 * TypeScript interfaces for session-code correlation and analysis endpoints
 */

export interface SessionCodeActivity {
  session: SessionCodeSession;
  code_activity: CodeActivitySummary;
  analysis_sessions: CodeAnalysisSessionSummary[];
  metadata: ActivityMetadata;
}

export interface SessionCodeSession {
  id: string;
  project_id: string;
  project_name?: string;
  session_type?: string;
  started_at: string;
  ended_at?: string;
  duration_minutes: number;
}

export interface CodeActivitySummary {
  total_components: number;
  components: SessionCodeComponent[];
  git_commits: SessionGitCommit[];
  commits_contributed: number;
  git_correlation_confidence: number;
}

export interface SessionCodeComponent {
  id: string;
  file_path: string;
  component_type: string;
  name: string;
  lines_of_code: number;
  complexity_score?: number;
  analyzed_at: string;
}

export interface SessionGitCommit {
  id: string;
  commit_sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  confidence_score: number;
  link_type: string;
  time_proximity_minutes?: number;
  author_match: boolean;
  file_changes?: GitFileChange[];
}

export interface GitFileChange {
  commit_id: string;
  file_path: string;
  old_file_path?: string;
  change_type: 'added' | 'modified' | 'deleted' | 'renamed';
  lines_added: number;
  lines_removed: number;
  is_binary: boolean;
  is_generated: boolean;
}

export interface CodeAnalysisSessionSummary {
  id: string;
  session_type: string;
  files_analyzed: string[];
  components_found: number;
  dependencies_found: number;
  analysis_duration_ms?: number;
  status: string;
  started_at: string;
  completed_at?: string;
  commit_sha?: string;
  branch_name?: string;
  working_directory?: string;
  git_status_clean?: boolean;
  files_changed_count: number;
  new_components_count: number;
  updated_components_count: number;
  quality_score?: number;
  trigger_type: string;
  auto_triggered: boolean;
  metadata?: any;
  metrics?: CodeMetric[];
}

export interface CodeMetric {
  analysis_session_id: string;
  metric_name: string;
  metric_value: string;
  component_id: string;
  component_name: string;
  component_file_path: string;
}

export interface ActivityMetadata {
  last_updated: string;
  analysis_count: number;
}

export interface TriggerCodeAnalysisRequest {
  sessionId?: string;
  analysisScope?: 'full' | 'incremental' | 'targeted' | 'file_specific';
  targetFiles?: string[];
  includeMetrics?: boolean;
  gitContext?: boolean;
}

export interface TriggerCodeAnalysisResponse {
  analysis_session_id: string;
  session_id: string;
  project_id: string;
  analysis_scope: string;
  target_files: string[];
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: string;
  git_context: GitContextInfo;
  message: string;
}

export interface GitContextInfo {
  commit_sha?: string;
  branch_name?: string;
  is_clean?: boolean;
  working_directory?: string;
}

export interface SessionCommitsResponse {
  session_id: string;
  project_id: string;
  commits: SessionGitCommit[];
  summary: CommitsSummary;
}

export interface CommitsSummary {
  total_commits: number;
  confidence_threshold: number;
  average_confidence: number;
  high_confidence_commits: number;
  author_matched_commits: number;
  time_range: {
    earliest: string;
    latest: string;
  } | null;
}

export interface CorrelateSessionRequest {
  sessionId: string;
  forceRefresh?: boolean;
  confidenceThreshold?: number;
  scope?: 'session' | 'project';
}

export interface CorrelateSessionResponse {
  session_id: string;
  project_id: string;
  correlation_result: CorrelationResult;
  scope: string;
  confidence_threshold: number;
  force_refresh: boolean;
  timestamp: string;
}

export interface CorrelationResult {
  success: boolean;
  linksCreated: number;
  linksUpdated: number;
  confidence: number;
  message: string;
}

export interface SessionMetricsRequest {
  metricType?: string;
  aggregateLevel?: 'session' | 'component' | 'file';
}

export interface SessionMetricsResponse {
  session_id: string;
  project_id: string;
  aggregate_level: string;
  metric_type_filter?: string;
  session_metrics: SessionMetricsSummary;
  aggregated_metrics: Record<string, any>;
  analysis_sessions: CodeAnalysisSessionSummary[];
  raw_metrics_count: number;
}

export interface SessionMetricsSummary {
  total_analysis_sessions: number;
  total_components_analyzed: number;
  total_files_analyzed: number;
  total_analysis_time_ms: number;
  average_quality_score?: number;
  metric_types_collected: string[];
  time_range: {
    first_analysis?: string;
    last_analysis?: string;
  };
}

export interface AggregatedMetric {
  total: number;
  average: number;
  min: number;
  max: number;
  count: number;
  components_affected: number;
}

export interface ComponentMetrics {
  component_name: string;
  file_path: string;
  component_type: string;
  metrics: Record<string, number>;
}

export interface SessionCodeSummary {
  session: SessionCodeSession;
  code_activity: CodeActivitySummary;
  analysis_sessions: CodeAnalysisSessionSummary[];
  summary: {
    total_analysis_sessions: number;
    total_files_analyzed: number;
    total_components_found: number;
    average_quality_score?: number;
  };
}

// API Response wrapper types
export interface SessionCodeApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

// Error types
export interface SessionCodeError {
  code: string;
  message: string;
  details?: any;
}

// Query parameter types
export interface GetCommitsQuery {
  includeFileChanges?: boolean;
  confidenceThreshold?: number;
}

export interface GetMetricsQuery {
  metricType?: string;
  aggregateLevel?: 'session' | 'component' | 'file';
}

// Configuration types
export interface SessionCodeConfig {
  defaultConfidenceThreshold: number;
  maxAnalysisFiles: number;
  analysisTimeout: number;
  enableGitCorrelation: boolean;
  enableMetricsCollection: boolean;
}