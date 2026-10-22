/**
 * BELIEF LAYER v1 — the config (Phase 4, Increment 1: supersession detection).
 *
 * THE MOAT (belief-layer design ca9a33c0, locked 535d76e0): cosine gives us the
 * RELEVANCE axis; the belief layer adds the TRUTH-NOW axis — it adjudicates whether a
 * relevant record still holds, or has been SUPERSEDED / CONTESTED. "Everyone retrieves;
 * we adjudicate." This module is the SINGLE home for every belief knob.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob the belief machinery touches lives HERE — a named value with a documented
 * default + an env override — never a literal buried in a service. This mirrors
 * trustConfig.ts / embeddingConfig.ts / edgeTypes.ts: the config is the contract, the
 * code reads it. The whole point of the belief layer is that it is TUNABLE (the
 * belief-eval gate can sweep any knob via env with zero code edit).
 *
 * SCOPE — INCREMENT 1 (this build): supersession detection ONLY. Two-stage pairing
 * (gemma-cosine candidate gate → small-LLM adjudicator) mints a `supersedes` edge for
 * high-confidence SUPERSEDES verdicts; every verdict is recorded in belief_adjudications.
 * The `contests` edge type + band flip (Inc-2) and time-bound expiry (Inc-3) are NOT in
 * this module yet — but their knobs are documented as reserved so nobody re-scatters them.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default),
 * exactly like trustConfig.envFloat and embeddingConfig.envStr.
 */

/** True when the env var is present and non-empty (an operator CHOSE this value). */
function envIsSet(...names: string[]): boolean {
  return names.some((n) => {
    const raw = process.env[n]; // env-read: via-callers
    return raw !== undefined && raw !== '';
  });
}

/** Read a finite-number env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read a positive-integer env var (e.g. a top-K), else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a non-empty string env var, else `fallback`. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Read a comma-separated string LIST env var (trimmed, blanks dropped), else `fallback`.
 * A present-but-empty env ('' or all-blanks) yields an EMPTY list — the explicit way to
 * turn a list-valued knob OFF via env (distinct from unset, which uses `fallback`).
 */
function envStrList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read a boolean env var ('1'/'true'/'yes'/'on' ⇒ true, '0'/'false'/'no'/'off' ⇒ false), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/** Read an integer env var that MAY be zero or negative (unlike envInt's positive-only), else `fallback`. */
function envIntAny(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) ? v : fallback;
}

/**
 * The MANDREL_BELIEF_ENABLED default when the operator left it unset AND no adjudicator
 * credential is present. A named constant so the compose/code agreement guard can
 * extract it. Mirrors docker-compose.yml's `MANDREL_BELIEF_ENABLED:-false`.
 */
export const BELIEF_ENABLED_NO_CREDENTIAL_DEFAULT = false;

/** The two credential variables the key-derived supersession mode looks at (names only, ever). */
export const SUPERSESSION_KEY_ENV_VARS = { subq: 'SUBQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } as const;

/** SubQ Snap's own model / host / key variable — the tier-1 default and the single-tier subq default. */
export const BELIEF_SNAP_DEFAULTS = {
  model: 'subq-snap-preview',
  endpoint: 'https://api.subq.ai',
  keyEnvVar: SUPERSESSION_KEY_ENV_VARS.subq,
} as const;

/** The Groq (openai-compat) tier-1 operating point — what tier 1 uses when MANDREL_BELIEF_TIER1_PROVIDER=openai-compat. */
export const BELIEF_GROQ_TIER1_DEFAULTS = {
  model: 'openai/gpt-oss-120b',
  endpoint: 'https://api.groq.com/openai',
  keyEnvVar: 'GROQ_API_KEY',
} as const;

/** Tier 1's provider when MANDREL_BELIEF_TIER1_PROVIDER is unset. */
export const BELIEF_TIER1_DEFAULT_PROVIDER = 'subq';

/** Model / endpoint / key-variable defaults for a tier-1 provider: Snap's own for `subq`, the Groq set for everything else (unchanged). */
function tier1DefaultsFor(provider: string): { model: string; endpoint: string; keyEnvVar: string } {
  return provider === 'subq' ? BELIEF_SNAP_DEFAULTS : BELIEF_GROQ_TIER1_DEFAULTS;
}

/** Single-tier defaults: Snap's own model/host/key when the resolved provider is `subq`; null = keep the generic ones. */
function singleSubqDefaults(provider: string): typeof BELIEF_SNAP_DEFAULTS | null {
  return provider === 'subq' ? BELIEF_SNAP_DEFAULTS : null;
}

/** The mode the adjudicator resolves to: a key-derived one, or whatever provider the operator named. */
export type SupersessionModeName = 'tiered' | 'subq' | 'anthropic' | 'off' | string;

export interface SupersessionModeResolution {
  /** `tiered` / `subq` / `anthropic` / `off` when derived from keys; the explicit provider name otherwise. */
  mode: SupersessionModeName;
  /** The adjudicator provider key this resolves to (`anthropic` when mode is `off`, the historical default). */
  provider: string;
  /** `explicit` = MANDREL_BELIEF_ADJUDICATOR_PROVIDER was set; `keys` = derived from the credentials present. */
  source: 'explicit' | 'keys';
  /** NAMES of the key variables that are set (never their values). */
  keysSeen: string[];
  /** NAMES of the key variables that are not set. */
  keysMissing: string[];
}

/**
 * SUPERSESSION MODE FOLLOWS THE KEYS YOU SET. When the operator did NOT set
 * MANDREL_BELIEF_ADJUDICATOR_PROVIDER:
 *   SUBQ_API_KEY + ANTHROPIC_API_KEY → tiered (tier 1 Snap, tier 2 Sonnet) · SUBQ only → subq
 *   single-tier · ANTHROPIC only → anthropic single-tier · neither → off (a659ffe3).
 * An explicit provider always wins over the keys. Pure: reads only `env`, returns names, never values.
 */
export function resolveSupersessionMode(
  env: Record<string, string | undefined> = process.env // env-read: via-callers
): SupersessionModeResolution {
  const present = (name: string): boolean => {
    const v = env[name];
    return v !== undefined && v !== '';
  };
  const names: string[] = Object.values(SUPERSESSION_KEY_ENV_VARS);
  const keysSeen = names.filter(present);
  const keysMissing = names.filter((n) => !present(n));
  const explicit = env.MANDREL_BELIEF_ADJUDICATOR_PROVIDER;
  if (explicit !== undefined && explicit !== '') {
    return { mode: explicit, provider: explicit, source: 'explicit', keysSeen, keysMissing };
  }
  const hasSubq = present(SUPERSESSION_KEY_ENV_VARS.subq);
  const hasAnthropic = present(SUPERSESSION_KEY_ENV_VARS.anthropic);
  const mode = hasSubq && hasAnthropic ? 'tiered' : hasSubq ? 'subq' : hasAnthropic ? 'anthropic' : 'off';
  return { mode, provider: mode === 'off' ? 'anthropic' : mode, source: 'keys', keysSeen, keysMissing };
}

/** The resolution for this process's environment (module load, like every other belief knob). */
export const SUPERSESSION_MODE: SupersessionModeResolution = resolveSupersessionMode();

/** One startup line: the mode, why, and which key variables were seen — names only, never a value. */
export function describeSupersessionMode(r: SupersessionModeResolution = SUPERSESSION_MODE): string {
  const why =
    r.source === 'explicit'
      ? `MANDREL_BELIEF_ADJUDICATOR_PROVIDER=${r.provider} is set, so it wins over the keys`
      : 'MANDREL_BELIEF_ADJUDICATOR_PROVIDER is unset, so the mode follows the keys';
  const seen = r.keysSeen.length ? r.keysSeen.join(', ') : 'none';
  const missing = r.keysMissing.length ? r.keysMissing.join(', ') : 'none';
  return `🧪 belief supersession mode: ${r.mode} (${why}; key variables seen: ${seen}; not set: ${missing})`;
}

/**
 * Is a credential present for the CONFIGURED adjudicator provider? This is the default for
 * MANDREL_BELIEF_ENABLED when the operator did not set it: supersession turns
 * itself on only when it can actually run. Reads the env directly (function declaration, hoisted)
 * because BELIEF_CONFIG is built before the adjudicator configs. With the provider unset the mode
 * follows the keys (`resolveSupersessionMode`); an explicit `tiered` counts as credentialed when
 * EITHER tier's key is present (a half-credentialed tiered setup is then reported loudly at arm
 * time rather than hidden). Keyless providers (ollama) have no credential to detect, so they never
 * self-enable.
 */
function adjudicatorCredentialPresent(): boolean {
  const has = (keyEnvName: string): boolean => {
    const v = process.env[keyEnvName]; // env-read: dynamic(configured API-key env var NAME)
    return v !== undefined && v !== '';
  };
  const { mode, provider, source } = resolveSupersessionMode();
  if (mode === 'off') return false;
  if (source === 'keys') return true; // the mode was derived FROM a present key
  if (provider === 'tiered') {
    const tier1Provider = process.env.MANDREL_BELIEF_TIER1_PROVIDER || BELIEF_TIER1_DEFAULT_PROVIDER; // env-read: via-callers
    return (
      has(process.env.MANDREL_BELIEF_TIER1_API_KEY_ENV || tier1DefaultsFor(tier1Provider).keyEnvVar) || // env-read: via-callers
      has(process.env.MANDREL_BELIEF_TIER2_API_KEY_ENV || 'ANTHROPIC_API_KEY') // env-read: via-callers
    );
  }
  if (provider === 'ollama') return false;
  return has(
    process.env.MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV || // env-read: via-callers
      singleSubqDefaults(provider)?.keyEnvVar ||
      'ANTHROPIC_API_KEY'
  );
}

/**
 * THE BELIEF KNOBS (design ca9a33c0 §3, locked defaults per 535d76e0).
 *
 * Two-stage detection: Stage-1 (cosine) NOMINATES candidate pairs cheaply; Stage-2 (the
 * adjudicator LLM) is the only thing that ADJUDICATES. Cosine never decides a verdict
 * (the relevance-vs-truth axiom) — it only gates which pairs are worth an adjudication.
 *
 * Each field is env-overridable so the belief-eval gate can sweep the model without a
 * code edit.
 */
export interface BeliefConfig {
  /**
   * pair_min_cosine — Stage-1 candidate gate. A neighbour must have at least this cosine
   * similarity to the record being adjudicated to be NOMINATED as a candidate pair. Below
   * it the pair is not even sent to the adjudicator (noise floor). Tuned to gemma geometry
   * (embeddingConfig similarityThresholds: gemma floor 0.35 / strong 0.55). The design's
   * provisional 0.75 was a MiniLM-era guess and nominated NOTHING under gemma. RAISED from
   * 0.40 → 0.60 (measured 2026-07-06 on the decision-run 137c26bf oracle-labelled sample):
   * the LOWEST true supersession sat at cos 0.614, while EVERY nominated pair below 0.60 was
   * `unrelated` junk (a floor of 0.40 dragged in 113 sub-0.60 pairs, all noise). 0.60 sits
   * just under the weakest observed true pair — it clears the low-cosine noise while keeping
   * all 41 oracle-labelled true supersessions in-net. Env: MANDREL_BELIEF_PAIR_MIN_COSINE.
   * Default 0.60.
   */
  pairMinCosine: number;
  /**
   * pair_max_cosine — Stage-1 candidate CEILING (picker anti-junk, measured 2026-07-06 on
   * the decision-run 137c26bf sample). A neighbour whose cosine is ABOVE this is dropped
   * from nomination: near-identical pairs (~0.95+) are DUPLICATE RESTATEMENTS of the same
   * record (a handoff re-stored, a decision re-affirmed), not "this replaced that". In the
   * oracle-labelled sample EVERY pair ≥0.95 was `restates` (n=5, cos 0.988–0.999) while the
   * strongest TRUE supersession sat at 0.938 — so 0.95 drops the restatement cluster with a
   * safety margin above the highest observed real supersede. These duplicates are the
   * over-eager judge's #1 false-supersede source. Set to 1.0 to disable the ceiling. Env:
   * MANDREL_BELIEF_PAIR_MAX_COSINE. Default 0.95.
   */
  pairMaxCosine: number;
  /**
   * pair_exclude_auto_record_kinds — Stage-1 auto-record EXCLUSION (picker anti-junk,
   * measured 2026-07-06). Periodic machine-written records (the control-plane tick-proposal
   * log, dispatch-proof stamps) are near-identical to each other run-to-run and dominated
   * the 6011-pair nomination (947 pairs had an auto-record endpoint; 892 were auto↔auto —
   * the 0.99-cosine restatement cluster the judge false-fired supersedes on). They carry a
   * RELIABLE STRUCTURED marker: `metadata->>'kind'`. Any record whose kind is in this list
   * is excluded from nomination as EITHER endpoint (source or neighbour). Grounded in what
   * the records actually carry (not a fragile content match); confirmed to drop 0 of the 41
   * oracle-labelled true supersessions. Empty list disables. Env (comma-separated):
   * MANDREL_BELIEF_PAIR_EXCLUDE_AUTO_RECORD_KINDS.
   * Default ['tick-proposal','dispatch-proof','pick-log','gate-log'].
   *
   * `pick-log` + `gate-log` were ADDED 2026-07-07 (belief pre-prod dry-run):
   * the control-plane tick writes periodic MACHINE-WRITTEN judgment decisions that are
   * near-identical run-to-run and are NEVER belief atoms — the scoper's "Picked by priority;
   * N ready…" judgment:scope snapshots (pick-log) and the risk classifier's "CN1 (customer
   * blast radius) tripped by…" / "cannot positively classify…" judgment:risk gate rationales
   * (gate-log). On the real corpus these two were the dominant false-supersede source: the
   * pick-logs were ~18% of the original 1111 mints, and after fixing them the gate-logs were
   * the single biggest remaining FP class (~10%). NOTE (2026-07-07): the durable write-site
   * kind-stamp for these (in the riverbend control-plane record writer) is PREPARED but
   * HELD as /tmp/belief-writesite-fix.patch — NOT applied (it edits a LIVE hourly cron;
   * awaits the operator). Until that patch lands, NO record carries `pick-log`/`gate-log`, so these
   * two entries are inert placeholders and `pairExcludeContentPrefixes` below is the CURRENT
   * defense for the whole untagged tick-auto-record class. Apply the patch to
   * make the structured marker live.
   */
  pairExcludeAutoRecordKinds: string[];
  /**
   * pair_exclude_content_prefixes — Stage-1 auto-record exclusion by CONTENT PREFIX (picker
   * anti-junk). The structured-`kind` exclusion above only catches records
   * that CARRY a kind; HISTORICAL machine-written records written before the write-site fix
   * have NO kind (e.g. the pre-existing "Picked by …" scoper snapshots + "CN1 (…) tripped
   * by…" gate rationales in the riverbend corpus, all kind=null). A record whose content
   * STARTS WITH any prefix in this list (case-insensitive, `ILIKE prefix||'%'`) is excluded
   * from nomination as EITHER endpoint — the belt-and-braces complement to the kind marker
   * that also protects legacy untagged auto-records without a data migration.
   *
   * GROUNDED on the real corpus: the "Picked by "/CNx/classify prefixes match
   * exactly the 199 machine-written tick judgments (all `decision`-type, kind=null, short) and
   * ZERO real belief atoms — a prefix (not a substring), so a record that merely MENTIONS
   * "Picked by priority" or "CN1" mid-body is NOT excluded. "Picked by " (trailing space)
   * covers all scoper reasons (priority / next-tag / auto-buildable); the CNx + classify
   * phrases are the risk classifier's verdict rationales; the last entry is the COMPANY MAP
   * registry snapshot (a separate machine-written class). Until the write-site kind-stamp
   * patch is applied, THIS LIST IS THE ONGOING SOLE DEFENSE for untagged tick records (not a
   * one-time backfill) — if the scoper/risk/registry wording changes, update it. Prefixes must
   * not contain SQL LIKE metachars (`%`/`_`); none currently do. Empty list disables. Env
   * (comma-separated): MANDREL_BELIEF_PAIR_EXCLUDE_CONTENT_PREFIXES.
   */
  pairExcludeContentPrefixes: string[];
  /**
   * pair_top_k — Stage-1 fan-out. At most this many top-cosine same-project neighbours are
   * nominated per record (keeps the adjudicator load bounded; embedder stays priority).
   * Env: MANDREL_BELIEF_PAIR_TOP_K. Default 8 (design §3).
   */
  pairTopK: number;
  /**
   * contest_min_confidence — the precision floor for a CONTESTS verdict (RESERVED for
   * Increment 2, when the `contests` edge is added). Documented here now so the knob is
   * single-sourced from day one and Inc-2 doesn't scatter a new literal. NOT consumed by
   * Increment-1 code (no contests edge is minted yet). Env:
   * MANDREL_BELIEF_CONTEST_MIN_CONFIDENCE. Default 0.5 (design §3).
   */
  contestMinConfidence: number;
  /**
   * adjudicator_concurrency — how many adjudications run at once. LOCKED at 1 (design §4 +
   * capacity recon 94b38d57): the adjudicator shares the Ollama daemon + CPUs with the LIVE
   * embedder, so it runs SERIAL, off any write critical path, embedder-priority. Raising
   * this contends with customer write embeddings — do not, without a dedicated box. Env:
   * MANDREL_BELIEF_ADJUDICATOR_CONCURRENCY. Default 1.
   */
  adjudicatorConcurrency: number;
  /**
   * belief_enabled — THE MASTER FEATURE FLAG for the live post-store belief hook (BL-9).
   * When true, a committed context_store / decision_record fires adjudicateNeighbourhood in
   * the background (non-blocking, fail-safe, serial). When false, the hook is a total no-op:
   * NO adjudication is enqueued, NO provider call is made, NO cost is incurred. DEFAULT TRUE
   * (the operator's call: on for all instances while users are few; the free tier flips it off per
   * the pricing model). Env-overridable so ANY instance can disable it without a code change —
   * `MANDREL_BELIEF_ENABLED=false` fully disarms the belief layer on that instance. This is a
   * KILL SWITCH: it gates the ONLY live caller of the adjudicator, so flipping it off returns
   * the write path to its exact pre-BL-9 behaviour. Env: MANDREL_BELIEF_ENABLED.
   * DEFAULT WHEN UNSET: ON only if the configured provider's credential is
   * present in the environment (see `adjudicatorCredentialPresent`); otherwise quietly OFF — a
   * fresh install with no key must not log an ERROR. An EXPLICIT true/false is always honoured
   * (explicit true with no credential keeps the single DISARMED error).
   */
  beliefEnabled: boolean;
  /** True when MANDREL_BELIEF_ENABLED was set by the operator (vs. the credential-derived default). */
  beliefEnabledExplicit: boolean;
  /**
   * belief_queue_max_depth — the bounded depth of the in-process background belief queue
   * (BL-9). The post-store hook enqueues onto a single-flight worker that drains SERIALLY
   * (concurrency=1). If a WRITE BURST outpaces the (slow, LLM-bound) adjudicator, the queue
   * is capped at this depth and further enqueues are DROPPED WITH A LOG rather than growing
   * unbounded and risking OOM — belief work is best-effort + forward-only, so shedding load
   * under a flood is the safe failure mode (a dropped adjudication just means that one new
   * record isn't adjudicated; the store already succeeded). Tunable so a bigger box can buffer
   * more. Env: MANDREL_BELIEF_QUEUE_MAX_DEPTH. Default 1000.
   */
  beliefQueueMaxDepth: number;
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are the design/lock values; every
 * one is env-overridable for the belief-eval sweep.
 */
export const BELIEF_CONFIG: BeliefConfig = {
  pairMinCosine: envFloat('MANDREL_BELIEF_PAIR_MIN_COSINE', 0.6),
  pairMaxCosine: envFloat('MANDREL_BELIEF_PAIR_MAX_COSINE', 0.95),
  pairExcludeAutoRecordKinds: envStrList('MANDREL_BELIEF_PAIR_EXCLUDE_AUTO_RECORD_KINDS', [
    'tick-proposal',
    'dispatch-proof',
    'pick-log',
    'gate-log',
  ]),
  pairExcludeContentPrefixes: envStrList('MANDREL_BELIEF_PAIR_EXCLUDE_CONTENT_PREFIXES', [
    // Scoper pick-logs (all reasons: priority / next-tag / auto-buildable).
    'Picked by ',
    // Risk-classifier gate rationales (the CNx control-node trips + the classify verdicts).
    'CN1 (customer blast radius) tripped by',
    'CN2 (irreversible on prod / personal data) tripped by',
    'CN3 (leaves the box to the world) tripped by',
    'CN4 (money & commitments) tripped by',
    'cannot positively classify as clean-internal-eng',
    'positively safe-internal-eng (owner',
  ]),
  pairTopK: envInt('MANDREL_BELIEF_PAIR_TOP_K', 8),
  contestMinConfidence: envFloat('MANDREL_BELIEF_CONTEST_MIN_CONFIDENCE', 0.5),
  adjudicatorConcurrency: envInt('MANDREL_BELIEF_ADJUDICATOR_CONCURRENCY', 1),
  beliefEnabled: envBool('MANDREL_BELIEF_ENABLED', adjudicatorCredentialPresent() || BELIEF_ENABLED_NO_CREDENTIAL_DEFAULT),
  beliefEnabledExplicit: envIsSet('MANDREL_BELIEF_ENABLED'),
  beliefQueueMaxDepth: envInt('MANDREL_BELIEF_QUEUE_MAX_DEPTH', 1000),
};

/**
 * THE ADJUDICATOR PROVIDER config (design §3/§9a — provider interface like the embedder).
 * The Stage-2 adjudicator is a small generative-instruct LLM behind a provider interface
 * so local-vs-API is a config flip + a bake-off decision, not a code rewrite.
 *
 * DEFAULTS PINNED (two-tier v1): the shipped default is the EVALUATED
 * operating point — provider `anthropic`, model `claude-sonnet-5`, omitTemperature true (the
 * 5-family deprecated the temperature param). This replaces the earlier `ollama`/`qwen2.5:1.5b`
 * default, which NO validation run actually used. Every value stays env-overridable, so the
 * ollama / openai-compat (groq, llama.cpp) providers still work by env with zero code change.
 */
export interface BeliefAdjudicatorConfig {
  /** Provider key selecting the AdjudicationProvider impl. Env: MANDREL_BELIEF_ADJUDICATOR_PROVIDER. Unset ⇒ follows the keys set (resolveSupersessionMode): tiered / subq / anthropic, or off with neither. */
  provider: string;
  /** Model id passed to the provider. Env: MANDREL_BELIEF_ADJUDICATOR_MODEL. Default 'claude-sonnet-5' (pinned; was 'qwen2.5:1.5b'). */
  model: string;
  /** Ollama daemon endpoint for the ollama provider. Env: MANDREL_BELIEF_ADJUDICATOR_ENDPOINT. Default local. */
  endpoint: string;
  /**
   * temperature — sampling temperature for the verdict. 0 = deterministic (we want a stable,
   * reproducible verdict, not creativity). Env: MANDREL_BELIEF_ADJUDICATOR_TEMPERATURE. Default 0.
   */
  temperature: number;
  /**
   * SERVING HARDENING (survey 13e60f6c cross-cutting finding): our #1 pain — a verdict that
   * FLIPS when the prompt is nudged — is partly a SERVING-CONFIG bug, not model capacity. The
   * fix (independent of model choice) is greedy decode + grammar-constrained JSON + no
   * thinking-mode CoT for the verdict. These four knobs bake that in, config-driven.
   *
   * top_k — sampling window. 1 = pure GREEDY decode (only the single most-likely token, sampling
   * effectively OFF) → the deterministic complement of temperature=0. Env:
   * MANDREL_BELIEF_ADJUDICATOR_TOP_K. Default 1.
   */
  topK: number;
  /**
   * send_top_k — whether the openai-compat provider includes `top_k` in the request body.
   * `top_k` is NOT part of the OpenAI Chat Completions schema; llama.cpp accepts it as a
   * superset (needed for the local greedy-decode ceiling-check), but strict OpenAI-compatible
   * hosts REJECT it — Groq returns `property 'top_k' is unsupported` (measured 2026-07-06). So
   * this is a config flip: TRUE for llama.cpp (preserves the ceiling-check greedy decode),
   * FALSE for Groq/OpenAI hosts. Ollama + anthropic providers ignore it. Env:
   * MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K. Default true (non-breaking for the llama.cpp path).
   */
  sendTopK: boolean;
  /**
   * top_p — nucleus sampling mass. With top_k=1 + temp=0 this is inert, but pinned low for
   * belt-and-braces determinism across engine versions. Env:
   * MANDREL_BELIEF_ADJUDICATOR_TOP_P. Default 1.
   */
  topP: number;
  /**
   * reasoning_effort — the OpenAI-wire "thinking mode" depth for reasoning models served over
   * the Chat Completions API (Groq gpt-oss: 'low' | 'medium' | 'high'). Only sent by the
   * openai-compat provider and ONLY when non-empty, so it's inert for llama.cpp / non-reasoning
   * hosts (empty default → param omitted). The research's two-body wall needs the model in
   * thinking mode; 'high' gives the deepest scope reasoning. The model's reasoning stream is
   * returned in a separate `reasoning` field — the verdict JSON stays clean in `content`. Env:
   * MANDREL_BELIEF_ADJUDICATOR_REASONING_EFFORT. Default '' (omitted).
   */
  reasoningEffort: string;
  /**
   * seed — fixed RNG seed so any residual sampling is reproducible run-to-run (a second
   * determinism guard alongside greedy decode). Env: MANDREL_BELIEF_ADJUDICATOR_SEED. Default 0.
   */
  seed: number;
  /**
   * chat_template_kwargs — a JSON object (as a string) forwarded to the openai-compat host's
   * `chat_template_kwargs` request field. Its concrete use: DISABLE thinking on a Qwen3-family
   * reasoning model served by llama.cpp — `{"enable_thinking":false}` — so the model emits the
   * verdict JSON directly instead of burning the completion budget on a `<think>` stream (the
   * measured "thinking hurts this task" finding, bdb46616). Only sent by the openai-compat
   * provider and ONLY when it parses to a non-empty object (empty default → field omitted, so
   * Groq / other hosts are unaffected). Env: MANDREL_BELIEF_ADJUDICATOR_CHAT_TEMPLATE_KWARGS.
   * Default '' (omitted).
   */
  chatTemplateKwargs: string;
  /**
   * structured_output — when true, the ollama `format` param is set to the VERDICT JSON SCHEMA
   * (grammar-constrained decoding: output is pinned to our schema at the token level, killing
   * the malformed-JSON + validate-retry loop). When false, falls back to plain `format:"json"`
   * (free-form JSON mode). The schema is DERIVED from the verdict vocab constants
   * (BELIEF_VERDICTS/DIRECTIONS/MODES) so it can never drift from the zod validator. Env:
   * MANDREL_BELIEF_ADJUDICATOR_STRUCTURED_OUTPUT. Default true.
   */
  structuredOutput: boolean;
  /**
   * think — whether to allow the model's thinking-mode / chain-of-thought stream. FALSE clamps a
   * reasoning/hybrid-thinking model (qwen3.x, phi-4-reasoning, granite hybrids) straight to the
   * structured verdict — no long CoT to parse or truncate, and less nondeterminism. Passed as the
   * top-level ollama `think` flag; harmless on non-thinking models. Env:
   * MANDREL_BELIEF_ADJUDICATOR_THINK. Default false.
   */
  think: boolean;
  /**
   * timeout_ms — per-adjudication hard cap. A verdict is ~3s warm; if the daemon is cold or
   * contended it can take longer, but we must not hang a queue. Env:
   * MANDREL_BELIEF_ADJUDICATOR_TIMEOUT_MS. Default 60000.
   */
  timeoutMs: number;
  /**
   * keep_alive — how long Ollama keeps the model resident between calls (warm = ~3s vs
   * ~13s cold). Long enough to serve a backfill batch without pinning RAM forever. Env:
   * MANDREL_BELIEF_ADJUDICATOR_KEEP_ALIVE. Default '10m'.
   */
  keepAlive: string;
  /**
   * max_content_chars — each record's content is truncated to this before going into the
   * prompt (bounds the token cost + keeps the small model on-task). Env:
   * MANDREL_BELIEF_ADJUDICATOR_MAX_CONTENT_CHARS. Default 1600.
   */
  maxContentChars: number;
  /**
   * max_tokens — completion cap for the API/chat-completions providers (openai-compat,
   * anthropic). The verdict JSON is tiny; a modest cap keeps latency + spend bounded. Unused
   * by the ollama provider. Env: MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS. Default 1024.
   */
  maxTokens: number;
  /**
   * api_base_url — base URL for the anthropic provider's Messages API. Env:
   * MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL. Default 'https://api.anthropic.com'. (The
   * openai-compat provider uses `endpoint` above, e.g. the desktop llama.cpp server.)
   */
  apiBaseUrl: string;
  /**
   * api_key_env — the NAME of the env var holding the anthropic API key. Only the NAME lives
   * on the config (safe to snapshot into the eval report); the KEY VALUE is read from env by
   * the provider and never stored or logged. Env: MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV.
   * Default 'ANTHROPIC_API_KEY'.
   */
  apiKeyEnvVar: string;
  /**
   * anthropic_version — the `anthropic-version` header the Messages API requires. Env:
   * MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_VERSION. Default '2023-06-01'.
   */
  anthropicVersion: string;
  /**
   * anthropic_thinking — enable Anthropic EXTENDED THINKING for the anthropic provider's
   * adjudication call (the ceiling-check "does frontier reasoning clear the case-3 scope
   * wall / the case-4 buried supersession?" measurement). When true the provider sends a
   * `thinking` block, and because the Messages API requires it, ALSO forces temperature=1
   * and tool_choice:auto (a FORCED tool_choice is incompatible with thinking — the model
   * still emits the record_verdict tool_use after its reasoning block). When false the
   * provider keeps the deterministic greedy path (temp=cfg.temperature, forced tool_choice).
   * Env: MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING. Default false.
   */
  anthropicThinking: boolean;
  /**
   * anthropic_thinking_budget_tokens — the extended-thinking token budget (API minimum
   * 1024). When thinking is on, the request's max_tokens is sent as (this + maxTokens) so
   * that max_tokens > budget_tokens ALWAYS holds (an API requirement) and the tiny verdict
   * tool_use still fits after the reasoning. Default 3072 is MEASURED (belief-eval, Haiku
   * 4.5, 2026-07-06): the hardest cases reason deeply (case-3 scope wall used ~1507 thinking
   * tokens, case-6 restatement ~1640); a 1024 budget TRUNCATED the verdict on those (the
   * tool_use JSON came back partial → Zod parse error). 3072 gives ~1.9x headroom over the
   * measured worst case so the verdict always completes. Env:
   * MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_BUDGET. Default 3072.
   */
  anthropicThinkingBudgetTokens: number;
  /**
   * anthropic_tool_choice — how the anthropic provider gets its structured verdict. 'tool'
   * FORCES the record_verdict tool (tool_choice:{type:'tool'}) — the greedy path every model up
   * to Sonnet 5 uses. 'auto' sends tool_choice:{type:'auto'} with a STRICT (grammar-constrained)
   * record_verdict tool and a one-line system instruction to call it: claude-sonnet-5-5 rejects a
   * forced tool_choice with HTTP 400 ("tool_choice: type \"tool\" and \"any\" are not supported
   * for this model"; platform.claude.com Sonnet 5.5 "what's new", read 2026-10-12, which names
   * auto + strict tool use as the replacement). Extended thinking (anthropicThinking) always uses
   * auto regardless. Env: MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_TOOL_CHOICE. Default 'tool'.
   */
  anthropicToolChoice: string;
  /**
   * anthropic_thinking_type — when non-empty (and anthropicThinking is false), sent as
   * `thinking:{type:<value>}`. Sonnet 5.5 runs ADAPTIVE thinking unless told otherwise, and
   * rejects `disabled`; `between_tools` is its lowest setting (no up-front thinking), which is
   * the closest match to the no-thinking path the adjudicator was evaluated on. '' or 'none' →
   * the field is omitted (every earlier model; claude-sonnet-5 returns HTTP 400 on
   * between_tools, measured 2026-10-12). Use 'none' to clear a non-empty default by env (an
   * empty env value falls back to the default). Env:
   * MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_TYPE. Default ''.
   */
  anthropicThinkingType: string;
  /**
   * prompt_cache — enable Anthropic PROMPT CACHING for the anthropic provider (BL-12).
   * When true, the STATIC prompt prefix (rubric + guardrails + worked examples,
   * ~2,500 tokens, byte-identical every call) is sent as a `cache_control:{type:'ephemeral'}`
   * content block, and the `record_verdict` tool schema (also static) is likewise marked
   * cache-eligible — so on repeat adjudications Anthropic bills that prefix at the reduced
   * cached-READ rate (~0.1x input) instead of full input rate. The DYNAMIC per-pair record
   * content is in a trailing block WITHOUT cache_control (never cached). This is a PURE COST
   * WIN: the model sees byte-identical text either way, so the verdict is unchanged. When
   * false, no cache_control is sent (the pre-BL-12 request shape). The ollama / openai-compat
   * providers do not use Anthropic caching and ignore this knob. Requires ≥1024 cached tokens
   * to actually cache (Sonnet minimum) — the ~2,500-token prefix clears it. Env:
   * MANDREL_BELIEF_ADJUDICATOR_PROMPT_CACHE. Default true.
   */
  promptCache: boolean;
  /**
   * anthropic_beta — an optional `anthropic-beta` header value for the anthropic provider.
   * Prompt caching is GA (no beta header needed) so this is EMPTY by default and NOT sent; it
   * is config-gated purely as an escape hatch if a specific account/model ever requires a beta
   * opt-in (then set it via env). Sent only when non-empty. Env:
   * MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_BETA. Default '' (omitted).
   */
  anthropicBeta: string;
  /**
   * omit_temperature — when true, the anthropic provider does NOT send a `temperature` field
   * at all. The current-generation models (Sonnet 5, Opus 4.8, the whole 5-family) DEPRECATED
   * the `temperature` param and return HTTP 400 `temperature is deprecated for this model` if
   * it is present — even temperature:0. Older models still accept it. So this is a config flip:
   * TRUE for 5-family / Opus-4.x adjudicators, FALSE for legacy models (set it via env when
   * pointing the adjudicator at an older model). Determinism on the new models is the API
   * default (no sampling knob exposed). Default PINNED true to match the pinned Sonnet-5
   * adjudicator (two-tier v1). Env:
   * MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE. Default true (was false).
   */
  omitTemperature: boolean;
  /**
   * Which credential-routing settings an operator set EXPLICITLY (env present) rather than
   * inherited from a shared default. Read ONLY by the provider credential-pairing check
   * (services/belief/providerCredentialPairing.ts). Absent ⇒ nothing was explicit (strict).
   */
  explicit?: BeliefExplicitCredentialSettings;
}

/** Which of a provider's credential-routing settings were chosen explicitly (see above). */
export interface BeliefExplicitCredentialSettings {
  /** The `endpoint` (ollama / openai-compat / subq) was set by env. */
  endpoint: boolean;
  /** The `apiBaseUrl` (anthropic) was set by env. */
  apiBaseUrl: boolean;
  /** The `apiKeyEnvVar` name was set by env. */
  apiKeyEnvVar: boolean;
}

/**
 * EACH PROVIDER'S OWN CREDENTIAL DEFAULTS — the only (endpoint, key-env) pair a provider may run
 * on WITHOUT the operator setting it. Anything else must be explicit, so one provider's key is
 * never sent to another provider's host by falling through a shared default.
 * `endpointField` names which config field carries that provider's host; `keyEnvVar` null means
 * the provider sends no API key (ollama), so the key-env is not checked.
 */
export interface BeliefProviderCredentialDefaults {
  endpointField: 'endpoint' | 'apiBaseUrl';
  endpoint: string;
  keyEnvVar: string | null;
}

export const BELIEF_PROVIDER_CREDENTIAL_DEFAULTS: Record<string, BeliefProviderCredentialDefaults> = {
  anthropic: { endpointField: 'apiBaseUrl', endpoint: 'https://api.anthropic.com', keyEnvVar: 'ANTHROPIC_API_KEY' },
  'openai-compat': { endpointField: 'endpoint', endpoint: 'https://api.groq.com/openai', keyEnvVar: 'GROQ_API_KEY' },
  subq: { endpointField: 'endpoint', endpoint: BELIEF_SNAP_DEFAULTS.endpoint, keyEnvVar: BELIEF_SNAP_DEFAULTS.keyEnvVar },
  ollama: { endpointField: 'endpoint', endpoint: 'http://127.0.0.1:11434', keyEnvVar: null },
};

export const BELIEF_ADJUDICATOR_CONFIG: BeliefAdjudicatorConfig = {
  provider: envStr('MANDREL_BELIEF_ADJUDICATOR_PROVIDER', SUPERSESSION_MODE.provider),
  model: envStr('MANDREL_BELIEF_ADJUDICATOR_MODEL', singleSubqDefaults(SUPERSESSION_MODE.provider)?.model ?? 'claude-sonnet-5'),
  endpoint: envStr(
    'MANDREL_BELIEF_ADJUDICATOR_ENDPOINT',
    singleSubqDefaults(SUPERSESSION_MODE.provider)?.endpoint ?? 'http://127.0.0.1:11434'
  ),
  temperature: envFloat('MANDREL_BELIEF_ADJUDICATOR_TEMPERATURE', 0),
  omitTemperature: envBool('MANDREL_BELIEF_ADJUDICATOR_OMIT_TEMPERATURE', true),
  topK: envInt('MANDREL_BELIEF_ADJUDICATOR_TOP_K', 1),
  sendTopK: envBool('MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K', true),
  topP: envFloat('MANDREL_BELIEF_ADJUDICATOR_TOP_P', 1),
  reasoningEffort: envStr('MANDREL_BELIEF_ADJUDICATOR_REASONING_EFFORT', ''),
  seed: envIntAny('MANDREL_BELIEF_ADJUDICATOR_SEED', 0),
  chatTemplateKwargs: envStr('MANDREL_BELIEF_ADJUDICATOR_CHAT_TEMPLATE_KWARGS', ''),
  structuredOutput: envBool('MANDREL_BELIEF_ADJUDICATOR_STRUCTURED_OUTPUT', true),
  think: envBool('MANDREL_BELIEF_ADJUDICATOR_THINK', false),
  timeoutMs: envInt('MANDREL_BELIEF_ADJUDICATOR_TIMEOUT_MS', 60000),
  keepAlive: envStr('MANDREL_BELIEF_ADJUDICATOR_KEEP_ALIVE', '10m'),
  maxContentChars: envInt('MANDREL_BELIEF_ADJUDICATOR_MAX_CONTENT_CHARS', 1600),
  maxTokens: envInt('MANDREL_BELIEF_ADJUDICATOR_MAX_TOKENS', 1024),
  apiBaseUrl: envStr('MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL', 'https://api.anthropic.com'),
  apiKeyEnvVar: envStr(
    'MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV',
    singleSubqDefaults(SUPERSESSION_MODE.provider)?.keyEnvVar ?? 'ANTHROPIC_API_KEY'
  ),
  anthropicVersion: envStr('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_VERSION', '2023-06-01'),
  anthropicThinking: envBool('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING', false),
  anthropicThinkingBudgetTokens: envInt('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_BUDGET', 3072),
  anthropicToolChoice: envStr('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_TOOL_CHOICE', 'tool'),
  anthropicThinkingType: envStr('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_THINKING_TYPE', ''),
  promptCache: envBool('MANDREL_BELIEF_ADJUDICATOR_PROMPT_CACHE', true),
  anthropicBeta: envStr('MANDREL_BELIEF_ADJUDICATOR_ANTHROPIC_BETA', ''),
  explicit: {
    endpoint: envIsSet('MANDREL_BELIEF_ADJUDICATOR_ENDPOINT'),
    apiBaseUrl: envIsSet('MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL'),
    apiKeyEnvVar: envIsSet('MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV'),
  },
};

/**
 * THE TIERED-ADJUDICATION config (BL-11) — Groq tier-1 prescreen → Sonnet
 * tier-2 confirm. The `tiered` provider (provider.ts factory) adjudicates EVERY candidate
 * pair with a CHEAP tier-1 model (Groq gpt-oss-120b) and only ESCALATES to the authoritative
 * tier-2 model (Sonnet 5) when tier-1 returns a verdict in `escalateVerdicts` — the
 * edge-producing family. Non-escalated verdicts (unrelated/restates — no edge would be minted
 * anyway) trust tier-1's cheap verdict directly. Goal: ~70% adjudicator cost cut by only
 * spending Sonnet on the ~edge-producing minority.
 *
 * WHY here (single-source discipline): the escalation set + BOTH tier provider/model configs
 * are TUNABLE KNOBS, so they live in this config — never a literal in the provider. Each tier
 * is a FULL BeliefAdjudicatorConfig (spread from BELIEF_ADJUDICATOR_CONFIG, tier-specific
 * fields overridden) so it plugs straight into the existing single-provider factory — the
 * tiered provider COMPOSES the existing openai-compat (Groq) + anthropic (Sonnet) providers,
 * it does not reimplement them. Single-provider modes (anthropic / openai-compat / ollama)
 * stay fully working: a config flip of MANDREL_BELIEF_ADJUDICATOR_PROVIDER back to one of them
 * bypasses this entirely (A/B or fallback).
 *
 * ⚠️ RECALL TRADEOFF (flagged, deliberately NOT solved here): escalating ONLY on tier-1's
 * supersede-family means a tier-1 FALSE-NEGATIVE — Groq wrongly saying `unrelated`/`restates`
 * on a pair that is REALLY a supersession/contest — is NOT recovered by Sonnet (Sonnet is
 * never called for it). That is the recall cost of a cheap prescreen. It is made TUNABLE +
 * MEASURABLE, not hidden: widen `escalateVerdicts` (e.g. add 'restates', or all four to make
 * tiered a pure double-check) via MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS and re-run the
 * belief-eval gold gate to measure recall-vs-cost. At the extreme (all 4 verdicts) tier-2 sees
 * every pair → zero prescreen recall loss but zero cost saving. The coordinator tunes the operating point.
 *
 * COST ATTRIBUTION for BL-10 (the $ rollup, not built here): the tiered provider records the
 * AUTHORITATIVE tier's provider+model on each belief_adjudications row (getters on the provider
 * — Groq for non-escalated rows, Sonnet for escalated rows). BL-10 reads
 * belief_adjudications.provider/model for the authoritative-tier cost, and knows that tier-1
 * (Groq) ran on EVERY pair (total row count) while tier-2 (Sonnet) ran only on the escalated
 * subset (rows whose provider/model == tier2's) — so both tiers' call counts are recoverable
 * from the rows + this config. The tiered provider also exposes `lastRouting` + `tiers` in-process.
 */
export interface BeliefTieredConfig {
  /**
   * escalate_verdicts — the tier-1 verdict set that ESCALATES to tier-2. Default
   * ['supersedes','contests'] (the edge-producing family). A raw string list here; the tiered
   * provider validates it against the BELIEF_VERDICTS vocab (unknown tokens dropped — the vocab
   * const lives in services/belief/types to keep this config layer free of a services import).
   * A present-but-empty env ('' — envStrList semantics) means NEVER escalate (pure tier-1). Env
   * (comma-separated): MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS.
   */
  escalateVerdicts: string[];
  /** Tier-1 (cheap prescreen — SubQ Snap by default) full adjudicator config. Env prefix MANDREL_BELIEF_TIER1_*. */
  tier1: BeliefAdjudicatorConfig;
  /** Tier-2 (authoritative confirm — Sonnet) full adjudicator config. Env prefix MANDREL_BELIEF_TIER2_*. */
  tier2: BeliefAdjudicatorConfig;
}

const TIER1_PROVIDER = envStr('MANDREL_BELIEF_TIER1_PROVIDER', BELIEF_TIER1_DEFAULT_PROVIDER);

export const BELIEF_TIERED_CONFIG: BeliefTieredConfig = {
  escalateVerdicts: envStrList('MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS', ['supersedes', 'contests']),
  // TIER 1 — SubQ Snap: provider subq, model subq-snap-preview, the SubQ API
  // host, key from SUBQ_API_KEY (by name; never stored). Every MANDREL_BELIEF_TIER1_* override still
  // wins; naming MANDREL_BELIEF_TIER1_PROVIDER=openai-compat (or ollama) brings back the Groq
  // operating point (gpt-oss-120b, GROQ_API_KEY — Groq rejects top_k, accepts temperature), so those
  // keep working exactly as before when set explicitly. Shared determinism/prompt knobs
  // (temperature/topP/seed/structuredOutput/maxContentChars/…) inherit from BELIEF_ADJUDICATOR_CONFIG
  // so both tiers use the SAME shared prompt + contract.
  tier1: {
    ...BELIEF_ADJUDICATOR_CONFIG,
    provider: TIER1_PROVIDER,
    model: envStr('MANDREL_BELIEF_TIER1_MODEL', tier1DefaultsFor(TIER1_PROVIDER).model),
    endpoint: envStr('MANDREL_BELIEF_TIER1_ENDPOINT', tier1DefaultsFor(TIER1_PROVIDER).endpoint),
    apiKeyEnvVar: envStr('MANDREL_BELIEF_TIER1_API_KEY_ENV', tier1DefaultsFor(TIER1_PROVIDER).keyEnvVar),
    explicit: {
      endpoint: envIsSet('MANDREL_BELIEF_TIER1_ENDPOINT'),
      apiBaseUrl: envIsSet('MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL'),
      apiKeyEnvVar: envIsSet('MANDREL_BELIEF_TIER1_API_KEY_ENV'),
    },
    omitTemperature: envBool('MANDREL_BELIEF_TIER1_OMIT_TEMPERATURE', false),
    sendTopK: envBool('MANDREL_BELIEF_TIER1_SEND_TOP_K', false),
    reasoningEffort: envStr('MANDREL_BELIEF_TIER1_REASONING_EFFORT', ''),
    maxTokens: envInt('MANDREL_BELIEF_TIER1_MAX_TOKENS', BELIEF_ADJUDICATOR_CONFIG.maxTokens),
  },
  // TIER 2 — Sonnet 5 over the Anthropic Messages API (AUTHORITATIVE on escalation). Sonnet 5
  // DEPRECATED temperature (omitTemperature=true). Key from ANTHROPIC_API_KEY (by name).
  tier2: {
    ...BELIEF_ADJUDICATOR_CONFIG,
    provider: envStr('MANDREL_BELIEF_TIER2_PROVIDER', 'anthropic'),
    model: envStr('MANDREL_BELIEF_TIER2_MODEL', 'claude-sonnet-5'),
    endpoint: envStr('MANDREL_BELIEF_TIER2_ENDPOINT', BELIEF_ADJUDICATOR_CONFIG.endpoint),
    apiKeyEnvVar: envStr('MANDREL_BELIEF_TIER2_API_KEY_ENV', 'ANTHROPIC_API_KEY'),
    explicit: {
      endpoint: envIsSet('MANDREL_BELIEF_TIER2_ENDPOINT', 'MANDREL_BELIEF_ADJUDICATOR_ENDPOINT'),
      apiBaseUrl: envIsSet('MANDREL_BELIEF_ADJUDICATOR_API_BASE_URL'),
      apiKeyEnvVar: envIsSet('MANDREL_BELIEF_TIER2_API_KEY_ENV'),
    },
    omitTemperature: envBool('MANDREL_BELIEF_TIER2_OMIT_TEMPERATURE', true),
    anthropicToolChoice: envStr(
      'MANDREL_BELIEF_TIER2_ANTHROPIC_TOOL_CHOICE',
      BELIEF_ADJUDICATOR_CONFIG.anthropicToolChoice
    ),
    anthropicThinkingType: envStr(
      'MANDREL_BELIEF_TIER2_ANTHROPIC_THINKING_TYPE',
      BELIEF_ADJUDICATOR_CONFIG.anthropicThinkingType
    ),
    maxTokens: envInt('MANDREL_BELIEF_TIER2_MAX_TOKENS', BELIEF_ADJUDICATOR_CONFIG.maxTokens),
  },
};

/**
 * THE SUBQ (Snap) ADJUDICATOR knobs (an earlier task bake-off). SubQ Snap is a DECISION model,
 * not a chat model: `POST {endpoint}{decisionsPath}` with a `state` + typed `questions`, and it
 * answers with PROBABILITIES (no generated text, no rationale). The provider maps our four
 * verdicts onto one `choice` question and reads `same_subject` off a `noul` (yes-probability).
 * The generic per-provider fields (endpoint / model / apiKeyEnvVar / timeoutMs /
 * maxContentChars) come from the BeliefAdjudicatorConfig the provider is built with — so subq
 * works as a single provider (MANDREL_BELIEF_ADJUDICATOR_*) or as a tier (MANDREL_BELIEF_TIER1_*).
 * Only the knobs that have no meaning for any other provider live here.
 */
export interface BeliefSubqConfig {
  /** Path appended to the provider endpoint. Env: MANDREL_BELIEF_SUBQ_DECISIONS_PATH. Default '/v1/systemone'. */
  decisionsPath: string;
  /**
   * same_subject threshold: the `noul` yes-probability at or above which the pair counts as
   * the same subject/scope. Env: MANDREL_BELIEF_SUBQ_SAME_SUBJECT_MIN. Default 0.5.
   */
  sameSubjectMin: number;
  /**
   * Where sameSubject comes from. 'noul' = the separate same_subject yes-probability vs
   * sameSubjectMin. 'verdict' = sameSubject is (verdict !== 'unrelated') — the verdict choice
   * already carries "different subject/scope → unrelated", and measured on the 80-pair run
   * Snap's noul contradicted its own verdict on 12/23 supersedes answers.
   * The noul is still asked and recorded either way. Confirmed on 150 HELD-OUT prod pairs with
   * the config frozen before the run: 'verdict' recall 64/67 vs 'noul' 54/67 (combined reference).
   * Env: MANDREL_BELIEF_SUBQ_SAME_SUBJECT_FROM. Default 'verdict'.
   */
  sameSubjectFrom: string;
  /**
   * Which instructions the verdict question carries. 'compact' = a Snap-native short question
   * whose four option descriptions paraphrase the rubric. 'full' = the canonical adjudication
   * rubric text (buildAdjudicationPromptParts().staticPrefix) verbatim — so the only variable
   * against the LLM providers is the model. Env: MANDREL_BELIEF_SUBQ_RUBRIC. Default 'compact'.
   */
  rubric: string;
}

export const BELIEF_SUBQ_CONFIG: BeliefSubqConfig = {
  decisionsPath: envStr('MANDREL_BELIEF_SUBQ_DECISIONS_PATH', '/v1/systemone'),
  sameSubjectMin: envFloat('MANDREL_BELIEF_SUBQ_SAME_SUBJECT_MIN', 0.5),
  sameSubjectFrom: envStr('MANDREL_BELIEF_SUBQ_SAME_SUBJECT_FROM', 'verdict'),
  rubric: envStr('MANDREL_BELIEF_SUBQ_RUBRIC', 'compact'),
};

/**
 * The provenance label stamped on every `supersedes` edge the belief adjudicator mints
 * (links.created_by) — so an auto-minted belief edge is always distinguishable from an
 * explicitly-curated one and is trivially revertible (design §9d). A trusted constant
 * (never user input).
 */
export const BELIEF_EDGE_CREATED_BY = 'auto:belief-adjudicator';

/**
 * BELIEF ATTEMPT LEDGER config (observability) — the knobs for the append-only
 * attempt ledger (migration 097, services/belief/attemptLedger.ts) that makes the pipeline's own
 * MISS RATE countable. Separate from the COST config (beliefCostConfig.ts) because it answers a
 * different question: cost accounts for calls that HAPPENED, this accounts for attempts that
 * were MADE — including the ones that produced nothing.
 */
export interface BeliefAttemptConfig {
  /**
   * enabled — write attempt rows at all. Default TRUE: an observability ledger that is off by
   * default reproduces the defect it exists to fix. Turning it off costs you the miss rate, not
   * a verdict (the write is fail-safe either way). Env: MANDREL_BELIEF_ATTEMPT_LEDGER_ENABLED.
   */
  enabled: boolean;
  /**
   * errorMessageMaxChars — truncation bound for the persisted error message. Provider error
   * bodies (Groq's failed_generation echo) can be large; the ledger is a rate instrument, not a
   * body archive. Env: MANDREL_BELIEF_ATTEMPT_ERROR_MAX_CHARS.
   */
  errorMessageMaxChars: number;
  /**
   * rollupWindowDays — default window for rollupAttempts(). Env:
   * MANDREL_BELIEF_ATTEMPT_ROLLUP_WINDOW_DAYS.
   */
  rollupWindowDays: number;
}

export const BELIEF_ATTEMPT_CONFIG: BeliefAttemptConfig = {
  enabled: envBool('MANDREL_BELIEF_ATTEMPT_LEDGER_ENABLED', true),
  errorMessageMaxChars: envInt('MANDREL_BELIEF_ATTEMPT_ERROR_MAX_CHARS', 500),
  rollupWindowDays: envInt('MANDREL_BELIEF_ATTEMPT_ROLLUP_WINDOW_DAYS', 7),
};
