/**
 * Input Validation
 * 
 * Validate text input before processing.
 */

import { EmbeddingError, EmbeddingErrorType } from './types.js';

/**
 * Validates input text before processing
 */
export function validateInput(text: string, maxTextLength: number): void {
  if (!text || typeof text !== 'string') {
    throw new EmbeddingError(
      'Input text must be a non-empty string',
      EmbeddingErrorType.INPUT_VALIDATION
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new EmbeddingError(
      'Input text cannot be empty or whitespace only',
      EmbeddingErrorType.INPUT_VALIDATION
    );
  }

  if (trimmed.length > maxTextLength) {
    throw new EmbeddingError(
      `Input text too long: ${trimmed.length} characters (max: ${maxTextLength})`,
      EmbeddingErrorType.INPUT_VALIDATION
    );
  }

  // Check for potentially problematic characters
  const controlCharsRegex = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
  if (controlCharsRegex.test(trimmed)) {
    throw new EmbeddingError(
      'Input text contains control characters that may cause processing issues',
      EmbeddingErrorType.INPUT_VALIDATION
    );
  }
}
