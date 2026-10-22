/**
 * Local Model Embedding
 * 
 * Generate embeddings using local Transformers.js model (FREE!).
 */

import { pipeline, env } from '@xenova/transformers';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingError, EmbeddingErrorType, EmbeddingVector, RetryConfig } from './types.js';
import { executeWithRetry } from './retry.js';
import { XENOVA_ALLOW_REMOTE, resolveXenovaCacheDir } from '../../config/embeddingConfig.js';
import { logger } from '../../utils/logger.js';

// Singleton model instance
let localModel: any = null;
const LOCAL_MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

// -----------------------------------------------------------------------------
// OFFLINE MODE. HF migrated the model file to its "Xet"
// backend, which returns 403 to the @xenova/transformers@2 client — so a RUNTIME
// download of the MiniLM model now FAILS, and because context_store embeds BEFORE
// the DB insert, that failure silently loses the customer's write. The permanent
// fix bakes the model into the image and loads it purely from the local disk cache.
//
// Configure the @xenova runtime ONCE at module load (config-driven, no hardcoded
// tunables — see embeddingConfig.ts):
//   * allowRemoteModels=false  → never touch the HF network.
//   * cacheDir (optional override) → where the baked model lives. Default is the
//     @xenova default `node_modules/@xenova/transformers/.cache`, which is exactly
//     the baked location AND prod systemd's seeded location, so no override needed.
// -----------------------------------------------------------------------------
env.allowRemoteModels = XENOVA_ALLOW_REMOTE;
/** Apply the resolved cache dir (MANDREL_XENOVA_CACHE_DIR, else vendored model dir, else @xenova default). */
function applyCacheDir(): void {
  const dir = resolveXenovaCacheDir();
  if (dir) {
    env.cacheDir = dir;
  }
}
applyCacheDir();

/**
 * Resolve the on-disk path of the baked/cached quantized model file that
 * `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` will load. @xenova
 * caches under `<cacheDir>/<modelId>/onnx/model_quantized.onnx` (quantized is the
 * default). `env.cacheDir` is populated by @xenova with its default when we don't
 * override it, so this tracks whatever cacheDir is actually in effect — no hardcode.
 */
function resolveLocalModelFile(): string {
  return path.join(String(env.cacheDir), LOCAL_MODEL_NAME, 'onnx', 'model_quantized.onnx');
}

/**
 * FAIL LOUD: in offline mode the model MUST be present on disk (baked into the
 * image). If it is missing we throw a clear, actionable error at model-init time
 * instead of letting @xenova attempt a (now-403) network fetch that fails silently
 * at a customer's first write. Returns the verified model path on success.
 */
function assertLocalModelPresent(): string {
  applyCacheDir();
  const modelFile = resolveLocalModelFile();
  if (!fs.existsSync(modelFile)) {
    const msg =
      `FATAL: local embedding model file not found at "${modelFile}" (directory searched: ` +
      `"${String(env.cacheDir)}") and remote downloads are disabled ` +
      `(MANDREL_XENOVA_ALLOW_REMOTE=false). Set MANDREL_XENOVA_CACHE_DIR to a directory ` +
      `containing ${LOCAL_MODEL_NAME}/onnx/model_quantized.onnx (a source checkout ships it ` +
      `at mcp-server/vendor/models/; the container image bakes it into the @xenova cache). ` +
      `Refusing to generate embeddings — mock embeddings need an explicit ` +
      `MANDREL_EMBEDDINGS_ALLOW_MOCK=true.`;
    logger.error(msg);
    throw new EmbeddingError(msg, EmbeddingErrorType.MODEL_INFERENCE, false);
  }
  return modelFile;
}

/**
 * Initialize local embedding model (lazy loading)
 */
export async function initializeLocalModel(): Promise<any> {
  if (localModel) {
    return localModel;
  }

  logger.info(`🔄 Loading local embedding model: ${LOCAL_MODEL_NAME}`);
  logger.info(
    `📦 Offline mode: allowRemoteModels=${env.allowRemoteModels}, cacheDir="${env.cacheDir}" ` +
    `(model is baked into the image — no network download)`
  );

  // FAIL LOUD before touching @xenova: verify the baked model is on disk so a
  // missing model surfaces as a clear boot/first-load error, not a silent 403.
  const modelFile = assertLocalModelPresent();
  logger.info(`✅ Local embedding model file present (offline): ${modelFile}`);

  try {
    localModel = await pipeline('feature-extraction', LOCAL_MODEL_NAME);
    logger.info('✅ Local embedding model loaded successfully!');
    return localModel;
  } catch (error) {
    const err = error as Error;
    logger.error('❌ Failed to load local model', err);
    throw new Error(`Failed to initialize local embedding model: ${err.message}`);
  }
}

/**
 * Check if local model is loaded
 */
export function isLocalModelLoaded(): boolean {
  return !!localModel;
}

/**
 * Get local model name
 */
export function getLocalModelName(): string {
  return LOCAL_MODEL_NAME;
}

/**
 * Generate embedding using local Transformers.js model with retry logic
 */
export async function generateLocalEmbedding(
  text: string,
  retryConfig: RetryConfig
): Promise<EmbeddingVector> {
  logger.info('🏠 Generating LOCAL embedding (FREE!)...');

  return executeWithRetry(async () => {
    const model = await initializeLocalModel();

    try {
      // Generate embedding using the local model
      const result = await model(text, { pooling: 'mean', normalize: true });

      // Extract the embedding array from the tensor
      const embedding = Array.from(result.data as Float32Array);

      // Validate the result
      if (!embedding || embedding.length === 0) {
        throw new EmbeddingError(
          'Local model returned empty embedding',
          EmbeddingErrorType.MODEL_INFERENCE,
          false
        );
      }

      // Check for NaN or invalid values
      const hasInvalidValues = embedding.some(val => !isFinite(val));
      if (hasInvalidValues) {
        throw new EmbeddingError(
          'Local model returned embedding with invalid values (NaN/Infinity)',
          EmbeddingErrorType.MODEL_INFERENCE,
          false
        );
      }

      logger.info(`✅ Generated LOCAL embedding (${embedding.length} dimensions)`);

      return {
        embedding,
        dimensions: embedding.length,
        model: `${LOCAL_MODEL_NAME}-local`,
      };
    } catch (error) {
      const err = error as Error;
      if (err instanceof EmbeddingError) {
        throw err;
      }

      // Categorize model inference errors
      const errorMessage = err.message?.toLowerCase() || '';
      let errorType = EmbeddingErrorType.MODEL_INFERENCE;
      let isRetryable = false;

      if (errorMessage.includes('out of memory') || errorMessage.includes('memory')) {
        errorType = EmbeddingErrorType.RESOURCE_EXHAUSTED;
        isRetryable = true;
      } else if (errorMessage.includes('network') || errorMessage.includes('download')) {
        errorType = EmbeddingErrorType.NETWORK_ERROR;
        isRetryable = true;
      }

      throw new EmbeddingError(
        `Local model inference failed: ${err.message}`,
        errorType,
        isRetryable,
        err
      );
    }
  }, 'Local embedding generation', retryConfig);
}
