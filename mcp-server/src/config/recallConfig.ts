/**
 * Mandrel Core Redesign — T1 fluidity config.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every tunable T1 introduces lives HERE — a named value with a sane default + a
 * one-line comment + an env override — never a literal buried in a route/handler. This
 * mirrors the existing config-driven patterns already in the tree (RANK_WEIGHTS /
 * SEARCH_MIN_SIMILARITY in handlers/context.ts; MIN_SHORT_ID_LENGTH in utils/idResolver.ts).
 *
 * Reads env at module load with a safe fallback (bad/missing → the default), exactly
 * like handlers/context.ts:envFloat.
 */

import {
  isAltitude,
  RESPONSE_FORMAT_TO_ALTITUDE,
  type Altitude,
} from './altitudeConfig.js';
import type { SnippetBudget } from '../services/altitudeProjection.js';

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * RECALL payload control (redesign §4 Capability 5 / item 1).
 *
 * RECALL_CONCISE_MAXLEN — the max number of characters of a context's `content` that the
 * EXPLICIT OPT-IN 'concise' response format returns per row. `concise` truncates each row
 * to this length with a clear "fetch full" affordance; `detailed` returns the untruncated
 * content. Tunable so the eval gate can sweep it without a code edit
 * (env: MANDREL_RECALL_CONCISE_MAXLEN).
 */
export const RECALL_CONCISE_MAXLEN = envInt('MANDREL_RECALL_CONCISE_MAXLEN', 500);

/**
 * The two recall response formats (redesign §4 Capability 5 — maps to recall_thread
 * altitude later). Defined once here so the zod enum, the route logic, and the docs all
 * reference one source.
 */
export const RECALL_RESPONSE_FORMATS = ['concise', 'detailed'] as const;
export type RecallResponseFormat = (typeof RECALL_RESPONSE_FORMATS)[number];

/** Read an env var constrained to RECALL_RESPONSE_FORMATS, falling back on missing/garbage. */
function envFormat(name: string, fallback: RecallResponseFormat): RecallResponseFormat {
  const raw = process.env[name]; // env-read: via-callers
  return (RECALL_RESPONSE_FORMATS as readonly string[]).includes(raw ?? '')
    ? (raw as RecallResponseFormat)
    : fallback;
}

/**
 * The default response format when the caller omits `response_format`.
 *
 * FLIPPED to 'detailed' (WS1 "clean the pipes", D1). The 'concise' default
 * put a "…[truncated; fetch the full record…]" stub in 6/13 read-tool responses on a
 * 16-record project — the DEFAULT read path was returning packaging instead of the record,
 * and every consumer paid a second round-trip to get what it asked for. FULL RECORDS ARE
 * THE DEFAULT; 'concise' remains an explicit per-call opt-in (response_format:'concise'),
 * and this default itself is tunable (env: MANDREL_RECALL_DEFAULT_FORMAT).
 */
export const RECALL_DEFAULT_FORMAT: RecallResponseFormat =
  envFormat('MANDREL_RECALL_DEFAULT_FORMAT', 'detailed');

/**
 * THE SAME DEFAULT, IN THE ONE VOCABULARY (SEARCH P3).
 *
 * `response_format` is now a DEPRECATED ALIAS; `altitude` is the advertised parameter. The
 * default is DERIVED from RECALL_DEFAULT_FORMAT rather than restated, so a deployment that
 * already sets MANDREL_RECALL_DEFAULT_FORMAT keeps governing its own instances and the two
 * knobs cannot disagree. MANDREL_RECALL_DEFAULT_ALTITUDE overrides it directly.
 *
 * ⚠️ IT IS `full`, AND THAT IS DELIBERATE. The concise default was flipped BACK for a
 * measured reason (quoted above): it put a truncation stub in 6/13 read-tool
 * responses on a 16-record project, so the DEFAULT read path returned packaging instead of
 * records. Standardising the VOCABULARY must not smuggle that regression back in under a
 * new name — `summary` is smart_search's default, not this one.
 */
export const RECALL_DEFAULT_ALTITUDE: Altitude = (() => {
  const raw = process.env.MANDREL_RECALL_DEFAULT_ALTITUDE; // env-read: via-callers
  return isAltitude(raw) ? raw : RESPONSE_FORMAT_TO_ALTITUDE[RECALL_DEFAULT_FORMAT];
})();

/**
 * The per-row `summary` budget for a context row, as the shared projection takes it.
 *
 * PER-ROW because the affordance names THIS row's id — the parameter that returns the whole
 * body.
 *
 * THE WORDING IS LOAD-BEARING AND IS CARRIED FORWARD VERBATIM from the applyRecallPayload
 * clipper this replaced (deleted in an earlier task once it had zero production callers). It
 * names the `id` PARAMETER and no tool, so it reads correctly on both the flat surface and
 * the gateway, and it cannot be misread as a `query:'id:<uuid>'` DSL. That misreading is not
 * hypothetical: the string previously read `context_search id:<id>`, agents duly called
 * `context_search({query:'id:<uuid>'})`, and the tool silently returned an unrelated record
 *. The affordance is emitted on EVERY truncation, so it was actively
 * TEACHING the misread. Do not reintroduce a `tool arg:value` form here; the notation is
 * fused by reservedQueryPrefix.contract.test.ts.
 */
export function recallSnippetBudget(id: string): SnippetBudget {
  return {
    maxlen: RECALL_CONCISE_MAXLEN,
    affordance: `…[truncated; fetch the full record by setting the id parameter: id="${id}"]`,
  };
}

