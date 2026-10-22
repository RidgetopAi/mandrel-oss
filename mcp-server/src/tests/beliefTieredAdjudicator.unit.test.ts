/**
 * TIERED ADJUDICATOR — PURE routing unit tests (BL-11). NO DB, NO LLM, NO network.
 *
 * Locks the tiered routing contract with INJECTED FAKE providers (no real Groq/Sonnet calls, no
 * money spent) so the routing rule itself is provable in isolation:
 *   - tier-1 returns a NON-escalate verdict (unrelated/restates) ⇒ tier-2 is NOT called, and the
 *     RETURNED verdict + attributed name/model are tier-1's (the cheap-verdict cost win);
 *   - tier-1 returns an ESCALATE verdict (supersedes/contests) ⇒ tier-2 IS called exactly once,
 *     and the RETURNED verdict + attributed name/model are tier-2's (Sonnet authoritative);
 *   - the escalation set is CONFIG-DRIVEN (flip it and routing flips with it);
 *   - the routing probe (lastRouting) + name/model getters attribute the authoritative tier
 *     (the BL-10 cost-attribution seam);
 *   - a MUTATION check: inverting the escalation rule would break these assertions.
 *
 * Also covers the factory: `getAdjudicationProvider` still returns the single-providers by
 * config (fallback/A-B intact) and the recursion guard (a tier of provider:'tiered' fails closed).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TieredAdjudicator } from '../services/belief/tieredAdjudicator.js';
import { getAdjudicationProvider } from '../services/belief/provider.js';
import { OllamaAdjudicator } from '../services/belief/ollamaAdjudicator.js';
import { OpenAICompatAdjudicator } from '../services/belief/openaiAdjudicator.js';
import { AnthropicAdjudicator } from '../services/belief/anthropicAdjudicator.js';
import { BELIEF_ADJUDICATOR_CONFIG } from '../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../config/beliefConfig.js';
import type {
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
  BeliefVerdict,
} from '../services/belief/types.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const REQ: AdjudicationRequest = {
  a: { id: A, type: 'context', content: 'a' },
  b: { id: B, type: 'context', content: 'b' },
  cosine: 0.9,
};

/** A scripted, call-counting fake provider — proves routing without any LLM/network. */
class FakeProvider implements AdjudicationProvider {
  public calls = 0;
  public lastReq: AdjudicationRequest | null = null;
  constructor(
    public readonly name: string,
    public readonly model: string,
    private readonly reply: AdjudicatorVerdict
  ) {}
  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.calls += 1;
    this.lastReq = req;
    return { ...this.reply };
  }
}

function verdict(v: BeliefVerdict, extra: Partial<AdjudicatorVerdict> = {}): AdjudicatorVerdict {
  return {
    sameSubject: v !== 'unrelated',
    subject: 's',
    verdict: v,
    direction: v === 'supersedes' ? 'a_supersedes_b' : 'none',
    mode: v === 'supersedes' ? 'replaced' : 'none',
    confidence: 0.95,
    rationale: `tier reply: ${v}`,
    ...extra,
  };
}

const DEFAULT_ESCALATE = ['supersedes', 'contests'];

describe('TieredAdjudicator — NON-escalate verdicts trust tier-1 (no tier-2 call)', () => {
  for (const v of ['unrelated', 'restates'] as BeliefVerdict[]) {
    it(`tier-1 '${v}' ⇒ tier-2 NOT called; tier-1 verdict returned + attributed`, async () => {
      const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict(v, { rationale: `groq:${v}` }));
      const t2 = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('supersedes'));
      const tiered = new TieredAdjudicator(t1, t2, DEFAULT_ESCALATE);

      const out = await tiered.adjudicate(REQ);

      expect(t1.calls).toBe(1); // prescreen ran
      expect(t2.calls).toBe(0); // NOT escalated — the cost win
      expect(out.verdict).toBe(v);
      expect(out.rationale).toBe(`groq:${v}`); // it is tier-1's verdict, verbatim
      // Attribution (BL-10): the authoritative tier is tier-1 (Groq).
      expect(tiered.name).toBe('groq');
      expect(tiered.model).toBe('gpt-oss-120b');
      expect(tiered.lastRouting).toMatchObject({
        tier1Verdict: v,
        escalated: false,
        authoritativeTier: 1,
        authoritative: { name: 'groq', model: 'gpt-oss-120b' },
      });
    });
  }
});

describe('TieredAdjudicator — escalate verdicts confirm with tier-2 (authoritative)', () => {
  for (const v of ['supersedes', 'contests'] as BeliefVerdict[]) {
    it(`tier-1 '${v}' ⇒ tier-2 called once; tier-2 verdict returned + attributed`, async () => {
      const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict(v, { rationale: `groq:${v}` }));
      // Tier-2 disagrees to PROVE tier-2 is authoritative (its verdict flows out, not tier-1's).
      const t2 = new FakeProvider(
        'anthropic',
        'claude-sonnet-5',
        verdict('restates', { rationale: 'sonnet:restates' })
      );
      const tiered = new TieredAdjudicator(t1, t2, DEFAULT_ESCALATE);

      const out = await tiered.adjudicate(REQ);

      expect(t1.calls).toBe(1);
      expect(t2.calls).toBe(1); // escalated
      // Tier-2 is AUTHORITATIVE: even though tier-1 said `${v}`, the output is tier-2's `restates`.
      expect(out.verdict).toBe('restates');
      expect(out.rationale).toBe('sonnet:restates');
      // Tier-2 was handed the SAME request (shared prompt / same pair).
      expect(t2.lastReq).toBe(REQ);
      // Attribution (BL-10): authoritative tier is tier-2 (Sonnet).
      expect(tiered.name).toBe('anthropic');
      expect(tiered.model).toBe('claude-sonnet-5');
      expect(tiered.lastRouting).toMatchObject({
        tier1Verdict: v,
        escalated: true,
        authoritativeTier: 2,
        authoritative: { name: 'anthropic', model: 'claude-sonnet-5' },
      });
    });
  }
});

describe('TieredAdjudicator — escalation set is CONFIG-DRIVEN', () => {
  it('widening escalateVerdicts to include restates escalates a restates verdict', async () => {
    const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict('restates'));
    const t2 = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('supersedes'));
    // With the DEFAULT set, restates does NOT escalate…
    const dflt = new TieredAdjudicator(t1, t2, DEFAULT_ESCALATE);
    await dflt.adjudicate(REQ);
    expect(t2.calls).toBe(0);

    // …but with restates ADDED to the set it DOES.
    const t1b = new FakeProvider('groq', 'gpt-oss-120b', verdict('restates'));
    const t2b = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('supersedes'));
    const widened = new TieredAdjudicator(t1b, t2b, ['supersedes', 'contests', 'restates']);
    const out = await widened.adjudicate(REQ);
    expect(t2b.calls).toBe(1);
    expect(out.verdict).toBe('supersedes'); // tier-2 authoritative
  });

  it('an EMPTY escalation set never escalates (pure tier-1 mode)', async () => {
    const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict('supersedes'));
    const t2 = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('restates'));
    const tiered = new TieredAdjudicator(t1, t2, []);
    const out = await tiered.adjudicate(REQ);
    expect(t2.calls).toBe(0);
    expect(out.verdict).toBe('supersedes'); // tier-1's, trusted directly
    expect(tiered.escalateVerdicts).toEqual([]);
  });

  it('drops unknown/off-vocab escalation tokens (fail-closed to the vocab)', async () => {
    const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict('supersedes'));
    const t2 = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('restates'));
    // 'bogus' is not a BeliefVerdict — must be dropped; 'supersedes' kept.
    const tiered = new TieredAdjudicator(t1, t2, ['bogus', 'supersedes', '']);
    expect(tiered.escalateVerdicts.sort()).toEqual(['supersedes']);
    await tiered.adjudicate(REQ);
    expect(t2.calls).toBe(1);
  });

  it('exposes both tier identities for BL-10 cost attribution', () => {
    const t1 = new FakeProvider('groq', 'gpt-oss-120b', verdict('unrelated'));
    const t2 = new FakeProvider('anthropic', 'claude-sonnet-5', verdict('restates'));
    const tiered = new TieredAdjudicator(t1, t2, DEFAULT_ESCALATE);
    expect(tiered.tiers).toEqual({
      tier1: { name: 'groq', model: 'gpt-oss-120b' },
      tier2: { name: 'anthropic', model: 'claude-sonnet-5' },
    });
  });
});

describe('TieredAdjudicator — MUTATION guard on the routing rule', () => {
  // If the routing rule were INVERTED (escalate on NON-edge verdicts / trust on edge verdicts),
  // these two facts could not BOTH hold. They pin the rule direction, not just "some routing".
  it('edge-verdict escalates AND non-edge-verdict does not — the exact rule direction', async () => {
    // Edge verdict → MUST call tier-2.
    const eT1 = new FakeProvider('groq', 'g', verdict('supersedes'));
    const eT2 = new FakeProvider('anthropic', 's', verdict('supersedes'));
    await new TieredAdjudicator(eT1, eT2, DEFAULT_ESCALATE).adjudicate(REQ);
    expect(eT2.calls).toBe(1);

    // Non-edge verdict → MUST NOT call tier-2.
    const nT1 = new FakeProvider('groq', 'g', verdict('unrelated'));
    const nT2 = new FakeProvider('anthropic', 's', verdict('supersedes'));
    await new TieredAdjudicator(nT1, nT2, DEFAULT_ESCALATE).adjudicate(REQ);
    expect(nT2.calls).toBe(0);
  });
});

describe('provider factory — single-provider modes intact + tiered wiring + recursion guard', () => {
  const ENV_KEYS = [
    'MANDREL_BELIEF_ADJUDICATOR_PROVIDER',
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'SUBQ_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // The anthropic provider throws without a key; give the factory a dummy so construction
    // succeeds (no network call is made — we only assert the returned instance type).
    process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
    process.env.GROQ_API_KEY = 'test-key-not-used';
    process.env.SUBQ_API_KEY = 'test-key-not-used';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    vi.restoreAllMocks();
  });

  const cfg = (provider: string): BeliefAdjudicatorConfig => ({
    ...BELIEF_ADJUDICATOR_CONFIG,
    provider,
  });

  it('single-provider modes still resolve (config flip = fallback / A-B)', () => {
    expect(getAdjudicationProvider(cfg('ollama'))).toBeInstanceOf(OllamaAdjudicator);
    expect(getAdjudicationProvider(cfg('openai-compat'))).toBeInstanceOf(OpenAICompatAdjudicator);
    expect(getAdjudicationProvider(cfg('anthropic'))).toBeInstanceOf(AnthropicAdjudicator);
  });

  it("provider 'tiered' resolves to a TieredAdjudicator composing Snap + Sonnet", () => {
    const p = getAdjudicationProvider(cfg('tiered'));
    expect(p).toBeInstanceOf(TieredAdjudicator);
    const tiered = p as TieredAdjudicator;
    // Composes the DEFAULT tier providers (subq Snap + anthropic Sonnet).
    expect(tiered.tiers.tier1.name).toBe('subq');
    expect(tiered.tiers.tier2.name).toBe('anthropic');
    expect(tiered.tiers.tier2.model).toBe('claude-sonnet-5');
  });

  it('an unknown single-provider fails closed (never silently adjudicates)', () => {
    expect(() => getAdjudicationProvider(cfg('does-not-exist'))).toThrow(/Unknown belief adjudicator provider/);
  });
});
