-- Migration 016: Remove agent system and migrate to simple tasks
-- Handles both fresh installs and upgrades from agent-based system.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks' AND table_schema = 'public') THEN
        -- UPGRADE PATH: Modify existing tasks table
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100);
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by VARCHAR(200);

        -- Change assigned_to from UUID to VARCHAR if it's UUID type
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tasks' AND column_name = 'assigned_to' AND data_type = 'uuid'
        ) THEN
            ALTER TABLE tasks ALTER COLUMN assigned_to TYPE VARCHAR(200) USING assigned_to::VARCHAR(200);
        END IF;

        RAISE NOTICE 'Migration 016: Updated existing tasks table';
    ELSE
        -- FRESH INSTALL: Create the tasks table from scratch
        CREATE TABLE tasks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            assigned_to VARCHAR(200),
            created_by VARCHAR(200),
            title VARCHAR(500) NOT NULL,
            description TEXT,
            type VARCHAR(100) NOT NULL DEFAULT 'general',
            status VARCHAR(50) NOT NULL DEFAULT 'todo',
            priority VARCHAR(20) NOT NULL DEFAULT 'medium',
            progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
            dependencies UUID[] DEFAULT '{}',
            tags TEXT[] DEFAULT '{}',
            metadata JSONB DEFAULT '{}',
            started_at TIMESTAMP WITH TIME ZONE,
            completed_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        -- Create indexes for the new tasks table
        CREATE INDEX idx_tasks_project ON tasks(project_id);
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_priority ON tasks(priority);
        CREATE INDEX idx_tasks_type ON tasks(type);
        CREATE INDEX idx_tasks_created_at ON tasks(created_at);
        CREATE INDEX idx_tasks_dependencies ON tasks USING GIN(dependencies);
        CREATE INDEX idx_tasks_tags ON tasks USING GIN(tags);

        -- Add updated_at trigger
        CREATE TRIGGER update_tasks_updated_at
            BEFORE UPDATE ON tasks
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();

        RAISE NOTICE 'Migration 016: Created tasks table (fresh install)';
    END IF;

    -- Only migrate data if backup tables exist
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks_backup' AND table_schema = 'public')
       AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks' AND table_schema = 'public') THEN
        -- Clear existing tasks and migrate from backup
        TRUNCATE tasks;

        INSERT INTO tasks (
            id, project_id, title, description, type, status, priority,
            dependencies, tags, metadata, created_at, updated_at, progress,
            assigned_to, created_by
        )
        SELECT
            t.id, t.project_id, t.title, t.description, t.type, t.status, t.priority,
            t.dependencies, t.tags, t.metadata, t.created_at, t.updated_at,
            COALESCE(t.progress, 0) as progress,
            CASE WHEN a1.name IS NOT NULL THEN a1.name ELSE 'unassigned' END as assigned_to,
            CASE WHEN a2.name IS NOT NULL THEN a2.name ELSE 'system' END as created_by
        FROM tasks_backup t
        LEFT JOIN agents_backup a1 ON t.assigned_to = a1.id
        LEFT JOIN agents_backup a2 ON t.created_by = a2.id;

        RAISE NOTICE 'Migration 016: Migrated tasks from backup';
    END IF;
END $$;
