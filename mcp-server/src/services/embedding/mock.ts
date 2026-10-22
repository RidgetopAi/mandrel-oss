/**
 * Mock Embedding
 * 
 * Generate mock embeddings for development/testing.
 */

import { EmbeddingVector } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Simple hash function for consistent mock embeddings
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Add content-based signals to make mock embeddings somewhat meaningful
 */
function addContentSignals(embedding: number[], text: string): void {
  const words = text.toLowerCase().split(/\s+/);
  
  // Add signals for common development terms
  const signals: Record<string, number[]> = {
    'database': [0, 50, 100],
    'postgresql': [1, 51, 101],
    'mcp': [2, 52, 102],
    'server': [3, 53, 103],
    'typescript': [4, 54, 104],
    'context': [5, 55, 105],
    'embedding': [6, 56, 106],
    'search': [7, 57, 107],
    'vector': [8, 58, 108],
    'agent': [9, 59, 109],
    'error': [10, 60, 110],
    'code': [11, 61, 111],
    'planning': [12, 62, 112],
    'decision': [13, 63, 113],
  };

  // Boost dimensions for words found in text
  words.forEach(word => {
    const positions = signals[word];
    if (positions) {
      positions.forEach(pos => {
        if (pos < embedding.length) {
          embedding[pos] += 0.2; // Boost signal for this concept (keep within [-1,1] range)
        }
      });
    }
  });
}

/**
 * Generate mock embedding for development/testing
 * 
 * This creates a deterministic vector based on text content.
 * While not semantically meaningful, it's perfect for testing
 * the vector search infrastructure!
 */
export function generateMockEmbedding(text: string, targetDimensions: number, model: string): EmbeddingVector {
  logger.info('🎭 Generating mock embedding for development...');
  
  const dimensions = targetDimensions;
  const embedding = new Array(dimensions);
  const textHash = simpleHash(text);
  
  // Use different aspects of the text to create varied dimensions
  for (let i = 0; i < dimensions; i++) {
    // Create pseudo-random values based on text content and position
    const seed = textHash + i;
    const value = Math.sin(seed * 0.001) * 0.6; // Range roughly [-0.6, 0.6] to leave room for signals
    embedding[i] = value;
  }

  // Add some content-based signals to make similar texts have similar embeddings
  addContentSignals(embedding, text);

  logger.info(`✅ Generated mock embedding (${dimensions} dimensions before normalization)`);
  
  return {
    embedding,
    dimensions,
    model: `${model}-mock`,
  };
}
