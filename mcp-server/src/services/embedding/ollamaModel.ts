/**
 * Ollama Embedding Backend
 *
 * Generates embeddings via a local Ollama daemon (`/api/embeddings`). This is the runtime
 * for embeddinggemma-300m: the model does NOT load under this repo's @xenova/transformers
 * (ONNX IR v10 > onnxruntime-node's max IR v8), so it runs through Ollama — the same
 * backend that won the P0 bake-off. Model + endpoint come from embeddingConfig (no literals).
 */

import { EmbeddingError, EmbeddingErrorType, EmbeddingVector, RetryConfig } from './types.js';
import { executeWithRetry } from './retry.js';
import { OLLAMA_ENDPOINT } from '../../config/embeddingConfig.js';
import { logger } from '../../utils/logger.js';

/**
 * Generate an embedding via Ollama. `text` MUST already have the model's role prefix
 * applied by the caller (EmbeddingService, from embeddingConfig.applyPrefix).
 */
export async function generateOllamaEmbedding(
  text: string,
  modelId: string,
  retryConfig: RetryConfig
): Promise<EmbeddingVector> {
  return executeWithRetry(async () => {
    let resp: Response;
    try {
      resp = await fetch(`${OLLAMA_ENDPOINT}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, prompt: text }),
      });
    } catch (err) {
      // Network / daemon-down → retryable.
      throw new EmbeddingError(
        `Ollama request failed (endpoint ${OLLAMA_ENDPOINT}): ${(err as Error).message}`,
        EmbeddingErrorType.NETWORK_ERROR,
        true,
        err as Error
      );
    }

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      const retryable = resp.status >= 500 || resp.status === 429;
      throw new EmbeddingError(
        `Ollama returned HTTP ${resp.status} for model ${modelId}: ${bodyText.slice(0, 200)}`,
        retryable ? EmbeddingErrorType.RESOURCE_EXHAUSTED : EmbeddingErrorType.API_ERROR,
        retryable
      );
    }

    const json = (await resp.json()) as { embedding?: number[] };
    const embedding = json.embedding;

    if (!embedding || embedding.length === 0) {
      throw new EmbeddingError(
        `Ollama returned empty embedding for model ${modelId}`,
        EmbeddingErrorType.MODEL_INFERENCE,
        false
      );
    }

    if (embedding.some((v) => !isFinite(v))) {
      throw new EmbeddingError(
        `Ollama returned embedding with invalid values (NaN/Infinity) for model ${modelId}`,
        EmbeddingErrorType.MODEL_INFERENCE,
        false
      );
    }

    logger.info(`✅ Generated OLLAMA embedding (${embedding.length}D, model: ${modelId})`);

    return {
      embedding,
      dimensions: embedding.length,
      model: `${modelId}-ollama`,
    };
  }, 'Ollama embedding generation', retryConfig);
}

/** Lightweight reachability check for the Ollama daemon (used by health status). */
export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { method: 'GET' });
    return resp.ok;
  } catch {
    return false;
  }
}
