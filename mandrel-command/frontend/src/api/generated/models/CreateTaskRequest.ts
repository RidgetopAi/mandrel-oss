/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreateTaskRequest = {
    /**
     * Task title
     */
    title: string;
    /**
     * Task description
     */
    description?: string;
    /**
     * Task type
     */
    type?: 'general' | 'feature' | 'bug' | 'refactor' | 'test' | 'docs' | 'devops';
    /**
     * Task priority
     */
    priority: 'low' | 'medium' | 'high' | 'urgent';
    /**
     * Assignee
     */
    assigned_to?: string;
    /**
     * Associated project ID
     */
    project_id: string;
    /**
     * Task tags
     */
    tags?: Array<string>;
    /**
     * The Punch List lane (migration 101). Setting stage:"ready" REQUIRES title + punch.doneWhen + punch.proofKind + a resolved project, or the write is refused (400, code PUNCH_INCOMPLETE).
     */
    stage?: 'draft' | 'ready' | 'claimed' | 'verifying' | 'evidence' | 'merged' | 'deployed';
    /**
     * Shallow-merged into metadata.punch.
     */
    punch?: {
        doneWhen?: string;
        proofKind?: 'test' | 'browser' | 'look';
        source?: 'form' | 'chat' | 'machine';
    };
};

