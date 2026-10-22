export type UUID = string;
export type Timestamp = string;
export type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
export interface JSONObject {
    [x: string]: JSONValue;
}
export interface JSONArray extends Array<JSONValue> {
}
export type ProjectStatus = 'active' | 'inactive' | 'archived';
export type AgentStatus = 'active' | 'busy' | 'offline' | 'error';
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ContextType = 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion';
export type DecisionType = 'architecture' | 'library' | 'framework' | 'pattern' | 'api_design' | 'database' | 'deployment' | 'security' | 'performance' | 'ui_ux' | 'testing' | 'tooling' | 'process' | 'naming_convention' | 'code_style';
export type ImpactLevel = 'low' | 'medium' | 'high' | 'critical';
export type OutcomeStatus = 'unknown' | 'successful' | 'failed' | 'mixed' | 'too_early';
export type EntityType = 'variable' | 'function' | 'class' | 'interface' | 'type' | 'component' | 'file' | 'directory' | 'module' | 'service' | 'endpoint' | 'database_table' | 'database_column' | 'config_key' | 'environment_var' | 'css_class' | 'html_id';
export type ComponentType = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'component' | 'module';
export type MessageType = 'info' | 'request' | 'response' | 'alert' | 'coordination';
export type DatabaseStatus = 'connected' | 'disconnected' | 'error';
export type SortOrder = 'asc' | 'desc';
export type Environment = 'development' | 'staging' | 'production' | 'test';
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type Theme = 'light' | 'dark' | 'auto';
export type FileType = 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'rust' | 'cpp' | 'csharp' | 'php' | 'ruby' | 'sql' | 'json' | 'yaml' | 'markdown' | 'unknown';
export interface Filter {
    field: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'not_in';
    value: any;
}
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
//# sourceMappingURL=common.d.ts.map