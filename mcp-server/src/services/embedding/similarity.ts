/**
 * Similarity & Validation
 * 
 * Cosine similarity calculation and embedding validation.
 */

import { EmbeddingError, EmbeddingErrorType } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Calculate cosine similarity between two embeddings with robust error handling
 * This is used for finding similar contexts
 */
export function calculateCosineSimilarity(a: number[], b: number[]): number {
  try {
    // Validate inputs
    if (!Array.isArray(a) || !Array.isArray(b)) {
      throw new EmbeddingError(
        'Similarity calculation requires two arrays',
        EmbeddingErrorType.INPUT_VALIDATION
      );
    }

    if (a.length !== b.length) {
      throw new EmbeddingError(
        `Embeddings must have same dimensions for similarity calculation (got ${a.length} and ${b.length})`,
        EmbeddingErrorType.INPUT_VALIDATION
      );
    }

    if (a.length === 0) {
      throw new EmbeddingError(
        'Cannot calculate similarity for empty embeddings',
        EmbeddingErrorType.INPUT_VALIDATION
      );
    }

    // Check for invalid values
    const hasInvalidA = a.some(val => !isFinite(val));
    const hasInvalidB = b.some(val => !isFinite(val));

    if (hasInvalidA || hasInvalidB) {
      throw new EmbeddingError(
        'Cannot calculate similarity for embeddings with invalid values (NaN/Infinity)',
        EmbeddingErrorType.INPUT_VALIDATION
      );
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    // Handle zero vectors
    if (normA === 0 || normB === 0) {
      logger.warn('⚠️  Zero vector detected in similarity calculation, returning 0');
      return 0;
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    // Clamp to valid range due to floating point precision
    return Math.max(-1, Math.min(1, similarity));
  } catch (error) {
    const err = error as Error;
    if (err instanceof EmbeddingError) {
      throw err;
    }

    throw new EmbeddingError(
      `Similarity calculation failed: ${err.message}`,
      EmbeddingErrorType.UNKNOWN,
      false,
      err
    );
  }
}

/**
 * Validate embedding vector format with detailed error reporting
 */
export function validateEmbedding(embedding: number[], expectedDimensions: number): boolean {
  if (!Array.isArray(embedding)) {
    logger.warn('⚠️  Embedding validation failed: not an array');
    return false;
  }

  if (embedding.length !== expectedDimensions) {
    logger.warn(`⚠️  Embedding validation failed: wrong dimensions (got ${embedding.length}, expected ${expectedDimensions})`);
    return false;
  }

  const invalidValues = embedding.filter((val, idx) => {
    const isValid = typeof val === 'number' && !isNaN(val) && isFinite(val) && val >= -1 && val <= 1;
    if (!isValid) {
      logger.warn(`⚠️  Embedding validation failed: invalid value at index ${idx}: ${val} (type: ${typeof val})`);
    }
    return !isValid;
  });

  return invalidValues.length === 0;
}
