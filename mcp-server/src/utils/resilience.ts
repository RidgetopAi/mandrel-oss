/**
 * Resilience Utilities
 * Circuit breaker and retry patterns for fault-tolerant operations
 */

import { logger } from './logger.js';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Circuit Breaker for Database Operations
 * Prevents cascading failures by stopping requests after threshold
 */
export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  private failureThreshold: number;
  private recoveryTimeout: number;

  constructor(
    failureThreshold: number = 5,
    recoveryTimeout: number = 30000
  ) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  /**
   * Execute an operation with circuit breaker protection
   * @param operation The async operation to execute
   * @returns Result of the operation
   * @throws Error if circuit is open or operation fails
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Get current circuit breaker state
   */
  getState(): string {
    return this.state;
  }
}

/**
 * Retry Logic with Exponential Backoff
 * Retries failed operations with increasing delays
 */
export class RetryHandler {
  /**
   * Execute an operation with retry logic and exponential backoff
   * @param operation The async operation to execute
   * @param maxRetries Maximum number of retry attempts
   * @param baseDelay Initial delay in milliseconds
   * @returns Result of the operation
   * @throws Error if all retries fail
   */
  static async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = MAX_RETRIES,
    baseDelay: number = INITIAL_RETRY_DELAY
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries) {
          throw lastError;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        logger.info(`🔄 Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }
}
