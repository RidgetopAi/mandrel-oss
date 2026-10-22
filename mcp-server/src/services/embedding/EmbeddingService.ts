/**
 * Embedding Service
 * 
 * Main service class that orchestrates embedding generation.
 * Supports multiple backends: local Transformers.js, OpenAI, and mock.
 */

import {
  EmbeddingError,
  EmbeddingErrorType,
  EmbeddingVector,
  EmbeddingRequest,
  EmbeddingMetrics,
  EmbeddingHealthStatus,
  EmbeddingStatus,
  EmbeddingConfig,
  RetryConfig,
  createDefaultMetrics
} from './types.js';
import { createRetryConfig, isRetryableError } from './retry.js';
import { generateLocalEmbedding, initializeLocalModel, isLocalModelLoaded, getLocalModelName } from './localModel.js';
import { generateOllamaEmbedding, isOllamaAvailable } from './ollamaModel.js';
import { generateOpenAIEmbedding, isOpenAIAvailable } from './openai.js';
import { generateMockEmbedding } from './mock.js';
import { applyTargetDimensions } from './normalize.js';
import { assertUsableEmbedding } from './degenerate.js';
import { calculateCosineSimilarity, validateEmbedding } from './similarity.js';
import { validateInput } from './validation.js';
import { activeEmbedder, activeEmbedderKey, applyPrefix, embeddingsAllowMock, EMBEDDING_MAX_TEXT_LENGTH } from '../../config/embeddingConfig.js';
import { logger } from '../../utils/logger.js';

export class EmbeddingService {
  private model: string;
  private dimensions: number;
  private preferLocal: boolean;
  private targetDimensions: number;
  private retryConfig: RetryConfig;
  private metrics: EmbeddingMetrics;
  private maxTextLength: number;
  private modelInitialized: boolean = false;

  constructor() {
    this.model = process.env.EMBEDDING_MODEL || 'text-embedding-ada-002';
    // Dimensionality is now owned by the activeEmbedder() (embeddingConfig): gemma stores
    // native 768, minilm pads to 1536. This replaces the old EMBEDDING_TARGET_DIMENSIONS
    // literal so the vector geometry can never drift from the selected model's column.
    this.targetDimensions = activeEmbedder().dimensions;
    this.dimensions = this.targetDimensions;
    this.preferLocal = process.env.EMBEDDING_PREFER_LOCAL !== 'false';
    this.retryConfig = createRetryConfig();
    this.metrics = createDefaultMetrics();
    // Sourced from config — the SAME constant store-path callers use to
    // bound their text before calling in, so the enforcer and the respecters can't drift.
    this.maxTextLength = EMBEDDING_MAX_TEXT_LENGTH;
    logger.info(
      `🧭 Embedder: ${activeEmbedder().label} [${activeEmbedderKey()}] backend=${activeEmbedder().backend} ` +
      `dim=${activeEmbedder().dimensions} column=${activeEmbedder().column}`
    );
  }

  /** True once verifyStartup() continued on the explicit mock opt-in (model failed to load). */
  private startupMock = false;

  /**
   * The embedding mode /health reports: 'mock' when the model could not load (explicit opt-in)
   * or any request has fallen back to mock vectors, else 'real'. install's validator fails on 'mock'.
   */
  getEmbeddingMode(): 'real' | 'mock' {
    return this.startupMock || this.metrics.mockFallbacks > 0 ? 'mock' : 'real';
  }

  /**
   * STARTUP CHECK: prove the active embedder can actually load. A model that cannot load
   * throws (the error names the directory searched and MANDREL_XENOVA_CACHE_DIR) so the
   * server refuses to start, instead of silently serving meaningless mock embeddings.
   * With the explicit mock opt-in (embeddingsAllowMock) it warns and continues.
   */
  async verifyStartup(): Promise<void> {
    this.startupMock = false;
    try {
      if (activeEmbedder().backend === 'ollama') {
        if (!(await isOllamaAvailable())) {
          throw new EmbeddingError(
            `Ollama embedder "${activeEmbedder().modelId}" is not reachable (see MANDREL_OLLAMA_ENDPOINT)`,
            EmbeddingErrorType.MODEL_INFERENCE,
            false
          );
        }
      } else {
        await initializeLocalModel();
      }
    } catch (error) {
      const err = error as Error;
      if (embeddingsAllowMock()) {
        this.startupMock = true;
        logger.warn(`⚠️  Embedding model cannot load; continuing with MOCK embeddings (explicit opt-in): ${err.message}`);
        return;
      }
      throw err instanceof EmbeddingError ? err : new EmbeddingError(
        `Embedding model cannot load: ${err.message}`,
        EmbeddingErrorType.MODEL_INFERENCE,
        false,
        err
      );
    }
  }

  /**
   * Generate an embedding using the activeEmbedder()'s backend, with its documented role
   * prefix applied. Returns a native-dimension vector (padded only if the embedder's
   * `padToDimensions` is set, e.g. legacy MiniLM 384→1536). This is the config-driven
   * primary path shared by store (role='document') and search (role='query').
   */
  private async generateWithActiveEmbedder(text: string, role: 'query' | 'document'): Promise<EmbeddingVector> {
    const prefixed = applyPrefix(text, role);
    let raw: EmbeddingVector;
    if (activeEmbedder().backend === 'ollama') {
      raw = await generateOllamaEmbedding(prefixed, activeEmbedder().modelId, this.retryConfig);
    } else {
      raw = await generateLocalEmbedding(prefixed, this.retryConfig);
    }
    // Pad/truncate ONLY when the embedder declares a legacy target geometry.
    return activeEmbedder().padToDimensions
      ? applyTargetDimensions(raw, activeEmbedder().backend, activeEmbedder().dimensions)
      : { ...raw, dimensions: raw.embedding.length };
  }

  /**
   * Record error for monitoring and debugging
   */
  private recordError(message: string): void {
    this.metrics.lastError = message;
    this.metrics.lastErrorTime = new Date();
    logger.error(`🔍 EMBEDDING ERROR RECORDED: ${message}`);
  }

  /**
   * Generate vector embedding for text content with comprehensive error handling
   */
  async generateEmbedding(request: EmbeddingRequest): Promise<EmbeddingVector> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    try {
      // Validate input
      validateInput(request.text, this.maxTextLength);
      const text = request.text.trim();
      const role: 'query' | 'document' = request.role ?? 'document';

      logger.info(`📝 Generating embedding for text (${text.length} chars, role=${role}): "${text.substring(0, 60)}..."`);

      let result: EmbeddingVector | undefined;
      let errors: EmbeddingError[] = [];

      // Try the activeEmbedder() (config-driven backend + role prefix) first (if preferred)
      if (this.preferLocal) {
        try {
          result = await this.generateWithActiveEmbedder(text, role);
          this.metrics.localModelSuccesses++;
          this.modelInitialized = true;
          logger.info(`✅ Successfully generated embedding using active embedder`);
        } catch (error) {
          const err = error as Error;
          const embeddingError = err instanceof EmbeddingError ? err :
            new EmbeddingError(
              `Local embedding generation failed: ${err.message}`,
              EmbeddingErrorType.MODEL_INFERENCE,
              isRetryableError(err),
              err
            );
          errors.push(embeddingError);
          logger.warn('⚠️  Local embedding failed, trying alternatives', { metadata: { message: embeddingError.message } });
        }
      }

      // Try OpenAI API if local failed or not preferred.
      // GUARD: OpenAI returns 1536-d — only usable when the active column is 1536-d.
      // For a native-dim embedder (e.g. gemma/768) a 1536 vector would corrupt the column,
      // so we skip OpenAI entirely and let the primary error surface.
      if (!result && activeEmbedder().dimensions === 1536) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (isOpenAIAvailable() && apiKey) {
          try {
            const openAIResult = await generateOpenAIEmbedding(text, apiKey, this.model, this.retryConfig);
            result = applyTargetDimensions(openAIResult, 'openai', this.targetDimensions);
            this.metrics.openAiSuccesses++;
            logger.info(`✅ Successfully generated embedding using OpenAI API`);
          } catch (error) {
            const err = error as Error;
            const embeddingError = err instanceof EmbeddingError ? err :
              new EmbeddingError(
                `OpenAI embedding generation failed: ${err.message}`,
                EmbeddingErrorType.API_ERROR,
                isRetryableError(err),
                err
              );
            errors.push(embeddingError);
            logger.warn('⚠️  OpenAI embedding failed, trying alternatives', { metadata: { message: embeddingError.message } });
          }
        }
      }

      // If the active embedder wasn't preferred, try it as backup
      if (!result && !this.preferLocal) {
        try {
          result = await this.generateWithActiveEmbedder(text, role);
          this.metrics.localModelSuccesses++;
          this.modelInitialized = true;
          logger.info(`✅ Successfully generated embedding using active embedder (backup)`);
        } catch (error) {
          const err = error as Error;
          const embeddingError = err instanceof EmbeddingError ? err :
            new EmbeddingError(
              `Local embedding backup failed: ${err.message}`,
              EmbeddingErrorType.MODEL_INFERENCE,
              isRetryableError(err),
              err
            );
          errors.push(embeddingError);
          logger.warn('⚠️  Local embedding backup failed', { metadata: { message: embeddingError.message } });
        }
      }

      // In production, throw error if all methods failed
      if (!result) {
        if (!embeddingsAllowMock()) {
          const combinedMessage = errors.map(e => e.message).join('; ');
          this.recordError(`All embedding methods failed: ${combinedMessage}`);
          this.metrics.failedRequests++;

          throw new EmbeddingError(
            `Failed to generate embedding using all available methods: ${combinedMessage}`,
            EmbeddingErrorType.UNKNOWN,
            false
          );
        }

        // Explicit opt-in only (MANDREL_EMBEDDINGS_ALLOW_MOCK=true or the test runner)
        logger.warn('⚠️  All embedding methods failed, using mock embeddings (MANDREL_EMBEDDINGS_ALLOW_MOCK opt-in)');
        const mockEmbedding = generateMockEmbedding(text, this.targetDimensions, this.model);
        result = applyTargetDimensions(mockEmbedding, 'mock', this.targetDimensions);
        this.metrics.mockFallbacks++;
      }

      // ── THE CHOKE POINT ───────────────────────────────────────────────
      // EVERY embedding that reaches a DB write comes out of THIS method: storeContext,
      // updateContext, recordDecision, updateDecision, backfillContexts, backfillDecisions.
      // Rather than six call-site checks that can drift, the post-condition is
      // asserted once, here, at the single return point: a vector with no direction is NOT an
      // embedding. Measured why it matters: an all-zero vector is NOT NULL, so `WHERE <col>
      // IS NULL` (the ONE "already embedded" gate, reembedBackfill.buildWhere) never selects
      // it for re-embedding, while pgvector returns NaN similarity for it against every
      // query — permanently un-retrievable, permanently un-retried.
      //
      // Throwing routes into each caller's EXISTING embed-failure handling (onEmbedFailure →
      // structured WARN + rate-limited chat + persist with NULL + self-heal re-embed),
      // so the failure is LOUD and the row stays in the one state the healer can see.
      // It is asserted BEFORE successfulRequests++ and inside the outer try, so the outer
      // catch does the failure accounting (failedRequests++ / recordError) exactly once —
      // the metrics must not report a dead vector as a healthy embedding.
      assertUsableEmbedding(result.embedding, `embedder "${result.model}"`);

      // Record successful request
      this.metrics.successfulRequests++;
      const processingTime = Date.now() - startTime;
      this.metrics.totalProcessingTime += processingTime;
      this.metrics.averageProcessingTime = this.metrics.totalProcessingTime / this.metrics.successfulRequests;

      logger.info(`⏱️  Embedding generated in ${processingTime}ms (${result.dimensions}D, model: ${result.model})`);
      return result;

    } catch (error) {
      const err = error as Error;
      this.metrics.failedRequests++;
      const processingTime = Date.now() - startTime;
      this.recordError(err.message);

      logger.error(`❌ Embedding generation failed after ${processingTime}ms`, err);

      if (err instanceof EmbeddingError) {
        throw err;
      }

      throw new EmbeddingError(
        `Embedding generation failed: ${err.message}`,
        EmbeddingErrorType.UNKNOWN,
        false,
        err
      );
    }
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  calculateCosineSimilarity(a: number[], b: number[]): number {
    return calculateCosineSimilarity(a, b);
  }

  /**
   * Validate embedding vector format
   */
  validateEmbedding(embedding: number[]): boolean {
    return validateEmbedding(embedding, this.dimensions);
  }

  /**
   * Check if the embedding service is healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const testText = "health check";
      const result = await this.generateEmbedding({ text: testText });
      return result &&
             Array.isArray(result.embedding) &&
             result.embedding.length > 0 &&
             result.embedding.every(val => isFinite(val));
    } catch (error) {
      const err = error as Error;
      logger.error('🌡️  Health check failed', err);
      return false;
    }
  }

  /**
   * Get detailed health status including model readiness
   */
  async getHealthStatus(): Promise<EmbeddingHealthStatus> {
    const healthy = await this.isHealthy();

    // Backend-aware readiness: for the ollama-backed active embedder, "model ready" means
    // the daemon is reachable — NOT that the xenova minilm loaded.
    let localModelReady = false;
    try {
      if (activeEmbedder().backend === 'ollama') {
        localModelReady = await isOllamaAvailable();
      } else if (isLocalModelLoaded()) {
        localModelReady = true;
      } else {
        await initializeLocalModel();
        localModelReady = true;
      }
    } catch {
      localModelReady = false;
    }

    return {
      healthy,
      localModelReady,
      openAiAvailable: isOpenAIAvailable(),
      lastError: this.metrics.lastError,
      lastErrorTime: this.metrics.lastErrorTime,
      metrics: { ...this.metrics }
    };
  }

  /**
   * Get performance metrics for monitoring
   */
  getMetrics(): EmbeddingMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = createDefaultMetrics();
    logger.info('🔄 Embedding service metrics reset');
  }

  /**
   * Get comprehensive service status for debugging
   */
  async getStatus(): Promise<EmbeddingStatus> {
    const config = this.getConfig();
    const health = await this.getHealthStatus();
    const metrics = this.getMetrics();

    return {
      config,
      health,
      metrics,
      runtime: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage()
      }
    };
  }

  /**
   * Get service configuration info
   */
  getConfig(): EmbeddingConfig {
    return {
      model: this.model,
      // Report the activeEmbedder() (config source of truth), not just the xenova minilm.
      localModel: `${activeEmbedder().label} [${activeEmbedderKey()}] via ${activeEmbedder().backend} (${getLocalModelName()} fallback)`,
      dimensions: this.dimensions,
      preferLocal: this.preferLocal,
      maxTextLength: this.maxTextLength,
      retryConfig: { ...this.retryConfig },
      hasRealApiKey: isOpenAIAvailable(),
      localModelLoaded: isLocalModelLoaded(),
      modelInitialized: this.modelInitialized,
      mode: this.preferLocal ? activeEmbedder().backend :
            (isOpenAIAvailable() ? 'openai' : 'mock'),
    };
  }
}
