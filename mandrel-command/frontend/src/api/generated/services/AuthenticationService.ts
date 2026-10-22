/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { LoginRequest } from '../models/LoginRequest';
import type { LoginResponse } from '../models/LoginResponse';
import type { ProfileResponse } from '../models/ProfileResponse';
import type { RefreshTokenResponse } from '../models/RefreshTokenResponse';
import type { RegisterRequest } from '../models/RegisterRequest';
import type { User } from '../models/User';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AuthenticationService {
    /**
     * User login
     * Authenticate a user with username and password
     * @returns LoginResponse Login successful
     * @throws ApiError
     */
    public static postAuthLogin({
        requestBody,
    }: {
        requestBody: LoginRequest,
    }): CancelablePromise<LoginResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/login',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request`,
                401: `Invalid credentials`,
                429: `Too many login attempts`,
                500: `Server error`,
            },
        });
    }
    /**
     * User logout
     * Logout the authenticated user and invalidate their token
     * @returns any Logout successful
     * @throws ApiError
     */
    public static postAuthLogout(): CancelablePromise<{
        success?: boolean;
        message?: string;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/logout',
            errors: {
                401: `Unauthorized - invalid or missing token`,
                500: `Server error`,
            },
        });
    }
    /**
     * Get user profile
     * Get the profile of the authenticated user
     * @returns ProfileResponse Profile retrieved successfully
     * @throws ApiError
     */
    public static getAuthProfile(): CancelablePromise<ProfileResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/auth/profile',
            errors: {
                401: `Unauthorized - invalid or missing token`,
                500: `Server error`,
            },
        });
    }
    /**
     * Refresh authentication token
     * Refresh the JWT token for the authenticated user
     * @returns RefreshTokenResponse Token refreshed successfully
     * @throws ApiError
     */
    public static postAuthRefresh(): CancelablePromise<RefreshTokenResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/refresh',
            errors: {
                401: `Unauthorized - invalid or missing token`,
                500: `Server error`,
            },
        });
    }
    /**
     * Register new user (Admin only)
     * Register a new user account. Requires admin privileges.
     * @returns any User created successfully
     * @throws ApiError
     */
    public static postAuthRegister({
        requestBody,
    }: {
        requestBody: RegisterRequest,
    }): CancelablePromise<{
        success?: boolean;
        message?: string;
        data?: {
            user?: User;
        };
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/register',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request`,
                401: `Unauthorized - invalid or missing token`,
                403: `Forbidden - admin privileges required`,
                409: `Conflict - username or email already exists`,
                429: `Too many registration attempts`,
                500: `Server error`,
            },
        });
    }
}
