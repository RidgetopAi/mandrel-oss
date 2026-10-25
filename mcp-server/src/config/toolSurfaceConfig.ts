/**
 * Tool-surface configuration — MCP-2026 rebuild, PHASE 0.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every tunable that shapes the advertised MCP tool surface lives HERE — a named value
 * with a sane default + a one-line comment + an env override — never a literal buried in
 * a route/handler. Mirrors the existing config-driven patterns (autoThreadConfig.ts,
 * recallConfig.ts, projectEchoConfig.ts).
 *
 * Reads env at module load with a safe fallback (bad/missing → the default), exactly like
 * config/autoThreadConfig.ts:envBool.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PHASE 0 — outputSchema wire trim (rebuild plan §8).
 *
 * Today every entry in the `tools/list` (ListTools) response carries a full per-tool
 * `outputSchema` (attached table-driven by config/toolDefinitions.ts:attachOutputSchemas).
 * Those output schemas roughly DOUBLE the real wire cost of `tools/list` (~20,980 tokens
 * with them vs ~11,600 without) yet the model never needs them on the lazy list — a client
 * that cannot find an outputSchema simply skips response-validation (a non-breaking change).
 *
 * This flag gates the ADVERTISEMENT of outputSchemas on the lazy list ONLY. It does NOT
 * change emission: tools still EMIT `structuredContent` at runtime (the
 * `ensureStructuredContent` seam in routes/index.ts is untouched), and full schemas stay
 * retrievable via `mandrel_explain` (today) / `discover.explain` (later) and the on-box
 * bridge's `/mcp/tools/schemas` endpoint (config/../server/healthServer.ts — untouched).
 *
 * DEFAULT = true → advertise ON → the `tools/list` wire stays BYTE-IDENTICAL to today, so
 * merging this change alters nothing live. The trim is exercised with the flag OFF; flipping
 * the default to `false` is a later NOTIFY-rung step (plan §8 Phase 0 "Risk rung"), NOT part
 * of Phase 0's build. Reversible: flag off↔on flips the wire with no migration.
 */

/** Read a boolean env var, falling back to `fallback` on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/**
 * MANDREL_ADVERTISE_OUTPUT_SCHEMAS — when true (default), each `tools/list` entry advertises
 * its `outputSchema` exactly as today (byte-identical wire). When false, the lazy list carries
 * NO per-entry `outputSchema` (the Phase 0 ~45% wire cut). Emission + schema retrieval are
 * unaffected either way (see file header).
 */
export const ADVERTISE_OUTPUT_SCHEMAS = envBool('MANDREL_ADVERTISE_OUTPUT_SCHEMAS', true);

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * PHASE 2 — gateway surface + `discover` + lazy tools/list (rebuild plan §1.2/§8 and its decision).
 *
 * These flags gate the WHOLE new 10-tool gateway surface. THE CORE INVARIANT: every flag
 * DEFAULTS to today's behaviour, so at the defaults the advertised `tools/list` is
 * BYTE-IDENTICAL to HEAD (the toolSurfaceGolden byte-identity snapshot stays green) and the
 * gateway/discover machinery exists but is advertised to NO ONE. A human flips the surface
 * flag in a later phase — this build ships the machinery DARK.
 *
 * Exposed as typed GETTER functions (not eager module-load consts like ADVERTISE_OUTPUT_SCHEMAS
 * above) so each is read from the environment at call-time: this keeps them (a) unit-testable
 * without a module reload, and (b) live-flippable per-instance for the Phase-3 canary. The
 * parsing helpers reject bad/unknown values back to the default (fail-safe), mirroring envBool.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/** Read a string-enum env var (case-insensitive), falling back to `fallback` on missing/unknown. */
function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage/non-positive. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Which advertised tool surface `tools/list` serves. */
export type ToolSurface = 'legacy' | 'gateway';
export const TOOL_SURFACES = ['legacy', 'gateway'] as const;

/** How the gateway surface advertises each gateway's input schema (only consulted when surface=gateway). */
export type ToolListMode = 'lazy' | 'full';
export const TOOLLIST_MODES = ['lazy', 'full'] as const;

/** Whether a direct flat-name `tools/call` is accepted or rejected with a deprecation error. */
export type FlatToolsPolicy = 'accept' | 'reject';
export const FLAT_TOOLS_POLICIES = ['accept', 'reject'] as const;

/**
 * MANDREL_TOOL_SURFACE ∈ legacy|gateway — DEFAULT `legacy`.
 * `legacy` = today's 54 flat tools, byte-identical to HEAD. `gateway` = the 10-tool gateway
 * surface (8 gateway envelopes + the flat headline tools). Flipping to `gateway` is a LATER
 * (human-gated) phase; this build only makes it possible.
 */
export function getToolSurface(): ToolSurface {
  return envEnum('MANDREL_TOOL_SURFACE', TOOL_SURFACES, 'legacy');
}

/**
 * MANDREL_TOOLLIST_MODE ∈ lazy|full — DEFAULT `lazy` (only meaningful when surface=gateway).
 * `lazy` = each gateway advertises a minimal `{action:{enum:[…]}}` envelope (the ~950-token
 * win); `full` = each gateway advertises its whole-tool action-discriminated oneOf schema.
 */
export function getToolListMode(): ToolListMode {
  return envEnum('MANDREL_TOOLLIST_MODE', TOOLLIST_MODES, 'lazy');
}

/**
 * MANDREL_FLAT_TOOLS ∈ accept|reject — DEFAULT `accept`.
 * `accept` = the legacy flat opId names (`context_store`, …) remain fully callable via
 * `tools/call` (the permanent back-compat shim the bridge/REST/boot-rituals depend on).
 * `reject` = a direct flat-name call returns an actionable deprecation error pointing at the
 * gateway form. The three deliberately-FLAT tools (recall_thread/smart_search/get_recommendations)
 * are ALWAYS accepted regardless of this flag.
 */
export function getFlatToolsPolicy(): FlatToolsPolicy {
  return envEnum('MANDREL_FLAT_TOOLS', FLAT_TOOLS_POLICIES, 'accept');
}

/**
 * MANDREL_TOOLLIST_TOKEN_BUDGET — DEFAULT 1550. The CI token-meter ceiling for the gateway
 * lazy `tools/list` (o200k_base). Named here (configs-not-hardcoded) so description creep can't
 * silently eat the context win without a RED gate.
 *
 * RAISED 1100→1400 (Phase 3): the plain lazy envelope measured ~1005 o200k tokens;
 * "lazy+core" (gatewaySurface.ts) DELIBERATELY lifts required-param hints + closed enums for the
 * un-guessable WRITE actions into the envelope (context ContextType enum, decision.record's 5
 * required, graph edge types, …) to close the measured 60%→100% first-call gap (the auditor rec
 * the auditor recommendation). MEASURED lazy+core = 1318 o200k tokens — a MEASURED, intentional trade (NOT creep),
 * and still a 93.7% cut vs the 21,012-token flat surface (54 tools w/ outputSchemas) / ~9x vs the
 * ~11.6k stripped surface. The ceiling sits ~80 tokens above the measured number so it still
 * catches genuine future creep. If lazy+core is ever tuned to lift more, re-measure and re-justify
 * this bump (do NOT silently raise it).
 *
 * RAISED 1400→1450 (P3): `graph` gained two ACTIONS — branch_assign and
 * branch_unassign — and the lazy envelope carries the action enum, so the surface grew.
 * MEASURED with the meter's own instrument (`encode(JSON.stringify({tools}))`, o200k_base,
 * gpt-tokenizer) on both refs:
 *   base main@f6df00d  TOTAL 1400 tokens / 6114 bytes · `graph` envelope 221 tokens / 944 bytes
 *   head (this tree)   TOTAL 1407 tokens / 6148 bytes · `graph` envelope 228 tokens / 978 bytes
 * The delta is +7 tokens and it is ENTIRELY the two action NAMES in `graph`'s action enum —
 * every other envelope is byte-identical, and NO param was lifted (`spine` was added to
 * IDENTIFIER_PARAMS, which is what keeps branch_assign out of lazy+core; without that the
 * cost would have been far larger). So this is surface the tools genuinely are, not creep.
 *
 * WHY THIS RAISE WAS UNAVOIDABLE, AND WHY THE NEW NUMBER HAS HEADROOM: the old ceiling was
 * 1400 and the measured surface was EXACTLY 1400 — zero slack — so the very next action of
 * any kind would have turned this gate RED regardless of its cost. A ceiling with no headroom
 * does not measure creep, it measures change. 1450 leaves ~43 tokens (roughly a dozen further
 * action names) above the measured 1407, which is enough that the next RED here means
 * something grew that should not have.
 *
 * RAISED 1450→1550 (reproject): `project` gained the `move` action,
 * and because it is a WRITE whose required params are un-guessable AS A SET, lazy+core lifts
 * them into the envelope. This gate went RED at 1494 and the raise is JUSTIFIED BY A MEASURED
 * BREAKDOWN, not by the failure. All four numbers from the meter's own instrument
 * (`encode(JSON.stringify({tools}))`, o200k_base, gpt-tokenizer), run on this tree with the
 * change progressively removed:
 *   base ref 61df00d (no op, no description edit)  1425 tokens / 6225 bytes
 *   + the one-clause gateway description edit      1432 (+7)
 *   + the `move` name in project's action enum     1434 (+2)
 *   + lazy+core lifting its three params           1494 (+60)   ← shipped
 * The +60 is the whole contract and there is nothing in it to trim: three property names, one
 * 3-value closed enum (`recordType`), and one "REQUIRED for action:move." sentence each —
 * inspected on the rendered envelope, not assumed. The alternative was to NOT lift it, which
 * costs 2 tokens and is the wrong answer twice over: `move` IS a write (it UPDATEs the record
 * row, its followers and its edge stamps), so excusing it into UNGUESSABLE_READ_ACTIONS would
 * be a false classification, and a first-call move with no lifted contract is exactly the
 * 60%→100% gap lazy+core exists to close — on the one op whose whole job is to repair a
 * misfile, where a failed first call is a caller who gives up.
 * 1550 leaves 56 tokens of headroom above the measured 1494, in line with the ~43 the previous
 * raise left, so the next RED here still means something grew that should not have.
 */
export function getToolListTokenBudget(): number {
  return envInt('MANDREL_TOOLLIST_TOKEN_BUDGET', 1550);
}

/**
 * MANDREL_LAZY_CORE_ENUM_MAX — DEFAULT 12. The largest CLOSED enum (value count) that lazy+core
 * inlines as an actual schema-prop `enum` on the lazy list (plan §1.2 / the auditor recommendation
 * "≤ ~12 values"). A required param whose enum EXCEEDS this is lifted by NAME only (its allowed
 * values stay one `discover.explain` call away) — this is exactly what keeps decision.record's
 * 15-value `decisionType` from bloating the budget while `impactLevel`(4) / ContextType(10) /
 * edgeType(10) are inlined as the strongest attention channel. Named here (configs-not-hardcoded).
 */
export function getLazyCoreEnumMax(): number {
  return envInt('MANDREL_LAZY_CORE_ENUM_MAX', 12);
}
