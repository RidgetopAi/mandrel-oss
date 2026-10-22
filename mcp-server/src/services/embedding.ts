/**
 * AIDIS Embedding Service
 * 
 * This file is a slim entry point that re-exports from the modular embedding/ directory.
 * The implementation has been split into focused modules for maintainability.
 * 
 * @see ./embedding/ for the modular implementation
 */

// Types (re-export)
export { EmbeddingErrorType, EmbeddingError } from './embedding/index.js';
export type {
  EmbeddingVector,
  EmbeddingRequest,
  EmbeddingMetrics,
  EmbeddingHealthStatus,
  EmbeddingStatus,
  EmbeddingConfig,
  RetryConfig
} from './embedding/index.js';
  
// Main service
export { EmbeddingService, embeddingService } from './embedding/index.js';
