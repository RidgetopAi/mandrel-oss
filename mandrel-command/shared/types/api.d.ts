export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: {
        message: string;
        code?: string;
        details?: any;
    };
    meta?: {
        total?: number;
        page?: number;
        limit?: number;
        timestamp: string;
    };
}
export interface PaginationParams {
    page?: number;
    limit?: number;
    offset?: number;
}
export interface SearchParams extends PaginationParams {
    query?: string;
    filters?: Record<string, any>;
    sort?: string;
    sortOrder?: 'asc' | 'desc';
}
export interface HealthCheckResponse {
    status: 'healthy' | 'unhealthy' | 'degraded';
    timestamp: string;
    uptime: number;
    memory: NodeJS.MemoryUsage;
    version: string;
    services?: {
        database?: 'connected' | 'disconnected' | 'error';
        mcp?: 'connected' | 'disconnected' | 'error';
    };
}
export interface CreateProjectRequest {
    name: string;
    description?: string;
    git_repo_url?: string;
    root_directory?: string;
    metadata?: Record<string, any>;
}
export interface UpdateProjectRequest {
    name?: string;
    description?: string;
    git_repo_url?: string;
    root_directory?: string;
    metadata?: Record<string, any>;
}
export interface CreateContextRequest {
    project_id?: string;
    session_id?: string;
    type: 'code' | 'decision' | 'error' | 'discussion' | 'planning' | 'completion';
    content: string;
    metadata?: Record<string, any>;
    tags?: string[];
    relevance_score?: number;
}
export interface SearchContextRequest extends SearchParams {
    project_id?: string;
    type?: string;
    tags?: string[];
    min_similarity?: number;
}
export interface CreateAgentRequest {
    name: string;
    type?: string;
    capabilities?: string[];
    metadata?: Record<string, any>;
}
export interface UpdateAgentRequest {
    status?: 'active' | 'busy' | 'offline' | 'error';
    metadata?: Record<string, any>;
}
export interface CreateTaskRequest {
    title: string;
    description?: string;
    type?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assigned_to?: string;
    dependencies?: string[];
    tags?: string[];
    metadata?: Record<string, any>;
}
export interface UpdateTaskRequest {
    title?: string;
    description?: string;
    status?: 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    assigned_to?: string;
    dependencies?: string[];
    tags?: string[];
    metadata?: Record<string, any>;
}
export interface ProjectStats {
    total_contexts: number;
    total_agents: number;
    total_tasks: number;
    total_decisions: number;
    total_naming_entries: number;
    total_code_components: number;
    active_agents: number;
    completed_tasks: number;
    last_activity: string;
}
export interface SystemStats {
    total_projects: number;
    total_contexts: number;
    total_agents: number;
    total_tasks: number;
    database_size: string;
    uptime: number;
    memory_usage: NodeJS.MemoryUsage;
}
//# sourceMappingURL=api.d.ts.map