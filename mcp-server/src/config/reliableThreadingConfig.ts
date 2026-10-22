/**
 * RELIABLE AUTO-THREADING — the durable/honest-anchor + no-orphan-inference config
 * (branch:mandrel-reliability, task ST-2 b8c64ee4, spec
 * docs/specs/reliable-auto-threading.md §X1).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. Every threshold / TTL /
 * limit the reliable-threading layer touches lives HERE, once — a named value with a
 * Operator-aligned default, a one-line note, and an env override. Never a literal buried in a
 * route or service. Mirrors recallConfig.ts (T1), edgeTypes.ts (T2a), trustConfig.ts (T2b),
 * threadConfig.ts (T3), autoThreadConfig.ts (T5b) — the config is the contract, the code
 * reads it. Downstream ST's (durable anchor A, inference B, backfill C) IMPORT these names;
 * this module is their single home so nothing downstream re-hardcodes a value.
 *
 * NOTE: this is a SEPARATE module from config/autoThreadConfig.ts (T5b — the WRITE-time
 * active-thread edge vocabulary + master switch). This one holds the RELIABILITY knobs the
 * spec adds on top: the anchor TTL + similarity floor (spec A3/A4), the write-time inference
 * threshold + candidate limit (spec B2), and the two kill/behavior switches. The two stay
 * un-tangled so the base auto-thread contract can't drift the reliability tunables.
 *
 * ENV-READ SAFETY vs FAIL-FAST (matches the house pattern, autoThreadConfig.ts):
 *   - A bad/unparseable env value (a typo — e.g. FLOOR="abc") FALLS BACK to the default,
 *     exactly like recallConfig.envInt / trustConfig.envFloat — a typo must not crash boot.
 *   - An OUT-OF-RANGE value (parses fine but is nonsensical — e.g. a similarity floor of
 *     1.5, a TTL of 0, a candidate limit of 0) THROWS at module load — a fail-fast load
 *     assert, the same mechanism autoThreadConfig.ts uses to catch a drifted edge mapping.
 *     A misconfigured threshold silently clamped would corrupt trust/inference decisions;
 *     better to refuse to boot and say why.
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
 * Read a finite-number env var, falling back to `fallback` on missing/unparseable input
 * (matches trustConfig.envFloat / handlers/context.ts:envFloat). Range is NOT enforced
 * here — an out-of-range but parseable value is returned and caught by the load-time
 * range assert below (so we can distinguish "typo → default" from "nonsense → fail-fast").
 */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Read an integer env var, falling back to `fallback` on missing/unparseable/non-integer
 * input (mirrors trustConfig.envInt's parse step). Range (≥ 1) is NOT enforced here — it is
 * checked by the load-time range assert so an out-of-range integer fails fast rather than
 * silently reverting to the default.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) ? v : fallback;
}

/**
 * Load-time fail-fast: throw if a (successfully-parsed) config value is out of its valid
 * range. Same intent as autoThreadConfig.ts's edge-vocabulary assert — refuse to boot on a
 * nonsensical config rather than run with a silently-corrected value.
 */
function assertRange(
  name: string,
  value: number,
  min: number,
  max: number,
  bound: '[]' | '(]' = '[]'
): number {
  const lowOk = bound === '(]' ? value > min : value >= min;
  const highOk = value <= max;
  if (!lowOk || !highOk) {
    throw new Error(
      `[reliableThreadingConfig] ${name}=${value} is out of range ` +
        `${bound === '(]' ? '(' : '['}${min}, ${max}] — fix the env override.`
    );
  }
  return value;
}

// ── Anchor knobs (spec A3/A4: durable/honest anchor) ────────────────────────────────

/**
 * ANCHOR_TTL_MS — how long a persisted active-thread anchor stays valid (spec A3). Past
 * this age the anchor is treated as NO anchor (falls through to inference), never used to
 * mint a trust-bearing edge. Env: MANDREL_ANCHOR_TTL_MS. Default 24h — a working session's
 * span; a next-day capture should not silently thread onto yesterday's stale anchor.
 * Must be > 0 (a zero/negative TTL means "always expired", which is a misconfig, not a knob).
 */
export const ANCHOR_TTL_MS: number = assertRange(
  'ANCHOR_TTL_MS',
  envInt('MANDREL_ANCHOR_TTL_MS', 24 * 60 * 60 * 1000),
  0,
  Number.MAX_SAFE_INTEGER,
  '(]'
);

/**
 * ANCHOR_SIMILARITY_FLOOR — the minimum embedding cosine similarity between a new capture
 * and its anchor target below which the anchor is REJECTED for minting a trust-bearing
 * `informs`/`decided_by` edge (spec A4), falling through to inference instead. Guards
 * against the live 2026-07-03 failure: a new, unrelated capture silently attaching to a
 * stale anchor. Env: MANDREL_ANCHOR_SIM_FLOOR. Must be in [0, 1] (a cosine).
 *
 * DEFAULT RAISED 0.5 -> 0.6 on 2026-08-11 (the operator approved). The E2
 * interrupt-and-return eval swept this floor against a REAL-capture corpus and counted
 * wrong trust-bearing edges — writes attributed to a task they do not belong to:
 *     0.3 -> 10   0.4 -> 7   0.5 -> 4   0.6 -> 0   0.7 -> 0
 * The four that got through at 0.5 cleared at cosine 0.5464, 0.5464, 0.5180, 0.5955.
 *
 * THIS IS A STOPGAP, NOT THE FIX, and it should be DELETED when D1 lands. Tuning a
 * threshold is the weak version: the anchor is still a GUESS minting a STRONG edge, and
 * no value of this number changes that. D1 demotes the anchor's mint
 * to the weak, non-trust-bearing `related_to`, which makes the bad state unreachable
 * regardless of the threshold. Two things this number does NOT fix, both measured:
 *   - an EMPTY thread ALLOWS UNCONDITIONALLY (`allowed-empty-thread`), so the first
 *     capture after anchoring a fresh task is never gated at ANY floor;
 *   - the gate reads a MAX over the anchored task's existing members, so a task's
 *     admissible topic BROADENS as its thread grows — the gate is loosest exactly where
 *     the thread is longest.
 * Recall cost of the raise was NOT measured (anchor recall at 0.5 was 52.6%); it is
 * accepted deliberately because a wrong trust-bearing edge is the more expensive error.
 */
export const ANCHOR_SIMILARITY_FLOOR: number = assertRange(
  'ANCHOR_SIMILARITY_FLOOR',
  envFloat('MANDREL_ANCHOR_SIM_FLOOR', 0.6),
  0,
  1
);

/**
 * ANCHOR_THIN_MARGIN_DELTA — how far ABOVE the floor a measured anchor similarity must land
 * before the admission stops being called THIN (an earlier decision read-model).
 * An edge admitted at floor+0.001 and one admitted at 0.95 are both "allowed", but they are
 * not equally trustworthy; a thin admission is the honest middle between admit and refuse and
 * is SURFACED so a reader can audit it. It is a DISPLAY signal ONLY — a thin-margin edge is
 * still minted exactly as before (surfacing is the fix; auto-refusing would be a change to
 * what gets linked, which this task explicitly does not do). Env: MANDREL_ANCHOR_THIN_MARGIN.
 * Default 0.05. Must be in [0, 1] (it is a distance between two cosines); 0 disables the
 * signal (nothing can be within 0 of the floor once it has cleared it).
 */
export const ANCHOR_THIN_MARGIN_DELTA: number = assertRange(
  'ANCHOR_THIN_MARGIN_DELTA',
  envFloat('MANDREL_ANCHOR_THIN_MARGIN', 0.05),
  0,
  1
);

/**
 * ANCHOR_PROJECT_FALLBACK_ENABLED — the D2 project-scoped anchor fallback. Default OFF — the
 * crude project-match returns another session's anchor to an anchorless connection (unsafe): a
 * fresh connection that never called thread_set would inherit another session's project anchor
 * and could mint a wrong cross-agent edge. The safe path is exact-match rehydrate (a connection
 * reusing its OWN session_key, which survives reconnect/reattach). Proper orb-reboot resume =
 * a client-declared stable session_key (deferred). Env: MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED
 * can still turn it ON explicitly for a single-agent project that wants the crude rehydrate.
 */
export const ANCHOR_PROJECT_FALLBACK_ENABLED: boolean = envBool(
  'MANDREL_ANCHOR_PROJECT_FALLBACK_ENABLED',
  false
);

/**
 * ANCHOR_STRICT_SESSION_KEYING — refuse a SHARED anchor key instead of
 * silently using one.
 *
 * THE DEFECT THIS CLOSES: the anchor's session key falls back to the CONNECTION id when no
 * DB session is resolved for the connection (handlers/project.ts resolveAnchorKeying), and
 * for every header-less HTTP caller that connection id is the SHARED transport literal
 * ('http-default' / 'default-session'). So two unrelated header-less callers read, merge
 * onto, and clear ONE anchor — the cross-session thread-anchor leak (sibling of the
 * current-project shared-slot leak).
 *
 * ON: a connection with NO resolved DB session (ActiveSessionStore miss) gets NO anchor:
 * thread_set / thread_current / thread_clear fail LOUD with a typed error
 * (ANCHOR_NO_SESSION_IDENTITY, handlers/project.ts AnchorSessionKeyError), and the
 * context_store auto-thread read returns no-anchor (falls through to the B1 no-orphan
 * inference) with the skip SURFACED in the response. Never silently shared.
 *
 * OFF (THE DEFAULT — shipped dark): byte-identical legacy behavior, including
 * the shared-literal fallback, so the fleet is unaffected on the next deploy. The operator
 * tenant enables it explicitly.
 *
 * CALL-TIME READ, deliberately unlike this module's load-time consts: it mirrors
 * actorIdentityConfig.compositeActorEnabled() (the identity-stack read discipline) so tests
 * can exercise both modes without a module reload, and so a tenant flip needs only a
 * process restart, never a rebuild. Env: MANDREL_ANCHOR_STRICT_SESSION_KEYING.
 */
export const ANCHOR_STRICT_SESSION_KEYING_ENV = 'MANDREL_ANCHOR_STRICT_SESSION_KEYING';

/** The shipped default for strict anchor keying: OFF (legacy shared-fallback behavior). */
export const ANCHOR_STRICT_SESSION_KEYING_DEFAULT = false;

export function anchorStrictSessionKeyingEnabled(): boolean {
  // Reuses this module's ONE boolean parse rule (envBool) — read at call time, not load time.
  return envBool(ANCHOR_STRICT_SESSION_KEYING_ENV, ANCHOR_STRICT_SESSION_KEYING_DEFAULT);
}

// ── Inference knobs (spec B2: no-orphan write-time inference) ─────────────────────────

/**
 * INFERENCE_THRESHOLD — the minimum embedding cosine similarity to the nearest non-orphan
 * neighbor at/above which write-time inference mints a weak `related_to` edge (spec B2), so
 * a store with no explicit links + no valid anchor doesn't orphan. Env:
 * MANDREL_INFERENCE_THRESHOLD. Default 0.6 (spec C3 — the auditor measured ~65% of orphans
 * rescuable at cosine ≥ 0.6; a starting default, not gospel). Must be in [0, 1] (a cosine).
 */
export const INFERENCE_THRESHOLD: number = assertRange(
  'INFERENCE_THRESHOLD',
  envFloat('MANDREL_INFERENCE_THRESHOLD', 0.6),
  0,
  1
);

/**
 * INFERENCE_CANDIDATE_LIMIT — how many nearest neighbors inference considers per store (spec
 * B2). Default 1 (mint to the single best neighbor). Env: MANDREL_INFERENCE_CANDIDATE_LIMIT.
 * Must be ≥ 1 (considering zero candidates would make inference a no-op).
 */
export const INFERENCE_CANDIDATE_LIMIT: number = assertRange(
  'INFERENCE_CANDIDATE_LIMIT',
  envInt('MANDREL_INFERENCE_CANDIDATE_LIMIT', 1),
  1,
  Number.MAX_SAFE_INTEGER
);

/**
 * RELIABLE_THREADING_ENABLED — the master kill-switch for the reliable-threading
 * inference/honesty layer (spec A4 honesty gate + B write-time inference). When false, the
 * A4 similarity gate and B inference are SKIPPED entirely: writes revert to the base
 * autoThreadConfig behavior (explicit links / a set anchor's edges only). The durable-anchor
 * persistence itself is unaffected — this switches off the NEW inference/honesty behavior so
 * it can be disabled fast without a redeploy. Env: MANDREL_RELIABLE_THREADING_ENABLED.
 * Default true (the whole point of the build is that writes stop orphaning by default).
 */
export const RELIABLE_THREADING_ENABLED: boolean = envBool(
  'MANDREL_RELIABLE_THREADING_ENABLED',
  true
);

/**
 * The reliable-threading tunables as one object — read once at module load. Mirrors
 * AUTO_THREAD_CONFIG / TRUST_CONFIG so downstream can import the whole config or a single
 * named const. Every field is one of the env-overridable knobs above (single home; no
 * second copy of a default here).
 */
export interface ReliableThreadingConfig {
  /** Master kill-switch for the inference/honesty layer (RELIABLE_THREADING_ENABLED). */
  enabled: boolean;
  /** Anchor validity window in ms (ANCHOR_TTL_MS). */
  anchorTtlMs: number;
  /** Min cosine to reuse an anchor for a trust-bearing edge (ANCHOR_SIMILARITY_FLOOR). */
  anchorSimilarityFloor: number;
  /** Margin above the floor below which an ADMITTED anchor edge is flagged THIN (display-only). */
  anchorThinMarginDelta: number;
  /** D2 project-scoped anchor fallback on/off (ANCHOR_PROJECT_FALLBACK_ENABLED). */
  anchorProjectFallbackEnabled: boolean;
  /** Min cosine to mint an inferred related_to edge (INFERENCE_THRESHOLD). */
  inferenceThreshold: number;
  /** Nearest-neighbor candidates considered per store (INFERENCE_CANDIDATE_LIMIT). */
  inferenceCandidateLimit: number;
}

/** THE LIVE CONFIG — operator-aligned defaults; every field env-overridable (see the consts). */
export const RELIABLE_THREADING_CONFIG: ReliableThreadingConfig = {
  enabled: RELIABLE_THREADING_ENABLED,
  anchorTtlMs: ANCHOR_TTL_MS,
  anchorSimilarityFloor: ANCHOR_SIMILARITY_FLOOR,
  anchorThinMarginDelta: ANCHOR_THIN_MARGIN_DELTA,
  anchorProjectFallbackEnabled: ANCHOR_PROJECT_FALLBACK_ENABLED,
  inferenceThreshold: INFERENCE_THRESHOLD,
  inferenceCandidateLimit: INFERENCE_CANDIDATE_LIMIT,
};
