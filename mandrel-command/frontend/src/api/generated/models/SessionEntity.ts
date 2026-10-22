/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BaseEntity } from './BaseEntity';
export type SessionEntity = (BaseEntity & {
    /**
     * Human-readable session ID
     */
    display_id?: string;
    project_id?: string;
    project_name?: string;
    title?: string;
    description?: string;
    session_goal?: string;
    tags?: Array<string>;
    started_at?: string;
    /**
     * Session end time - null means active
     */
    ended_at?: string | null;
    /**
     * Decimal string of duration in minutes
     */
    duration_minutes?: string;
    last_activity_at?: string;
    last_context_at?: string;
    /**
     * Session status indicator
     */
    status?: string;
    session_type?: string;
    /**
     * Type of AI agent
     */
    agent_type?: string;
    /**
     * AI model used
     */
    ai_model?: string;
    /**
     * The stable principal that owns the session — the "who" dimension (operator, coordinator, builder-<id8>, tick, deploy-smoke, anonymous…). Null for pre-actor / header-less sessions. Attribution, not an authz boundary.
     */
    actor?: string | null;
    lines_added?: number;
    lines_deleted?: number;
    lines_net?: number;
    files_modified_count?: number;
    /**
     * Derived from tasks.session_id (not the denormalized counter)
     */
    tasks_created?: number;
    /**
     * Alias of tasks_created — same derived source
     */
    task_count?: number;
    /**
     * Counter column: an update leaves no per-session child row, so this one is not derivable
     */
    tasks_updated?: number;
    /**
     * Derived from tasks.session_id WHERE status = completed
     */
    tasks_completed?: number;
    /**
     * Decimal string percentage
     */
    task_completion_rate?: string;
    /**
     * Derived from contexts.session_id (not the denormalized counter)
     */
    contexts_created?: number;
    /**
     * Alias of contexts_created — same derived source
     */
    context_count?: number;
    /**
     * Derived from technical_decisions.session_id. The sessions.decisions_created column has no runtime writer and is permanently 0
     */
    decisions_created?: number;
    /**
     * Alias of decisions_created — same derived source
     */
    decision_count?: number;
    /**
     * Input tokens consumed
     */
    input_tokens?: string;
    /**
     * Output tokens generated
     */
    output_tokens?: string;
    /**
     * Total tokens (input + output)
     */
    total_tokens?: string;
    /**
     * Decimal productivity score 0-100
     */
    productivity_score?: string;
    activity_count?: number;
    metadata?: Record<string, any>;
});

