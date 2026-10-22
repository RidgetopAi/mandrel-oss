-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 102 — task_attachments: images attached to a task (Punch List)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Two producers, one table. The operator files a bug from his phone with a "before" screenshot
-- (`kind='before'`); later a Walkthrough critic stores an "evidence" image against the same
-- task (`kind='evidence'`). Both are small, task-scoped binary blobs with no independent
-- lifecycle of their own — they exist only as long as their task does.
--
-- WHY `bytea` IN-ROW AND NOT AN OBJECT STORE: the 5 MiB cap (`byte_size` CHECK, matched by
-- the upload route's multer `limits.fileSize`) keeps a worst-case row small, and this repo
-- has no object-storage service to depend on. If volume ever demands otherwise, move the
-- bytes and keep this row as metadata + a pointer — a migration for that day, not this one.
--
-- WHY project_id IS DENORMALIZED (task_attachments carries it directly rather than joining
-- through tasks.project_id every read): the entity-detail authorization choke point
-- (`services/entityProjectScope.ts`) and the cross-project 404 test both need a project
-- column on THIS table to scope on without a join, matching the pattern already used by
-- every other PROJECT_OWNED_ENTITIES row. It is set once at insert time from the owning
-- task's project and is never expected to drift (a task does not change project on this
-- branch); nothing here re-derives it after insert.
--
-- WHY `kind` IS A CHECK, NOT A NATIVE ENUM: same reasoning as tasks.blocked_on (migration
-- 093) — a CHECK is edited by dropping and re-adding one constraint, no DDL lock profile
-- concern across the fleet.
--
-- Safe: purely additive (new table, new index). Fully reversible while the table is empty;
-- see rollback/102_task_attachments_ROLLBACK.sql for the data-loss caveat (DROP TABLE
-- destroys any stored bytes — there is no "undo" for that half).

BEGIN;

CREATE TABLE IF NOT EXISTS public.task_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES public.projects(id),
    kind character varying(20) NOT NULL DEFAULT 'before',
    filename character varying(255) NOT NULL,
    mime character varying(100) NOT NULL,
    byte_size integer NOT NULL,
    data bytea NOT NULL,
    created_by character varying(200),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_attachments_kind_check CHECK (kind IN ('before', 'evidence')),
    CONSTRAINT task_attachments_byte_size_check CHECK (byte_size > 0 AND byte_size <= 5242880)
);

CREATE INDEX IF NOT EXISTS idx_task_attachments_task_created
    ON public.task_attachments (task_id, created_at);

COMMENT ON TABLE public.task_attachments IS
    'Images attached to a task: a phone-filed "before" screenshot, or "evidence" stored by the Walkthrough critic (Punch List).';
COMMENT ON COLUMN public.task_attachments.kind IS
    'before (filed with the bug report) or evidence (stored by a later reviewer/critic).';
COMMENT ON COLUMN public.task_attachments.byte_size IS
    'Bytes in `data`. Capped at 5 MiB (5242880) — matches the upload route multer limit.';

COMMIT;

-- Verify
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.task_attachments'::regclass
ORDER BY conname;
