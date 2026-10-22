/**
 * Embedding Normalization
 * 
 * Normalize embeddings to target dimensions with unit normalization.
 */

import { EmbeddingVector } from './types.js';
import { logger } from '../../utils/logger.js';
import { assertUsableEmbedding } from './degenerate.js';

/**
 * Pad or downsample embeddings so they match the configured dimensionality
 * with unit normalization for proper cosine similarity.
 *
 * REFUSES TO MANUFACTURE A DEAD VECTOR. Two paths here used to invent an
 * all-zero result and return it as if it were an embedding — measured on this exact code:
 *   - `normalizeEmbedding([], 1536)` → 1536 zeros, no throw, no warning; and
 *     `applyTargetDimensions({embedding: []}, …)` then labelled it `dimensions: 1536`.
 *   - the DOWNSAMPLE branch takes every ⌊i·step⌋-th coordinate, so a perfectly healthy
 *     source can alias to nothing: a 768-d vector of norm 19.6 with its signal on the ODD
 *     indices downsamples to 384 zeros (measured). The input was fine; the output is dead.
 * Both now throw an EmbeddingError, which every caller already treats as an embed failure
 * (degrade + persist NULL + LOUD alert + self-heal) rather than writing an un-retrievable row.
 */
export function normalizeEmbedding(rawEmbedding: number[], targetDimensions: number): number[] {
  const target = targetDimensions;
  const source = Array.from(rawEmbedding ?? []);

  if (target <= 0) {
    // No target geometry to enforce — hand the source back, but never a dead one.
    assertUsableEmbedding(source, 'normalizeEmbedding (no target dimensions)');
    return source;
  }

  // An empty source carries no information; padding it to `target` produces zeros that are
  // indistinguishable from a real embedding to every NOT-NULL check in the system.
  assertUsableEmbedding(source, 'normalizeEmbedding (source vector)');

  // Apply dimension transformation first
  let normalized: number[];

  if (source.length === target) {
    normalized = source;
  } else if (source.length > target) {
    // Downsample: take evenly spaced samples
    const step = source.length / target;
    normalized = new Array<number>(target);
    for (let i = 0; i < target; i++) {
      normalized[i] = source[Math.floor(i * step)];
    }
  } else {
    // Upsample: zero-pad to target dimensions (preserves original information)
    normalized = new Array<number>(target);
    for (let i = 0; i < target; i++) {
      normalized[i] = i < source.length ? source[i] : 0;
    }
  }

  // The transformation itself can destroy the vector (the downsample-aliasing case above),
  // so re-check the RESULT, not just the input. A zero-norm result cannot be unit-normalized
  // and must never be returned as an embedding.
  assertUsableEmbedding(normalized, `normalizeEmbedding (${source.length}D → ${target}D result)`);

  // Apply unit normalization for cosine similarity
  // This ensures all vectors have magnitude 1, making distance calculations consistent
  const norm = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0));

  return normalized.map(val => val / norm);
}

/**
 * Normalize embeddings from different sources to the canonical dimensionality
 */
export function applyTargetDimensions(
  result: EmbeddingVector,
  source: string,
  targetDimensions: number
): EmbeddingVector {
  const normalized = normalizeEmbedding(result.embedding, targetDimensions);

  if (normalized.length !== result.embedding.length) {
    logger.info(`🔁 Adjusted ${source} embedding from ${result.embedding.length}D to ${targetDimensions}D`);
  }

  return {
    embedding: normalized,
    dimensions: targetDimensions,
    model: result.model,
  };
}
