/**
 * SUBQ ADJUDICATOR — unit tests. NO network, NO paid call: `globalThis.fetch`
 * is stubbed so the exact request the provider sends is inspected and a canned Decisions-API
 * response is fed back.
 *
 * Population: the provider's three behaviours — the REQUEST it sends (URL, auth, body shape),
 * how it PARSES a response into our verdict contract (incl. direction-from-dates and the
 * off-shape refusals), and the NO-KEY / HTTP-error failure paths. Plus the factory wiring
 * (provider:'subq' resolves to this class) and its cost-table entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BELIEF_ADJUDICATOR_CONFIG } from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig, BeliefSubqConfig } from '../config/beliefConfig.js';
import { BELIEF_COST_CONFIG } from '../config/beliefCostConfig.js';
import { getAdjudicationProvider } from '../services/belief/provider.js';
import { BeliefProviderCallError } from '../services/belief/providerError.js';
import {
  SubqAdjudicator,
  directionFromDates,
  parseSubqDecision,
} from '../services/belief/subqAdjudicator.js';
import { buildAdjudicationPromptParts } from '../services/belief/ollamaAdjudicator.js';
import type { AdjudicationRequest } from '../services/belief/types.js';

const ENV_KEY = 'SUBQ_UNIT_TEST_KEY';
const CFG: BeliefAdjudicatorConfig = {
  ...BELIEF_ADJUDICATOR_CONFIG,
  provider: 'subq',
  model: 'subq-snap-preview',
  endpoint: 'https://subq.example.test',
  apiKeyEnvVar: ENV_KEY,
  maxContentChars: 40,
};
const SUBQ: BeliefSubqConfig = { decisionsPath: '/v1/systemone', sameSubjectMin: 0.5, sameSubjectFrom: 'noul', rubric: 'compact' };

const OLD = '2026-07-01T09:00:00.000Z';
const NEW = '2026-08-01T09:00:00.000Z';
function req(aDate: string | null, bDate: string | null): AdjudicationRequest {
  return {
    a: { id: 'aaaaaaaa-0000-0000-0000-000000000000', type: 'context', content: 'A'.repeat(100), createdAt: aDate },
    b: { id: 'bbbbbbbb-0000-0000-0000-000000000000', type: 'decision', content: 'the queue is RabbitMQ', createdAt: bDate },
    cosine: 0.9,
  };
}

function answers(over: Record<string, unknown> = {}) {
  return {
    model: 'subq-snap-preview',
    answers: {
      same_subject: { type: 'noul', noul: 0.91 },
      verdict: {
        type: 'choice',
        choice: 'supersedes',
        probabilities: { supersedes: 0.9, contests: 0.05, restates: 0.03, unrelated: 0.02 },
        confidence: 0.87,
      },
      mode: { type: 'choice', choice: 'replaced', probabilities: { replaced: 0.8, fallback_retained: 0.2 }, confidence: 0.6 },
      ...over,
    },
    usage: { input_tokens: 412, output_tokens: 0 },
  };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'unit-test-key';
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

function stubFetch(status: number, payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('SubqAdjudicator — request shape', () => {
  it('POSTs the Decisions API at endpoint+path with bearer auth and three typed questions', async () => {
    const spy = stubFetch(200, answers());
    await new SubqAdjudicator(CFG, SUBQ).adjudicate(req(NEW, OLD));
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://subq.example.test/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer unit-test-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('subq-snap-preview');
    expect(body.questions.same_subject.type).toBe('noul');
    expect(body.questions.verdict.type).toBe('choice');
    expect(Object.keys(body.questions.verdict.criteria).sort()).toEqual(
      ['contests', 'restates', 'supersedes', 'unrelated']
    );
    expect(Object.keys(body.questions.mode.criteria).sort()).toEqual(['fallback_retained', 'replaced']);
    // state carries both records with their second-resolution dates, content capped by maxContentChars
    expect(body.state).toContain('RECORD A (id=aaaaaaaa-0000-0000-0000-000000000000, type=context, date=2026-08-01T09:00:00Z)');
    expect(body.state).toContain('RECORD B (id=bbbbbbbb-0000-0000-0000-000000000000, type=decision, date=2026-07-01T09:00:00Z)');
    expect(body.state).toContain('A'.repeat(40));
    expect(body.state).not.toContain('A'.repeat(41));
  });

  it("rubric:'full' sends the canonical rubric verbatim as the verdict instructions", async () => {
    const spy = stubFetch(200, answers());
    await new SubqAdjudicator(CFG, { ...SUBQ, rubric: 'full' }).adjudicate(req(NEW, OLD));
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.questions.verdict.instructions).toBe(buildAdjudicationPromptParts(req(NEW, OLD), CFG).staticPrefix);
  });
});

describe('SubqAdjudicator — response parsing', () => {
  it('maps a supersedes choice to our verdict; direction from the dates (later wins); usage recorded', async () => {
    stubFetch(200, answers());
    const p = new SubqAdjudicator(CFG, SUBQ);
    const v = await p.adjudicate(req(NEW, OLD));
    expect(v).toMatchObject({ sameSubject: true, verdict: 'supersedes', direction: 'a_supersedes_b', mode: 'replaced', confidence: 0.87 });
    expect(v.rationale).toContain('p(supersedes)=0.900');
    expect(p.lastUsage).toEqual([
      { tier: 'single', provider: 'subq', model: 'subq-snap-preview', inputTokens: 412, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(p.lastDetail?.sameSubjectP).toBe(0.91);
  });

  it('direction follows the dates, not the position: B later ⇒ b_supersedes_a; tie/unknown ⇒ none', () => {
    expect(directionFromDates(req(OLD, NEW))).toBe('b_supersedes_a');
    expect(directionFromDates(req(NEW, NEW))).toBe('none');
    expect(directionFromDates(req(null, NEW))).toBe('none');
    expect(directionFromDates(req('not-a-date', NEW))).toBe('none');
  });

  it('same_subject EXACTLY at the threshold counts as same subject (inclusive boundary)', () => {
    const at = parseSubqDecision(answers({ same_subject: { type: 'noul', noul: SUBQ.sameSubjectMin } }), req(NEW, OLD), SUBQ);
    expect(at.verdict).toMatchObject({ sameSubject: true, verdict: 'supersedes', direction: 'a_supersedes_b' });
  });

  it('same_subject below the threshold ⇒ sameSubject false and no direction/mode', () => {
    const r = parseSubqDecision(answers({ same_subject: { type: 'noul', noul: 0.49 } }), req(NEW, OLD), SUBQ);
    expect(r.verdict).toMatchObject({ sameSubject: false, verdict: 'supersedes', direction: 'none', mode: 'none' });
  });

  it("sameSubjectFrom:'verdict' ignores the noul: supersedes ⇒ same subject, unrelated ⇒ not", () => {
    const vcfg = { ...SUBQ, sameSubjectFrom: 'verdict' };
    const low = answers({ same_subject: { type: 'noul', noul: 0.1 } });
    expect(parseSubqDecision(low, req(NEW, OLD), vcfg).verdict).toMatchObject({
      sameSubject: true, verdict: 'supersedes', direction: 'a_supersedes_b',
    });
    const unrel = answers({
      same_subject: { type: 'noul', noul: 0.99 },
      verdict: { type: 'choice', choice: 'unrelated', probabilities: { unrelated: 0.9 }, confidence: 0.8 },
    });
    expect(parseSubqDecision(unrel, req(NEW, OLD), vcfg).verdict.sameSubject).toBe(false);
  });

  it('a non-supersedes verdict carries no direction/mode', () => {
    const r = parseSubqDecision(
      answers({ verdict: { type: 'choice', choice: 'restates', probabilities: { restates: 0.7 }, confidence: 0.5 } }),
      req(NEW, OLD),
      SUBQ
    );
    expect(r.verdict).toMatchObject({ verdict: 'restates', direction: 'none', mode: 'none', confidence: 0.5 });
  });

  it.each([
    ['absent answers', { model: 'x' }],
    ['off-vocabulary verdict', answers({ verdict: { type: 'choice', choice: 'maybe', probabilities: {}, confidence: 0.9 } })],
    ['confidence out of range', answers({ verdict: { type: 'choice', choice: 'restates', probabilities: {}, confidence: 1.5 } })],
    ['same_subject absent', answers({ same_subject: undefined })],
    ['mode absent', answers({ mode: undefined })],
  ])('refuses an off-shape response (%s) with a typed provider error', async (_label, payload) => {
    stubFetch(200, payload);
    const p = new SubqAdjudicator(CFG, SUBQ);
    await expect(p.adjudicate(req(NEW, OLD))).rejects.toBeInstanceOf(BeliefProviderCallError);
    expect(p.lastUsage).toEqual([]);
    expect(p.lastDetail).toBeNull();
  });
});

describe('SubqAdjudicator — failure paths', () => {
  it('no key ⇒ fails closed at construction, naming the env var, and never calls the network', () => {
    delete process.env[ENV_KEY];
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(() => new SubqAdjudicator(CFG, SUBQ)).toThrow(ENV_KEY);
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP error ⇒ BeliefProviderCallError carrying the status (429 is retryable upstream)', async () => {
    stubFetch(429, { detail: { error_type: 'rate_limit', message: 'slow down' } });
    const err = await new SubqAdjudicator(CFG, SUBQ).adjudicate(req(NEW, OLD)).catch((e) => e);
    expect(err).toBeInstanceOf(BeliefProviderCallError);
    expect(err.httpStatus).toBe(429);
    expect(err.provider).toBe('subq');
    expect(String(err.message)).not.toContain('unit-test-key');
  });
});

describe('factory + cost wiring', () => {
  it("provider:'subq' resolves to SubqAdjudicator", () => {
    expect(getAdjudicationProvider(CFG)).toBeInstanceOf(SubqAdjudicator);
  });
  it('subq-snap-preview is priced (input only)', () => {
    expect(BELIEF_COST_CONFIG.rates['subq-snap-preview']).toEqual({ input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
