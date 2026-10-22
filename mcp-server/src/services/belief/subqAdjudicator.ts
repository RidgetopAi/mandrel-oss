/**
 * SUBQ ADJUDICATOR — SubQ Snap (`subq-snap-preview`) behind the AdjudicationProvider seam
 * (an earlier task bake-off). Selected by config like every other provider:
 * MANDREL_BELIEF_ADJUDICATOR_PROVIDER=subq (single) or MANDREL_BELIEF_TIER1_PROVIDER=subq (tier).
 *
 * Snap is a DECISION model, not a chat model (docs.subq.ai, Decisions API): one
 * `POST {endpoint}{decisionsPath}` carries a `state` (the text to judge) and named typed
 * `questions`, and returns PROBABILITIES — no generated text. So this provider does not reuse
 * the JSON-emitting prompt contract; it MAPS our verdict contract onto Snap's question types:
 *
 *   same_subject  noul    yes-probability ≥ BELIEF_SUBQ_CONFIG.sameSubjectMin → sameSubject
 *                         (or, sameSubjectFrom='verdict': sameSubject = verdict !== 'unrelated')
 *   verdict       choice  one of BELIEF_VERDICTS; Snap's `confidence` → verdict.confidence
 *   mode          choice  replaced | fallback_retained (meaningful only for a supersession)
 *
 * DIRECTION IS DECIDED IN CODE, FROM THE DATES. The canonical rubric already tells every LLM
 * provider "set direction from the date= fields alone; the LATER record wins; equal/unknown
 * dates → no direction", and deriveBeliefOutcome's chronology gate refuses anything else. Snap
 * is not asked to reproduce a rule code can apply exactly (the docs' own guidance: "rules you
 * can write down belong in code"). Tie or unknown date → direction 'none' (→ no_direction).
 *
 * RATIONALE: Snap emits none. The provider writes a receipt of the probabilities instead, so a
 * minted edge still carries WHY (the numbers), never an empty string.
 *
 * SECRET DISCIPLINE (same as anthropicAdjudicator): the key is read from env BY NAME
 * (cfg.apiKeyEnvVar); only the NAME lives on the snapshot-able config; an absent key fails
 * closed at construction with an actionable error naming the var. The VALUE is never logged.
 *
 * Billing: Snap bills INPUT tokens only (`usage.output_tokens` is always 0 per the docs).
 */

import { BELIEF_ADJUDICATOR_CONFIG, BELIEF_SUBQ_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig, BeliefSubqConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import { buildAdjudicationPromptParts, fmtDate } from './ollamaAdjudicator.js';
import { BeliefProviderCallError } from './providerError.js';
import { BELIEF_VERDICTS } from './types.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
  BeliefDirection,
  BeliefMode,
  BeliefVerdict,
} from './types.js';

/** Option descriptions for the verdict `choice` — a paraphrase of the canonical rubric. */
const COMPACT_VERDICT_INSTRUCTIONS =
  'How does the LATER record relate to the EARLIER record\'s claim? Only the date= fields decide which record is later.';
const VERDICT_CRITERIA: Record<BeliefVerdict, string> = {
  supersedes:
    'The later record states a DIFFERENT current value for the same fact the earlier record asserts, so the earlier claim is now false. ' +
    'A changed status of the same subject counts (not-done→done, planned→shipped/live, proposed→locked, blocked→unblocked, built→deployed, rejected→approved).',
  contests:
    'They directly contradict each other about the same fact and neither one is clearly newer or authoritative.',
  restates:
    'Same fact with the same status, only reworded or duplicated; or one record merely references, summarizes, implements or builds on the other ' +
    'without changing its claim. Replacement language aimed at some third thing (not the other record\'s own claim) does not count.',
  unrelated: 'Different subject or scope, or no meaningful relationship.',
};
const SAME_SUBJECT_INSTRUCTIONS =
  'Are RECORD A and RECORD B about the same subject at the same scope — the same system, environment (production vs development), box, service or instance?';
const SAME_SUBJECT_CRITERIA = {
  true: 'The same thing at the same scope/instance. Shared vocabulary alone is not enough.',
  false: 'A different subject, or a different environment/box/service even if the words overlap.',
};
const MODE_INSTRUCTIONS =
  'If the later record replaces the earlier record\'s claim, does it keep the old approach as a recoverable fallback?';
const MODE_CRITERIA: Record<Exclude<BeliefMode, 'none'>, string> = {
  replaced: 'The old approach is replaced and not kept.',
  fallback_retained:
    'The old approach is explicitly kept as a recoverable fallback (reversible, flip back, preserved, kept as fallback).',
};

/** Snap response shapes (Decisions API). */
interface SubqChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
interface SubqNoulAnswer {
  type: 'noul';
  noul: number;
}
interface SubqDecisionResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** What the provider read off the most recent decision — an in-process probe for the eval. */
export interface SubqDecisionDetail {
  sameSubjectP: number;
  verdictProbabilities: Record<string, number>;
  verdictConfidence: number;
  modeChoice: string;
}

function isUnit(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** The request body for one pair. Exported so the contract is unit-testable without a network. */
export function buildSubqDecisionBody(
  req: AdjudicationRequest,
  cfg: BeliefAdjudicatorConfig,
  subq: BeliefSubqConfig
): Record<string, unknown> {
  const max = cfg.maxContentChars;
  const state = [
    `RECORD A (id=${req.a.id}, type=${req.a.type}, date=${fmtDate(req.a.createdAt)}):`,
    (req.a.content ?? '').slice(0, max),
    '',
    `RECORD B (id=${req.b.id}, type=${req.b.type}, date=${fmtDate(req.b.createdAt)}):`,
    (req.b.content ?? '').slice(0, max),
  ].join('\n');
  const verdictInstructions =
    subq.rubric === 'full'
      ? buildAdjudicationPromptParts(req, cfg).staticPrefix
      : COMPACT_VERDICT_INSTRUCTIONS;
  return {
    model: cfg.model,
    state,
    questions: {
      same_subject: { type: 'noul', instructions: SAME_SUBJECT_INSTRUCTIONS, criteria: SAME_SUBJECT_CRITERIA },
      verdict: { type: 'choice', instructions: verdictInstructions, criteria: { ...VERDICT_CRITERIA } },
      mode: { type: 'choice', instructions: MODE_INSTRUCTIONS, criteria: { ...MODE_CRITERIA } },
    },
  };
}

/** The LATER record wins; a tie or an unparseable/absent date yields no direction. */
export function directionFromDates(req: AdjudicationRequest): BeliefDirection {
  const t = (d: AdjudicationRequest['a']['createdAt']): number =>
    d ? (d instanceof Date ? d : new Date(d)).getTime() : NaN;
  const ta = t(req.a.createdAt);
  const tb = t(req.b.createdAt);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta === tb) return 'none';
  return ta > tb ? 'a_supersedes_b' : 'b_supersedes_a';
}

/**
 * Parse + validate a Snap response into our verdict. Throws (never guesses) on a response that
 * does not carry the three answers in the documented shape — a typed API that answers off-shape
 * is a transport anomaly, and adjudicating on a defaulted value would mint on a fabrication.
 */
export function parseSubqDecision(
  json: SubqDecisionResponse,
  req: AdjudicationRequest,
  subq: BeliefSubqConfig
): { verdict: AdjudicatorVerdict; detail: SubqDecisionDetail } {
  const answers = json.answers ?? {};
  const ss = answers.same_subject as SubqNoulAnswer | undefined;
  const v = answers.verdict as SubqChoiceAnswer | undefined;
  const m = answers.mode as SubqChoiceAnswer | undefined;
  if (!ss || !isUnit(ss.noul)) throw new Error('subq: answers.same_subject.noul missing or not in [0,1]');
  if (!v || !(BELIEF_VERDICTS as readonly string[]).includes(v.choice) || !isUnit(v.confidence)) {
    throw new Error('subq: answers.verdict missing, off-vocabulary, or without a [0,1] confidence');
  }
  if (!m || (m.choice !== 'replaced' && m.choice !== 'fallback_retained')) {
    throw new Error('subq: answers.mode missing or off-vocabulary');
  }
  const verdictName = v.choice as BeliefVerdict;
  const sameSubject =
    subq.sameSubjectFrom === 'verdict' ? verdictName !== 'unrelated' : ss.noul >= subq.sameSubjectMin;
  // Same coherence rule as normalizeVerdict: direction/mode only mean something for a
  // same-subject supersession.
  const isSupersede = verdictName === 'supersedes' && sameSubject;
  const direction: BeliefDirection = isSupersede ? directionFromDates(req) : 'none';
  const mode: BeliefMode = isSupersede ? (m.choice as BeliefMode) : 'none';
  const probs = v.probabilities ?? {};
  const receipt =
    `subq-snap: p(same_subject)=${ss.noul.toFixed(3)}; ` +
    BELIEF_VERDICTS.map((k) => `p(${k})=${(probs[k] ?? 0).toFixed(3)}`).join(' ') +
    `; confidence=${v.confidence.toFixed(3)}; mode=${m.choice}` +
    (isSupersede && direction === 'none' ? '; dates tie/unknown → no direction' : '');
  return {
    verdict: {
      sameSubject,
      subject: '',
      verdict: verdictName,
      direction,
      mode,
      confidence: v.confidence,
      rationale: receipt,
    },
    detail: {
      sameSubjectP: ss.noul,
      verdictProbabilities: { ...probs },
      verdictConfidence: v.confidence,
      modeChoice: m.choice,
    },
  };
}

/** SubQ Snap adjudication provider. */
export class SubqAdjudicator implements AdjudicationProvider {
  readonly name = 'subq';
  readonly model: string;
  public lastUsage: AdjudicationCallUsage[] = [];
  /** The probabilities behind the most recent verdict (eval probe). Null after a failed call. */
  public lastDetail: SubqDecisionDetail | null = null;
  private readonly cfg: BeliefAdjudicatorConfig;
  private readonly subq: BeliefSubqConfig;
  private readonly apiKey: string;

  constructor(cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG, subq: BeliefSubqConfig = BELIEF_SUBQ_CONFIG) {
    this.cfg = cfg;
    this.subq = subq;
    this.model = cfg.model;
    const key = process.env[cfg.apiKeyEnvVar]; // env-read: dynamic(API-key env var NAME is configurable via MANDREL_BELIEF_*_API_KEY_ENV; e.g. SUBQ_API_KEY)
    if (!key) {
      throw new Error(
        `SubQ adjudicator needs an API key: env var "${cfg.apiKeyEnvVar}" is not set. ` +
          `Export it (or set MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV to the var that holds it).`
      );
    }
    this.apiKey = key;
  }

  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    this.lastUsage = [];
    this.lastDetail = null;
    const body = buildSubqDecisionBody(req, this.cfg, this.subq);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let json: SubqDecisionResponse;
    try {
      const resp = await fetch(`${this.cfg.endpoint}${this.subq.decisionsPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new BeliefProviderCallError(
          `subq HTTP ${resp.status} for ${this.cfg.model}: ${errBody.slice(0, 200)}`,
          { provider: this.name, model: this.model, httpStatus: resp.status }
        );
      }
      json = (await resp.json()) as SubqDecisionResponse;
    } finally {
      clearTimeout(timer);
    }

    let parsed: ReturnType<typeof parseSubqDecision>;
    try {
      parsed = parseSubqDecision(json, req, this.subq);
    } catch (e) {
      throw new BeliefProviderCallError((e as Error).message, {
        provider: this.name,
        model: this.model,
        cause: e,
      });
    }
    this.lastDetail = parsed.detail;
    this.lastUsage = [
      {
        tier: 'single',
        provider: this.name,
        model: this.model,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    const v = parsed.verdict;
    logger.info(
      `🧪 belief adjudicator (${this.name}/${this.model}): ${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} ⇒ ` +
        `${v.verdict}/${v.direction}/${v.mode} conf=${v.confidence.toFixed(2)}`
    );
    return v;
  }
}
