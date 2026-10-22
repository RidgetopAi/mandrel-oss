import type { SessionEntity } from '../api/generated';

export interface Session extends SessionEntity {
  // SessionEntity now has all the fields we need, but we can add overrides if needed

  // Git integration (not in SessionEntity)
  active_branch?: string;
  working_commit_sha?: string;
}

export interface SessionDetail extends Session {
  session_id?: string;  // Backend returns session_id instead of id
  start_time?: string;  // Backend also uses start_time
  end_time?: string;    // Backend also uses end_time
  contexts?: Array<{
    id: string;
    // The Command backend serialises `context_type`; older shapes used `type`.
    context_type?: string;
    type?: string;
    content: string;
    created_at: string;
    tags?: string[];
  }>;
  duration?: number;
  metadata?: Record<string, unknown>;

  // Detail activity contract served by GET /api/sessions/:id (SessionDetailService).
  // The list read model omits these; the detail endpoint fills them in.
  decisions_created?: number;
  tasks_completed?: number;
  tasks_updated?: number;
  decisions?: Array<{
    id: string;
    decision_type?: string;
    title: string;
    description?: string;
    status?: string;
    impact_level?: string;
    created_at: string;
  }>;
  tasks?: Array<{
    id: string;
    title: string;
    type?: string;
    status?: string;
    priority?: string;
    created_at: string;
    completed_at?: string;
  }>;
  linked_commits?: Array<{
    id: string;
    commit_sha: string;
    short_sha: string;
    message: string;
    author_name?: string;
    author_email?: string;
    author_date: string;
    confidence_score?: number;
    link_type?: string;
    author_match?: boolean;
  }>;
  commits_contributed?: number;
  git_correlation_confidence?: number;
}

export interface UpdateSessionRequest {
  title?: string;
  description?: string;
  session_goal?: string;
  tags?: string[];
  ai_model?: string;
  project_id?: string;
  session_type?: 'mcp-server' | 'AI Model';
}

export interface SessionFile {
  id: string;
  session_id: string;
  file_path: string;
  lines_added: number;
  lines_deleted: number;
  source: 'tool' | 'git' | 'manual';
  first_modified_at: string;
  last_modified_at: string;
}

export interface FileSyncResponse {
  success: boolean;
  data?: {
    sessionId: string;
    filesProcessed: number;
    totalLinesAdded: number;
    totalLinesDeleted: number;
    netChange: number;
    message: string;
  };
  error?: string;
}
