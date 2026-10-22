DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM projects WHERE id = '00000000-0000-0000-0000-000000000000'
    ) THEN
        INSERT INTO projects (id, name, description)
        VALUES (
            '00000000-0000-0000-0000-000000000000',
            '__unassigned__',
            'Placeholder for unassigned sessions'
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_sessions_project'
          AND table_name = 'sessions'
    ) THEN
        ALTER TABLE sessions
            ADD CONSTRAINT fk_sessions_project
            FOREIGN KEY (project_id) REFERENCES projects(id);
    END IF;
END $$;

-- Set default project_id for new sessions (idempotent operation)
ALTER TABLE sessions
    ALTER COLUMN project_id SET DEFAULT '00000000-0000-0000-0000-000000000000';
