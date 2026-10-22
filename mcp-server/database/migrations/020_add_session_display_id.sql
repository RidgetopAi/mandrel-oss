-- Migration 020: Add human-readable display_id to sessions
-- TS005-1: Session Display ID Generation (Phase 1)
-- Format: SES-YYYY-NNNN (e.g., SES-2025-0042)
-- Date: 2025-09-29

-- Step 1: Add display_id column
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS display_id VARCHAR(20) UNIQUE;

-- Step 2: Create function to generate next display_id
CREATE OR REPLACE FUNCTION get_next_session_display_id()
RETURNS VARCHAR(20) AS $$
DECLARE
  current_year INTEGER;
  sequence_name TEXT;
  next_num INTEGER;
  display_id VARCHAR(20);
BEGIN
  -- Get current year
  current_year := EXTRACT(YEAR FROM CURRENT_TIMESTAMP)::INTEGER;

  -- Build sequence name for this year
  sequence_name := 'session_seq_' || current_year;

  -- Create sequence if it doesn't exist (atomic operation)
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START WITH 1', sequence_name);

  -- Get next number from sequence
  EXECUTE format('SELECT nextval(%L)', sequence_name) INTO next_num;

  -- Format as SES-YYYY-NNNN (e.g., SES-2025-0042)
  display_id := 'SES-' || current_year || '-' || LPAD(next_num::TEXT, 4, '0');

  RETURN display_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_next_session_display_id IS 'Generate next human-readable session display ID in format SES-YYYY-NNNN. Creates year-based sequences automatically. Atomic and thread-safe.';

-- Step 3: Create trigger function to auto-generate display_id
CREATE OR REPLACE FUNCTION auto_generate_session_display_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Only generate if display_id is NULL
  IF NEW.display_id IS NULL THEN
    NEW.display_id := get_next_session_display_id();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create trigger on sessions table
DROP TRIGGER IF EXISTS trigger_auto_generate_session_display_id ON sessions;
CREATE TRIGGER trigger_auto_generate_session_display_id
  BEFORE INSERT ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_session_display_id();

-- Step 5: Backfill existing sessions with display_ids (chronological order)
-- This ensures older sessions get lower numbers
DO $$
DECLARE
  session_record RECORD;
  backfill_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Starting chronological backfill of session display_ids...';

  -- Process sessions in chronological order (oldest first)
  FOR session_record IN
    SELECT id, started_at
    FROM sessions
    WHERE display_id IS NULL
    ORDER BY started_at ASC
  LOOP
    -- Generate and assign display_id
    UPDATE sessions
    SET display_id = get_next_session_display_id()
    WHERE id = session_record.id;

    backfill_count := backfill_count + 1;
  END LOOP;

  RAISE NOTICE 'Backfilled % sessions with display_ids', backfill_count;
END $$;

-- Step 6: Add NOT NULL constraint (now that all sessions have display_ids)
ALTER TABLE sessions
ALTER COLUMN display_id SET NOT NULL;

-- Step 7: Create indexes for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_display_id
ON sessions(display_id);

CREATE INDEX IF NOT EXISTS idx_sessions_display_id_search
ON sessions(display_id text_pattern_ops);

-- Step 8: Add column comment
COMMENT ON COLUMN sessions.display_id IS 'Human-readable session display ID in format SES-YYYY-NNNN (e.g., SES-2025-0042). Auto-generated on insert. Searchable by users and AI. Unique across all sessions.';

-- Step 9: Verification query
DO $$
DECLARE
  total_sessions INTEGER;
  sessions_with_display_id INTEGER;
  duplicate_count INTEGER;
BEGIN
  -- Count total sessions
  SELECT COUNT(*) INTO total_sessions FROM sessions;

  -- Count sessions with display_id
  SELECT COUNT(*) INTO sessions_with_display_id
  FROM sessions
  WHERE display_id IS NOT NULL;

  -- Check for duplicates (should be 0)
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT display_id, COUNT(*) as cnt
    FROM sessions
    GROUP BY display_id
    HAVING COUNT(*) > 1
  ) duplicates;

  RAISE NOTICE '=== Migration 020 Verification ===';
  RAISE NOTICE 'Total sessions: %', total_sessions;
  RAISE NOTICE 'Sessions with display_id: %', sessions_with_display_id;
  RAISE NOTICE 'Duplicate display_ids: %', duplicate_count;

  IF total_sessions = sessions_with_display_id AND duplicate_count = 0 THEN
    RAISE NOTICE '✅ Migration successful - all sessions have unique display_ids';
  ELSE
    RAISE EXCEPTION '❌ Migration verification failed!';
  END IF;
END $$;

-- Performance note: Unique index ensures O(log n) lookups by display_id