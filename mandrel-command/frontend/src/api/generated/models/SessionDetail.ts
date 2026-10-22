/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SessionEntity } from './SessionEntity';
export type SessionDetail = (SessionEntity & {
    contexts?: Array<{
        id?: string;
        type?: string;
        content?: string;
        created_at?: string;
        tags?: Array<string>;
    }>;
    duration?: number;
    metadata?: Record<string, any>;
});

