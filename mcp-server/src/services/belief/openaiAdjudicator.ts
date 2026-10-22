/**
 * OPENAI-COMPAT ADJUDICATOR — a CEILING-CHECK Stage-2 provider (belief-eval).
 *
 * Talks the OpenAI Chat Completions wire shape (`POST {endpoint}/v1/chat/completions`) so it
 * can drive ANY OpenAI-compatible server. Its concrete use here is the desktop llama.cpp
 * server running Qwen3.6-35B-A3B on the tailnet (`run-server-eval.sh`, host 192.0.2.10:5005)
 * — a "does a BIG local model clear the case-3 scope wall?" measurement. Local-vs-API stays a
 * config flip (provider factory), never a pipeline rewrite (design ca9a33c0 §3/§9a).
 *
 * It reuses the SAME adjudication prompt + verdict contract + parser as the ollama provider
 * (imported from ollamaAdjudicator) so the only variable across the bake-off is the MODEL, not
 * the prompt — one source, no drift.
 *
 * SERVING HARDENING (survey 13e60f6c): greedy decode (temp 0 + top_k 1) + JSON-mode output.
 * llama.cpp's Chat Completions honours `response_format:{type:"json_object"}` (grammar-forced
 * valid JSON) — the closest equivalent to ollama's grammar-JSON. NOTE: this pins the output to
 * *valid JSON* but does NOT token-pin the verdict ENUMS the way ollama's json-schema `format`
 * does; the zod RawVerdictSchema still rejects an off-vocab verdict downstream. Everything
 * tunable comes from beliefConfig — no literals.
 *
 * HOSTED OpenAI-COMPAT (Groq etc.) — added for the Phase-4 API adjudicator test:
 *  - AUTH: if the env var named by cfg.apiKeyEnvVar holds a key, we send `Authorization: Bearer
 *    <key>`. SECRET DISCIPLINE (same pattern as anthropicAdjudicator): the key is read from env
 *    BY NAME; only the NAME (apiKeyEnvVar) ever lives on the config object (which is snapshotted
 *    into the eval report) — the key VALUE is held in a private field and never logged/serialized.
 *    The header is OMITTED when no key is present, so the local llama.cpp path is unchanged (no
 *    key needed there).
 *  - top_k: NOT part of the OpenAI schema. Strict hosts reject it (Groq: "property 'top_k' is
 *    unsupported"), llama.cpp accepts it as a superset. Sent only when cfg.sendTopK is true.
 *  - reasoning_effort: the OpenAI-wire "thinking mode" for reasoning models (gpt-oss on Groq).
 *    Sent only when cfg.reasoningEffort is non-empty (inert for non-reasoning hosts). The model's
 *    reasoning stream returns in a separate field; the verdict JSON stays clean in `content`.
 */

import { BELIEF_ADJUDICATOR_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import {
  buildAdjudicationPrompt,
  normalizeVerdict,
  extractJson,
  RawVerdictSchema,
} from './ollamaAdjudicator.js';
import { BeliefProviderCallError } from './providerError.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
} from './types.js';

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  // Some hosts (incl. Groq) surface cached prompt tokens here on a cache hit.
  prompt_tokens_details?: { cached_tokens?: number };
}
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: OpenAIUsage;
}

/** OpenAI-compatible (Chat Completions) adjudication provider — ceiling-check bake-off. */
export class OpenAICompatAdjudicator implements AdjudicationProvider {
  readonly name = 'openai-compat';
  readonly model: string;
  /** Per-call token usage from the most recent adjudicate() (BL-10 cost ledger). One entry
   *  (tier='single'); the tiered provider re-tags it tier1/tier2. Reset per call. */
  public lastUsage: AdjudicationCallUsage[] = [];
  private readonly cfg: BeliefAdjudicatorConfig;
  /** Optional bearer key for hosted OpenAI-compat providers (Groq). Read from env BY NAME;
   *  never stored on the snapshot-able config, never logged. Undefined for keyless llama.cpp. */
  private readonly apiKey: string | undefined;

  constructor(cfg: BeliefAdjudicatorConfig = BELIEF_ADJUDICATOR_CONFIG) {
    this.cfg = cfg;
    this.model = cfg.model;
    const key = process.env[cfg.apiKeyEnvVar]; // env-read: dynamic(API-key env var NAME is configurable via MANDREL_BELIEF_*_API_KEY_ENV; e.g. OPENAI_API_KEY)
    this.apiKey = key && key.length > 0 ? key : undefined;
  }

  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    // Reset usage: a call that throws before completion leaves NO stale usage attributed to it.
    this.lastUsage = [];
    const prompt = buildAdjudicationPrompt(req, this.cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let json: OpenAIChatResponse;
    try {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: this.cfg.temperature,
        top_p: this.cfg.topP,
        seed: this.cfg.seed,
        max_tokens: this.cfg.maxTokens,
        stream: false,
      };
      if (this.cfg.sendTopK) {
        // top_k is an OpenAI-superset knob: llama.cpp accepts it (greedy-decode ceiling-check);
        // strict hosts (Groq) reject it — set MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K=false there.
        body.top_k = this.cfg.topK;
      }
      if (this.cfg.reasoningEffort) {
        // "Thinking mode" for reasoning hosts (gpt-oss on Groq). Reasoning returns in a separate
        // field; the verdict JSON stays in `content`. Omitted when empty (inert for llama.cpp).
        body.reasoning_effort = this.cfg.reasoningEffort;
      }
      if (this.cfg.structuredOutput) {
        // Grammar-forced valid JSON (the closest OpenAI-wire equivalent to ollama's json-schema).
        body.response_format = { type: 'json_object' };
      }
      if (this.cfg.chatTemplateKwargs) {
        // Host-template kwargs (llama.cpp): e.g. {"enable_thinking":false} to clamp a Qwen3
        // reasoning model straight to the verdict JSON (thinking hurts this task). Sent only
        // when it parses to a non-empty object; malformed/empty → omitted (Groq unaffected).
        try {
          const parsed = JSON.parse(this.cfg.chatTemplateKwargs) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            body.chat_template_kwargs = parsed;
          }
        } catch {
          logger.warn(
            `🧪 belief adjudicator (openai-compat): ignoring malformed chatTemplateKwargs JSON`
          );
        }
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) {
        // Bearer auth for hosted providers (Groq); the key VALUE never leaves this header.
        headers['authorization'] = `Bearer ${this.apiKey}`;
      }
      const resp = await fetch(`${this.cfg.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        // TYPED: the attempt ledger records provider/model/status as COLUMNS
        // rather than regexing this message. The message text is unchanged.
        throw new BeliefProviderCallError(
          `openai-compat HTTP ${resp.status} for ${this.cfg.model}: ${errBody.slice(0, 200)}`,
          { provider: this.name, model: this.model, httpStatus: resp.status }
        );
      }
      json = (await resp.json()) as OpenAIChatResponse;
    } finally {
      clearTimeout(timer);
    }

    const rawText = json.choices?.[0]?.message?.content ?? '';
    const parsed = RawVerdictSchema.parse(extractJson(rawText));
    const verdict = normalizeVerdict(parsed);
    // BL-10: record this real call's usage (cost ledger). OpenAI-wire usage = prompt/completion
    // tokens; a cache hit (Groq) is reported under prompt_tokens_details.cached_tokens — the
    // cached portion counts as cache-READ, the remainder as fresh input. No cache-WRITE line on
    // this wire (creation stays 0). tier='single'; the tiered provider re-tags it tier1/tier2.
    const u = json.usage ?? {};
    const promptTokens = u.prompt_tokens ?? 0;
    const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
    this.lastUsage = [
      {
        tier: 'single',
        provider: this.name,
        model: this.model,
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        outputTokens: u.completion_tokens ?? 0,
        cacheCreationTokens: 0,
        cacheReadTokens: cachedTokens,
      },
    ];
    logger.info(
      `🧪 belief adjudicator (${this.name}/${this.model}): ${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} ⇒ ` +
        `${verdict.verdict}/${verdict.direction}/${verdict.mode} conf=${verdict.confidence.toFixed(2)}`
    );
    return verdict;
  }
}
