/**
 * Embedding Service Module
 * 
 * Barrel exports for the modular embedding service.
 */

// Types
export { EmbeddingErrorType, EmbeddingError, createDefaultMetrics } from './types.js';
export type {
  EmbeddingVector,
  EmbeddingRequest,
  EmbeddingMetrics,
  EmbeddingHealthStatus,
  EmbeddingStatus,
  EmbeddingConfig,
  RetryConfig
} from './types.js';

// Core utilities
export { validateInput } from './validation.js';
export { calculateCosineSimilarity, validateEmbedding } from './similarity.js';
export { normalizeEmbedding, applyTargetDimensions } from './normalize.js';

// Retry utilities
export {
  createRetryConfig,
  sleep,
  calculateRetryDelay,
  isRetryableError,
  executeWithRetry
} from './retry.js';

// Embedding generators
export {
  initializeLocalModel,
  isLocalModelLoaded,
  getLocalModelName,
  generateLocalEmbedding
} from './localModel.js';
export { generateOllamaEmbedding, isOllamaAvailable } from './ollamaModel.js';
export { generateOpenAIEmbedding, isOpenAIAvailable } from './openai.js';
export { generateMockEmbedding } from './mock.js';

// Main service
export { EmbeddingService } from './EmbeddingService.js';

// Singleton instance
import { EmbeddingService } from './EmbeddingService.js';
export const embeddingService = new EmbeddingService();
