// Common utility types and enums

export type UUID = string;
export type Timestamp = string;
export type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
export interface JSONObject {
  [x: string]: JSONValue;
}
export interface JSONArray extends Array<JSONValue> {}

// Status types
export type ProjectStatus = 'active' | 'inactive' | 'archived';
export type AgentStatus = 'active' | 'busy' | 'offline' | 'error';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

// Context types
export type ContextType = 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion';

// Decision types
export type DecisionType = 
  | 'architecture' 
  | 'library' 
  | 'framework' 
  | 'pattern' 
  | 'api_design' 
  | 'database' 
  | 'deployment' 
  | 'security' 
  | 'performance' 
  | 'ui_ux' 
  | 'testing' 
  | 'tooling' 
  | 'process' 
  | 'naming_convention' 
  | 'code_style';

export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';

export type OutcomeStatus = 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early';

// Entity types for naming registry
export type EntityType = 
  | 'variable' 
  | 'function' 
  | 'class' 
  | 'interface' 
  | 'type' 
  | 'component' 
  | 'file' 
  | 'directory' 
  | 'module' 
  | 'service' 
  | 'endpoint' 
  | 'database_table' 
  | 'database_column' 
  | 'config_key' 
  | 'environment_var' 
  | 'css_class' 
  | 'html_id';

// Code component types
export type ComponentType = 
  | 'function' 
  | 'class' 
  | 'interface' 
  | 'type' 
  | 'variable' 
  | 'constant' 
  | 'component' 
  | 'module';

// Message types
export type MessageType = 'info' | 'request' | 'response' | 'alert' | 'coordination';

// Database connection status
export type DatabaseStatus = 'connected' | 'disconnected' | 'error';

// Sorting options
export type SortOrder = 'asc' | 'desc';

// Environment types
export type Environment = 'development' | 'staging' | 'production' | 'test';

// Error severity
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

// UI Theme types
export type Theme = 'light' | 'dark' | 'auto';

// File types for code analysis
export type FileType = 
  | 'typescript' 
  | 'javascript' 
  | 'python' 
  | 'java' 
  | 'go' 
  | 'rust' 
  | 'cpp' 
  | 'csharp' 
  | 'php' 
  | 'ruby' 
  | 'sql' 
  | 'json' 
  | 'yaml' 
  | 'markdown' 
  | 'unknown';

// Generic filter interface
export interface Filter {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_in';
  value: any;
}

// Configuration interface
export interface Config {
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  server: {
    port: number;
    cors_origin: string;
    jwt_secret?: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
  };
}
