/**
 * Embedding Core Utilities
 * 
 * Shared utilities for embedding operations.
 */

import type { EmbeddingScope } from './types';

/**
 * Resolve project ID from scope (by ID or name)
 */
export async function resolveProjectId(scope: EmbeddingScope): Promise<string | undefined> {
  // Name resolution DELETED (the reviewer D1). This used to fall back to
  // `SELECT id FROM projects WHERE LOWER(name) = LOWER($1)` when the scope carried a
  // projectName — and the only thing that ever set projectName was the unauthorized
  // legacy `project` header, so this query was the step that turned a guessable NAME into
  // a project id an unauthorized caller could read. The scope now only ever carries an
  // id that getRequestProjectId() already authorized, so there is nothing left to resolve.
  return scope.projectId;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
