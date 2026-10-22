/**
 * ANTHROPIC ADJUDICATOR — a CEILING-CHECK Stage-2 provider (belief-eval).
 *
 * Calls the Anthropic Messages API (`POST {apiBaseUrl}/v1/messages`) — the "does a strong
 * frontier model clear the case-3 scope-precision wall?" measurement (Ceiling 2 = Claude
 * Haiku). Structured output is obtained via TOOL-USE: we expose a single `record_verdict`
 * tool whose input_schema IS the verdict json-schema, and force `tool_choice` to it, so the
 * model must return the verdict as a well-typed tool_use input (no prose-JSON scraping).
 *
 * Reuses the SAME adjudication prompt + verdict contract + parser as the ollama provider so
 * the only bake-off variable is the MODEL, not the prompt (one source, no drift).
 *
 * SECRET DISCIPLINE: the API key is read from an ENV VAR (its NAME is config-driven via
 * cfg.apiKeyEnvVar, default ANTHROPIC_API_KEY); the key VALUE is never stored on the config
 * object (which is snapshotted into the eval report) and never logged. If the env var is
 * absent we throw a clear, actionable error naming the var — the run fails closed, it does
 * not silently adjudicate with a broken client.
 *
 * Everything tunable comes from beliefConfig — no literals.
 */

import { BELIEF_ADJUDICATOR_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import { BeliefProviderCallError } from './providerError.js';
import {
  buildAdjudicationPromptParts,
  buildVerdictJsonSchema,
  normalizeVerdict,
  RawVerdictSchema,
} from './ollamaAdjudicator.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from './types.js';

const VERDICT_TOOL_NAME = 'record_verdict';

/**
 * OUTPUT-FORMAT forcing for the extended-thinking path. With `thinking` enabled the API
 * FORBIDS a forced tool_choice, so we can't guarantee the structured verdict the way the
 * greedy path does (tool_choice:{type:'tool'}) or ollama does (grammar-constrained format).
 * This system instruction is the parallel structured-output mechanism — it governs OUTPUT
 * FORMAT only (call the tool once, no prose), NOT the adjudication reasoning (that stays in
 * the shared user prompt, so the bake-off variable remains the model, not the prompt).
 * Only sent when thinking is on.
 */
const FORCE_TOOL_SYSTEM =
  'You are a memory-adjudication engine. Reason through the pair in your thinking, then you ' +
  `MUST record your final answer by calling the ${VERDICT_TOOL_NAME} tool exactly once. ` +
  'Do not answer in prose — the tool call is the only accepted output.';

/** System line for the NON-thinking auto path (cfg.anthropicToolChoice='auto'): a model that
 *  rejects a forced tool_choice (Sonnet 5.5) is told to call the tool instead. */
const AUTO_TOOL_SYSTEM =
  `You are a memory-adjudication engine. You MUST record your answer by calling the ${VERDICT_TOOL_NAME} tool ` +
  'exactly once. Do not answer in prose — the tool call is the only accepted output.';

/**
 * The Anthropic cache-breakpoint marker. Placed on the STATIC prompt prefix (rubric + guardrails
 * + worked examples, ~2,500 tokens) and on the static `record_verdict` tool schema, so Anthropic
 * bills those at the reduced cached-READ rate on repeat calls (BL-12). Ephemeral = the default
 * ~5-minute cache TTL; a steady adjudication stream keeps it warm.
 */
const EPHEMERAL_CACHE = { type: 'ephemeral' as const };

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  // Prompt-cache accounting (BL-12): tokens written to the cache on a MISS vs read from it on a
  // HIT. On a warm cache cache_read_input_tokens carries the ~2,500-token static prefix at the
  // reduced rate; these let the live smoke confirm real cache hits.
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: AnthropicUsage;
}

/** Anthropic Messages API adjudication provider (tool-use structured output) — ceiling-check. */
export class AnthropicAdjudicator implements AdjudicationProvider {
  readonly name = 'anthropic';
  readonly model: string;
  /** Per-call token usage from the most recent adjudicate() (BL-10 cost ledger). One entry
   *  (tier='single'); the tiered provider re-tags it tier1/tier2. Reset per call. */
  public lastUsage: AdjudicationCallUsage[] = [];
  private readonly cfg: BeliefAdjudicatorConfig;
  private readonly apiKey: string;

  constructor(cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG) {
    this.cfg = cfg;
    this.model = cfg.model;
    const key = process.env[cfg.apiKeyEnvVar]; // env-read: dynamic(API-key env var NAME is configurable via MANDREL_BELIEF_*_API_KEY_ENV; e.g. ANTHROPIC_API_KEY)
    if (!key) {
      throw new Error(
        `Anthropic adjudicator needs an API key: env var "${cfg.apiKeyEnvVar}" is not set. ` +
          `Export it (or set MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV to the var that holds it).`
      );
    }
    this.apiKey = key;
  }

  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    // Reset usage: a call that throws before completion leaves NO stale usage attributed to it.
    this.lastUsage = [];
    // Split the prompt into its STATIC prefix (cache-eligible) and DYNAMIC per-pair half. The
    // concatenation staticPrefix+dynamic is byte-identical to the single-string prompt the
    // ollama/openai-compat providers send — caching only restructures the request, never the text.
    const { staticPrefix, dynamic } = buildAdjudicationPromptParts(req, this.cfg);
    const cacheOn = this.cfg.promptCache;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    // PROMPT CACHING (BL-12): when on, the static prefix goes in its own leading content block
    // marked cache_control (Anthropic caches everything up to + including it), and the dynamic
    // record content trails in an UNMARKED block (never cached). Their texts concatenate to the
    // exact original prompt. When off, we send the combined string — the pre-BL-12 shape.
    const userContent: unknown = cacheOn
      ? [
          { type: 'text', text: staticPrefix, cache_control: EPHEMERAL_CACHE },
          { type: 'text', text: dynamic },
        ]
      : staticPrefix + dynamic;

    // The record_verdict tool schema is STATIC too — mark it cache-eligible when caching is on.
    const thinkingOn = this.cfg.anthropicThinking;
    // 'auto' (Sonnet 5.5+): no forced tool_choice, so the schema is enforced by STRICT tool use
    // instead (grammar-constrained input; strict requires additionalProperties:false).
    const autoTool = this.cfg.anthropicToolChoice === 'auto';
    const verdictTool: Record<string, unknown> = {
      name: VERDICT_TOOL_NAME,
      description: 'Record the pairwise memory-adjudication verdict for records A and B.',
      input_schema: autoTool
        ? { ...buildVerdictJsonSchema(), additionalProperties: false }
        : buildVerdictJsonSchema(),
    };
    if (autoTool) {
      verdictTool.strict = true;
    }
    if (cacheOn) {
      verdictTool.cache_control = EPHEMERAL_CACHE;
    }

    // Extended-thinking path (ceiling-check): the Messages API requires temperature=1 and a
    // non-forced tool_choice when `thinking` is enabled — the model still emits the
    // record_verdict tool_use after its reasoning block. max_tokens is bumped past the
    // thinking budget so both the reasoning and the tiny verdict fit.
    const forcedTool = !thinkingOn && !autoTool;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: thinkingOn
        ? this.cfg.anthropicThinkingBudgetTokens + this.cfg.maxTokens
        : this.cfg.maxTokens,
      tools: [verdictTool],
      tool_choice: forcedTool ? { type: 'tool', name: VERDICT_TOOL_NAME } : { type: 'auto' },
      messages: [{ role: 'user', content: userContent }],
    };
    if (thinkingOn) {
      body.thinking = { type: 'enabled', budget_tokens: this.cfg.anthropicThinkingBudgetTokens };
      body.system = FORCE_TOOL_SYSTEM;
    } else {
      if (autoTool) body.system = AUTO_TOOL_SYSTEM;
      // e.g. Sonnet 5.5 `between_tools` (its lowest thinking setting; `disabled` is a 400).
      // 'none' is the explicit "omit" (an empty env value falls back to the default, so it
      // cannot clear a non-empty default) — needed to point a between_tools default back at
      // claude-sonnet-5, which 400s on between_tools.
      const tt = this.cfg.anthropicThinkingType;
      if (tt && tt !== 'none') body.thinking = { type: tt };
    }
    // temperature: the current-gen models (Sonnet 5 / Opus 4.8 / 5-family) DEPRECATED this
    // param and 400 if it is present at all; omit it for them (cfg.omitTemperature). Legacy
    // models still take it. Extended thinking, when on, requires temperature=1.
    if (!this.cfg.omitTemperature) {
      body.temperature = thinkingOn ? 1 : this.cfg.temperature;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.cfg.anthropicVersion,
    };
    // Prompt caching is GA (no beta header required); this is an inert escape hatch, sent only
    // if an account/model ever needs a beta opt-in (config-gated, empty default → omitted).
    if (this.cfg.anthropicBeta) {
      headers['anthropic-beta'] = this.cfg.anthropicBeta;
    }

    let json: AnthropicMessagesResponse;
    const startedAt = Date.now();
    try {
      const resp = await fetch(`${this.cfg.apiBaseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        // TYPED — see openaiAdjudicator: status/provider/model become ledger
        // COLUMNS instead of prose the ledger would have to re-parse. Message text unchanged.
        throw new BeliefProviderCallError(
          `anthropic HTTP ${resp.status} for ${this.cfg.model}: ${errBody.slice(0, 200)}`,
          { provider: this.name, model: this.model, httpStatus: resp.status }
        );
      }
      json = (await resp.json()) as AnthropicMessagesResponse;
    } finally {
      clearTimeout(timer);
    }

    const toolUse = (json.content ?? []).find(
      (b) => b.type === 'tool_use' && b.name === VERDICT_TOOL_NAME
    );
    if (!toolUse || toolUse.input === undefined) {
      throw new Error(
        `anthropic returned no ${VERDICT_TOOL_NAME} tool_use block (stop_reason=${json.stop_reason ?? 'unknown'})`
      );
    }
    const latencyMs = Date.now() - startedAt;
    const parsed = RawVerdictSchema.parse(toolUse.input);
    const verdict = normalizeVerdict(parsed);
    const u = json.usage ?? {};
    // BL-10: record this real call's usage (cost ledger). tier='single' — the tiered provider
    // re-tags it tier1/tier2 when it composes this provider.
    this.lastUsage = [
      {
        tier: 'single',
        provider: this.name,
        model: this.model,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      },
    ];
    logger.info(
      `🧪 belief adjudicator (${this.name}/${this.model}${thinkingOn ? '+thinking' : ''}): ` +
        `${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} ⇒ ` +
        `${verdict.verdict}/${verdict.direction}/${verdict.mode} conf=${verdict.confidence.toFixed(2)} | ` +
        `latency_ms=${latencyMs} in_tok=${u.input_tokens ?? '?'} out_tok=${u.output_tokens ?? '?'} ` +
        `think_tok=${u.output_tokens_details?.thinking_tokens ?? 0} ` +
        `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`
    );
    return verdict;
  }
}
