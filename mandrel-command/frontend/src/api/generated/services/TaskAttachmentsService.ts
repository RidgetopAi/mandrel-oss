/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TaskAttachment } from '../models/TaskAttachment';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class TaskAttachmentsService {
    /**
     * Bulk-by-task-ids read of task attachment metadata (board fan-out fix)
     * Replaces a per-card `GET /tasks/:id/attachments` fan-out. Task ids outside the caller's resolved project scope are silently OMITTED from the result, not 403'd, so one foreign id cannot fail the whole board fetch.
     *
     * @returns any Attachment metadata (no bytes) for the requested task ids, grouped flat and ordered by task_id then created_at
     * @throws ApiError
     */
    public static getAttachments({
        taskIds,
    }: {
        /**
         * Comma-separated task UUIDs, max 100
         */
        taskIds?: string,
    }): CancelablePromise<{
        success?: boolean;
        data?: {
            attachments?: Array<TaskAttachment>;
        };
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/attachments',
            query: {
                'taskIds': taskIds,
            },
            errors: {
                400: `Malformed taskIds, or more than 100 ids`,
            },
        });
    }
    /**
     * Upload an attachment for a task (before screenshot or evidence image)
     * @returns any Attachment stored
     * @throws ApiError
     */
    public static postTasksAttachments({
        id,
        formData,
    }: {
        id: string,
        formData: {
            file: Blob;
            kind?: 'before' | 'evidence';
        },
    }): CancelablePromise<{
        success?: boolean;
        data?: TaskAttachment;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/tasks/{id}/attachments',
            path: {
                'id': id,
            },
            formData: formData,
            mediaType: 'multipart/form-data',
            errors: {
                404: `Task not found`,
                413: `File exceeds the 5 MiB cap`,
                415: `Mime type not in the allowlist`,
            },
        });
    }
    /**
     * List attachments for a task
     * @returns any Attachments for the task, no bytes included
     * @throws ApiError
     */
    public static getTasksAttachments({
        id,
    }: {
        id: string,
    }): CancelablePromise<{
        success?: boolean;
        data?: {
            attachments?: Array<TaskAttachment>;
        };
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/tasks/{id}/attachments',
            path: {
                'id': id,
            },
        });
    }
    /**
     * Get an attachment's raw bytes
     * @returns binary The attachment bytes, Content-Type set to the stored mime
     * @throws ApiError
     */
    public static getAttachments1({
        attachmentId,
    }: {
        attachmentId: string,
    }): CancelablePromise<Blob> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/attachments/{attachmentId}',
            path: {
                'attachmentId': attachmentId,
            },
            errors: {
                404: `Attachment not found`,
            },
        });
    }
    /**
     * Delete an attachment
     * @returns void
     * @throws ApiError
     */
    public static deleteAttachments({
        attachmentId,
    }: {
        attachmentId: string,
    }): CancelablePromise<void> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/attachments/{attachmentId}',
            path: {
                'attachmentId': attachmentId,
            },
            errors: {
                404: `Attachment not found`,
            },
        });
    }
}
