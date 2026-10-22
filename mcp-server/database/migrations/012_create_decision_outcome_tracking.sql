-- AIDIS Migration 012: Create Decision Outcome Tracking Framework
--
-- TC016: Build decision outcome tracking framework
-- This extends our existing technical_decisions system with comprehensive
-- outcome monitoring, impact analysis, and learning capabilities.
--
-- PROBLEM SOLVED: Transform decision tracking from simple recording to 
-- intelligent learning system that prevents repeated mistakes and 
-- identifies successful patterns across all decisions.
--
-- Author: AIDIS Team
-- Date: 2025-09-10

-- =============================================
-- DECISION OUTCOMES TABLE
-- =============================================
-- Detailed tracking of decision outcomes over time
CREATE TABLE IF NOT EXISTS decision_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id UUID REFERENCES technical_decisions(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Outcome measurement
    outcome_type VARCHAR(50) NOT NULL CHECK (outcome_type IN (
        'implementation', 'performance', 'maintenance', 'cost', 'adoption',
        'security', 'scalability', 'developer_experience', 'user_experience'
    )),
    
    -- Quantitative metrics
    predicted_value DECIMAL(10,2), -- What we expected (cost, time, performance)
    actual_value DECIMAL(10,2),    -- What actually happened
    variance_percentage DECIMAL(5,2), -- % difference (positive = better than expected)
    
    -- Qualitative assessment
    outcome_score INTEGER CHECK (outcome_score BETWEEN 1 AND 10), -- 1=disastrous, 10=exceptional
    outcome_status VARCHAR(50) NOT NULL DEFAULT 'in_progress' CHECK (outcome_status IN (
        'in_progress', 'successful', 'failed', 'mixed', 'abandoned', 'superseded'
    )),
    
    -- Timeline tracking
    measured_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    measurement_period_days INTEGER, -- How long after decision to measure
    
    -- Context and evidence
    evidence_type VARCHAR(50) CHECK (evidence_type IN (
        'metrics', 'user_feedback', 'performance_data', 'cost_analysis', 
        'developer_survey', 'incident_report', 'code_review', 'automated_test'
    )),
    evidence_data JSONB DEFAULT '{}'::jsonb, -- Structured evidence
    notes TEXT,
    
    -- Attribution
    measured_by VARCHAR(100), -- Who/what measured this outcome
    confidence_level VARCHAR(20) DEFAULT 'medium' CHECK (confidence_level IN ('low', 'medium', 'high')),
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- DECISION IMPACT ANALYSIS TABLE
-- =============================================
-- Track ripple effects and correlations between decisions
CREATE TABLE IF NOT EXISTS decision_impact_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_decision_id UUID REFERENCES technical_decisions(id) ON DELETE CASCADE,
    impacted_decision_id UUID REFERENCES technical_decisions(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Impact relationship
    impact_type VARCHAR(50) NOT NULL CHECK (impact_type IN (
        'enables', 'conflicts_with', 'depends_on', 'supersedes', 'complements',
        'complicates', 'simplifies', 'blocks', 'accelerates'
    )),
    
    -- Impact strength
    impact_strength VARCHAR(20) DEFAULT 'medium' CHECK (impact_strength IN ('low', 'medium', 'high')),
    impact_direction VARCHAR(20) CHECK (impact_direction IN ('positive', 'negative', 'neutral')),
    
    -- Quantified impact
    time_impact_days INTEGER, -- How many days added/saved
    cost_impact_amount DECIMAL(10,2), -- Financial impact
    complexity_impact_score INTEGER CHECK (complexity_impact_score BETWEEN -10 AND 10),
    
    -- Analysis details
    analysis_method VARCHAR(50) CHECK (analysis_method IN (
        'manual_review', 'automated_analysis', 'stakeholder_feedback',
        'performance_correlation', 'timeline_analysis', 'dependency_graph'
    )),
    description TEXT,
    confidence_score DECIMAL(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    
    -- Discovery tracking
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    discovered_by VARCHAR(100),
    validated BOOLEAN DEFAULT FALSE,
    validation_notes TEXT,
    
    -- Prevent duplicate relationships
    UNIQUE(source_decision_id, impacted_decision_id, impact_type)
);

-- =============================================
-- DECISION LEARNING INSIGHTS TABLE  
-- =============================================
-- Extract and store learned patterns from decision outcomes
CREATE TABLE IF NOT EXISTS decision_learning_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Pattern identification
    insight_type VARCHAR(50) NOT NULL CHECK (insight_type IN (
        'success_pattern', 'failure_pattern', 'risk_indicator', 'best_practice',
        'anti_pattern', 'correlation', 'threshold', 'timing_pattern'
    )),
    
    -- Pattern definition
    pattern_name VARCHAR(200) NOT NULL,
    pattern_description TEXT NOT NULL,
    pattern_conditions JSONB NOT NULL, -- Conditions that trigger this pattern
    
    -- Pattern strength
    confidence_score DECIMAL(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    supporting_evidence_count INTEGER DEFAULT 1,
    contradicting_evidence_count INTEGER DEFAULT 0,
    
    -- Actionable recommendations
    recommendation TEXT,
    prevention_strategy TEXT, -- How to avoid negative patterns
    enhancement_strategy TEXT, -- How to leverage positive patterns
    
    -- Scope and applicability  
    decision_types TEXT[], -- Which decision types this applies to
    impact_levels TEXT[], -- Which impact levels this applies to
    applicable_components TEXT[], -- Which system components
    contextual_factors JSONB DEFAULT '{}'::jsonb, -- When this pattern applies
    
    -- Pattern lifecycle
    first_observed TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_confirmed TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'under_review')),
    
    -- Source tracking
    source_decisions UUID[], -- Decisions that led to this insight
    derived_from_insights UUID[], -- Other insights this builds on
    
    -- Usage tracking
    times_applied INTEGER DEFAULT 0,
    last_applied TIMESTAMP WITH TIME ZONE,
    application_success_rate DECIMAL(3,2) CHECK (application_success_rate BETWEEN 0 AND 1),
    
    UNIQUE(project_id, pattern_name)
);

-- =============================================
-- DECISION METRICS TIMELINE TABLE
-- =============================================
-- Track key metrics over time for trend analysis
CREATE TABLE IF NOT EXISTS decision_metrics_timeline (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id UUID REFERENCES technical_decisions(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Metric identification
    metric_name VARCHAR(100) NOT NULL,
    metric_category VARCHAR(50) CHECK (metric_category IN (
        'performance', 'cost', 'quality', 'velocity', 'satisfaction',
        'adoption', 'maintenance', 'security', 'reliability'
    )),
    
    -- Metric values
    metric_value DECIMAL(15,6),
    metric_unit VARCHAR(20), -- ms, $, %, points, etc.
    baseline_value DECIMAL(15,6), -- Pre-decision baseline
    target_value DECIMAL(15,6), -- Expected/target value
    
    -- Temporal context
    measurement_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    days_since_decision INTEGER,
    phase VARCHAR(30) CHECK (phase IN (
        'pre_implementation', 'implementation', 'early_adoption', 
        'steady_state', 'optimization', 'migration', 'deprecation'
    )),
    
    -- Data quality
    data_source VARCHAR(100),
    collection_method VARCHAR(50),
    sample_size INTEGER,
    confidence_interval DECIMAL(5,4),
    
    -- Contextual factors
    external_factors JSONB DEFAULT '{}'::jsonb, -- Market conditions, team changes, etc.
    
    UNIQUE(decision_id, metric_name, measurement_timestamp)
);

-- =============================================
-- DECISION RETROSPECTIVES TABLE
-- =============================================  
-- Structured retrospective sessions on decisions
CREATE TABLE IF NOT EXISTS decision_retrospectives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    decision_id UUID REFERENCES technical_decisions(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Retrospective session info
    retrospective_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    retrospective_type VARCHAR(30) CHECK (retrospective_type IN (
        'quarterly', 'post_implementation', 'incident_driven', 'milestone', 'ad_hoc'
    )),
    participants TEXT[],
    facilitator VARCHAR(100),
    
    -- Assessment framework
    overall_satisfaction INTEGER CHECK (overall_satisfaction BETWEEN 1 AND 10),
    would_decide_same_again BOOLEAN,
    recommendation_to_others INTEGER CHECK (recommendation_to_others BETWEEN 1 AND 10),
    
    -- Structured feedback
    what_went_well TEXT,
    what_went_poorly TEXT,
    what_we_learned TEXT,
    what_we_would_do_differently TEXT,
    
    -- Forward-looking insights
    recommendations_for_similar_decisions TEXT,
    process_improvements TEXT,
    tools_or_resources_needed TEXT,
    
    -- Risk assessment
    unforeseen_risks TEXT,
    risk_mitigation_effectiveness TEXT,
    new_risks_discovered TEXT,
    
    -- Quantified outcomes
    time_to_value_actual_days INTEGER,
    time_to_value_predicted_days INTEGER,
    total_effort_actual_hours DECIMAL(8,2),
    total_effort_predicted_hours DECIMAL(8,2),
    
    -- Stakeholder impact
    stakeholder_feedback JSONB DEFAULT '{}'::jsonb,
    adoption_challenges TEXT,
    change_management_lessons TEXT,
    
    -- Meta-retrospective
    retrospective_quality_score INTEGER CHECK (retrospective_quality_score BETWEEN 1 AND 10),
    action_items JSONB DEFAULT '[]'::jsonb,
    follow_up_required BOOLEAN DEFAULT FALSE,
    follow_up_date TIMESTAMP WITH TIME ZONE
);

-- =============================================
-- PERFORMANCE INDEXES
-- =============================================

-- Decision Outcomes
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision_id ON decision_outcomes(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_project_type ON decision_outcomes(project_id, outcome_type);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_status ON decision_outcomes(outcome_status, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_score ON decision_outcomes(outcome_score DESC);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_timeline ON decision_outcomes(measured_at DESC, measurement_period_days);
CREATE INDEX IF NOT EXISTS idx_decision_outcomes_evidence_gin ON decision_outcomes USING GIN(evidence_data);

-- Decision Impact Analysis  
CREATE INDEX IF NOT EXISTS idx_decision_impact_source ON decision_impact_analysis(source_decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_impact_target ON decision_impact_analysis(impacted_decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_impact_type ON decision_impact_analysis(impact_type, impact_strength);
CREATE INDEX IF NOT EXISTS idx_decision_impact_project ON decision_impact_analysis(project_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_impact_validated ON decision_impact_analysis(validated, confidence_score DESC);

-- Decision Learning Insights
CREATE INDEX IF NOT EXISTS idx_decision_learning_project_type ON decision_learning_insights(project_id, insight_type);
CREATE INDEX IF NOT EXISTS idx_decision_learning_confidence ON decision_learning_insights(confidence_score DESC, supporting_evidence_count DESC);
CREATE INDEX IF NOT EXISTS idx_decision_learning_status ON decision_learning_insights(status, last_confirmed DESC);
CREATE INDEX IF NOT EXISTS idx_decision_learning_patterns_gin ON decision_learning_insights USING GIN(pattern_conditions);
CREATE INDEX IF NOT EXISTS idx_decision_learning_components_gin ON decision_learning_insights USING GIN(applicable_components);
CREATE INDEX IF NOT EXISTS idx_decision_learning_types_gin ON decision_learning_insights USING GIN(decision_types);

-- Decision Metrics Timeline
CREATE INDEX IF NOT EXISTS idx_decision_metrics_decision_timeline ON decision_metrics_timeline(decision_id, measurement_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_metrics_category ON decision_metrics_timeline(metric_category, measurement_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_metrics_phase ON decision_metrics_timeline(phase, days_since_decision);
CREATE INDEX IF NOT EXISTS idx_decision_metrics_project_metric ON decision_metrics_timeline(project_id, metric_name);

-- Decision Retrospectives
CREATE INDEX IF NOT EXISTS idx_decision_retrospectives_decision ON decision_retrospectives(decision_id, retrospective_date DESC);
CREATE INDEX IF NOT EXISTS idx_decision_retrospectives_project_type ON decision_retrospectives(project_id, retrospective_type);
CREATE INDEX IF NOT EXISTS idx_decision_retrospectives_satisfaction ON decision_retrospectives(overall_satisfaction DESC);
CREATE INDEX IF NOT EXISTS idx_decision_retrospectives_followup ON decision_retrospectives(follow_up_required, follow_up_date);

-- Full-text search indexes
CREATE INDEX IF NOT EXISTS idx_decision_learning_insights_fts ON decision_learning_insights USING GIN(
    to_tsvector('english', pattern_name || ' ' || pattern_description || ' ' || COALESCE(recommendation, ''))
);
CREATE INDEX IF NOT EXISTS idx_decision_retrospectives_fts ON decision_retrospectives USING GIN(
    to_tsvector('english', what_went_well || ' ' || what_went_poorly || ' ' || what_we_learned || ' ' || recommendations_for_similar_decisions)
);

-- =============================================
-- ENHANCED TRIGGERS FOR AUTOMATION
-- =============================================

-- Auto-update technical_decisions outcome_status based on decision_outcomes
CREATE OR REPLACE FUNCTION update_decision_outcome_status()
RETURNS TRIGGER AS $$
BEGIN
    -- Calculate overall outcome status based on individual outcomes
    UPDATE technical_decisions SET
        outcome_status = (
            SELECT CASE 
                WHEN AVG(outcome_score) >= 8 THEN 'successful'
                WHEN AVG(outcome_score) <= 3 THEN 'failed'
                WHEN AVG(outcome_score) BETWEEN 4 AND 7 THEN 'mixed'
                ELSE 'unknown'
            END
            FROM decision_outcomes 
            WHERE decision_id = NEW.decision_id 
            AND outcome_status IN ('successful', 'failed', 'mixed')
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.decision_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_decision_outcome_status
    AFTER INSERT OR UPDATE ON decision_outcomes
    FOR EACH ROW EXECUTE FUNCTION update_decision_outcome_status();

-- Auto-generate learning insights from successful patterns
CREATE OR REPLACE FUNCTION generate_learning_insights()
RETURNS TRIGGER AS $$
DECLARE
    pattern_threshold INTEGER := 3; -- Minimum occurrences to create pattern
    similar_decisions INTEGER;
BEGIN
    -- Only process successful outcomes with high scores
    IF NEW.outcome_status = 'successful' AND NEW.outcome_score >= 8 THEN
        -- Check if we have similar successful decisions to form a pattern
        SELECT COUNT(*) INTO similar_decisions
        FROM decision_outcomes dout
        JOIN technical_decisions td ON dout.decision_id = td.id
        WHERE dout.outcome_status = 'successful'
        AND dout.outcome_score >= 8
        AND td.decision_type = (SELECT decision_type FROM technical_decisions WHERE id = NEW.decision_id)
        AND td.impact_level = (SELECT impact_level FROM technical_decisions WHERE id = NEW.decision_id);
        
        -- If we have enough similar successes, create/update pattern
        IF similar_decisions >= pattern_threshold THEN
            INSERT INTO decision_learning_insights (
                project_id, insight_type, pattern_name, pattern_description,
                pattern_conditions, confidence_score, supporting_evidence_count,
                recommendation, decision_types, impact_levels, source_decisions
            )
            SELECT 
                td.project_id,
                'success_pattern',
                'Successful ' || td.decision_type || ' decisions at ' || td.impact_level || ' impact',
                'Pattern identified from successful ' || td.decision_type || ' decisions with high outcome scores',
                jsonb_build_object(
                    'decision_type', td.decision_type,
                    'impact_level', td.impact_level,
                    'min_outcome_score', 8
                ),
                LEAST(similar_decisions / 10.0, 0.95), -- Cap confidence at 95%
                similar_decisions,
                'Continue applying similar approaches for ' || td.decision_type || ' decisions',
                ARRAY[td.decision_type],
                ARRAY[td.impact_level],
                ARRAY[NEW.decision_id]
            FROM technical_decisions td 
            WHERE td.id = NEW.decision_id
            ON CONFLICT (project_id, pattern_name) DO UPDATE SET
                supporting_evidence_count = EXCLUDED.supporting_evidence_count,
                confidence_score = EXCLUDED.confidence_score,
                last_confirmed = CURRENT_TIMESTAMP,
                source_decisions = array_append(decision_learning_insights.source_decisions, NEW.decision_id);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_learning_insights
    AFTER INSERT OR UPDATE ON decision_outcomes
    FOR EACH ROW EXECUTE FUNCTION generate_learning_insights();

-- =============================================
-- VIEWS FOR COMMON QUERIES
-- =============================================

-- Decision outcome summary view
CREATE OR REPLACE VIEW decision_outcome_summary AS
SELECT 
    td.id as decision_id,
    td.title,
    td.decision_type,
    td.impact_level,
    td.status,
    td.decision_date,
    COUNT(dout.id) as outcome_measurements,
    AVG(dout.outcome_score) as avg_outcome_score,
    MAX(dout.measured_at) as last_measured,
    string_agg(DISTINCT dout.outcome_status, ', ') as outcome_statuses,
    AVG(dout.variance_percentage) as avg_variance,
    COUNT(dia.id) as impact_connections
FROM technical_decisions td
LEFT JOIN decision_outcomes dout ON td.id = dout.decision_id
LEFT JOIN decision_impact_analysis dia ON td.id = dia.source_decision_id OR td.id = dia.impacted_decision_id
GROUP BY td.id, td.title, td.decision_type, td.impact_level, td.status, td.decision_date;

-- Learning insights by effectiveness view  
CREATE OR REPLACE VIEW learning_insights_effectiveness AS
SELECT 
    dli.*,
    CASE 
        WHEN dli.application_success_rate >= 0.8 THEN 'highly_effective'
        WHEN dli.application_success_rate >= 0.6 THEN 'effective' 
        WHEN dli.application_success_rate >= 0.4 THEN 'moderately_effective'
        ELSE 'needs_review'
    END as effectiveness_rating,
    (dli.supporting_evidence_count - dli.contradicting_evidence_count) as evidence_strength
FROM decision_learning_insights dli
WHERE dli.status = 'active'
ORDER BY dli.confidence_score DESC, evidence_strength DESC;

-- Project decision health view
CREATE OR REPLACE VIEW project_decision_health AS
SELECT 
    p.id as project_id,
    p.name as project_name,
    COUNT(td.id) as total_decisions,
    COUNT(CASE WHEN td.status = 'active' THEN 1 END) as active_decisions,
    COUNT(CASE WHEN td.outcome_status = 'successful' THEN 1 END) as successful_decisions,
    COUNT(CASE WHEN td.outcome_status = 'failed' THEN 1 END) as failed_decisions,
    ROUND(AVG(dout.outcome_score), 2) as avg_outcome_score,
    COUNT(dli.id) as learning_insights_generated,
    COUNT(dr.id) as retrospectives_conducted,
    MAX(td.decision_date) as last_decision_date
FROM projects p
LEFT JOIN technical_decisions td ON p.id = td.project_id
LEFT JOIN decision_outcomes dout ON td.id = dout.decision_id
LEFT JOIN decision_learning_insights dli ON p.id = dli.project_id
LEFT JOIN decision_retrospectives dr ON td.id = dr.decision_id
GROUP BY p.id, p.name;

-- Verify migration success
SELECT 'Migration 012 completed successfully - Decision Outcome Tracking Framework ready' as status;

-- Count new tables
SELECT 
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'decision_outcomes') as outcomes_table,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'decision_impact_analysis') as impact_table,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'decision_learning_insights') as insights_table,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'decision_metrics_timeline') as metrics_table,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'decision_retrospectives') as retrospectives_table;