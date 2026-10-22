/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DocumentationService {
    /**
     * Get OpenAPI specification
     * @returns any OpenAPI specification in JSON format
     * @throws ApiError
     */
    public static getOpenapiJson(): CancelablePromise<Record<string, any>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/openapi.json',
        });
    }
}
