/**
 * OLLAMA ADJUDICATOR — the Increment-1 Stage-2 provider (the belief-layer design §3/§9a).
 *
 * A generative-instruct LLM judges a candidate pair: same subject? supersedes / contests /
 * restates / unrelated, with direction, mode, confidence, rationale. The pinned adjudicator
 * default is now anthropic/claude-sonnet-5 (two-tier v1) — this OLLAMA
 * provider is the local path, selected by env (MANDREL_BELIEF_ADJUDICATOR_PROVIDER=ollama +
 * MANDREL_BELIEF_ADJUDICATOR_MODEL=<a local model, e.g. qwen2.5:1.5b>). NOTE: cfg.model is
 * SHARED across providers, so the ollama provider needs its model set explicitly by env (the
 * pinned default 'claude-sonnet-5' is an Anthropic id, not an Ollama tag). Runs via the local
 * Ollama daemon `/api/generate` with `format:"json"` + temperature 0 for a stable verdict.
 *
 * SCOPE RUBRIC IS IN THE PROMPT (design §2/§6 case 3): the FIRST question is "same subject
 * AND same scope/instance/plane?" — a prod-plane record vs a dev-plane record is UNRELATED
 * even with shared vocabulary. This is where the thin subject-anchor earns its keep and the
 * false-conflict trap (axis ②) is avoided.
 *
 * Everything tunable comes from beliefConfig (BELIEF_ADJUDICATOR_CONFIG) — no literals.
 */

import { z } from 'zod';

import { BELIEF_ADJUDICATOR_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import {
  BELIEF_VERDICTS,
  BELIEF_DIRECTIONS,
  BELIEF_MODES,
} from './types.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from './types.js';

/** The raw JSON contract we ask the model to emit (validated before we trust it).
 *  EXPORTED so the sibling ceiling providers (openai-compat, anthropic) validate against the
 *  exact same contract — one schema, no drift across providers (belief-eval ceiling check). */
export const RawVerdictSchema = z.object({
  same_subject: z.boolean(),
  subject: z.string().default(''),
  verdict: z.enum(BELIEF_VERDICTS),
  direction: z.enum(BELIEF_DIRECTIONS).default('none'),
  mode: z.enum(BELIEF_MODES).default('none'),
  confidence: z.number(),
  rationale: z.string().default(''),
});

/**
 * THE GRAMMAR — the verdict JSON schema handed to ollama's structured-output `format` param
 * (grammar-constrained decoding). DERIVED from the shared verdict vocab constants so it can
 * NEVER drift from RawVerdictSchema / the zod validator: same enums, one source. Pinning the
 * output to this schema at the token level kills malformed JSON + the validate-retry loop
 * (the serving survey serving-hardening finding). confidence is a plain number here (JSON Schema
 * min/max is unreliable across engines) — the range is enforced downstream by clamp01.
 */
export function buildVerdictJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      same_subject: { type: 'boolean' },
      subject: { type: 'string' },
      verdict: { type: 'string', enum: [...BELIEF_VERDICTS] },
      direction: { type: 'string', enum: [...BELIEF_DIRECTIONS] },
      mode: { type: 'string', enum: [...BELIEF_MODES] },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
    required: ['same_subject', 'verdict', 'direction', 'mode', 'confidence'],
  };
}

/** Clamp a possibly-out-of-range confidence into [0,1] (a small model can emit 1.2 / -0). */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * ISO timestamp for the prompt, to SECOND resolution, or 'unknown'.
 *
 * SECONDS, NOT DAYS — and the resolution is load-bearing. The rubric tells
 * the model that direction is decided by the dates; that rule is HOLLOW if the prompt cannot
 * express which record is later. MEASURED over the 58 pairs retracted on 2026-08-28
 * (reports/artifacts/b6-fde9bdaf-retract/, joined to the endpoints' real timestamps on prod):
 *
 *   day resolution     -> 56 of 58 pairs are a TIE (the old `slice(0, 10)`)
 *   minute resolution  ->  2 of 58
 *   second resolution  ->  1 of 58
 *
 * So the previous format gave the model no way to answer the direction question in 97% of
 * exactly the population that got it wrong. One genuine same-second tie remains; the rubric
 * tells the model to refuse a direction rather than guess when the timestamps are equal.
 *
 * Deliberately NOT sub-second: `checkEdgeChronology` breaks a true tie lexicographically on
 * the row id, which is not a judgment a model should be asked to reproduce, and the mint-time
 * chronology gate is what actually enforces the order anyway.
 */
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return 'unknown';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? 'unknown' : `${dt.toISOString().slice(0, 19)}Z`;
}

/**
 * THE ADJUDICATION PROMPT — split into its STATIC and DYNAMIC halves (BL-12).
 *
 * `staticPrefix` is the rubric + guardrails + worked examples — byte-IDENTICAL on every call,
 * so it is the Anthropic prompt-cache prefix (the anthropic provider places `cache_control` on
 * it; ~2,500 tokens billed at the cached-read rate on repeat calls). `dynamic` is the per-pair
 * record content + the response-shape footer — it VARIES per call and is NEVER cached.
 *
 * The split is purely STRUCTURAL: there is ONE copy of the guardrail/example text (so BL-7 can't
 * drift), and the CONTRACT is `staticPrefix + dynamic === buildAdjudicationPrompt(...)` — the
 * exact same text reaches the model whether sent as one string (ollama/openai-compat) or as two
 * cache-delimited content blocks (anthropic). `staticPrefix` carries the trailing '\n' joiner so
 * plain concatenation (no separator) reproduces the original prompt byte-for-byte.
 */
export interface AdjudicationPromptParts {
  /** STATIC rubric + guardrails + worked examples — identical every call (cache-eligible). */
  staticPrefix: string;
  /** DYNAMIC per-pair record content + the response-shape footer — varies per call (NOT cached). */
  dynamic: string;
}

/** Build the STATIC/DYNAMIC prompt halves (see {@link AdjudicationPromptParts}). */
export function buildAdjudicationPromptParts(
  req: AdjudicationRequest,
  cfg: BeliefAdjudicatorConfig
): AdjudicationPromptParts {
  const max = cfg.maxContentChars;
  const aContent = (req.a.content ?? '').slice(0, max);
  const bContent = (req.b.content ?? '').slice(0, max);
  // STATIC — the rubric + guardrails + worked examples. Identical for every pair, so the
  // anthropic provider caches it. Trailing '\n' makes `staticPrefix + dynamic` == the original.
  const staticPrefix =
    [
      'You are a MEMORY ADJUDICATOR. Two stored memory records are given. Decide how they',
      'relate. Be strict and literal. Answer ONLY with a single JSON object, no prose.',
      '',
      'DECISION PROCEDURE:',
      '1) SAME SUBJECT & SCOPE? Are A and B about the SAME thing at the SAME scope/instance/',
      '   plane? Records about DIFFERENT environments (a PRODUCTION system vs a DEVELOPMENT',
      '   system, two different boxes/services) are NOT the same subject even if they share',
      '   words. If not → verdict "unrelated", same_subject=false.',
      '2) If SAME subject, pick exactly ONE verdict, using this priority:',
      '   * "supersedes" — one record REPLACES the other\'s claim with a DIFFERENT CURRENT VALUE,',
      '     so the older value is now WRONG/stale; OR the two records DIRECTLY DISAGREE about the',
      '     current fact and one is clearly newer/authoritative. There must be an OLD value and a',
      '     NEW value for the SAME attribute, and the new one makes the old FALSE. A change in the',
      '     truth-STATUS of the SAME subject IS such a change — the old status is the OLD value and',
      '     is now FALSE: not-done→done, not-installed→installed, planned→shipped/live, proposed→',
      '     locked, blocked→unblocked, built→deployed, rejected→approved. Trigger phrases:',
      '     "migrated from X to Y", "replaces X", "X is dead/stale/deprecated, use Y", "zero X',
      '     left", "now uses Y instead of X", "switched from X to Y", "now done/shipped/live/',
      '     locked/approved". Set direction from the DATES, never from the wording: the LATER',
      '     record is the winner — "a_supersedes_b" if the A record is dated after the B record,',
      '     else "b_supersedes_a". See DIRECTION IS DECIDED BY DATE below.',
      '     Set mode="fallback_retained" if the winner explicitly keeps the old approach',
      '     as a recoverable fallback ("reversible", "flip back", "preserved", "kept as fallback");',
      '     otherwise mode="replaced".',
      '   * "restates" — both assert the SAME current fact with NO change and NEITHER negates the',
      '     other (a duplicate/rephrasing), OR one record merely REFERENCES/MENTIONS/SUMMARIZES/',
      '     IMPLEMENTS/BUILDS ON the other without changing its claim. If neither record makes the',
      '     other\'s value FALSE, it is NOT supersedes. restates requires the SAME truth-status',
      '     merely reworded — if the STATUS of the subject DIFFERS (e.g. planned vs shipped,',
      '     not-done vs done), it is NOT a restatement; it is supersedes.',
      '   * "contests" — they DIRECTLY CONTRADICT and NEITHER clearly wins (no newer/authoritative',
      '     side).',
      '   * "unrelated" — different subject/scope or no meaningful relationship.',
      '',
      'GUARDRAIL — REFERENCE IS NOT REPLACEMENT (read before choosing supersedes):',
      'A record that merely REFERENCES, MENTIONS, SUMMARIZES, IMPLEMENTS, or BUILDS ON another does',
      'NOT supersede it. A progress note, handoff, status update, plan, or completion that TALKS',
      'ABOUT a decision/memo does NOT replace that decision — the decision is still valid. Only mint',
      'supersedes when the older record\'s claim is now FALSE because the newer one states a DIFFERENT',
      'current value for the SAME fact. "We decided X, now building it" / "P4 architecture (=X) done,',
      'moving to build" does NOT supersede "DECISION: architecture = X" — it AGREES with and relies',
      'on it. When in doubt, it is NOT supersedes.',
      '',
      'GUARDRAIL — A STATUS-FLIP IS NOT A RESTATEMENT (read before choosing restates):',
      'When both records are about the SAME subject but its truth-STATUS CHANGED — not-done→done,',
      'planned→shipped/live, proposed→locked, blocked→unblocked, built→deployed, rejected→approved —',
      'that is a SUPERSESSION, not a restatement: the older status ("not done", "planned",',
      '"proposed") is now FALSE. This is the dual of the rule above — a mere reference/mention with',
      'NO status change = restates; the SAME subject with a CHANGED status = supersedes (direction =',
      'the record asserting the NEW status). BOTH must hold for supersedes: SAME subject AND the',
      'older status is now FALSE.',
      '',
      'DIRECTION IS DECIDED BY DATE — WHETHER and WHICH WAY are two different questions:',
      '  * WHETHER these two records supersede at all is decided by the LANGUAGE, using the rules',
      '    above. Explicit replacement/negation language is what makes a pair a supersession',
      '    rather than a restatement or a mere reference.',
      '  * WHICH WAY is decided by the DATES, always, and the wording never overrides them. The',
      '    LATER record supersedes the EARLIER one. An older record cannot supersede a newer one:',
      '    a claim written before the other claim existed cannot be a replacement of it. Read the',
      '    date= field given for each record and set direction from that alone. If the wording',
      '    seems to point the other way, the wording is being misread — read the guardrail below',
      '    before answering.',
      '  * The date= fields are full timestamps to the SECOND, so one of them is later unless',
      '    they are byte-identical. Do NOT reason about which record "sounds" newer, and do not',
      '    infer an order from dates mentioned INSIDE the record text — only the date= fields',
      '    count. If date= is "unknown" for either record, or the two are exactly EQUAL, there',
      '    is no direction to assign: answer "restates" or "contests", never "supersedes".',
      '',
      'GUARDRAIL — REPLACEMENT LANGUAGE IS OFTEN AIMED AT A THIRD RECORD:',
      'A record that says "this replaces X" is talking about whatever X is, and X is usually NOT',
      'the other record in front of you. Supersession language counts for THIS pair only when the',
      "thing being replaced is the OTHER RECORD'S OWN CLAIM. Before letting any trigger phrase",
      'decide, check: does the LATER record state a different current value for a fact the EARLIER',
      'record asserts? If the phrase names some third system, value, plan or decision that neither',
      'record in this pair claims, it is evidence about that third thing and says NOTHING about',
      'this pair → "restates" or "unrelated". Replacement language sitting in the OLDER record is',
      'where this mistake usually comes from: check WHAT it names before letting it decide',
      'anything. It may still be a real supersession — but if so the NEWER record is the winner.',
      'confidence is 0..1.',
      '',
      'EXAMPLES (in every supersedes example below, A is the LATER record — that is why the',
      'direction is a_supersedes_b):',
      'A="we now send all alerts via chat; zero email alerts left" B="email alerts are',
      'working" → {"same_subject":true,"verdict":"supersedes","direction":"a_supersedes_b",',
      '"mode":"replaced","confidence":0.95}',
      'A="the service runs on port 9000 now" B="reach the service on port 8080" →',
      '{"same_subject":true,"verdict":"supersedes","direction":"a_supersedes_b","mode":"replaced"}',
      'A="we switched the engine to Y; reversible — flip back to X anytime, X data preserved"',
      'B="our engine is X" → {"same_subject":true,"verdict":"supersedes","direction":',
      '"a_supersedes_b","mode":"fallback_retained","confidence":0.9}',
      'A="feature X shipped to prod" B="feature X is live in prod" →',
      '{"same_subject":true,"verdict":"restates","direction":"none","mode":"none"}',
      '// STATUS-FLIP — same subject, truth-status changed (not-started → done) → supersedes:',
      'A="the gemma embedder migration is DONE — gemma is live in prod" B="TODO: migrate the',
      'embedder to gemma (not started yet)" → {"same_subject":true,"verdict":"supersedes",',
      '"direction":"a_supersedes_b","mode":"replaced","confidence":0.95}',
      '// TRUE RESTATEMENT — same status (both DONE), only reworded → restates (contrast the above):',
      'A="the gemma embedder migration is complete" B="we finished migrating the embedder to gemma"',
      '→ {"same_subject":true,"verdict":"restates","direction":"none","mode":"none","confidence":0.9}',
      '// REFERENCE, NOT REPLACEMENT — the handoff talks about the decision, does not change it:',
      'A="handoff: P4 architecture decided (= layered runtime), moving to build" B="DECISION: P4',
      'architecture = layered runtime" → {"same_subject":true,"verdict":"restates","direction":',
      '"none","mode":"none","confidence":0.9}',
      'A="the PROD database is on host H" B="the DEV database is on host O" →',
      '{"same_subject":false,"verdict":"unrelated","direction":"none","mode":"none"}',
      '// THIRD-RECORD LANGUAGE — A is OLDER and its "replaces" names something that is not B:',
      'A (date=2026-07-01T09:00:00Z)="the control host replaces the old dev laptop for all agent work"',
      'B (date=2026-08-01T09:00:00Z)="Mandrel prod runs on the prod box" → the replacement',
      'language in A is about the LAPTOP, not about B\'s claim, and A is the EARLIER record, so',
      'it could not supersede B even if it were the same subject →',
      '{"same_subject":false,"verdict":"unrelated","direction":"none","mode":"none"}',
      '// SAME SUBJECT, but the replacement language sits in the OLDER record → direction follows',
      '// the DATES, so the NEWER record wins:',
      'A (date=2026-06-01T09:00:00Z)="we are replacing the queue: RabbitMQ is dead, everything',
      'moves to Kafka" B (date=2026-08-01T09:00:00Z)="the queue is RabbitMQ again; the Kafka move',
      'was reverted" →',
      '{"same_subject":true,"verdict":"supersedes","direction":"b_supersedes_a","mode":"replaced",',
      '"confidence":0.9}',
    ].join('\n') + '\n';
  // DYNAMIC — the per-pair records + the response-shape footer. Leading '' reproduces the blank
  // line that separated the examples from RECORD A in the original single-string prompt.
  const dynamic = [
    '',
    `RECORD A (id=${req.a.id}, type=${req.a.type}, date=${fmtDate(req.a.createdAt)}):`,
    aContent,
    '',
    `RECORD B (id=${req.b.id}, type=${req.b.type}, date=${fmtDate(req.b.createdAt)}):`,
    bContent,
    '',
    'Respond with ONLY this JSON shape (no prose):',
    '{"same_subject": true|false, "subject": "<short subject label>", "verdict":',
    '"supersedes"|"contests"|"restates"|"unrelated", "direction":',
    '"a_supersedes_b"|"b_supersedes_a"|"none", "mode": "replaced"|"fallback_retained"|"none",',
    '"confidence": 0.0-1.0, "rationale": "<one sentence>"}',
  ].join('\n');
  return { staticPrefix, dynamic };
}

/**
 * THE ADJUDICATION PROMPT. Deterministic, rubric-driven. `a` and `b` are labelled by
 * position; direction/mode are reported relative to them. The rubric encodes the six-case
 * intent (explicit-replacement ⇒ supersedes; different plane/scope ⇒ unrelated; recoverable
 * fallback ⇒ mode fallback_retained; same fact restated ⇒ restates).
 *
 * The single combined string used by the ollama + openai-compat providers. It is the exact
 * concatenation of the two halves (see {@link buildAdjudicationPromptParts}) — one source of the
 * text, no drift — so the anthropic cache split changes nothing those providers send.
 */
export function buildAdjudicationPrompt(req: AdjudicationRequest, cfg: BeliefAdjudicatorConfig): string {
  const { staticPrefix, dynamic } = buildAdjudicationPromptParts(req, cfg);
  return staticPrefix + dynamic;
}

/** Normalise a validated raw verdict into the internal AdjudicatorVerdict (enforce coherence). */
export function normalizeVerdict(raw: z.infer<typeof RawVerdictSchema>): AdjudicatorVerdict {
  // Coherence: direction/mode are only meaningful for a supersedes verdict.
  const isSupersede = raw.verdict === 'supersedes' && raw.same_subject;
  const direction = isSupersede ? raw.direction : 'none';
  const mode = isSupersede ? raw.mode : 'none';
  return {
    sameSubject: raw.same_subject,
    subject: raw.subject ?? '',
    verdict: raw.verdict,
    direction,
    mode,
    confidence: clamp01(raw.confidence),
    rationale: raw.rationale ?? '',
  };
}

/** Extract the first balanced JSON object from a model response (defensive against prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the first {...} block.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('no JSON object found in adjudicator response');
  }
}

interface OllamaGenerateResponse {
  response?: string;
  total_duration?: number;
  // Native token accounting (BL-10 cost ledger): prompt vs generated token counts.
  prompt_eval_count?: number;
  eval_count?: number;
}

/** The Increment-1 ollama-backed adjudication provider. */
export class OllamaAdjudicator implements AdjudicationProvider {
  readonly name = 'ollama';
  readonly model: string;
  /** Per-call token usage from the most recent adjudicate() (BL-10 cost ledger). One entry
   *  (tier='single'). Local/free — priced at $0 unless a rate is configured. Reset per call. */
  public lastUsage: AdjudicationCallUsage[] = [];
  private readonly cfg: BeliefAdjudicatorConfig;

  constructor(cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG) {
    this.cfg = cfg;
    this.model = cfg.model;
  }

  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    // Reset usage: a call that throws before completion leaves NO stale usage attributed to it.
    this.lastUsage = [];
    const prompt = buildAdjudicationPrompt(req, this.cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let json: OllamaGenerateResponse;
    try {
      // SERVING HARDENING: grammar-constrained structured output + greedy
      // decode + no thinking-mode — all config-driven (BELIEF_ADJUDICATOR_CONFIG), zero literals.
      const format: unknown = this.cfg.structuredOutput ? buildVerdictJsonSchema() : 'json';
      const resp = await fetch(`${this.cfg.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.cfg.model,
          prompt,
          stream: false,
          format,
          think: this.cfg.think,
          keep_alive: this.cfg.keepAlive,
          options: {
            temperature: this.cfg.temperature,
            top_k: this.cfg.topK,
            top_p: this.cfg.topP,
            seed: this.cfg.seed,
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`ollama HTTP ${resp.status} for ${this.cfg.model}: ${body.slice(0, 200)}`);
      }
      json = (await resp.json()) as OllamaGenerateResponse;
    } finally {
      clearTimeout(timer);
    }

    const rawText = json.response ?? '';
    const parsed = RawVerdictSchema.parse(extractJson(rawText));
    const verdict = normalizeVerdict(parsed);
    // BL-10: record this real call's usage (cost ledger). Ollama is local; cost resolves to $0
    // unless a rate is configured. No prompt-cache accounting on this wire (cache_* stay 0).
    this.lastUsage = [
      {
        tier: 'single',
        provider: this.name,
        model: this.model,
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ];
    logger.info(
      `🧪 belief adjudicator (${this.name}/${this.model}): ${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} ⇒ ` +
        `${verdict.verdict}/${verdict.direction}/${verdict.mode} conf=${verdict.confidence.toFixed(2)}`
    );
    return verdict;
  }
}
