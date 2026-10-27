/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiToken } from '../models/ApiToken';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ApiTokensService {
    /**
     * List the current user's API tokens
     * Name, display prefix, created, last used and expiry for each un-revoked token the CALLER owns. Never returns a token or its hash.
     *
     * @returns any The caller's tokens, newest first
     * @throws ApiError
     */
    public static getApiTokens(): CancelablePromise<{
        success?: boolean;
        data?: {
            tokens?: Array<ApiToken>;
        };
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api-tokens',
            errors: {
                401: `Not logged in`,
                403: `Not an admin — API tokens carry full MCP access, so only admins may hold them`,
            },
        });
    }
    /**
     * Create an API token for the current user
     * Returns the plaintext token exactly once, in this response. Only its SHA-256 is stored; it cannot be shown again. Rate-limited and capped per user.
     *
     * @returns any Created. `plaintext` is the token; store it now.
     * @throws ApiError
     */
    public static postApiTokens({
        requestBody,
    }: {
        requestBody: {
            name: string;
            expiresInDays?: number | null;
        },
    }): CancelablePromise<{
        success?: boolean;
        data?: {
            token?: ApiToken;
            plaintext?: string;
        };
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api-tokens',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid name or expiry`,
                403: `Not an admin`,
                409: `The per-user token limit is reached`,
                429: `Create rate limit reached`,
            },
        });
    }
    /**
     * Revoke one of the current user's API tokens
     * Takes effect on the next request made with the token. Another user's token id answers 404, exactly like an id that does not exist.
     *
     * @returns any Revoked
     * @throws ApiError
     */
    public static deleteApiTokens({
        id,
    }: {
        id: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api-tokens/{id}',
            path: {
                'id': id,
            },
            errors: {
                400: `Malformed id`,
                403: `Not an admin`,
                404: `No such un-revoked token for this user`,
            },
        });
    }
}
