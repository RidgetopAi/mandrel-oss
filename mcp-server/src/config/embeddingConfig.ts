/**
 * EMBEDDER CONFIG — the single source of truth for which embedding model Mandrel uses,
 * its geometry, its documented prompt prefixes, its storage column, and its ivfflat
 * tuning (an earlier task "D1: adopt embeddinggemma-300m").
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob the embed path touches lives HERE — a named value with a doc comment + an
 * env override — never a literal buried in a handler. Mirrors trustConfig.ts / recallConfig.ts.
 *
 * WHY A REGISTRY (not a single active model): the swap must be REVERSIBLE and SWITCHABLE.
 * BOTH the incumbent MiniLM and the new gemma stay selectable via `MANDREL_EMBEDDER`, each
 * with its OWN vector column so the two data sets coexist (additive dual-column migration,
 * not a destructive in-place alter). Cutover = flip the env + rebuild the index; rollback =
 * flip it back — the old column's data is never destroyed.
 *
 * MEASURED (2026-07-05, dev-host): embeddinggemma does NOT load under this repo's
 * @xenova/transformers@2.17.2 (ONNX IR v10 > onnxruntime-node max IR v8; `gemma3_text`
 * arch unknown). So the gemma backend runs via OLLAMA (the same backend that won the P0
 * bake-off, +8.5 strict coverage). MiniLM stays on the self-contained @xenova path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** Read a non-empty string env var, else `fallback`. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Read a positive-integer env var, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a finite-number env var, else `fallback`. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read a boolean env var ("true"/"1"/"yes" → true, "false"/"0"/"no" → false), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * XENOVA OFFLINE CONFIG (an earlier task — HF "Xet" migration returns 403 to the
 * @xenova/transformers@2 client, so a RUNTIME download of the MiniLM model now fails and
 * takes the whole embed-before-insert write path down). The permanent weld: the model is
 * BAKED into the fleet image and loaded PURELY from the local on-disk cache — the process
 * must NEVER touch the HF network. These are the two knobs the xenova backend needs.
 *
 * STANDING PRINCIPLE (the operator): no hardcoded tunables — each is a named value + env override.
 *
 *  - XENOVA_ALLOW_REMOTE  → sets @xenova `env.allowRemoteModels`. DEFAULT false = offline,
 *    never fetch from HF. (Set MANDREL_XENOVA_ALLOW_REMOTE=true only for a dev machine that
 *    intentionally wants to download.)
 *  - MANDREL_XENOVA_CACHE_DIR → optional override of @xenova `env.cacheDir`. When UNSET the
 *    directory is resolved by `resolveXenovaCacheDir()`: first the model VENDORED in-repo at
 *    `mcp-server/vendor/models/` (so a source checkout — `npm run dev:mcp` — finds the real
 *    model with no setting), else empty = leave the @xenova default
 *    `node_modules/@xenova/transformers/.cache`, which is EXACTLY where the model is baked in
 *    the container image AND where prod systemd's seeded cache already lives (the image has
 *    no `vendor/` next to its code, so it keeps using that default). Set the variable for a
 *    non-standard install layout.
 *  - MANDREL_EMBEDDINGS_ALLOW_MOCK → explicit opt-in to deterministic MOCK embeddings
 *    (`embeddingsAllowMock()`). Without it, a model that cannot load stops the server at
 *    startup. The test runner (VITEST / NODE_ENV=test) counts as an opt-in.
 */
export const XENOVA_ALLOW_REMOTE: boolean = envBool('MANDREL_XENOVA_ALLOW_REMOTE', false);

/** Model id + relative file whose presence marks a usable vendored/cache dir. */
const XENOVA_MODEL_PROBE = path.join('Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx');
/** Vendored model root, relative to the mcp-server package root. */
const VENDORED_MODELS_SUBDIR = path.join('vendor', 'models');
/** How many parent directories to climb from this module looking for the package root. */
const VENDORED_SEARCH_DEPTH = 4;

/**
 * Resolve the @xenova cache dir: MANDREL_XENOVA_CACHE_DIR if set; else the vendored
 * `mcp-server/vendor/models/` found by walking up from this module (works from both
 * `src/` and the compiled `dist/`); else '' (leave the @xenova default). Read at call time.
 */
export function resolveXenovaCacheDir(): string {
  const explicit = envStr('MANDREL_XENOVA_CACHE_DIR', '');
  if (explicit) return explicit;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < VENDORED_SEARCH_DEPTH; i++) {
    const candidate = path.join(dir, VENDORED_MODELS_SUBDIR);
    if (fs.existsSync(path.join(candidate, XENOVA_MODEL_PROBE))) return candidate;
    dir = path.dirname(dir);
  }
  return '';
}
export const XENOVA_CACHE_DIR: string = resolveXenovaCacheDir();

/**
 * Mock embeddings are allowed ONLY on an explicit opt-in: MANDREL_EMBEDDINGS_ALLOW_MOCK=true,
 * or running under the test runner (VITEST / NODE_ENV=test). Read at call time.
 */
export function embeddingsAllowMock(): boolean {
  return envBool('MANDREL_EMBEDDINGS_ALLOW_MOCK', false) ||
    process.env.NODE_ENV === 'test' || // env-read: via-callers
    !!process.env.VITEST; // env-read: via-callers
}

/** Which runtime executes the model. */
export type EmbedderBackend = 'xenova' | 'ollama';

export interface EmbedderSpec {
  /** Stable key + the value of MANDREL_EMBEDDER that selects this embedder. */
  key: string;
  /** Human label for logs / status. */
  label: string;
  /** Runtime that executes it: 'xenova' (in-process Transformers.js) or 'ollama' (daemon). */
  backend: EmbedderBackend;
  /** Model id passed to the backend (xenova repo id, or ollama model tag). */
  modelId: string;
  /**
   * NATIVE output dimensionality. This is what actually lands in the column — NO padding.
   * (MiniLM historically padded 384→1536; gemma is stored at its native 768. See `column`.)
   */
  dimensions: number;
  /**
   * The postgres vector column this embedder reads+writes on `contexts` /
   * `technical_decisions`. Each embedder owns its own column so both coexist. This is a
   * TRUSTED IDENTIFIER (from config, never user input) that is interpolated into SQL.
   */
  column: string;
  /**
   * Prefix prepended to a QUERY (search-side) before embedding. Asymmetric encoders need
   * the query framed differently from a stored document. Empty for symmetric encoders.
   */
  queryPrefix: string;
  /** Prefix prepended to a DOCUMENT (store-side) before embedding. */
  docPrefix: string;
  /**
   * If true, pad/truncate the native vector to `dimensions` for backward-compat with a
   * legacy column geometry (MiniLM: 384 native → stored 1536). If false, store native.
   */
  padToDimensions: boolean;
  /** ivfflat `lists` for this embedder's index (build-time knob). */
  indexLists: number;
  /**
   * ivfflat `probes` for SEARCH (recall knob). Prod historically ran the pgvector default
   * of 1 (an earlier task — poor recall); this is the config-driven fix. `SET LOCAL
   * ivfflat.probes` is applied per search transaction from this value.
   */
  indexProbes: number;
}

/**
 * THE EMBEDDER REGISTRY. Add a model here (never a literal in a handler). Defaults are
 * grounded in the P0 bake-off (evals/p0-embedder-bakeoff/p0.config.json) + localModel.ts.
 *
 * A FUNCTION, NOT A CONST — see "NOTHING HERE IS MEMOIZED" below.
 */
export function embedders(): Record<string, EmbedderSpec> {
  return {
  /** Incumbent floor — self-contained Transformers.js, symmetric (no prefix), 384→1536 pad. */
  minilm: {
    key: 'minilm',
    label: 'all-MiniLM-L6-v2 (incumbent)',
    backend: 'xenova',
    modelId: envStr('MANDREL_MINILM_MODEL_ID', 'Xenova/all-MiniLM-L6-v2'),
    dimensions: 1536,
    column: envStr('MANDREL_MINILM_COLUMN', 'embedding'),
    queryPrefix: '',
    docPrefix: '',
    padToDimensions: true,
    indexLists: envInt('MANDREL_MINILM_INDEX_LISTS', 100),
    indexProbes: envInt('MANDREL_MINILM_INDEX_PROBES', 10),
  },
  /** D1 winner — embeddinggemma-300m via Ollama, asymmetric prefixes, native 768. */
  gemma: {
    key: 'gemma',
    label: 'embeddinggemma-300m (D1)',
    backend: 'ollama',
    modelId: envStr('MANDREL_GEMMA_MODEL_ID', 'embeddinggemma'),
    dimensions: 768,
    column: envStr('MANDREL_GEMMA_COLUMN', 'embedding_gemma'),
    // Documented EmbeddingGemma prompt templates (model card / bake-off config):
    queryPrefix: envStr('MANDREL_GEMMA_QUERY_PREFIX', 'task: search result | query: '),
    docPrefix: envStr('MANDREL_GEMMA_DOC_PREFIX', 'title: none | text: '),
    padToDimensions: false,
    indexLists: envInt('MANDREL_GEMMA_INDEX_LISTS', 100),
    // 20, not 10 — measured 2026-08-28, operator-approved. On the live
    // corpus shape (11,100 contexts, lists=100) probes=20 is the knee:
    //   probes=10  recall@50 0.9532  253ms/100q  Index Scan
    //   probes=20  recall@50 0.9852  415ms/100q  Index Scan  <- here
    //   probes=40  recall@50 0.9964  778ms/100q  Index Scan
    // Above ~40 the planner abandons the index (probes=60 -> Seq Scan, 70ms/query),
    // so this knob buys recall only up to a cliff. Do NOT carry forward this task's
    // older PLANNER_FLIP=8 metadata: that came from a project-filtered 2,343-row
    // shape and does not describe the live corpus. Re-measure before moving it.
    indexProbes: envInt('MANDREL_GEMMA_INDEX_PROBES', 20),
  },
  };
}

/**
 * ============================================================================
 * NOTHING HERE IS MEMOIZED — AND THAT IS THE POINT.
 * ============================================================================
 * These USED to be three module-scope `export const`s evaluated at FIRST IMPORT:
 *
 *     export const ACTIVE_EMBEDDER_KEY = (() => envStr('MANDREL_EMBEDDER', <default>))();
 *     export const ACTIVE_EMBEDDER     = EMBEDDERS[ACTIVE_EMBEDDER_KEY];
 *     export const EMBEDDING_COLUMN    = ACTIVE_EMBEDDER.column;
 *
 * (The default literal is deliberately written as `<default>` above and NOT as a real
 * quoted value: two guards — fleet-defaults-drift script and
 * scripts/test/compose-code-default-agreement.test.sh — extract this file's code default
 * with the regex `envStr\('MANDREL_EMBEDDER', *'([^']*)'\)`, and a SECOND quoted literal
 * anywhere in this file makes that extraction ambiguous. Both guards then fail closed
 * ("matched CONFLICTING defaults"), which turns a live fleet-drift detector off. Measured
 * on this branch before the flip: the historical snippet here matched alongside the real
 * one and only agreed by accident, because both said minilm.)
 *
 * That made the value a function of WHEN this module was first evaluated rather than of
 * the environment — a snapshot that any later change to `MANDREL_EMBEDDER` could not
 * reach. It made the authoritative clean gate NON-DETERMINISTIC: the vitest suite runs
 * every file in ONE process (vitest.config: fileParallelism:false + singleFork:true), and
 * the embedder-specific files flip `MANDREL_EMBEDDER` in a `vi.hoisted()` block. Whenever
 * this module's evaluation was reused across files, the flip was INERT and
 * embedResilienceGemma's `expect(activeEmbeddingColumn()).toBe(embedders().gemma.column)`
 * failed with "expected 'embedding' to be 'embedding_gemma'" — GREEN then RED on the same
 * ref, same box. Reproduced deterministically at f9d10f8 with a shared module registry;
 * see embedderSelectionMemoization.unit.test.ts + vitest.order-matrix.config.ts.
 *
 * THE FIX IS THE DELETION. There is no cached value left to go stale, so the bad state is
 * not merely unlikely — it is unrepresentable. Ordering the tests, retrying, or adding a
 * `resetEmbedderConfig()` the test must remember to call would all have left a snapshot
 * that CAN disagree with the environment; this leaves none. (a past incident's named sub-trap:
 * "a static import of a memoizing config module evaluates BEFORE the test stubs env →
 * poisoned cache; read process.env directly.")
 *
 * COST: each call rebuilds two small spec objects. These are called when a SQL string is
 * built (per query, never per row); the surrounding work is a database round-trip. Prod
 * behavior is otherwise unchanged — `MANDREL_EMBEDDER` does not change within a process,
 * so every call returns exactly what the old snapshot did.
 *
 * SHAPE-MATCHED to the Command backend's mirror of this decision
 * (mandrel-command/backend/src/config/embeddingColumn.ts), which already read env at point
 * of use: `activeEmbedderKey()` / `activeEmbeddingColumn()`. Two copies of one rule now
 * agree on the rule (C5).
 */

/**
 * THE ACTIVE EMBEDDER KEY — selected by `MANDREL_EMBEDDER`, read at EVERY call.
 *
 * DEFAULT: `minilm` — built in and offline, so a self-hoster needs no
 * Ollama daemon. Fleet instances that run gemma MUST set `MANDREL_EMBEDDER=gemma`
 * (docker-compose.yml declares it per service). `gemma` stays SELECTABLE and its
 * `embedding_gemma` column is untouched. The default must agree with the compose default,
 * the Command backend default and the fleet REQUIRED posture
 * (embedderCodeDefaultAgreement.unit.test.ts).
 *
 * AN UNRECOGNIZED VALUE THROWS. It used to fall back to minilm, which is the same silent
 * mis-column bug wearing a typo instead of a missing line. `MANDREL_EMBEDDER` does not
 * change within a process, so this surfaces at the first embed / SQL-build call — loudly,
 * naming the bad value and the valid keys — instead of quietly querying the wrong column
 * forever. ABSENT is NOT an error: absent means minilm.
 */
export function activeEmbedderKey(): string {
  const k = envStr('MANDREL_EMBEDDER', 'minilm');
  if (!embedders()[k]) {
    throw new Error(
      `MANDREL_EMBEDDER=${JSON.stringify(k)} is not a known embedder. ` +
        `Valid values: ${Object.keys(embedders()).sort().join(', ')}. ` +
        `Unset it to get the default (minilm). Refusing to guess a vector column: ` +
        `guessing wrong makes every search silently return nothing.`,
    );
  }
  return k;
}

/** THE ACTIVE EMBEDDER SPEC — resolved from the env at EVERY call (never memoized). */
export function activeEmbedder(): EmbedderSpec {
  return embedders()[activeEmbedderKey()];
}

/**
 * THE ACTIVE VECTOR COLUMN — the ONE name every SQL site (store / search / stats / admit /
 * count / auto-thread inference / anchor gate, on BOTH `contexts` and `technical_decisions`,
 * which share the column name) must use to read+write embeddings. Call THIS everywhere
 * instead of hardcoding `embedding` — so the whole class follows the active embedder and a
 * gemma cutover can't leave a legacy-column reference behind. A trusted
 * identifier from config (never user input) → safe to interpolate into SQL.
 */
export function activeEmbeddingColumn(): string {
  return activeEmbedder().column;
}

/**
 * SIMILARITY THRESHOLDS — geometry differs per model, so the "is this a real match" floor
 * is per-embedder tunable. Consumed by search ranking / abstain logic. Defaults are
 * conservative; env-overridable for the eval sweep. (MiniLM historically had no explicit
 * floor; gemma's cosine range is tighter — see the retrieval sanity in the task proof.)
 */
export interface SimilarityThresholds {
  /** Below this cosine similarity a candidate is treated as noise (not a match). */
  floor: number;
  /** At/above this it is a strong match. */
  strong: number;
}

/**
 * Functions, not consts — same reason as the ACTIVE_* trio above.
 *
 * NOT exported: measured 0 call sites outside this module (`grep -rn similarityThresholds
 * --include=*.ts --exclude-dir=node_modules` -> only the definition, activeSimilarity()
 * below, and one prose mention in beliefConfig.ts). The per-embedder registry is an
 * implementation detail of activeSimilarity(); exporting it was surface nobody consumed.
 */
function similarityThresholds(): Record<string, SimilarityThresholds> {
  return {
    minilm: {
      floor: envFloat('MANDREL_MINILM_SIM_FLOOR', 0.1),
      strong: envFloat('MANDREL_MINILM_SIM_STRONG', 0.5),
    },
    gemma: {
      floor: envFloat('MANDREL_GEMMA_SIM_FLOOR', 0.35),
      strong: envFloat('MANDREL_GEMMA_SIM_STRONG', 0.55),
    },
  };
}

export function activeSimilarity(): SimilarityThresholds {
  const t = similarityThresholds();
  return t[activeEmbedderKey()] ?? t.minilm;
}

/** Ollama daemon endpoint (used only by the ollama backend). */
export const OLLAMA_ENDPOINT: string = envStr('MANDREL_OLLAMA_ENDPOINT', 'http://127.0.0.1:11434');

/**
 * Max input length (characters) the embedder will accept before it REJECTS the text.
 *
 * This is a HARD limit, not a soft one: services/embedding/validation.ts `validateInput`
 * THROWS an EmbeddingError above it. Callers on a store path must therefore bound their
 * text to this BEFORE calling generateEmbedding, or the record silently loses its
 * embedding (the handler catches the throw and stores without one → the row falls back to
 * trgm search and drops out of semantic recall).
 *
 * Previously this was a bare `parseInt(process.env.EMBEDDING_MAX_TEXT_LENGTH || '8000')`
 * literal inside EmbeddingService, invisible to every caller that needed to respect it
 *. It lives here now so the service that ENFORCES it and the handlers that
 * must RESPECT it read the same number — the standing no-hardcoded-variables rule.
 *
 * env: EMBEDDING_MAX_TEXT_LENGTH
 */
export const EMBEDDING_MAX_TEXT_LENGTH: number = envInt('EMBEDDING_MAX_TEXT_LENGTH', 8000);

/**
 * Bound `text` to what the embedder will accept (see EMBEDDING_MAX_TEXT_LENGTH).
 *
 * Store-path callers use this so a long record degrades to an embedding of its leading
 * text — which still retrieves — instead of throwing and leaving the row with NO embedding
 * at all. Truncated-but-searchable beats un-embedded-and-invisible.
 */
export function boundEmbeddingText(text: string): string {
  return text.length > EMBEDDING_MAX_TEXT_LENGTH ? text.slice(0, EMBEDDING_MAX_TEXT_LENGTH) : text;
}

/**
 * Apply the active embedder's role prefix to raw text.
 * @param role 'query' for search-side, 'document' for store-side.
 */
export function applyPrefix(text: string, role: 'query' | 'document'): string {
  const spec = activeEmbedder();
  const prefix = role === 'query' ? spec.queryPrefix : spec.docPrefix;
  return prefix ? `${prefix}${text}` : text;
}
