/**
 * ANTHROPIC PROMPT CACHING — request-shape unit tests (BL-12). NO DB, NO LLM,
 * NO paid calls: `globalThis.fetch` is stubbed so we can INSPECT the exact request body the
 * anthropic provider assembles and PROVE the cache boundary sits where BL-12 requires.
 *
 * What these lock:
 *   - the STATIC/DYNAMIC split is byte-exact: staticPrefix + dynamic === buildAdjudicationPrompt
 *     (the single-string prompt every other provider sends) — the same text reaches the model;
 *   - the staticPrefix is INVARIANT across different pairs (it is the cacheable prefix) while the
 *     dynamic half changes with the records;
 *   - cache ON  ⇒ user content is [ {static, cache_control}, {dynamic, NO cache_control} ] and the
 *     record_verdict tool carries cache_control; the two block texts concatenate to the original;
 *   - cache OFF ⇒ user content is the plain combined string and NOTHING carries cache_control
 *     (the pre-BL-12 request shape) — proving the toggle;
 *   - MUTATION guard: the DYNAMIC (per-pair) block must NEVER carry cache_control — caching the
 *     variable content would defeat the cache and is the exact boundary bug to guard against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnthropicAdjudicator } from '../services/belief/anthropicAdjudicator.js';
import {
  buildAdjudicationPrompt,
  buildAdjudicationPromptParts,
} from '../services/belief/ollamaAdjudicator.js';
import { BELIEF_ADJUDICATOR_CONFIG } from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../config/beliefConfig.js';
import type { AdjudicationRequest } from '../services/belief/types.js';

// Record content deliberately chosen NOT to collide with any worked-example text in the static
// prefix, so "prefix must not contain the per-pair content" assertions are meaningful.
const A_CONTENT = 'riverbend widget-frobnicator ships at revision zap-4711';
const B_CONTENT = 'the widget-frobnicator is pinned to revision zap-4710';

const REQ: AdjudicationRequest = {
  a: { id: 'aaaa1111', type: 'context', content: A_CONTENT, createdAt: '2026-07-01' },
  b: { id: 'bbbb2222', type: 'decision', content: B_CONTENT, createdAt: '2026-06-20' },
  cosine: 0.82,
};

const OTHER_REQ: AdjudicationRequest = {
  a: { id: 'cccc3333', type: 'context', content: 'quux-daemon flipped to teal mode zonk-88', createdAt: '2026-07-02' },
  b: { id: 'dddd4444', type: 'decision', content: 'quux-daemon defaults to amber mode', createdAt: '2026-06-01' },
  cosine: 0.7,
};

/** A single tool_use response so the provider's parser succeeds without a real API call. */
function fakeResponse() {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'record_verdict',
          input: {
            same_subject: true,
            subject: 'service port',
            verdict: 'supersedes',
            direction: 'a_supersedes_b',
            mode: 'replaced',
            confidence: 0.95,
            rationale: 'port changed',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 2500 },
    }),
    text: async () => '',
  } as unknown as Response;
}

/** Run one adjudication with a stubbed fetch and return the parsed request body it sent. */
async function captureBody(cfg: BeliefAdjudicatorConfig, req: AdjudicationRequest = REQ) {
  let captured: any = null;
  let capturedInit: any = null;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
    capturedInit = init;
    captured = JSON.parse(init.body as string);
    return fakeResponse();
  });
  const adj = new AnthropicAdjudicator(cfg);
  await adj.adjudicate(req);
  spy.mockRestore();
  return { body: captured, init: capturedInit };
}

function cfgWith(over: Partial<BeliefAdjudicatorConfig>): BeliefAdjudicatorConfig {
  return { ...BELIEF_ADJUDICATOR_CONFIG, ...over };
}

const ENV_KEY = 'ANTHROPIC_API_KEY';
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'test-key-not-used'; // provider needs a key to construct; fetch is stubbed
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedKey;
  vi.restoreAllMocks();
});

describe('buildAdjudicationPromptParts — the STATIC/DYNAMIC split is byte-exact', () => {
  it('staticPrefix + dynamic === buildAdjudicationPrompt (the same text reaches the model)', () => {
    const { staticPrefix, dynamic } = buildAdjudicationPromptParts(REQ, BELIEF_ADJUDICATOR_CONFIG);
    expect(staticPrefix + dynamic).toBe(buildAdjudicationPrompt(REQ, BELIEF_ADJUDICATOR_CONFIG));
  });

  it('the static prefix is INVARIANT across pairs; the dynamic half varies', () => {
    const p1 = buildAdjudicationPromptParts(REQ, BELIEF_ADJUDICATOR_CONFIG);
    const p2 = buildAdjudicationPromptParts(OTHER_REQ, BELIEF_ADJUDICATOR_CONFIG);
    // The cacheable prefix must be identical (that is the whole point of caching it)…
    expect(p1.staticPrefix).toBe(p2.staticPrefix);
    // …and must contain the rubric/guardrails/examples but NONE of the per-pair record content.
    expect(p1.staticPrefix).toContain('You are a MEMORY ADJUDICATOR');
    expect(p1.staticPrefix).toContain('REFERENCE IS NOT REPLACEMENT');
    expect(p1.staticPrefix).toContain('STATUS-FLIP IS NOT A RESTATEMENT');
    expect(p1.staticPrefix).not.toContain('RECORD A');
    expect(p1.staticPrefix).not.toContain('riverbend widget-frobnicator ships at revision zap-4711');
    // The dynamic half differs per pair and carries the record content + the response footer.
    expect(p1.dynamic).not.toBe(p2.dynamic);
    expect(p1.dynamic).toContain('riverbend widget-frobnicator ships at revision zap-4711');
    expect(p1.dynamic).toContain('the widget-frobnicator is pinned to revision zap-4710');
    expect(p1.dynamic).toContain('Respond with ONLY this JSON shape');
  });

  it('the static prefix clears the Sonnet 1024-token cache minimum (chars ≫ 1024)', () => {
    const { staticPrefix } = buildAdjudicationPromptParts(REQ, BELIEF_ADJUDICATOR_CONFIG);
    // ~4 chars/token; the prefix is thousands of chars, comfortably over 1024 tokens.
    expect(staticPrefix.length).toBeGreaterThan(4096);
  });
});

describe('AnthropicAdjudicator — prompt cache ON (default) places the boundary correctly', () => {
  it('user content = [static+cache_control, dynamic WITHOUT cache_control]; texts reconstruct the prompt', async () => {
    const { body } = await captureBody(cfgWith({ promptCache: true }));
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);

    const [staticBlock, dynamicBlock] = content;
    // Block 0 = the STATIC prefix, marked for caching.
    expect(staticBlock.type).toBe('text');
    expect(staticBlock.cache_control).toEqual({ type: 'ephemeral' });
    // Block 1 = the DYNAMIC record content, NOT cached.
    expect(dynamicBlock.type).toBe('text');
    expect(dynamicBlock.cache_control).toBeUndefined();

    // The two blocks concatenate to the exact single-string prompt (verdict text unchanged).
    expect(staticBlock.text + dynamicBlock.text).toBe(buildAdjudicationPrompt(REQ, BELIEF_ADJUDICATOR_CONFIG));
    // And the cached block matches the invariant static prefix (nothing per-pair leaked in).
    const { staticPrefix, dynamic } = buildAdjudicationPromptParts(REQ, BELIEF_ADJUDICATOR_CONFIG);
    expect(staticBlock.text).toBe(staticPrefix);
    expect(dynamicBlock.text).toBe(dynamic);
  });

  it('the record_verdict tool schema is marked cache-eligible', async () => {
    const { body } = await captureBody(cfgWith({ promptCache: true }));
    const tool = body.tools[body.tools.length - 1];
    expect(tool.name).toBe('record_verdict');
    expect(tool.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('AnthropicAdjudicator — prompt cache OFF reverts to the pre-BL-12 shape', () => {
  it('user content is the plain combined string and NOTHING carries cache_control', async () => {
    const { body } = await captureBody(cfgWith({ promptCache: false }));
    // Single-string content, byte-identical to the shared prompt.
    expect(typeof body.messages[0].content).toBe('string');
    expect(body.messages[0].content).toBe(buildAdjudicationPrompt(REQ, BELIEF_ADJUDICATOR_CONFIG));
    // No cache_control anywhere in the serialized body.
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body.tools[0].cache_control).toBeUndefined();
  });
});

describe('AnthropicAdjudicator — MUTATION guard: the variable content is never cached', () => {
  it('exactly ONE user content block carries cache_control, and it is NOT the record block', async () => {
    const { body } = await captureBody(cfgWith({ promptCache: true }));
    const content = body.messages[0].content as any[];
    const cachedBlocks = content.filter((b) => b.cache_control !== undefined);
    expect(cachedBlocks).toHaveLength(1);
    // The one cached block must be the static prefix (no RECORD content), never the dynamic half.
    expect(cachedBlocks[0].text).not.toContain('RECORD A');
    expect(cachedBlocks[0].text).not.toContain('riverbend widget-frobnicator ships at revision zap-4711');
  });
});

describe('AnthropicAdjudicator — the anthropic-beta header is config-gated (GA: off by default)', () => {
  it('no anthropic-beta header by default (prompt caching is GA)', async () => {
    const { init } = await captureBody(cfgWith({ promptCache: true }));
    expect(init.headers['anthropic-beta']).toBeUndefined();
  });

  it('sends anthropic-beta only when configured', async () => {
    const { init } = await captureBody(cfgWith({ promptCache: true, anthropicBeta: 'prompt-caching-2024-07-31' }));
    expect(init.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });
});
