-- AIDIS Migration 009: Add updated_at column to technical_decisions table
--
-- PROBLEM: The decision_update handler tries to use updated_at column which doesn't exist
-- SOLUTION: Add updated_at column with proper defaults and update existing records
--
-- Author: CodeAgent
-- Date: 2025-08-21

-- Add updated_at column to technical_decisions table
ALTER TABLE technical_decisions 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Update existing records to have updated_at = decision_date initially
UPDATE technical_decisions 
SET updated_at = decision_date 
WHERE updated_at IS NULL;

-- Add index for updated_at column for performance
CREATE INDEX IF NOT EXISTS idx_technical_decisions_updated_at ON technical_decisions(updated_at DESC);

-- Verify the column was added successfully
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default 
FROM information_schema.columns 
WHERE table_name = 'technical_decisions' 
AND column_name = 'updated_at';

-- Show count of records that now have updated_at
SELECT COUNT(*) as records_with_updated_at 
FROM technical_decisions 
WHERE updated_at IS NOT NULL;

SELECT 'Migration 009 completed successfully - added updated_at column to technical_decisions' as status;
