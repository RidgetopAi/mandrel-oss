-- Migration 033: Drop Pattern Detection System
-- Date: 2025-10-24
-- Reason: Pattern detection system deprecated - most functionality stubbed out
--
-- This migration removes the entire pattern detection infrastructure:
-- - 6 database tables (created in migration 019)
-- - All historical pattern data (last analysis: Sept 10, 2025)
-- - Only 1 of 4 pattern types had real data (file co-occurrence)
--
-- Decision: Clean slate removal per user request (Option C)
-- Partnership quality: Asked user first, got confirmation before dropping data

BEGIN;

-- Record what we're dropping for audit trail (handle fresh installs where tables may not exist)
DO $$
DECLARE
    v_cooccurrence_count INTEGER := 0;
    v_temporal_count INTEGER := 0;
    v_developer_count INTEGER := 0;
    v_magnitude_count INTEGER := 0;
    v_insights_count INTEGER := 0;
    v_sessions_count INTEGER := 0;
BEGIN
    -- Count existing data before deletion (skip if tables don't exist)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'file_cooccurrence_patterns') THEN
        SELECT COUNT(*) INTO v_cooccurrence_count FROM file_cooccurrence_patterns;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'temporal_patterns') THEN
        SELECT COUNT(*) INTO v_temporal_count FROM temporal_patterns;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'developer_patterns') THEN
        SELECT COUNT(*) INTO v_developer_count FROM developer_patterns;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'change_magnitude_patterns') THEN
        SELECT COUNT(*) INTO v_magnitude_count FROM change_magnitude_patterns;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pattern_insights') THEN
        SELECT COUNT(*) INTO v_insights_count FROM pattern_insights;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pattern_discovery_sessions') THEN
        SELECT COUNT(*) INTO v_sessions_count FROM pattern_discovery_sessions;
    END IF;

    RAISE NOTICE 'Migration 033: Dropping pattern detection system';
    RAISE NOTICE '  - file_cooccurrence_patterns: % rows', v_cooccurrence_count;
    RAISE NOTICE '  - temporal_patterns: % rows', v_temporal_count;
    RAISE NOTICE '  - developer_patterns: % rows', v_developer_count;
    RAISE NOTICE '  - change_magnitude_patterns: % rows', v_magnitude_count;
    RAISE NOTICE '  - pattern_insights: % rows', v_insights_count;
    RAISE NOTICE '  - pattern_discovery_sessions: % rows', v_sessions_count;
    RAISE NOTICE '  Total data rows being deleted: %',
        v_cooccurrence_count + v_temporal_count + v_developer_count +
        v_magnitude_count + v_insights_count + v_sessions_count;
END $$;

-- Drop tables in dependency order (children first, then parents)
-- All tables have ON DELETE CASCADE, but explicit ordering is clearer

-- Drop child tables first (reference pattern_discovery_sessions)
DROP TABLE IF EXISTS file_cooccurrence_patterns CASCADE;
DROP TABLE IF EXISTS temporal_patterns CASCADE;
DROP TABLE IF EXISTS developer_patterns CASCADE;
DROP TABLE IF EXISTS change_magnitude_patterns CASCADE;
DROP TABLE IF EXISTS pattern_insights CASCADE;

-- Drop parent table last
DROP TABLE IF EXISTS pattern_discovery_sessions CASCADE;

-- Also drop pattern_operation_metrics if it exists (from migration 019)
DROP TABLE IF EXISTS pattern_operation_metrics CASCADE;

-- Final confirmation
DO $$
BEGIN
    RAISE NOTICE 'Migration 033: Pattern detection system removed successfully';
    RAISE NOTICE '  All 6+ pattern tables dropped';
    RAISE NOTICE '  Historical pattern data deleted';
    RAISE NOTICE '  System ready for code cleanup';
END $$;

COMMIT;

-- Rollback script (saved separately as 033_drop_pattern_detection_system_ROLLBACK.sql)
-- To rollback: Re-run migration 019_create_change_pattern_tables.sql
-- Note: Data cannot be recovered unless you have a database backup
