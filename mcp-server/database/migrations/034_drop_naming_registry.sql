-- AIDIS Migration 034: Drop Naming Registry Table
--
-- Removes naming registry feature - replaced by dependency tracking system
--
-- Rationale:
-- - Only 19 entries across 3 projects (minimal adoption)
-- - Last usage: 2025-09-21 (~1 month stale)
-- - Manual registration creates friction
-- - IDE/TypeScript provides better naming consistency
-- - Dependency tracking provides more value for solo dev + AI workflow
--
-- Impact:
-- - Removes 4 MCP tools (naming_register, naming_check, naming_suggest, naming_stats)
-- - Saves ~1,200 tokens in MCP context
-- - Removes ~2,500 lines of code
-- - Cleans up 1 database table with 6 indexes
--
-- Author: the operator & AIDIS Team
-- Date: 2025-10-24

BEGIN;

-- Drop the naming_registry table (CASCADE will drop indexes and constraints)
DROP TABLE IF EXISTS naming_registry CASCADE;

-- Verification
SELECT 'Migration 034 completed successfully - naming_registry table dropped' as status;

-- Verify table no longer exists
SELECT
    CASE
        WHEN EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = 'naming_registry'
        )
        THEN '❌ ERROR: naming_registry table still exists'
        ELSE '✅ SUCCESS: naming_registry table dropped'
    END as verification;

COMMIT;
