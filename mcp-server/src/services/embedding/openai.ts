/**
 * OpenAI Embedding
 * 
 * Generate embeddings using OpenAI API (production grade).
 */

import { EmbeddingError, EmbeddingErrorType, EmbeddingVector, RetryConfig } from './types.js';
import { executeWithRetry, isRetryableError } from './retry.js';
import { logger } from '../../utils/logger.js';

/**
 * Check if OpenAI API is available
 */
export function isOpenAIAvailable(): boolean {
  const apiKey = process.env.OPENAI_API_KEY;
  return !!(apiKey && apiKey !== 'your_openai_api_key_here' && apiKey.startsWith('sk-'));
}

/**
 * Generate real OpenAI embedding with retry logic
 */
export async function generateOpenAIEmbedding(
  text: string,
  apiKey: string,
  model: string,
  retryConfig: RetryConfig
): Promise<EmbeddingVector> {
  logger.info('🔮 Generating real OpenAI embedding...');

  return executeWithRetry(async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: text,
          model: model,
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorType = EmbeddingErrorType.API_ERROR;
        let isRetryable = false;

        // Categorize API errors
        if (response.status === 429) {
          errorType = EmbeddingErrorType.RESOURCE_EXHAUSTED;
          isRetryable = true;
        } else if (response.status >= 500) {
          isRetryable = true;
        } else if (response.status === 401 || response.status === 403) {
          errorType = EmbeddingErrorType.API_ERROR;
          isRetryable = false;
        }

        const errorText = await response.text().catch(() => response.statusText);
        throw new EmbeddingError(
          `OpenAI API error (${response.status}): ${errorText}`,
          errorType,
          isRetryable
        );
      }

      const data = await response.json();

      // Validate API response structure
      if (!data || !data.data || !Array.isArray(data.data) || data.data.length === 0) {
        throw new EmbeddingError(
          'OpenAI API returned invalid response structure',
          EmbeddingErrorType.API_ERROR,
          false
        );
      }

      const embedding = data.data[0].embedding;

      // Validate embedding data
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new EmbeddingError(
          'OpenAI API returned invalid embedding data',
          EmbeddingErrorType.API_ERROR,
          false
        );
      }

      // Check for invalid values
      const hasInvalidValues = embedding.some((val: any) => typeof val !== 'number' || !isFinite(val));
      if (hasInvalidValues) {
        throw new EmbeddingError(
          'OpenAI API returned embedding with invalid values',
          EmbeddingErrorType.API_ERROR,
          false
        );
      }

      logger.info(`✅ Generated OpenAI embedding (${embedding.length} dimensions)`);

      return {
        embedding,
        dimensions: embedding.length,
        model: model,
      };
    } catch (error) {
      const err = error as Error & { code?: string; name?: string };
      if (err instanceof EmbeddingError) {
        throw err;
      }

      // Handle fetch-specific errors
      if (err.name === 'AbortError') {
        throw new EmbeddingError(
          'OpenAI API request timed out',
          EmbeddingErrorType.NETWORK_ERROR,
          true,
          err
        );
      }

      if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
        throw new EmbeddingError(
          `OpenAI API network error: ${err.message}`,
          EmbeddingErrorType.NETWORK_ERROR,
          true,
          err
        );
      }

      throw new EmbeddingError(
        `OpenAI API request failed: ${err.message}`,
        EmbeddingErrorType.API_ERROR,
        isRetryableError(err),
        err
      );
    }
  }, 'OpenAI embedding generation', retryConfig);
}
