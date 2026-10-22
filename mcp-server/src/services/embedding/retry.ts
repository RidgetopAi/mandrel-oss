/**
 * Retry Logic
 * 
 * Exponential backoff with jitter for retryable operations.
 */

import { EmbeddingError, RetryConfig } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Create default retry configuration from environment
 */
export function createRetryConfig(): RetryConfig {
  return {
    maxRetries: parseInt(process.env.EMBEDDING_MAX_RETRIES || '3'),
    baseDelay: parseInt(process.env.EMBEDDING_BASE_DELAY || '1000'),
    maxDelay: parseInt(process.env.EMBEDDING_MAX_DELAY || '30000'),
    backoffMultiplier: parseFloat(process.env.EMBEDDING_BACKOFF_MULTIPLIER || '2.0')
  };
}

/**
 * Sleep function for retry delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay for retry with exponential backoff and jitter
 */
export function calculateRetryDelay(attempt: number, config: RetryConfig): number {
  const delay = Math.min(
    config.baseDelay * Math.pow(config.backoffMultiplier, attempt),
    config.maxDelay
  );

  // Add jitter (±25% random variation) to prevent thundering herd
  const jitter = delay * 0.25 * (Math.random() - 0.5);
  return Math.floor(delay + jitter);
}

/**
 * Determines if an error is retryable
 */
export function isRetryableError(error: any): boolean {
  if (error instanceof EmbeddingError) {
    return error.isRetryable;
  }

  // Network errors are generally retryable
  if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
    return true;
  }

  // HTTP status codes that indicate retryable errors
  if (error.status) {
    const retryableStatuses = [408, 429, 500, 502, 503, 504];
    return retryableStatuses.includes(error.status);
  }

  // Transformers.js specific errors that might be retryable
  const errorMessage = error.message?.toLowerCase() || '';
  if (errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('temporary') ||
      errorMessage.includes('rate limit')) {
    return true;
  }

  return false;
}

/**
 * Execute a function with retry logic
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        logger.info(`✅ ${operationName} succeeded after ${attempt} retries`);
      }
      return result;
    } catch (error) {
      const err = error as Error;
      lastError = err;

      if (attempt === config.maxRetries) {
        logger.error(`❌ ${operationName} failed after ${attempt} retries`, err);
        break;
      }

      if (!isRetryableError(err)) {
        logger.error(`❌ ${operationName} failed with non-retryable error`, err);
        throw err;
      }

      const delay = calculateRetryDelay(attempt, config);
      logger.warn(`⚠️ ${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}), retrying in ${delay}ms`, { metadata: { error: err.message } });
      await sleep(delay);
    }
  }

  throw lastError;
}
