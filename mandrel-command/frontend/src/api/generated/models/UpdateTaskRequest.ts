/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateTaskRequest = {
    /**
     * Task title
     */
    title?: string;
    /**
     * Task description
     */
    description?: string;
    /**
     * Task type
     */
    type?: 'general' | 'feature' | 'bug' | 'refactor' | 'test' | 'docs' | 'devops';
    /**
     * Task status
     */
    status?: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
    /**
     * The Punch List lane (migration 101). Setting stage:"ready" REQUIRES title + punch.doneWhen + punch.proofKind + a resolved project (evaluated against the MERGED existing+incoming state), or the write is refused (400, code PUNCH_INCOMPLETE).
     */
    stage?: 'draft' | 'ready' | 'claimed' | 'verifying' | 'evidence' | 'merged' | 'deployed';
    /**
     * Shallow-merged into metadata.punch — an omitted field is untouched, an explicit null deletes it.
     */
    punch?: {
        doneWhen?: string | null;
        proofKind?: 'test' | 'browser' | 'look' | null;
        source?: 'form' | 'chat' | 'machine' | null;
    };
    /**
     * Task priority
     */
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    /**
     * Assignee
     */
    assigned_to?: string;
    /**
     * Task tags
     */
    tags?: Array<string>;
};

