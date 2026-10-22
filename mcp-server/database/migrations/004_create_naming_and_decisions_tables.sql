-- AIDIS Migration 004: Create Naming Registry and Technical Decisions Tables
--
-- This creates the core consistency enforcement systems:
-- - naming_registry: Prevents naming conflicts and enforces conventions
-- - technical_decisions: Records architectural decisions with full rationale
--
-- These tables solve the problems that KILL large projects:
-- 1. Naming inconsistencies that cause bugs and confusion
-- 2. Lost architectural knowledge that leads to repeated mistakes
-- 3. Context loss when team members leave or forget decisions
--
-- Author: the operator & AIDIS Team
-- Date: 2025-08-15

-- =============================================
-- NAMING REGISTRY TABLE
-- =============================================
-- This prevents naming chaos and enforces consistency across projects

CREATE TABLE IF NOT EXISTS naming_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- What type of entity is this? (variable, function, class, file, component, etc.)
    entity_type VARCHAR(50) NOT NULL CHECK (entity_type IN (
        'variable', 'function', 'class', 'interface', 'type', 'component', 
        'file', 'directory', 'module', 'service', 'endpoint', 'database_table', 
        'database_column', 'config_key', 'environment_var', 'css_class', 'html_id'
    )),
    
    -- The official, canonical name that should be used
    canonical_name VARCHAR(255) NOT NULL,
    
    -- Alternative names or variations (for migration/detection)
    aliases TEXT[] DEFAULT '{}',
    
    -- Description of what this entity represents
    description TEXT,
    
    -- Naming convention metadata
    naming_convention JSONB DEFAULT '{}'::jsonb, -- Pattern: camelCase, snake_case, PascalCase, etc.
    
    -- Usage tracking
    first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    usage_count INTEGER DEFAULT 1,
    
    -- Lifecycle management
    deprecated BOOLEAN DEFAULT FALSE,
    deprecated_reason TEXT,
    replacement_id UUID REFERENCES naming_registry(id), -- What to use instead
    
    -- Context and relationships
    context_tags TEXT[] DEFAULT '{}', -- Tags for categorization
    related_entities UUID[] DEFAULT '{}', -- Related naming entries
    
    -- Ensure uniqueness per project and type
    UNIQUE(project_id, entity_type, canonical_name)
);

-- =============================================  
-- TECHNICAL DECISIONS TABLE
-- =============================================
-- This records WHY we made choices, preventing repeated mistakes

CREATE TABLE IF NOT EXISTS technical_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    
    -- Decision classification
    decision_type VARCHAR(50) NOT NULL CHECK (decision_type IN (
        'architecture', 'library', 'framework', 'pattern', 'api_design', 
        'database', 'deployment', 'security', 'performance', 'ui_ux', 
        'testing', 'tooling', 'process', 'naming_convention', 'code_style'
    )),
    
    -- Core decision content
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    rationale TEXT NOT NULL, -- WHY we made this choice
    
    -- Decision context
    problem_statement TEXT, -- What problem were we solving?
    success_criteria TEXT, -- How do we know this worked?
    
    -- Alternatives analysis
    alternatives_considered JSONB DEFAULT '[]'::jsonb, -- [{name, pros, cons, reason_rejected}]
    
    -- Decision metadata
    decision_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    decided_by TEXT, -- Who made the decision (agent, team, person)
    stakeholders TEXT[], -- Who was involved/affected
    
    -- Lifecycle management
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'superseded', 'under_review')),
    superseded_by UUID REFERENCES technical_decisions(id),
    superseded_date TIMESTAMP WITH TIME ZONE,
    superseded_reason TEXT,
    
    -- Impact and importance
    impact_level VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (impact_level IN ('low', 'medium', 'high', 'critical')),
    affected_components TEXT[], -- What parts of the system are affected
    
    -- Organization and search
    tags TEXT[] DEFAULT '{}',
    category TEXT, -- Broader categorization
    
    -- Outcomes tracking
    outcome_status VARCHAR(50) DEFAULT 'unknown' CHECK (outcome_status IN ('unknown', 'successful', 'failed', 'mixed', 'too_early')),
    outcome_notes TEXT,
    lessons_learned TEXT
);

-- =============================================
-- PERFORMANCE INDEXES  
-- =============================================

-- Naming Registry Indexes
CREATE INDEX IF NOT EXISTS idx_naming_registry_project_type ON naming_registry(project_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_naming_registry_canonical_name ON naming_registry(canonical_name);
CREATE INDEX IF NOT EXISTS idx_naming_registry_aliases_gin ON naming_registry USING GIN(aliases);
CREATE INDEX IF NOT EXISTS idx_naming_registry_usage ON naming_registry(usage_count DESC, last_used DESC);
CREATE INDEX IF NOT EXISTS idx_naming_registry_deprecated ON naming_registry(deprecated, project_id);
CREATE INDEX IF NOT EXISTS idx_naming_registry_tags_gin ON naming_registry USING GIN(context_tags);

-- Technical Decisions Indexes
CREATE INDEX IF NOT EXISTS idx_technical_decisions_project_type ON technical_decisions(project_id, decision_type);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_status ON technical_decisions(status, project_id);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_impact ON technical_decisions(impact_level, project_id);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_date ON technical_decisions(decision_date DESC);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_tags_gin ON technical_decisions USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_components_gin ON technical_decisions USING GIN(affected_components);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_naming_registry_description_fts ON naming_registry USING GIN(to_tsvector('english', description));
CREATE INDEX IF NOT EXISTS idx_technical_decisions_content_fts ON technical_decisions USING GIN(
    to_tsvector('english', title || ' ' || description || ' ' || rationale || ' ' || COALESCE(problem_statement, ''))
);

-- =============================================
-- SAMPLE DATA FOR TESTING
-- =============================================

DO $$
DECLARE
    aidis_project_id UUID;
BEGIN
    -- Get the AIDIS bootstrap project ID
    SELECT id INTO aidis_project_id FROM projects WHERE name = 'aidis-bootstrap';
    
    IF aidis_project_id IS NOT NULL THEN
        -- Insert sample naming conventions
        INSERT INTO naming_registry (project_id, entity_type, canonical_name, description, naming_convention, context_tags) VALUES
        (aidis_project_id, 'variable', 'contextId', 'Unique identifier for stored contexts', '{"pattern": "camelCase", "suffix": "Id"}', ARRAY['id', 'context']),
        (aidis_project_id, 'variable', 'projectName', 'Human-readable project name', '{"pattern": "camelCase", "type": "string"}', ARRAY['project', 'name']),
        (aidis_project_id, 'function', 'generateEmbedding', 'Creates vector embeddings from text', '{"pattern": "camelCase", "prefix": "generate"}', ARRAY['embedding', 'ai']),
        (aidis_project_id, 'interface', 'ContextEntry', 'TypeScript interface for context objects', '{"pattern": "PascalCase", "suffix": "Entry"}', ARRAY['interface', 'context']),
        (aidis_project_id, 'component', 'ProjectSwitcher', 'React component for switching projects', '{"pattern": "PascalCase", "type": "component"}', ARRAY['component', 'project']);
        
        -- Insert sample technical decisions
        INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale, alternatives_considered, impact_level, affected_components, tags) VALUES
        (
            aidis_project_id, 
            'database', 
            'Use PostgreSQL with pgvector for context storage',
            'Selected PostgreSQL with pgvector extension as the primary database for AIDIS context storage and semantic search.',
            'PostgreSQL provides ACID compliance, mature ecosystem, and pgvector enables efficient vector similarity search without external dependencies.',
            '[
                {"name": "MongoDB with vector search", "pros": ["Document-oriented", "Flexible schema"], "cons": ["Less mature vector support", "No ACID"], "reason_rejected": "Vector search capabilities not as advanced"},
                {"name": "Pinecone + PostgreSQL", "pros": ["Best vector performance", "Managed service"], "cons": ["Extra cost", "External dependency", "Data split across systems"], "reason_rejected": "Increased complexity and cost"},
                {"name": "SQLite with custom vectors", "pros": ["Simple", "Embedded"], "cons": ["No concurrent access", "Limited scalability"], "reason_rejected": "Not suitable for multi-agent scenarios"}
            ]'::jsonb,
            'high',
            ARRAY['database', 'context_storage', 'search', 'embeddings'],
            ARRAY['database', 'postgresql', 'pgvector', 'architecture']
        ),
        (
            aidis_project_id, 
            'library', 
            'Use local embeddings with Transformers.js',
            'Implemented local text embedding generation using Transformers.js instead of OpenAI API calls.',
            'Local embeddings eliminate API costs, enable offline operation, and provide consistent performance without rate limits.',
            '[
                {"name": "OpenAI Embeddings API", "pros": ["High quality", "1536 dimensions", "Proven"], "cons": ["API costs", "Rate limits", "Network dependency"], "reason_rejected": "Ongoing costs would be prohibitive for high-volume usage"},
                {"name": "Sentence Transformers (Python)", "pros": ["Many models", "High quality"], "cons": ["Python dependency", "Complex integration"], "reason_rejected": "Adds deployment complexity"},
                {"name": "Cohere Embeddings", "pros": ["Good quality", "API"], "cons": ["Still has API costs", "Less ecosystem"], "reason_rejected": "Similar cost issues to OpenAI"}
            ]'::jsonb,
            'high',
            ARRAY['embeddings', 'context_storage', 'search', 'api_integration'],
            ARRAY['embeddings', 'transformers', 'local', 'cost-optimization']
        ),
        (
            aidis_project_id, 
            'architecture', 
            'MCP protocol for AI agent integration',
            'Adopted Model Context Protocol (MCP) as the standard interface for AI agent communication with AIDIS.',
            'MCP provides standardized tool calling, resource access, and is supported by major AI systems like Claude and ChatGPT.',
            '[
                {"name": "REST API", "pros": ["Universal", "Simple", "Well understood"], "cons": ["No standardization", "Custom integration needed"], "reason_rejected": "Would require custom integration for each AI system"},
                {"name": "GraphQL API", "pros": ["Flexible queries", "Type safety", "Efficient"], "cons": ["More complex", "Not standard for AI tools"], "reason_rejected": "Overkill for tool-calling use case"},
                {"name": "gRPC", "pros": ["Type safety", "Performance", "Streaming"], "cons": ["Complex setup", "Not AI-agent friendly"], "reason_rejected": "Too low-level for AI agent integration"}
            ]'::jsonb,
            'critical',
            ARRAY['api', 'integration', 'ai_agents', 'protocol'],
            ARRAY['mcp', 'protocol', 'ai-agents', 'integration']
        );
        
        RAISE NOTICE 'Sample naming registry and technical decisions data inserted successfully';
    END IF;
END $$;

-- Verify migration success
SELECT 'Migration 004 completed successfully' as status;
SELECT 
    (SELECT COUNT(*) FROM naming_registry) as naming_entries,
    (SELECT COUNT(*) FROM technical_decisions) as decision_entries;
