/**
 * QA Finding #3: Sentry Integration for Error Reporting
 * Configures Sentry for comprehensive error tracking and performance monitoring
 */

import * as Sentry from '@sentry/react';
import { logger } from '../utils/logger';

// Sentry configuration
export const initSentry = () => {
  // Only initialize Sentry when explicitly enabled with a valid DSN
  // Prevents accidental telemetry to demo DSN
  const shouldInitSentry =
    import.meta.env.PROD &&
    import.meta.env.VITE_SENTRY_ENABLED === 'true' &&
    !!import.meta.env.VITE_SENTRY_DSN;

  if (!shouldInitSentry) {
    logger.log('Sentry disabled (not enabled or missing DSN)');
    return;
  }

  Sentry.init({
    // Use environment variable for DSN - REQUIRED
    dsn: import.meta.env.VITE_SENTRY_DSN,

    environment: import.meta.env.MODE,

    // Release tracking
    release: import.meta.env.VITE_VERSION || '1.0.0',

    // Performance monitoring sample rate (10% in production)
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,

    // Error sampling rate
    sampleRate: 1.0,

    // Enhanced error context
    beforeSend(event, hint) {
      // Add additional context
      event.tags = {
        ...event.tags,
        component: 'frontend',
        framework: 'react',
        build: import.meta.env.VITE_BUILD_NUMBER || 'development',
      };

      // Add user context if available
      const authToken = localStorage.getItem('aidis_token');
      if (authToken) {
        event.user = {
          ...event.user,
          authenticated: true,
        };
      }

      // Filter out known non-critical errors
      if (hint.originalException) {
        const error = hint.originalException as Error;

        // Filter network errors that are handled by React Query
        if (error.message?.includes('fetch') || error.message?.includes('Network')) {
          return null; // Don't send network errors that are handled
        }

        // Filter React Suspense errors (normal React behavior)
        if (error.message?.includes('Suspense')) {
          return null;
        }
      }

      return event;
    },

    // Performance monitoring configuration
    beforeSendTransaction(transaction: any) {
      // Add custom context to transactions
      transaction.setTag('component', 'frontend');
      return transaction;
    },

    // Error filtering
    ignoreErrors: [
      // Browser extensions
      'Non-Error promise rejection captured',
      'ResizeObserver loop limit exceeded',
      'Script error.',
      // Network errors handled by React Query
      'Failed to fetch',
      'NetworkError',
      'Load failed',
      // React development warnings
      'Warning: ',
    ],

    // Privacy settings
    sendDefaultPii: false,

    // Debug mode in development
    debug: import.meta.env.DEV,
  });

  // Set user context
  Sentry.setUser({
    id: 'aidis-user',
    username: 'developer',
  });

  logger.log('Sentry initialized successfully');
};

// Enhanced error reporting functions
export const reportError = (error: Error, context?: Record<string, any>) => {
  Sentry.withScope((scope) => {
    if (context) {
      scope.setContext('additional_info', context);
    }
    scope.setLevel('error');
    Sentry.captureException(error);
  });
};

export const addBreadcrumb = (message: string, category?: string, data?: Record<string, any>) => {
  Sentry.addBreadcrumb({
    message,
    category: category || 'custom',
    data,
    level: 'info',
  });
};

// Sentry export removed - unused