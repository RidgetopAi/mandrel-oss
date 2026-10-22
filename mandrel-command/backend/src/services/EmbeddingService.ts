/**
 * Embedding Service
 * 
 * Re-exports from modular structure for backward compatibility.
 * 
 * @see ./embedding/index.ts for the modular implementation
 * 
 * Structure:
 * - embedding/core.ts          - Shared utilities
 * - embedding/datasets.ts      - Available datasets
 * - embedding/visualization.ts - Matrix, projection, clustering
 * - embedding/quality.ts       - Quality metrics
 * - embedding/relevance.ts     - Relevance analytics
 * - embedding/relationships.ts - Project graphs
 * - embedding/knowledgeGap.ts  - Gap analysis
 * - embedding/usagePatterns.ts - Activity patterns
 */

export * from './embedding';
export { EmbeddingService } from './embedding';
