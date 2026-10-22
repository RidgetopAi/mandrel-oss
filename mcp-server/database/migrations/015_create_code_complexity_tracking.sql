-- TC015: Code Complexity Tracking System
-- Comprehensive system to track code complexity evolution and identify hotspots
-- 
-- Features:
-- 1. Multi-dimensional complexity analysis (cyclomatic, cognitive, Halstead, etc.)
-- 2. Real-time complexity monitoring via git commits
-- 3. Complexity trend analysis and forecasting  
-- 4. Complexity threshold alerting and regression detection
-- 5. Refactoring opportunity identification
-- 6. Technical debt quantification through complexity metrics
--
-- Performance: Optimized for sub-100ms queries with proper indexing

-- ============================================================================
-- COMPLEXITY ANALYSIS SESSIONS
-- ============================================================================

-- Track complexity analysis sessions for each project
CREATE TABLE IF NOT EXISTS complexity_analysis_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    commit_sha VARCHAR(40), -- Git commit that triggered this analysis
    analysis_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    analysis_trigger VARCHAR(50) NOT NULL CHECK (analysis_trigger IN ('manual', 'git_commit', 'scheduled', 'threshold_breach', 'batch_analysis')),
    analyzer_version VARCHAR(20) DEFAULT 'tc015_v1.0',
    
    -- Performance metrics
    execution_time_ms INTEGER NOT NULL DEFAULT 0,
    files_analyzed INTEGER NOT NULL DEFAULT 0,
    functions_analyzed INTEGER NOT NULL DEFAULT 0,
    classes_analyzed INTEGER NOT NULL DEFAULT 0,
    complexity_metrics_calculated INTEGER NOT NULL DEFAULT 0,
    
    -- Analysis summary
    total_complexity_score DECIMAL(10, 4) DEFAULT 0,
    avg_complexity_score DECIMAL(8, 4) DEFAULT 0,
    max_complexity_score DECIMAL(8, 4) DEFAULT 0,
    hotspots_identified INTEGER DEFAULT 0,
    threshold_violations INTEGER DEFAULT 0,
    refactoring_opportunities INTEGER DEFAULT 0,
    
    -- Quality indicators
    analysis_completeness_score DECIMAL(4, 3) DEFAULT 0, -- 0-1 scale
    confidence_score DECIMAL(4, 3) DEFAULT 0, -- 0-1 scale
    data_freshness_hours INTEGER DEFAULT 0,
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
    error_message TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optimize for recent sessions and project queries
CREATE INDEX idx_complexity_analysis_sessions_project_timestamp ON complexity_analysis_sessions(project_id, analysis_timestamp DESC);
CREATE INDEX idx_complexity_analysis_sessions_commit ON complexity_analysis_sessions(commit_sha) WHERE commit_sha IS NOT NULL;
CREATE INDEX idx_complexity_analysis_sessions_status ON complexity_analysis_sessions(status, analysis_timestamp) WHERE status IN ('running', 'failed');

-- ============================================================================
-- CYCLOMATIC COMPLEXITY METRICS
-- ============================================================================

-- Track cyclomatic complexity for functions and methods
CREATE TABLE IF NOT EXISTS cyclomatic_complexity_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Code element identification
    file_path TEXT NOT NULL,
    class_name VARCHAR(200),
    function_name VARCHAR(200) NOT NULL,
    function_signature TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    
    -- Cyclomatic complexity metrics
    cyclomatic_complexity INTEGER NOT NULL DEFAULT 1, -- Number of independent paths
    essential_complexity INTEGER DEFAULT 1, -- Complexity after removing structured programming constructs
    design_complexity INTEGER DEFAULT 1, -- Complexity of module's decision structure
    
    -- Derived metrics
    complexity_grade VARCHAR(5) NOT NULL CHECK (complexity_grade IN ('A', 'B', 'C', 'D', 'F')), -- A(1-10), B(11-20), C(21-50), D(51-100), F(>100)
    risk_level VARCHAR(15) NOT NULL CHECK (risk_level IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    maintainability_risk VARCHAR(15) NOT NULL CHECK (maintainability_risk IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    testing_effort_estimate DECIMAL(4, 1) DEFAULT 1.0, -- Relative testing effort multiplier
    
    -- Code structure analysis
    decision_points INTEGER DEFAULT 0, -- Number of decision points (if, while, for, etc.)
    nesting_depth INTEGER DEFAULT 0, -- Maximum nesting level
    logical_operators INTEGER DEFAULT 0, -- Number of logical operators (&&, ||, !)
    
    -- Quality indicators
    analysis_confidence DECIMAL(4, 3) DEFAULT 1.0, -- 0-1 confidence in analysis
    parse_errors INTEGER DEFAULT 0,
    warnings TEXT[],
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_cyclomatic_function_per_session UNIQUE (analysis_session_id, file_path, function_name, start_line)
);

-- Optimize for complexity queries and hotspot identification
CREATE INDEX idx_cyclomatic_complexity_project_file ON cyclomatic_complexity_metrics(project_id, file_path);
CREATE INDEX idx_cyclomatic_complexity_high_values ON cyclomatic_complexity_metrics(cyclomatic_complexity DESC) WHERE cyclomatic_complexity > 10;
CREATE INDEX idx_cyclomatic_complexity_risk_level ON cyclomatic_complexity_metrics(risk_level, cyclomatic_complexity DESC) WHERE risk_level IN ('high', 'very_high', 'critical');

-- ============================================================================
-- COGNITIVE COMPLEXITY METRICS  
-- ============================================================================

-- Track cognitive complexity (mental effort to understand code)
CREATE TABLE IF NOT EXISTS cognitive_complexity_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Code element identification  
    file_path TEXT NOT NULL,
    class_name VARCHAR(200),
    function_name VARCHAR(200) NOT NULL,
    function_signature TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    
    -- Cognitive complexity metrics
    cognitive_complexity INTEGER NOT NULL DEFAULT 0, -- Mental effort to understand
    base_complexity INTEGER DEFAULT 0, -- Base complexity without nesting
    nesting_increment INTEGER DEFAULT 0, -- Complexity added by nesting
    
    -- Contributing factors breakdown
    if_statements INTEGER DEFAULT 0,
    switch_statements INTEGER DEFAULT 0,
    loops INTEGER DEFAULT 0,
    try_catch_blocks INTEGER DEFAULT 0,
    lambda_expressions INTEGER DEFAULT 0,
    recursive_calls INTEGER DEFAULT 0,
    break_continue_statements INTEGER DEFAULT 0,
    
    -- Cognitive load factors
    max_nesting_level INTEGER DEFAULT 0,
    binary_logical_operators INTEGER DEFAULT 0, -- &&, ||  
    ternary_operators INTEGER DEFAULT 0,
    jump_statements INTEGER DEFAULT 0, -- break, continue, return, throw
    
    -- Readability metrics
    readability_score DECIMAL(4, 3) DEFAULT 1.0, -- 0-1 scale, 1 = highly readable
    understandability_grade VARCHAR(5) CHECK (understandability_grade IN ('A', 'B', 'C', 'D', 'F')),
    mental_effort_estimate DECIMAL(4, 1) DEFAULT 1.0, -- Minutes to understand
    
    -- Risk assessment
    cognitive_risk_level VARCHAR(15) NOT NULL CHECK (cognitive_risk_level IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    review_priority INTEGER DEFAULT 3 CHECK (review_priority BETWEEN 1 AND 5), -- 1=urgent, 5=low
    refactoring_benefit_score DECIMAL(4, 3) DEFAULT 0, -- Expected benefit from refactoring
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_cognitive_function_per_session UNIQUE (analysis_session_id, file_path, function_name, start_line)
);

-- Optimize for cognitive complexity analysis
CREATE INDEX idx_cognitive_complexity_high_values ON cognitive_complexity_metrics(cognitive_complexity DESC) WHERE cognitive_complexity > 15;
CREATE INDEX idx_cognitive_complexity_risk ON cognitive_complexity_metrics(cognitive_risk_level, cognitive_complexity DESC) WHERE cognitive_risk_level IN ('high', 'very_high', 'critical');
CREATE INDEX idx_cognitive_complexity_refactoring ON cognitive_complexity_metrics(refactoring_benefit_score DESC) WHERE refactoring_benefit_score > 0.5;

-- ============================================================================
-- HALSTEAD COMPLEXITY METRICS
-- ============================================================================

-- Track Halstead complexity metrics (program vocabulary and structure)
CREATE TABLE IF NOT EXISTS halstead_complexity_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Code element identification
    file_path TEXT NOT NULL,
    class_name VARCHAR(200),
    function_name VARCHAR(200),
    scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('function', 'method', 'class', 'file')),
    start_line INTEGER DEFAULT 1,
    end_line INTEGER DEFAULT 1,
    
    -- Basic Halstead metrics
    distinct_operators INTEGER NOT NULL DEFAULT 0, -- n1: Number of distinct operators
    distinct_operands INTEGER NOT NULL DEFAULT 0,  -- n2: Number of distinct operands  
    total_operators INTEGER NOT NULL DEFAULT 0,    -- N1: Total operators
    total_operands INTEGER NOT NULL DEFAULT 0,     -- N2: Total operands
    
    -- Derived Halstead measures
    program_vocabulary INTEGER NOT NULL DEFAULT 0,  -- n = n1 + n2
    program_length INTEGER NOT NULL DEFAULT 0,      -- N = N1 + N2
    calculated_length DECIMAL(8, 2) DEFAULT 0,      -- n1*log2(n1) + n2*log2(n2)  
    volume DECIMAL(10, 2) DEFAULT 0,                -- V = N * log2(n)
    difficulty DECIMAL(8, 3) DEFAULT 0,             -- D = (n1/2) * (N2/n2)
    effort DECIMAL(12, 2) DEFAULT 0,                -- E = D * V
    
    -- Time and defect estimates
    programming_time DECIMAL(8, 2) DEFAULT 0,       -- T = E / 18 (seconds)
    delivered_bugs DECIMAL(6, 3) DEFAULT 0,         -- B = V / 3000 (estimated defects)
    
    -- Maintainability metrics
    maintainability_index DECIMAL(6, 2) DEFAULT 100, -- MI = max(0, (171 - 5.2*ln(V) - 0.23*CC - 16.2*ln(LOC))*100/171)
    complexity_density DECIMAL(6, 3) DEFAULT 0,      -- Complexity per line of code
    vocabulary_richness DECIMAL(4, 3) DEFAULT 0,     -- n/N (measure of vocabulary usage)
    
    -- Quality indicators
    halstead_grade VARCHAR(5) CHECK (halstead_grade IN ('A', 'B', 'C', 'D', 'F')),
    maintainability_risk VARCHAR(15) CHECK (maintainability_risk IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    defect_probability DECIMAL(4, 3) DEFAULT 0,      -- Probability of defects 0-1
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints (function_name can be NULL, which PostgreSQL handles correctly in UNIQUE)
    CONSTRAINT unique_halstead_scope_per_session UNIQUE (analysis_session_id, file_path, scope_type, function_name, start_line)
);

-- Optimize for Halstead metrics analysis
CREATE INDEX idx_halstead_complexity_high_effort ON halstead_complexity_metrics(effort DESC) WHERE effort > 1000;
CREATE INDEX idx_halstead_complexity_maintainability ON halstead_complexity_metrics(maintainability_index ASC) WHERE maintainability_index < 70;
CREATE INDEX idx_halstead_complexity_defects ON halstead_complexity_metrics(delivered_bugs DESC) WHERE delivered_bugs > 0.1;

-- ============================================================================
-- DEPENDENCY COMPLEXITY METRICS
-- ============================================================================

-- Track coupling and dependency complexity
CREATE TABLE IF NOT EXISTS dependency_complexity_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Code element identification
    file_path TEXT NOT NULL,
    class_name VARCHAR(200),
    element_type VARCHAR(20) NOT NULL CHECK (element_type IN ('class', 'module', 'package', 'function')),
    element_name VARCHAR(200) NOT NULL,
    
    -- Coupling metrics
    afferent_coupling INTEGER DEFAULT 0,    -- Ca: Number of classes/modules that depend on this
    efferent_coupling INTEGER DEFAULT 0,    -- Ce: Number of classes/modules this depends on
    coupling_factor DECIMAL(6, 4) DEFAULT 0, -- (Ce + Ca) / Total possible couplings
    
    -- Cohesion metrics
    lack_of_cohesion DECIMAL(6, 3) DEFAULT 0,        -- LCOM: Lack of Cohesion in Methods
    cohesion_score DECIMAL(4, 3) DEFAULT 1.0,        -- 1 - (LCOM normalized)
    functional_cohesion DECIMAL(4, 3) DEFAULT 1.0,    -- How well methods work together
    
    -- Dependency analysis
    direct_dependencies INTEGER DEFAULT 0,
    indirect_dependencies INTEGER DEFAULT 0,
    circular_dependencies INTEGER DEFAULT 0,
    dependency_depth INTEGER DEFAULT 0,        -- Maximum depth in dependency chain
    dependency_cycles TEXT[],                  -- List of dependency cycles
    
    -- Architectural metrics
    abstractness DECIMAL(4, 3) DEFAULT 0,     -- Abstract classes/interfaces ratio
    instability DECIMAL(4, 3) DEFAULT 0,      -- Ce / (Ca + Ce) 
    distance_from_main_sequence DECIMAL(4, 3) DEFAULT 0, -- |A + I - 1| 
    
    -- Impact analysis
    change_impact_score DECIMAL(6, 3) DEFAULT 0,     -- Estimated impact of changes
    ripple_effect_size INTEGER DEFAULT 0,            -- Number of elements affected by changes
    fan_in INTEGER DEFAULT 0,                        -- Number of modules calling this
    fan_out INTEGER DEFAULT 0,                       -- Number of modules called by this
    
    -- Risk assessment
    coupling_risk_level VARCHAR(15) CHECK (coupling_risk_level IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    architectural_violation BOOLEAN DEFAULT FALSE,
    design_pattern_violations TEXT[],
    refactoring_recommendations TEXT[],
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_dependency_element_per_session UNIQUE (analysis_session_id, file_path, element_type, element_name)
);

-- Optimize for coupling analysis and architectural queries
CREATE INDEX idx_dependency_complexity_high_coupling ON dependency_complexity_metrics(coupling_factor DESC) WHERE coupling_factor > 0.3;
CREATE INDEX idx_dependency_complexity_instability ON dependency_complexity_metrics(instability DESC) WHERE instability > 0.7;
CREATE INDEX idx_dependency_complexity_violations ON dependency_complexity_metrics(architectural_violation) WHERE architectural_violation = TRUE;
CREATE INDEX idx_dependency_complexity_circular ON dependency_complexity_metrics(circular_dependencies DESC) WHERE circular_dependencies > 0;

-- ============================================================================
-- FILE COMPLEXITY SUMMARY
-- ============================================================================

-- Aggregated complexity metrics per file for quick dashboard queries
CREATE TABLE IF NOT EXISTS file_complexity_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- File identification
    file_path TEXT NOT NULL,
    file_type VARCHAR(20),
    lines_of_code INTEGER DEFAULT 0,
    lines_of_comments INTEGER DEFAULT 0,
    blank_lines INTEGER DEFAULT 0,
    
    -- Function/method counts
    total_functions INTEGER DEFAULT 0,
    total_classes INTEGER DEFAULT 0,
    total_interfaces INTEGER DEFAULT 0,
    
    -- Aggregated complexity scores
    avg_cyclomatic_complexity DECIMAL(6, 2) DEFAULT 0,
    max_cyclomatic_complexity INTEGER DEFAULT 0,
    total_cognitive_complexity INTEGER DEFAULT 0,
    avg_cognitive_complexity DECIMAL(6, 2) DEFAULT 0,
    
    -- Halstead summary
    total_halstead_volume DECIMAL(10, 2) DEFAULT 0,
    avg_halstead_effort DECIMAL(10, 2) DEFAULT 0,
    estimated_bugs DECIMAL(6, 3) DEFAULT 0,
    maintainability_index DECIMAL(6, 2) DEFAULT 100,
    
    -- Dependency summary
    total_dependencies INTEGER DEFAULT 0,
    coupling_score DECIMAL(6, 3) DEFAULT 0,
    cohesion_score DECIMAL(4, 3) DEFAULT 1.0,
    
    -- Risk assessment
    overall_complexity_score DECIMAL(8, 3) NOT NULL DEFAULT 0, -- Weighted combination of all metrics
    complexity_grade VARCHAR(5) NOT NULL DEFAULT 'A' CHECK (complexity_grade IN ('A', 'B', 'C', 'D', 'F')),
    risk_level VARCHAR(15) NOT NULL DEFAULT 'very_low' CHECK (risk_level IN ('very_low', 'low', 'moderate', 'high', 'very_high', 'critical')),
    
    -- Hotspot identification
    is_complexity_hotspot BOOLEAN DEFAULT FALSE,
    hotspot_score DECIMAL(6, 3) DEFAULT 0,          -- Combination of complexity + change frequency
    refactoring_priority INTEGER DEFAULT 5 CHECK (refactoring_priority BETWEEN 1 AND 5), -- 1=urgent
    
    -- Change frequency correlation (from git data)
    change_frequency INTEGER DEFAULT 0,              -- Changes in recent period
    last_modified TIMESTAMP WITH TIME ZONE,
    modification_trend VARCHAR(20) CHECK (modification_trend IN ('increasing', 'decreasing', 'stable', 'volatile')),
    
    -- Technical debt estimation  
    technical_debt_minutes INTEGER DEFAULT 0,        -- Estimated minutes to address complexity issues
    maintenance_cost_factor DECIMAL(4, 2) DEFAULT 1.0, -- Relative maintenance cost multiplier
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_file_per_session UNIQUE (analysis_session_id, file_path)
);

-- Optimize for hotspot identification and dashboard queries
CREATE INDEX idx_file_complexity_summary_project ON file_complexity_summary(project_id, overall_complexity_score DESC);
CREATE INDEX idx_file_complexity_summary_hotspots ON file_complexity_summary(is_complexity_hotspot, hotspot_score DESC) WHERE is_complexity_hotspot = TRUE;
CREATE INDEX idx_file_complexity_summary_high_risk ON file_complexity_summary(risk_level, overall_complexity_score DESC) WHERE risk_level IN ('high', 'very_high', 'critical');
CREATE INDEX idx_file_complexity_summary_refactoring ON file_complexity_summary(refactoring_priority, technical_debt_minutes DESC) WHERE refactoring_priority <= 3;

-- ============================================================================
-- COMPLEXITY TRENDS AND HISTORY
-- ============================================================================

-- Track complexity evolution over time for trend analysis
CREATE TABLE IF NOT EXISTS complexity_trends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Trend identification
    file_path TEXT NOT NULL,
    complexity_type VARCHAR(30) NOT NULL CHECK (complexity_type IN ('cyclomatic', 'cognitive', 'halstead_effort', 'coupling', 'overall')),
    trend_period VARCHAR(20) NOT NULL CHECK (trend_period IN ('daily', 'weekly', 'monthly', 'commit_based')),
    
    -- Time series data
    measurement_date DATE NOT NULL,
    commit_sha VARCHAR(40),
    complexity_value DECIMAL(10, 3) NOT NULL,
    
    -- Trend analysis
    moving_average DECIMAL(10, 3),
    trend_direction VARCHAR(15) CHECK (trend_direction IN ('increasing', 'decreasing', 'stable', 'volatile')),
    trend_slope DECIMAL(8, 4),                    -- Rate of change
    trend_acceleration DECIMAL(8, 4),             -- Change in rate of change
    seasonal_component DECIMAL(8, 4),             -- Seasonal variation
    
    -- Statistical measures
    percentile_rank DECIMAL(5, 2),                -- Percentile within project history
    standard_deviations DECIMAL(6, 3),            -- Standard deviations from mean
    anomaly_score DECIMAL(6, 3) DEFAULT 0,        -- Anomaly detection score
    is_anomaly BOOLEAN DEFAULT FALSE,
    
    -- Change point detection
    change_point_detected BOOLEAN DEFAULT FALSE,
    change_magnitude DECIMAL(8, 3),
    change_significance DECIMAL(4, 3),
    
    -- Forecasting
    forecast_next_week DECIMAL(10, 3),
    forecast_confidence DECIMAL(4, 3),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT unique_trend_measurement UNIQUE (project_id, file_path, complexity_type, measurement_date, trend_period)
);

-- Optimize for trend analysis and forecasting
CREATE INDEX idx_complexity_trends_project_file_type ON complexity_trends(project_id, file_path, complexity_type, measurement_date DESC);
CREATE INDEX idx_complexity_trends_anomalies ON complexity_trends(is_anomaly, anomaly_score DESC) WHERE is_anomaly = TRUE;
CREATE INDEX idx_complexity_trends_change_points ON complexity_trends(change_point_detected, change_significance DESC) WHERE change_point_detected = TRUE;
CREATE INDEX idx_complexity_trends_recent ON complexity_trends(measurement_date DESC, trend_direction);

-- ============================================================================
-- COMPLEXITY ALERTS AND THRESHOLDS
-- ============================================================================

-- Track complexity threshold violations and alerts
CREATE TABLE IF NOT EXISTS complexity_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_session_id UUID REFERENCES complexity_analysis_sessions(id) ON DELETE SET NULL,
    
    -- Alert identification
    alert_type VARCHAR(30) NOT NULL CHECK (alert_type IN ('threshold_exceeded', 'complexity_regression', 'hotspot_detected', 'trend_violation', 'technical_debt_spike')),
    complexity_type VARCHAR(30) NOT NULL CHECK (complexity_type IN ('cyclomatic', 'cognitive', 'halstead', 'coupling', 'overall')),
    
    -- Target information
    file_path TEXT NOT NULL,
    function_name VARCHAR(200),
    class_name VARCHAR(200),
    
    -- Threshold data
    current_value DECIMAL(10, 3) NOT NULL,
    threshold_value DECIMAL(10, 3) NOT NULL,
    baseline_value DECIMAL(10, 3),
    violation_magnitude DECIMAL(8, 3) NOT NULL,    -- How much threshold was exceeded
    violation_severity VARCHAR(15) NOT NULL CHECK (violation_severity IN ('info', 'warning', 'error', 'critical')),
    
    -- Alert metadata
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    impact_assessment TEXT,
    
    -- Recommendations
    immediate_actions TEXT[],
    recommended_actions TEXT[],
    refactoring_suggestions TEXT[],
    estimated_effort_hours DECIMAL(5, 1),
    
    -- Alert lifecycle
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'investigating', 'resolved', 'suppressed', 'false_positive')),
    priority INTEGER DEFAULT 3 CHECK (priority BETWEEN 1 AND 5), -- 1=urgent, 5=low
    assigned_to VARCHAR(200),
    
    -- Timestamps
    triggered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    
    -- Resolution tracking
    resolution_method VARCHAR(50) CHECK (resolution_method IN ('refactored', 'threshold_adjusted', 'false_positive', 'accepted_risk', 'split_function', 'other')),
    resolution_notes TEXT,
    follow_up_required BOOLEAN DEFAULT FALSE,
    follow_up_date DATE,
    
    -- Recurrence tracking
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_count INTEGER DEFAULT 1,
    first_occurrence TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optimize for alert management and monitoring
CREATE INDEX idx_complexity_alerts_open_priority ON complexity_alerts(status, priority ASC, triggered_at DESC) WHERE status IN ('open', 'acknowledged');
CREATE INDEX idx_complexity_alerts_project_severity ON complexity_alerts(project_id, violation_severity, triggered_at DESC) WHERE violation_severity IN ('error', 'critical');
CREATE INDEX idx_complexity_alerts_file_type ON complexity_alerts(file_path, complexity_type, triggered_at DESC);
CREATE INDEX idx_complexity_alerts_recurring ON complexity_alerts(is_recurring, recurrence_count DESC) WHERE is_recurring = TRUE;

-- ============================================================================
-- REFACTORING OPPORTUNITIES
-- ============================================================================

-- Identify and track refactoring opportunities based on complexity analysis
CREATE TABLE IF NOT EXISTS refactoring_opportunities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_session_id UUID NOT NULL REFERENCES complexity_analysis_sessions(id) ON DELETE CASCADE,
    
    -- Target code element
    file_path TEXT NOT NULL,
    class_name VARCHAR(200),
    function_name VARCHAR(200),
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    
    -- Opportunity identification
    opportunity_type VARCHAR(50) NOT NULL CHECK (opportunity_type IN (
        'extract_method', 'split_function', 'reduce_nesting', 'eliminate_duplication',
        'simplify_conditionals', 'reduce_parameters', 'break_dependencies', 
        'improve_cohesion', 'extract_class', 'inline_method', 'replace_temp_with_query'
    )),
    
    -- Current state metrics
    current_complexity_score DECIMAL(8, 3) NOT NULL,
    current_cyclomatic_complexity INTEGER,
    current_cognitive_complexity INTEGER,
    current_halstead_effort DECIMAL(10, 2),
    current_coupling_factor DECIMAL(6, 4),
    
    -- Potential improvement
    estimated_complexity_reduction DECIMAL(8, 3) NOT NULL,
    estimated_maintainability_gain DECIMAL(4, 3),
    estimated_readability_improvement DECIMAL(4, 3),
    
    -- Effort estimation
    refactoring_effort_hours DECIMAL(5, 1) NOT NULL,
    testing_effort_hours DECIMAL(5, 1),
    risk_level VARCHAR(15) CHECK (risk_level IN ('very_low', 'low', 'moderate', 'high', 'very_high')),
    
    -- Business value
    impact_on_development_velocity DECIMAL(4, 3), -- -1 to 1, negative means slowdown
    bug_reduction_potential DECIMAL(4, 3),        -- Expected bug reduction 0-1
    maintenance_cost_savings DECIMAL(8, 2),       -- Estimated cost savings per year
    
    -- Opportunity details
    description TEXT NOT NULL,
    refactoring_steps TEXT[],
    before_code_snippet TEXT,
    suggested_after_code TEXT,
    
    -- Dependencies and constraints
    blocked_by TEXT[],                             -- What prevents this refactoring
    blocks TEXT[],                                 -- What this refactoring would enable
    requires_breaking_changes BOOLEAN DEFAULT FALSE,
    affects_public_api BOOLEAN DEFAULT FALSE,
    
    -- Prioritization
    priority_score DECIMAL(6, 3) NOT NULL DEFAULT 0, -- Calculated priority score
    roi_score DECIMAL(6, 3) NOT NULL DEFAULT 0,      -- Return on investment score
    urgency_level VARCHAR(15) CHECK (urgency_level IN ('low', 'medium', 'high', 'urgent')),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'identified' CHECK (status IN ('identified', 'planned', 'in_progress', 'completed', 'rejected', 'deferred')),
    assigned_to VARCHAR(200),
    target_completion_date DATE,
    
    -- Validation
    is_validated BOOLEAN DEFAULT FALSE,            -- Human validated opportunity
    validation_notes TEXT,
    false_positive BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optimize for refactoring opportunity management
CREATE INDEX idx_refactoring_opportunities_priority ON refactoring_opportunities(project_id, priority_score DESC, status);
CREATE INDEX idx_refactoring_opportunities_roi ON refactoring_opportunities(roi_score DESC, status) WHERE status IN ('identified', 'planned');
CREATE INDEX idx_refactoring_opportunities_file ON refactoring_opportunities(file_path, opportunity_type);
CREATE INDEX idx_refactoring_opportunities_urgent ON refactoring_opportunities(urgency_level, target_completion_date) WHERE urgency_level IN ('high', 'urgent');

-- ============================================================================
-- MATERIALIZED VIEWS FOR PERFORMANCE
-- ============================================================================

-- Project complexity dashboard view for sub-100ms queries
CREATE MATERIALIZED VIEW project_complexity_dashboard AS
SELECT 
    p.id as project_id,
    p.name as project_name,
    
    -- Latest analysis info
    MAX(cas.analysis_timestamp) as last_analysis,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(cas.analysis_timestamp))) / 3600 as hours_since_analysis,
    
    -- Current complexity state
    AVG(fcs.overall_complexity_score) as avg_complexity_score,
    MAX(fcs.overall_complexity_score) as max_complexity_score,
    COUNT(fcs.*) as total_files_analyzed,
    
    -- Risk distribution
    COUNT(fcs.*) FILTER (WHERE fcs.risk_level = 'critical') as critical_risk_files,
    COUNT(fcs.*) FILTER (WHERE fcs.risk_level = 'very_high') as very_high_risk_files,
    COUNT(fcs.*) FILTER (WHERE fcs.risk_level = 'high') as high_risk_files,
    COUNT(fcs.*) FILTER (WHERE fcs.risk_level IN ('critical', 'very_high', 'high')) as total_high_risk_files,
    
    -- Complexity grades
    COUNT(fcs.*) FILTER (WHERE fcs.complexity_grade = 'A') as grade_a_files,
    COUNT(fcs.*) FILTER (WHERE fcs.complexity_grade = 'B') as grade_b_files,
    COUNT(fcs.*) FILTER (WHERE fcs.complexity_grade = 'C') as grade_c_files,
    COUNT(fcs.*) FILTER (WHERE fcs.complexity_grade = 'D') as grade_d_files,
    COUNT(fcs.*) FILTER (WHERE fcs.complexity_grade = 'F') as grade_f_files,
    
    -- Hotspots and alerts
    COUNT(fcs.*) FILTER (WHERE fcs.is_complexity_hotspot = TRUE) as complexity_hotspots,
    COUNT(ca.*) FILTER (WHERE ca.status IN ('open', 'acknowledged')) as active_alerts,
    COUNT(ca.*) FILTER (WHERE ca.violation_severity = 'critical') as critical_alerts,
    
    -- Refactoring opportunities
    COUNT(ro.*) FILTER (WHERE ro.status IN ('identified', 'planned')) as refactoring_opportunities,
    COUNT(ro.*) FILTER (WHERE ro.urgency_level = 'urgent') as urgent_refactoring_opportunities,
    AVG(ro.roi_score) FILTER (WHERE ro.status IN ('identified', 'planned')) as avg_refactoring_roi,
    
    -- Technical debt estimation
    SUM(fcs.technical_debt_minutes) as total_technical_debt_minutes,
    AVG(fcs.maintenance_cost_factor) as avg_maintenance_cost_factor,
    
    -- Trend indicators
    COUNT(ct.*) FILTER (WHERE ct.trend_direction = 'increasing' AND ct.measurement_date >= CURRENT_DATE - INTERVAL '30 days') as increasing_complexity_files,
    COUNT(ct.*) FILTER (WHERE ct.is_anomaly = TRUE AND ct.measurement_date >= CURRENT_DATE - INTERVAL '30 days') as recent_complexity_anomalies
    
FROM projects p
LEFT JOIN complexity_analysis_sessions cas ON p.id = cas.project_id 
    AND cas.analysis_timestamp >= CURRENT_TIMESTAMP - INTERVAL '7 days'
    AND cas.status = 'completed'
LEFT JOIN file_complexity_summary fcs ON cas.id = fcs.analysis_session_id
LEFT JOIN complexity_alerts ca ON p.id = ca.project_id 
    AND ca.triggered_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
LEFT JOIN refactoring_opportunities ro ON p.id = ro.project_id
LEFT JOIN complexity_trends ct ON p.id = ct.project_id 
    AND ct.measurement_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY p.id, p.name;

-- Create unique index for materialized view
CREATE UNIQUE INDEX idx_project_complexity_dashboard_project ON project_complexity_dashboard(project_id);

-- High-risk complexity items view for urgent attention
CREATE MATERIALIZED VIEW high_risk_complexity_items AS
SELECT 
    fcs.project_id,
    fcs.file_path,
    fcs.overall_complexity_score,
    fcs.risk_level,
    fcs.complexity_grade,
    fcs.is_complexity_hotspot,
    fcs.hotspot_score,
    fcs.refactoring_priority,
    fcs.technical_debt_minutes,
    fcs.change_frequency,
    fcs.modification_trend,
    
    -- Function-level details for worst offenders
    ccm.function_name,
    ccm.cyclomatic_complexity,
    cogm.cognitive_complexity,
    hcm.maintainability_index,
    dcm.coupling_factor,
    
    -- Alert information
    COUNT(ca.id) as active_alerts,
    MAX(ca.violation_severity) as max_alert_severity,
    
    -- Refactoring opportunities
    COUNT(ro.id) as refactoring_opportunities,
    MAX(ro.priority_score) as max_refactoring_priority,
    
    cas.analysis_timestamp as last_analyzed

FROM file_complexity_summary fcs
JOIN complexity_analysis_sessions cas ON fcs.analysis_session_id = cas.id
LEFT JOIN cyclomatic_complexity_metrics ccm ON cas.id = ccm.analysis_session_id 
    AND fcs.file_path = ccm.file_path
    AND ccm.cyclomatic_complexity = (
        SELECT MAX(cyclomatic_complexity) 
        FROM cyclomatic_complexity_metrics ccm2 
        WHERE ccm2.analysis_session_id = cas.id 
        AND ccm2.file_path = fcs.file_path
    )
LEFT JOIN cognitive_complexity_metrics cogm ON cas.id = cogm.analysis_session_id 
    AND fcs.file_path = cogm.file_path
    AND cogm.cognitive_complexity = (
        SELECT MAX(cognitive_complexity) 
        FROM cognitive_complexity_metrics cogm2 
        WHERE cogm2.analysis_session_id = cas.id 
        AND cogm2.file_path = fcs.file_path
    )
LEFT JOIN halstead_complexity_metrics hcm ON cas.id = hcm.analysis_session_id 
    AND fcs.file_path = hcm.file_path
    AND hcm.scope_type = 'file'
LEFT JOIN dependency_complexity_metrics dcm ON cas.id = dcm.analysis_session_id 
    AND fcs.file_path = dcm.file_path
LEFT JOIN complexity_alerts ca ON fcs.project_id = ca.project_id 
    AND fcs.file_path = ca.file_path
    AND ca.status IN ('open', 'acknowledged')
LEFT JOIN refactoring_opportunities ro ON fcs.project_id = ro.project_id 
    AND fcs.file_path = ro.file_path
    AND ro.status IN ('identified', 'planned')
    
WHERE fcs.risk_level IN ('high', 'very_high', 'critical')
   OR fcs.is_complexity_hotspot = TRUE
   OR fcs.refactoring_priority <= 2
   
GROUP BY 
    fcs.project_id, fcs.file_path, fcs.overall_complexity_score,
    fcs.risk_level, fcs.complexity_grade, fcs.is_complexity_hotspot,
    fcs.hotspot_score, fcs.refactoring_priority, fcs.technical_debt_minutes,
    fcs.change_frequency, fcs.modification_trend,
    ccm.function_name, ccm.cyclomatic_complexity,
    cogm.cognitive_complexity, hcm.maintainability_index, 
    dcm.coupling_factor, cas.analysis_timestamp;

CREATE INDEX idx_high_risk_complexity_items_project ON high_risk_complexity_items(project_id, overall_complexity_score DESC);

-- ============================================================================
-- AUTOMATED TRIGGERS AND FUNCTIONS
-- ============================================================================

-- Update session summary when analysis completes
CREATE OR REPLACE FUNCTION update_complexity_analysis_session_summary()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the analysis session with summary statistics
    UPDATE complexity_analysis_sessions 
    SET 
        files_analyzed = (
            SELECT COUNT(DISTINCT file_path) 
            FROM file_complexity_summary 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        functions_analyzed = (
            SELECT COUNT(*) 
            FROM cyclomatic_complexity_metrics 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        complexity_metrics_calculated = (
            SELECT COUNT(*) 
            FROM cyclomatic_complexity_metrics 
            WHERE analysis_session_id = NEW.analysis_session_id
        ) + (
            SELECT COUNT(*) 
            FROM cognitive_complexity_metrics 
            WHERE analysis_session_id = NEW.analysis_session_id
        ) + (
            SELECT COUNT(*) 
            FROM halstead_complexity_metrics 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        hotspots_identified = (
            SELECT COUNT(*) 
            FROM file_complexity_summary 
            WHERE analysis_session_id = NEW.analysis_session_id 
            AND is_complexity_hotspot = TRUE
        ),
        refactoring_opportunities = (
            SELECT COUNT(*) 
            FROM refactoring_opportunities 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        avg_complexity_score = (
            SELECT AVG(overall_complexity_score) 
            FROM file_complexity_summary 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        max_complexity_score = (
            SELECT MAX(overall_complexity_score) 
            FROM file_complexity_summary 
            WHERE analysis_session_id = NEW.analysis_session_id
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.analysis_session_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update session summary when file complexity is inserted
CREATE TRIGGER trigger_update_complexity_session_summary
    AFTER INSERT ON file_complexity_summary
    FOR EACH ROW
    EXECUTE FUNCTION update_complexity_analysis_session_summary();

-- Function to refresh materialized views
CREATE OR REPLACE FUNCTION refresh_complexity_materialized_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY project_complexity_dashboard;
    REFRESH MATERIALIZED VIEW CONCURRENTLY high_risk_complexity_items;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PERFORMANCE OPTIMIZATION INDEXES
-- ============================================================================

-- Additional composite indexes for common query patterns
CREATE INDEX idx_complexity_analysis_recent_completed ON complexity_analysis_sessions(analysis_timestamp DESC, status) WHERE status = 'completed';

-- Index for trend analysis queries
CREATE INDEX idx_complexity_trends_analysis ON complexity_trends(project_id, complexity_type, measurement_date DESC, trend_direction);

-- Index for alert dashboard queries
CREATE INDEX idx_complexity_alerts_dashboard ON complexity_alerts(project_id, status, violation_severity, triggered_at DESC) WHERE status IN ('open', 'acknowledged');

-- Partial indexes for hot paths
CREATE INDEX idx_file_complexity_hotspots_dashboard ON file_complexity_summary(project_id, hotspot_score DESC, overall_complexity_score DESC) WHERE is_complexity_hotspot = TRUE;

-- ============================================================================
-- TABLE COMMENTS
-- ============================================================================

COMMENT ON TABLE complexity_analysis_sessions IS 'TC015: Tracks complexity analysis sessions with performance metrics and summary statistics';
COMMENT ON TABLE cyclomatic_complexity_metrics IS 'TC015: Cyclomatic complexity metrics for functions - measures independent paths through code';
COMMENT ON TABLE cognitive_complexity_metrics IS 'TC015: Cognitive complexity metrics - measures mental effort to understand code';  
COMMENT ON TABLE halstead_complexity_metrics IS 'TC015: Halstead complexity metrics - program vocabulary and structure analysis';
COMMENT ON TABLE dependency_complexity_metrics IS 'TC015: Coupling and dependency complexity metrics for architectural analysis';
COMMENT ON TABLE file_complexity_summary IS 'TC015: Aggregated file-level complexity summary for dashboard queries';
COMMENT ON TABLE complexity_trends IS 'TC015: Time series data for complexity trend analysis and forecasting';
COMMENT ON TABLE complexity_alerts IS 'TC015: Complexity threshold violations and alerts with resolution tracking';
COMMENT ON TABLE refactoring_opportunities IS 'TC015: Identified refactoring opportunities based on complexity analysis';

COMMENT ON MATERIALIZED VIEW project_complexity_dashboard IS 'TC015: Pre-calculated project complexity dashboard for sub-100ms queries';
COMMENT ON MATERIALIZED VIEW high_risk_complexity_items IS 'TC015: High-risk complexity items requiring immediate attention';

-- Migration complete