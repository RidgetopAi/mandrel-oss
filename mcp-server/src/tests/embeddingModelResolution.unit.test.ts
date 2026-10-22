/**
 * EMBEDDING MODEL RESOLUTION + NO SILENT MOCK (install-proof finding 12/13).
 *
 *  1. Source checkout, MANDREL_XENOVA_CACHE_DIR unset → the vendored model under
 *     mcp-server/vendor/models/ is found and a REAL 384-value embedding is produced.
 *  2. Model cannot load, no mock opt-in → verifyStartup() throws naming the searched dir and
 *     MANDREL_XENOVA_CACHE_DIR; generateEmbedding returns no mock.
 *  3. Explicit MANDREL_EMBEDDINGS_ALLOW_MOCK=true → missing model yields mock embeddings.
 *
 * NO DB, NO network. The test runner is itself a mock opt-in, so cases 2/3 clear it via
 * stubEnv to exercise the production gate.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = path.resolve(here, '../../vendor/models');
const MISSING = path.join(os.tmpdir(), 'mandrel-no-such-model-dir-9eb66417');

async function freshService() {
  vi.resetModules();
  const mod = await import('../services/embedding/EmbeddingService.js');
  return new mod.EmbeddingService();
}

describe('embedding model resolution', () => {
  beforeEach(() => {
    vi.stubEnv('MANDREL_XENOVA_CACHE_DIR', '');
    vi.stubEnv('MANDREL_EMBEDDER', 'minilm');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('(1) unset cache dir in a source checkout resolves vendor/models and embeds for real', async () => {
    const cfg = await import('../config/embeddingConfig.js');
    expect(cfg.resolveXenovaCacheDir()).toBe(VENDORED);

    vi.stubEnv('MANDREL_EMBEDDINGS_ALLOW_MOCK', '');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const svc = await freshService();
    await svc.verifyStartup();
    const r = await svc.generateEmbedding({ text: 'hello vendored model' });
    expect(r.model).toContain('all-MiniLM-L6-v2-local');
    expect(r.model).not.toMatch(/mock/i);
    expect(svc.getMetrics().mockFallbacks).toBe(0);
    // minilm pads to the column geometry; the real model's own 384 values are non-zero.
    expect(r.embedding.slice(0, 384).some((v) => v !== 0)).toBe(true);
  }, 60000);

  it('(2) unloadable model without opt-in: startup throws naming dir + setting; no mock', async () => {
    vi.stubEnv('MANDREL_XENOVA_CACHE_DIR', MISSING);
    vi.stubEnv('MANDREL_EMBEDDINGS_ALLOW_MOCK', '');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const svc = await freshService();
    await expect(svc.verifyStartup()).rejects.toThrow(MISSING);
    await expect(svc.verifyStartup()).rejects.toThrow('MANDREL_XENOVA_CACHE_DIR');
    await expect(svc.generateEmbedding({ text: 'x marks the spot' })).rejects.toThrow();
    expect(svc.getMetrics().mockFallbacks).toBe(0);
  });

  it('(3) explicit opt-in: missing model yields mock embeddings', async () => {
    vi.stubEnv('MANDREL_XENOVA_CACHE_DIR', MISSING);
    vi.stubEnv('MANDREL_EMBEDDINGS_ALLOW_MOCK', 'true');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    const svc = await freshService();
    await expect(svc.verifyStartup()).resolves.toBeUndefined();
    const r = await svc.generateEmbedding({ text: 'x marks the spot' });
    expect(svc.getMetrics().mockFallbacks).toBe(1);
    expect(r.embedding.length).toBeGreaterThan(0);
  });

  it('(3b) embeddingConfig comment names MANDREL_XENOVA_CACHE_DIR, not the bare name', () => {
    const src = fs.readFileSync(path.resolve(here, '../config/embeddingConfig.ts'), 'utf8');
    expect(src).toMatch(/\* {2}- MANDREL_XENOVA_CACHE_DIR/);
    expect(src).not.toMatch(/\* {2}- XENOVA_CACHE_DIR/);
  });
});
