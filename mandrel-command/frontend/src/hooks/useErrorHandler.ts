/**
 * TR002-6: Error Handler Hook for AIDIS API Integration
 * Provides error handling utilities for components using AIDIS V2 API
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { message } from 'antd';
import type { ApiError } from '../api/mandrelApiClient';
import { reportError } from '../services/errorReporter';
import { logger } from '../utils/logger';

export interface ErrorState {
  hasError: boolean;
  error: Error | ApiError | null;
  errorType: 'api' | 'component' | 'network' | 'validation' | 'unknown';
  retryCount: number;
  lastErrorTime: Date | null;
  isRecovering: boolean;
}

export interface ErrorHandlerConfig {
  componentName: string;
  enableAutoRetry?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  showUserMessages?: boolean;
  reportToAidis?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<ErrorHandlerConfig, 'componentName'>> = {
  enableAutoRetry: true,
  maxRetries: 3,
  retryDelay: 1000,
  showUserMessages: true,
  reportToAidis: true,
};

export const useErrorHandler = (config: ErrorHandlerConfig) => {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const [errorState, setErrorState] = useState<ErrorState>({
    hasError: false,
    error: null,
    errorType: 'unknown',
    retryCount: 0,
    lastErrorTime: null,
    isRecovering: false,
  });

  const retryTimeoutRef = useRef<NodeJS.Timeout>();
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, []);

  const classifyError = useCallback((error: Error | ApiError): ErrorState['errorType'] => {
    const errorString = error.message.toLowerCase();

    // API-specific errors
    if ('code' in error || errorString.includes('api') || errorString.includes('request')) {
      return 'api';
    }

    // Network errors
    if (errorString.includes('network') || errorString.includes('fetch') || errorString.includes('timeout')) {
      return 'network';
    }

    // Validation errors
    if (errorString.includes('validation') || errorString.includes('schema') || errorString.includes('invalid')) {
      return 'validation';
    }

    // Component errors
    if (errorString.includes('component') || errorString.includes('render') || errorString.includes('hook')) {
      return 'component';
    }

    return 'unknown';
  }, []);

  const reportErrorToAidis = useCallback(async (error: Error | ApiError, errorType: ErrorState['errorType']) => {
    if (!finalConfig.reportToAidis) return;

    try {
      const errorContext = {
        componentName: finalConfig.componentName,
        errorType,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error.message,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        url: window.location.href,
        ...(('code' in error) && { errorCode: error.code }),
        ...(('requestId' in error) && { requestId: error.requestId }),
      };

      // NOT via MCP `context_store`. A browser presents no
      // X-Connection-ID, so an ambient context_store naming no project is rejected by
      // callerIdentityGuard G2 the moment MANDREL_PROJECT_SCOPE_GUARD flips to `enforce`
      // — and rejected INSIDE this try/catch, i.e. UI error telemetry would go silently
      // dark exactly when something is already wrong. Before the flip it was worse than
      // useless: it wrote the user's UI stack traces into whichever project the shared
      // slot happened to point at, so it POLLUTED a project nobody chose.
      // services/errorReporter.ts is the purpose-built path (Sentry + the authenticated
      // /api/monitoring/errors REST endpoint), it is project-scope-free by construction,
      // and it is not reachable by the identity guard at all.
      await reportError(
        error instanceof Error ? error : new Error(error.message),
        undefined,
        {
          section: finalConfig.componentName,
          metadata: { ...errorContext, tags: ['ui-error', errorType] },
        }
      );

      logger.log('✅ Error reported:', errorContext);
      // Binding is named `reportFailure`, NOT `reportError` — this file now imports a function
      // called `reportError`, and a catch parameter of the same name shadows it inside this
      // block. Harmless while nothing here calls it; a trap the moment someone tries to.
    } catch (reportFailure) {
      logger.warn('⚠️ Failed to report UI error:', reportFailure);
    }
  }, [finalConfig.componentName, finalConfig.reportToAidis]);

  const handleError = useCallback((error: Error | ApiError, options?: {
    skipRetry?: boolean;
    showMessage?: boolean;
    customMessage?: string;
  }) => {
    if (!mountedRef.current) return;

    const errorType = classifyError(error);
    const now = new Date();

    setErrorState(prev => ({
      hasError: true,
      error,
      errorType,
      retryCount: options?.skipRetry ? prev.retryCount : prev.retryCount + 1,
      lastErrorTime: now,
      isRecovering: false,
    }));

    // Report to AIDIS
    reportErrorToAidis(error, errorType);

    // Show user message
    if (finalConfig.showUserMessages && options?.showMessage !== false) {
      const userMessage = options?.customMessage || getUserFriendlyMessage(error, errorType);
      message.error(userMessage);
    }

    // Auto-retry logic
    if (
      finalConfig.enableAutoRetry &&
      !options?.skipRetry &&
      errorState.retryCount < finalConfig.maxRetries &&
      (errorType === 'api' || errorType === 'network')
    ) {
      scheduleRetry();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyError, reportErrorToAidis, finalConfig, errorState.retryCount]); // scheduleRetry excluded to prevent infinite loops

  const getUserFriendlyMessage = (error: Error | ApiError, errorType: ErrorState['errorType']): string => {
    switch (errorType) {
      case 'api':
        return 'API request failed. Please try again.';
      case 'network':
        return 'Connection problem. Please check your internet.';
      case 'validation':
        return 'Invalid data. Please check your input.';
      case 'component':
        return 'Component error. Refreshing may help.';
      default:
        return 'Something went wrong. Please try again.';
    }
  };

  const scheduleRetry = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }

    setErrorState(prev => ({ ...prev, isRecovering: true }));

    const delay = finalConfig.retryDelay * Math.pow(2, errorState.retryCount);

    retryTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) {
        setErrorState(prev => ({ ...prev, isRecovering: false }));
      }
    }, delay);
  }, [finalConfig.retryDelay, errorState.retryCount]);

  const clearError = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
    }

    setErrorState({
      hasError: false,
      error: null,
      errorType: 'unknown',
      retryCount: 0,
      lastErrorTime: null,
      isRecovering: false,
    });
  }, []);

  const retryOperation = useCallback(async (operation: () => Promise<any>) => {
    setErrorState(prev => ({ ...prev, isRecovering: true }));

    try {
      const result = await operation();
      clearError();
      if (finalConfig.showUserMessages) {
        message.success('Operation succeeded');
      }
      return result;
    } catch (error) {
      handleError(error as Error | ApiError);
      throw error;
    }
  }, [clearError, handleError, finalConfig.showUserMessages]);

  const withErrorHandling = useCallback(<T extends any[], R>(
    operation: (...args: T) => Promise<R>
  ) => {
    return async (...args: T): Promise<R | undefined> => {
      try {
        const result = await operation(...args);
        // Clear any previous errors on success
        if (errorState.hasError) {
          clearError();
        }
        return result;
      } catch (error) {
        handleError(error as Error | ApiError);
        return undefined;
      }
    };
  }, [clearError, handleError, errorState.hasError]);

  const getErrorMessage = useCallback((): string => {
    if (!errorState.error) return '';

    return `${finalConfig.componentName}: ${errorState.error.message}`;
  }, [errorState.error, finalConfig.componentName]);

  const isRetryable = useCallback((): boolean => {
    return (
      errorState.hasError &&
      errorState.retryCount < finalConfig.maxRetries &&
      (errorState.errorType === 'api' || errorState.errorType === 'network')
    );
  }, [errorState, finalConfig.maxRetries]);

  return {
    // State
    errorState,
    hasError: errorState.hasError,
    error: errorState.error,
    errorType: errorState.errorType,
    isRecovering: errorState.isRecovering,

    // Actions
    handleError,
    clearError,
    retryOperation,
    withErrorHandling,

    // Utilities
    getErrorMessage,
    isRetryable,
    retryCount: errorState.retryCount,
    maxRetries: finalConfig.maxRetries,
  };
};