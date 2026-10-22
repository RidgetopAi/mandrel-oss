/**
 * QA Finding #3: React Query Error Handler with Sentry Integration
 * Provides centralized error handling for React Query operations
 */

import { useCallback } from 'react';
import { reportError as sentryReportError, addBreadcrumb } from '../config/sentry';
import { logger } from '../utils/logger';

interface QueryErrorContext {
  queryKey?: string;
  operation?: 'query' | 'mutation';
  endpoint?: string;
}

export const useQueryErrorHandler = () => {
  const handleQueryError = useCallback((error: any, context?: QueryErrorContext) => {
    // Log for development debugging
    logger.error('React Query Error:', error, context);

    // Add breadcrumb for debugging
    addBreadcrumb(
      `React Query ${context?.operation || 'operation'} failed`,
      'http',
      {
        queryKey: context?.queryKey,
        endpoint: context?.endpoint,
        status: error?.status,
        message: error?.message,
      }
    );

    // Only report certain errors to Sentry (avoid noise from expected network errors)
    const shouldReport =
      error?.status >= 500 || // Server errors
      !error?.status || // Unknown errors
      error?.name === 'TypeError' || // JavaScript errors
      error?.name === 'SyntaxError'; // Parse errors

    if (shouldReport) {
      sentryReportError(
        error instanceof Error ? error : new Error(error?.message || 'React Query Error'),
        {
          queryOperation: context?.operation,
          queryKey: context?.queryKey,
          endpoint: context?.endpoint,
          httpStatus: error?.status,
          responseBody: error?.body,
        }
      );
    }
  }, []);

  const handleMutationError = useCallback((error: any, variables?: any, context?: any) => {
    handleQueryError(error, {
      operation: 'mutation',
      endpoint: context?.endpoint,
      queryKey: context?.queryKey,
    });
  }, [handleQueryError]);

  return {
    handleQueryError,
    handleMutationError,
  };
};

// Global error handler for React Query
export const globalQueryErrorHandler = (error: any) => {
  // Don't log 4xx errors as they're often expected (validation, auth, etc.)
  if (error?.status >= 400 && error?.status < 500) {
    return;
  }

  logger.error('Global React Query Error:', error);

  // Report unexpected errors to Sentry
  addBreadcrumb('Global React Query Error', 'http', {
    status: error?.status,
    message: error?.message,
  });

  if (error?.status >= 500 || !error?.status) {
    sentryReportError(
      error instanceof Error ? error : new Error(error?.message || 'Global React Query Error'),
      {
        global: true,
        httpStatus: error?.status,
      }
    );
  }
};