// Core AIDIS database model types

export interface Project {
  id: string;
  name: string;
  description?: string;
  git_repo_url?: string;
  root_directory?: string;
  metadata?: Record<string, any>;
  created_at: string;
  last_updated: string;
}

export interface Context {
  id: string;
  project_id: string;
  session_id?: string;
  type: 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion';
  content: string;
  metadata?: Record<string, any>;
  tags: string[];
  relevance_score: number;
  embedding?: number[];
  created_at: string;
}

export interface Agent {
  id: string;
  project_id: string;
  name: string;
  type: string;
  capabilities: string[];
  status: 'active' | 'busy' | 'offline' | 'error';
  metadata?: Record<string, any>;
  registered_at: string;
  last_active: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  type: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  dependencies: string[];
  tags: string[];
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface TechnicalDecision {
  id: string;
  project_id: string;
  decision_type: 'architecture' | 'library' | 'framework' | 'pattern' | 'api_design' | 'database' | 'deployment' | 'security' | 'performance' | 'ui_ux' | 'testing' | 'tooling' | 'process' | 'naming_convention' | 'code_style';
  title: string;
  description: string;
  problem_statement: string;
  rationale: string;
  alternatives_considered: AlternativeOption[];
  impact_level: 'low' | 'medium' | 'high' | 'critical';
  affected_components: string[];
  outcome_status?: 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early';
  outcome_notes?: string;
  lessons_learned?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface AlternativeOption {
  name: string;
  pros: string[];
  cons: string[];
  reasonRejected: string;
}

export interface NamingEntry {
  id: string;
  project_id: string;
  entity_type: 'variable' | 'function' | 'class' | 'interface' | 'type' | 'component' | 'file' | 'directory' | 'module' | 'service' | 'endpoint' | 'database_table' | 'database_column' | 'config_key' | 'environment_var' | 'css_class' | 'html_id';
  canonical_name: string;
  aliases: string[];
  description?: string;
  context_tags: string[];
  created_at: string;
}

export interface CodeComponent {
  id: string;
  project_id: string;
  file_path: string;
  component_name: string;
  component_type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'component' | 'module';
  line_start: number;
  line_end: number;
  dependencies: string[];
  exports: string[];
  complexity_score?: number;
  metadata?: Record<string, any>;
  analyzed_at: string;
}

export interface Message {
  id: string;
  project_id: string;
  session_id: string;
  from_agent_id: string;
  to_agent_id?: string;
  message_type: 'info' | 'request' | 'response' | 'alert' | 'coordination';
  title?: string;
  content: string;
  task_refs: string[];
  context_refs: string[];
  metadata?: Record<string, any>;
  created_at: string;
  read_at?: string;
}
