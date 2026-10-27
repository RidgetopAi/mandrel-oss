/**
 * BOOT-TIME EMBEDDER CHECK IS A NAMED KNOB.
 *
 * MANDREL_EMBEDDING_VERIFY_STARTUP = warn | strict, default strict (a deployment
 * that must start with its embedder down sets warn). With the embedder UNREACHABLE at
 * boot (gemma on an Ollama endpoint whose port nothing listens on):
 *   warn   → verifyStartup() resolves, logs exactly one loud error line, records the failure;
 *   strict → verifyStartup() rejects.
 * The process-level half (strict → main exits non-zero; warn → boot continues) is
 * embeddingVerifyStartupBoot.contract.test.ts.
 *
 * NO DB, NO network beyond a refused loopback connect. The test runner is a mock opt-in, so
 * every case clears it (VITEST / NODE_ENV / MANDREL_EMBEDDINGS_ALLOW_MOCK) to reach the gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';

let deadEndpoint = '';

async function load() {
  vi.resetModules();
  const cfg = await import('../config/embeddingConfig.js');
  const { logger } = await import('../utils/logger.js');
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const mod = await import('../services/embedding/EmbeddingService.js');
  return { cfg, svc: new mod.EmbeddingService(), error };
}

describe('MANDREL_EMBEDDING_VERIFY_STARTUP', () => {
  beforeEach(async () => {
    // A port the OS just handed out and released: nothing listens, so the connect is refused.
    deadEndpoint = `http://127.0.0.1:${await reserveEphemeralPort()}`;
    vi.stubEnv('MANDREL_EMBEDDER', 'gemma');
    vi.stubEnv('MANDREL_OLLAMA_ENDPOINT', deadEndpoint);
    vi.stubEnv('MANDREL_EMBEDDINGS_ALLOW_MOCK', '');
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('the code default is strict', async () => {
    vi.stubEnv('MANDREL_EMBEDDING_VERIFY_STARTUP', '');
    const { cfg } = await load();
    expect(cfg.EMBEDDING_VERIFY_STARTUP_DEFAULT).toBe('strict');
    expect(cfg.embeddingVerifyStartupMode()).toBe('strict');
  });

  it('unset (default) + unreachable embedder: refuses to start, exactly as strict does', async () => {
    vi.stubEnv('MANDREL_EMBEDDING_VERIFY_STARTUP', '');
    const { svc, error } = await load();
    await expect(svc.verifyStartup()).rejects.toThrow(/not reachable/);
    expect(error).not.toHaveBeenCalled();
  });

  it('warn + unreachable embedder: starts anyway, ONE loud error line naming the knob', async () => {
    vi.stubEnv('MANDREL_EMBEDDING_VERIFY_STARTUP', 'warn');
    const { svc, error } = await load();
    await expect(svc.verifyStartup()).resolves.toBeUndefined();
    expect(svc.startupCheckFailed()).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('EMBEDDER UNUSABLE AT STARTUP');
    expect(line).toContain('MANDREL_EMBEDDING_VERIFY_STARTUP=warn');
    expect(line).toContain('not reachable');
    expect(svc.getEmbeddingMode(), 'no mock was substituted').toBe('real');
  });

  it('strict + unreachable embedder: refuses to start (rejects), no warn-mode line', async () => {
    vi.stubEnv('MANDREL_EMBEDDING_VERIFY_STARTUP', 'strict');
    const { svc, error } = await load();
    await expect(svc.verifyStartup()).rejects.toThrow(/not reachable/);
    expect(svc.startupCheckFailed()).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('an unknown value throws instead of silently meaning warn', async () => {
    vi.stubEnv('MANDREL_EMBEDDING_VERIFY_STARTUP', 'strcit');
    const { cfg, svc } = await load();
    expect(() => cfg.embeddingVerifyStartupMode()).toThrow(/not a known mode/);
    await expect(svc.verifyStartup()).rejects.toThrow(/not a known mode/);
  });
});
