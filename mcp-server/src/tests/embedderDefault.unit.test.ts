/**
 * THE EMBEDDER DEFAULT IS MINILM.
 *
 * Self-hosters get MiniLM (built in, offline) with NO configuration; Ollama +
 * embeddinggemma stays available via MANDREL_EMBEDDER=gemma. Both directions are pinned
 * here, and the test controls its own environment — it passes whether or not the
 * invoking shell exports MANDREL_EMBEDDER (the prior value is restored afterwards).
 *
 * The cross-surface agreement of the default (compose, Command backend, fleet posture)
 * is embedderCodeDefaultAgreement.unit.test.ts; this file pins the VALUE for mcp-server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeEmbedder, activeEmbedderKey, activeEmbeddingColumn, embedders } from '@/config/embeddingConfig';

const VAR = 'MANDREL_EMBEDDER';

describe(`${VAR}: the default embedder`, () => {
  const PRIOR = process.env[VAR];

  beforeEach(() => {
    delete process.env[VAR];
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env[VAR];
    else process.env[VAR] = PRIOR;
  });

  it('unset resolves to the minilm embedder (xenova, in-process, offline)', () => {
    expect(activeEmbedderKey()).toBe('minilm');
    const spec = activeEmbedder();
    expect(spec.key).toBe('minilm');
    expect(spec.backend).toBe('xenova');
    expect(spec).toEqual(embedders().minilm);
    expect(activeEmbeddingColumn()).toBe(embedders().minilm.column);
  });

  it('an empty value is treated as unset, so it also resolves to minilm', () => {
    process.env[VAR] = '';
    expect(activeEmbedderKey()).toBe('minilm');
  });

  it('MANDREL_EMBEDDER=gemma resolves to gemma (ollama, embedding_gemma, 768-d)', () => {
    process.env[VAR] = 'gemma';
    expect(activeEmbedderKey()).toBe('gemma');
    const spec = activeEmbedder();
    expect(spec).toEqual(embedders().gemma);
    expect(spec.backend).toBe('ollama');
    expect(spec.modelId).toBe('embeddinggemma');
    expect(spec.column).toBe('embedding_gemma');
    expect(spec.dimensions).toBe(768); // eslint-disable-line no-restricted-syntax -- pins gemma's on-disk width independent of the registry
  });

  it('an unknown value still throws rather than guessing a column', () => {
    process.env[VAR] = 'nope';
    expect(() => activeEmbedderKey()).toThrow(/not a known embedder/);
  });
});
