-- TS004: Add Session Title and Description Fields
-- Add title and description fields to sessions table for better session management

ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS title VARCHAR(255);

-- Add description field (longer description of session purpose/goals)
ALTER TABLE sessions 
ADD COLUMN IF NOT EXISTS description TEXT;

-- Create index on title for quick lookups
CREATE INDEX IF NOT EXISTS idx_sessions_title ON sessions(title);

-- Also fix the invalid default UUID for project_id while we're here (TS003 related)
ALTER TABLE sessions 
ALTER COLUMN project_id DROP DEFAULT;

-- Add comment for documentation
COMMENT ON COLUMN sessions.title IS 'Short descriptive title for the session (e.g., "Implement user authentication", "Debug payment flow")';
COMMENT ON COLUMN sessions.description IS 'Detailed description of session goals, context, and objectives';

DROP TRIGGER IF EXISTS trigger_ensure_session_title ON sessions;

CREATE OR REPLACE FUNCTION ensure_session_title()
RETURNS TRIGGER AS $$
BEGIN
  -- If description is provided but title is null, auto-generate a title
  IF NEW.description IS NOT NULL AND NEW.description != '' AND (NEW.title IS NULL OR NEW.title = '') THEN
    -- Extract first 50 characters of description as title
    NEW.title := LEFT(TRIM(NEW.description), 50);
    -- Clean up title by removing newlines and extra spaces
    NEW.title := REGEXP_REPLACE(NEW.title, '\s+', ' ', 'g');
    -- Add ellipsis if truncated
    IF LENGTH(TRIM(NEW.description)) > 50 THEN
      NEW.title := NEW.title || '...';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_ensure_session_title
  BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION ensure_session_title();

-- Add validation constraint to ensure reasonable title length
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reasonable_title_length'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions 
    ADD CONSTRAINT reasonable_title_length 
    CHECK (title IS NULL OR LENGTH(title) BETWEEN 1 AND 255);
  END IF;
END $$;

-- Update existing sessions with auto-generated titles based on context_summary
UPDATE sessions 
SET title = CASE 
  WHEN context_summary IS NOT NULL AND context_summary != '' THEN 
    LEFT(TRIM(REGEXP_REPLACE(context_summary, '\s+', ' ', 'g')), 50) ||
    CASE WHEN LENGTH(TRIM(context_summary)) > 50 THEN '...' ELSE '' END
  ELSE 
    'Session ' || TO_CHAR(started_at, 'YYYY-MM-DD HH24:MI')
  END
WHERE title IS NULL;

-- Performance note: Index on title will help with session searches and filtering
