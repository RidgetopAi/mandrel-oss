/**
 * Dimensionality Reduction Service
 * 
 * Reduces high-dimensional vectors (1536D) to 2D/3D coordinates
 * for visualization and spatial analysis using UMAP algorithm.
 */

import { UMAP } from 'umap-js';
import { logger } from '../utils/logger.js';

export interface CoordinateResult {
  x: number;
  y: number;
  z?: number;
  method: 'umap' | 'tsne';
}

export interface VectorMapping {
  id: string;
  coordinates: CoordinateResult;
}

class DimensionalityReductionService {
  private umapCache: Map<string, UMAP> = new Map();

  /**
   * Reduce a batch of vectors to 2D or 3D coordinates
   */
  async reduceVectors(
    vectors: number[][],
    options: {
      dimensions?: 2 | 3;
      method?: 'umap';
      nNeighbors?: number;
      minDist?: number;
      spread?: number;
    } = {}
  ): Promise<number[][]> {
    const {
      dimensions = 3,
      method = 'umap',
      nNeighbors = 15,
      minDist = 0.1,
      spread = 1.0,
    } = options;

    if (vectors.length === 0) {
      return [];
    }

    // Validate input dimensions
    const inputDim = vectors[0].length;
    if (inputDim !== 1536 && inputDim !== 384) {
      throw new Error(`Invalid vector dimension: ${inputDim}. Expected 1536 or 384.`);
    }

    if (method === 'umap') {
      return this.umapReduce(vectors, dimensions, nNeighbors, minDist, spread);
    }

    throw new Error(`Unsupported reduction method: ${method}`);
  }

  /**
   * UMAP dimensionality reduction
   */
  private async umapReduce(
    vectors: number[][],
    dimensions: number,
    nNeighbors: number,
    minDist: number,
    spread: number
  ): Promise<number[][]> {
    // Need at least nNeighbors + 1 samples for UMAP
    if (vectors.length < nNeighbors + 1) {
      logger.warn(
        `Not enough samples for UMAP (${vectors.length} < ${nNeighbors + 1}). Using fallback.`
      );
      return this.fallbackReduce(vectors, dimensions);
    }

    const umap = new UMAP({
      nComponents: dimensions,
      nNeighbors: Math.min(nNeighbors, vectors.length - 1),
      minDist,
      spread,
      random: Math.random,
    });

    try {
      const embedding = await umap.fitAsync(vectors);
      return embedding as number[][];
    } catch (error) {
      logger.error('UMAP reduction failed', error as Error);
      return this.fallbackReduce(vectors, dimensions);
    }
  }

  /**
   * Fallback: PCA-like reduction when UMAP fails
   */
  private fallbackReduce(vectors: number[][], dimensions: number): number[][] {
    logger.info('Using PCA-like fallback reduction');
    
    // Simple variance-based projection
    const result: number[][] = [];
    
    for (const vector of vectors) {
      const coords: number[] = [];
      
      // Take first N principal components (simplified)
      for (let i = 0; i < dimensions; i++) {
        const step = Math.floor(vector.length / dimensions);
        const start = i * step;
        const end = Math.min(start + step, vector.length);
        
        // Average values in this segment
        const avg = vector.slice(start, end).reduce((a, b) => a + b, 0) / (end - start);
        coords.push(avg);
      }
      
      result.push(coords);
    }
    
    return result;
  }

  /**
   * Normalize coordinates to a specific range
   */
  normalizeCoordinates(
    coordinates: number[][],
    range: { min: number; max: number } = { min: -10, max: 10 }
  ): number[][] {
    if (coordinates.length === 0) return [];

    const dimensions = coordinates[0].length;
    const mins = new Array(dimensions).fill(Infinity);
    const maxs = new Array(dimensions).fill(-Infinity);

    // Find min/max for each dimension
    for (const coord of coordinates) {
      for (let i = 0; i < dimensions; i++) {
        mins[i] = Math.min(mins[i], coord[i]);
        maxs[i] = Math.max(maxs[i], coord[i]);
      }
    }

    // Normalize to range
    return coordinates.map((coord) =>
      coord.map((val, i) => {
        const normalized = (val - mins[i]) / (maxs[i] - mins[i]);
        return range.min + normalized * (range.max - range.min);
      })
    );
  }

  /**
   * Map a single vector to coordinates (incremental mapping)
   * Uses existing vectors as context for consistent positioning
   */
  async mapSingleVector(
    newVector: number[],
    referenceVectors: number[][],
    referenceCoordinates: number[][]
  ): Promise<CoordinateResult> {
    if (referenceVectors.length === 0 || referenceCoordinates.length === 0) {
      // No reference data, use fallback
      const fallback = this.fallbackReduce([newVector], 3)[0];
      return {
        x: fallback[0],
        y: fallback[1],
        z: fallback[2],
        method: 'umap',
      };
    }

    // Find k-nearest neighbors in high-dimensional space
    const k = Math.min(5, referenceVectors.length);
    const neighbors = this.findKNearestNeighbors(newVector, referenceVectors, k);

    // Interpolate position based on neighbors in low-dimensional space
    let x = 0, y = 0, z = 0;
    let totalWeight = 0;

    for (const { index, distance } of neighbors) {
      const weight = 1 / (distance + 1e-6); // Avoid division by zero
      const coords = referenceCoordinates[index];
      
      x += coords[0] * weight;
      y += coords[1] * weight;
      if (coords.length > 2) z += coords[2] * weight;
      
      totalWeight += weight;
    }

    return {
      x: x / totalWeight,
      y: y / totalWeight,
      z: referenceCoordinates[0].length > 2 ? z / totalWeight : 0,
      method: 'umap',
    };
  }

  /**
   * Find k-nearest neighbors using cosine similarity
   */
  private findKNearestNeighbors(
    vector: number[],
    candidates: number[][],
    k: number
  ): Array<{ index: number; distance: number }> {
    const distances = candidates.map((candidate, index) => ({
      index,
      distance: this.cosineDistance(vector, candidate),
    }));

    distances.sort((a, b) => a.distance - b.distance);
    return distances.slice(0, k);
  }

  /**
   * Calculate cosine distance between two vectors
   */
  private cosineDistance(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return 1 - similarity; // Distance = 1 - similarity
  }

  /**
   * Clear UMAP cache
   */
  clearCache(): void {
    this.umapCache.clear();
  }
}

// Singleton instance
export const dimensionalityReductionService = new DimensionalityReductionService();
