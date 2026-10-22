/**
 * ANTHROPIC TOOL-CHOICE + THINKING-TYPE — request-shape unit tests. NO paid
 * calls: `globalThis.fetch` is stubbed and the request body the provider assembles is inspected.
 *
 * Why: claude-sonnet-5-5 rejects a FORCED tool_choice (HTTP 400) and rejects thinking:disabled,
 * while claude-sonnet-5 rejects thinking:between_tools (HTTP 400, measured 2026-10-12). So the
 * request shape is config-driven (anthropicToolChoice / anthropicThinkingType) and these lock:
 *   - 'tool' (default) ⇒ forced tool_choice, no strict flag, no system line, no thinking field;
 *   - 'auto' ⇒ tool_choice auto + STRICT tool (additionalProperties:false) + a system line;
 *   - anthropicThinkingType 'between_tools' ⇒ thinking:{type:'between_tools'}; 'none'/'' ⇒ omitted;
 *   - legacy extended thinking still wins over the thinking-type knob.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnthropicAdjudicator } from '../services/belief/anthropicAdjudicator.js';
import { BELIEF_ADJUDICATOR_CONFIG } from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../config/beliefConfig.js';
import type { AdjudicationRequest } from '../services/belief/types.js';

const REQ: AdjudicationRequest = {
  a: { id: 'aaaa1111', type: 'context', content: 'the queue backend is Kafka now', createdAt: '2026-07-02T00:00:00Z' },
  b: { id: 'bbbb2222', type: 'decision', content: 'the queue backend is RabbitMQ', createdAt: '2026-07-01T00:00:00Z' },
  cosine: 0.8,
};

function fakeResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'record_verdict',
          input: {
            same_subject: true, subject: 'queue', verdict: 'supersedes', direction: 'a_supersedes_b',
            mode: 'replaced', confidence: 0.9, rationale: 'queue changed',
          },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    text: async () => '',
  } as unknown as Response;
}

async function body(over: Partial<BeliefAdjudicatorConfig>): Promise<any> {
  let captured: any = null;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
    captured = JSON.parse(init.body as string);
    return fakeResponse();
  });
  await new AnthropicAdjudicator({ ...BELIEF_ADJUDICATOR_CONFIG, ...over }).adjudicate(REQ);
  return captured;
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
  vi.restoreAllMocks();
});

describe('anthropic request shape — tool choice', () => {
  it("'tool' forces record_verdict; no strict flag, no system line, no thinking field", async () => {
    const b = await body({ anthropicToolChoice: 'tool', anthropicThinking: false, anthropicThinkingType: '' });
    expect(b.tool_choice).toEqual({ type: 'tool', name: 'record_verdict' });
    expect(b.tools[0].strict).toBeUndefined();
    expect(b.system).toBeUndefined();
    expect(b.thinking).toBeUndefined();
  });

  it("'auto' sends tool_choice auto with a STRICT tool and a system line naming the tool", async () => {
    const b = await body({ anthropicToolChoice: 'auto', anthropicThinking: false, anthropicThinkingType: '' });
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect(b.tools[0].strict).toBe(true);
    expect(b.tools[0].input_schema.additionalProperties).toBe(false);
    expect(b.system).toContain('record_verdict');
  });
});

describe('anthropic request shape — thinking type', () => {
  it("'between_tools' is sent as thinking:{type:'between_tools'}", async () => {
    const b = await body({ anthropicToolChoice: 'auto', anthropicThinking: false, anthropicThinkingType: 'between_tools' });
    expect(b.thinking).toEqual({ type: 'between_tools' });
  });

  it("'none' omits the thinking field (the env-settable way to clear a non-empty default)", async () => {
    const b = await body({ anthropicToolChoice: 'auto', anthropicThinking: false, anthropicThinkingType: 'none' });
    expect(b.thinking).toBeUndefined();
  });

  it('legacy extended thinking wins over the thinking-type knob', async () => {
    const b = await body({ anthropicThinking: true, anthropicThinkingType: 'between_tools', omitTemperature: true });
    expect(b.thinking.type).toBe('enabled');
    expect(b.tool_choice).toEqual({ type: 'auto' });
  });
});
