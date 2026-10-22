/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type TaskAttachment = {
    id: string;
    taskId: string;
    kind: 'before' | 'evidence';
    filename: string;
    mime: string;
    byteSize: number;
    createdBy?: string | null;
    createdAt: string;
    /**
     * Path to GET the raw bytes
     */
    url: string;
};

