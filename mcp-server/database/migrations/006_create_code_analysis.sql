-- Migration 006: Create Code Analysis System
-- This migration adds tables for code structure analysis and dependency tracking

-- Code components: Track functions, classes, modules, etc.
CREATE TABLE code_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    component_type VARCHAR(100) NOT NULL, -- function, class, interface, module, variable, etc.
    name VARCHAR(500) NOT NULL,
    signature TEXT, -- function signature, class definition, etc.
    start_line INTEGER,
    end_line INTEGER,
    complexity_score INTEGER DEFAULT 0,
    lines_of_code INTEGER DEFAULT 0,
    documentation TEXT,
    is_exported BOOLEAN DEFAULT FALSE,
    is_deprecated BOOLEAN DEFAULT FALSE,
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, file_path, name, component_type)
);

-- Code dependencies: Track relationships between components
CREATE TABLE code_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_component_id UUID NOT NULL REFERENCES code_components(id) ON DELETE CASCADE,
    to_component_id UUID REFERENCES code_components(id) ON DELETE CASCADE,
    dependency_type VARCHAR(100) NOT NULL, -- import, call, inheritance, interface, reference
    import_path TEXT, -- for external dependencies
    import_alias VARCHAR(255),
    is_external BOOLEAN DEFAULT FALSE, -- true for npm packages, etc.
    confidence_score FLOAT DEFAULT 1.0, -- how certain we are about this dependency
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Code analysis sessions: Track when code was analyzed
CREATE TABLE code_analysis_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analyzer_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    session_type VARCHAR(100) NOT NULL DEFAULT 'full', -- full, incremental, targeted
    files_analyzed TEXT[] DEFAULT '{}',
    components_found INTEGER DEFAULT 0,
    dependencies_found INTEGER DEFAULT 0,
    analysis_duration_ms INTEGER,
    status VARCHAR(50) NOT NULL DEFAULT 'completed', -- running, completed, failed, cancelled
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- File analysis cache: Store file analysis results
CREATE TABLE file_analysis_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_hash VARCHAR(64) NOT NULL, -- SHA-256 of file content
    language VARCHAR(50),
    analysis_result JSONB NOT NULL, -- parsed AST/structure data
    components_count INTEGER DEFAULT 0,
    dependencies_count INTEGER DEFAULT 0,
    complexity_total INTEGER DEFAULT 0,
    lines_of_code INTEGER DEFAULT 0,
    last_modified TIMESTAMP WITH TIME ZONE,
    analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, file_path, file_hash)
);

-- Code metrics: Track code quality metrics over time
CREATE TABLE code_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT,
    component_id UUID REFERENCES code_components(id) ON DELETE CASCADE,
    metric_type VARCHAR(100) NOT NULL, -- complexity, coverage, duplication, maintainability
    metric_name VARCHAR(255) NOT NULL,
    metric_value FLOAT NOT NULL,
    threshold_min FLOAT,
    threshold_max FLOAT,
    status VARCHAR(50) DEFAULT 'ok', -- ok, warning, critical
    metadata JSONB DEFAULT '{}',
    measured_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_code_components_project ON code_components(project_id);
CREATE INDEX idx_code_components_file ON code_components(file_path);
CREATE INDEX idx_code_components_type ON code_components(component_type);
CREATE INDEX idx_code_components_name ON code_components(name);
CREATE INDEX idx_code_components_exported ON code_components(is_exported);
CREATE INDEX idx_code_components_updated ON code_components(updated_at);

CREATE INDEX idx_code_dependencies_project ON code_dependencies(project_id);
CREATE INDEX idx_code_dependencies_from ON code_dependencies(from_component_id);
CREATE INDEX idx_code_dependencies_to ON code_dependencies(to_component_id);
CREATE INDEX idx_code_dependencies_type ON code_dependencies(dependency_type);
CREATE INDEX idx_code_dependencies_external ON code_dependencies(is_external);

CREATE INDEX idx_code_analysis_sessions_project ON code_analysis_sessions(project_id);
CREATE INDEX idx_code_analysis_sessions_agent ON code_analysis_sessions(analyzer_agent_id);
CREATE INDEX idx_code_analysis_sessions_status ON code_analysis_sessions(status);
CREATE INDEX idx_code_analysis_sessions_started ON code_analysis_sessions(started_at);

CREATE INDEX idx_file_analysis_cache_project ON file_analysis_cache(project_id);
CREATE INDEX idx_file_analysis_cache_file ON file_analysis_cache(file_path);
CREATE INDEX idx_file_analysis_cache_hash ON file_analysis_cache(file_hash);
CREATE INDEX idx_file_analysis_cache_language ON file_analysis_cache(language);
CREATE INDEX idx_file_analysis_cache_analyzed ON file_analysis_cache(analyzed_at);

CREATE INDEX idx_code_metrics_project ON code_metrics(project_id);
CREATE INDEX idx_code_metrics_component ON code_metrics(component_id);
CREATE INDEX idx_code_metrics_type ON code_metrics(metric_type);
CREATE INDEX idx_code_metrics_name ON code_metrics(metric_name);
CREATE INDEX idx_code_metrics_status ON code_metrics(status);
CREATE INDEX idx_code_metrics_measured ON code_metrics(measured_at);

-- GIN indexes for array columns
CREATE INDEX idx_code_components_tags ON code_components USING GIN(tags);
CREATE INDEX idx_code_analysis_sessions_files ON code_analysis_sessions USING GIN(files_analyzed);

-- Full-text search for code documentation
CREATE INDEX idx_code_components_documentation_fts ON code_components USING GIN(to_tsvector('english', documentation));
