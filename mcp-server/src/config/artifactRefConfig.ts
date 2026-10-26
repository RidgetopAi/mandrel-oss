/**
 * FIRST-CLASS ARTIFACT REFERENCE — the config
 * (Amp-orb eval Lane C P3).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * THE BOUNDARY THIS PROTECTS (do not erode it)
 * ═══════════════════════════════════════════════════════════════════════════════════
 * MANDREL DOES NOT STORE CODE ARTIFACTS. The outside evaluator confirmed the boundary is
 * HEALTHY: a replacement orchestrator that knew the accepted commit `6acef87…` existed but
 * did NOT possess the Git object still recovered a complete bundle using Mandrel provenance.
 * Nothing here stores a blob, a bundle, or a Git object — this module describes WHERE an
 * artifact lives, WHAT its identity is, and HOW to verify it. The bytes stay outside.
 *
 * THE DEFECT IT CLOSES: that location/identity/verification contract lived in PROSE inside a
 * handoff, so recovery was manual archaeology instead of a deterministic lookup. The fix is a
 * STRUCTURED reference in the metadata the record already carries (see METADATA_KEY below).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * WHY IT RIDES `metadata`, NOT A NEW COLUMN (grounded, 2026-07-25)
 * ═══════════════════════════════════════════════════════════════════════════════════
 * The existing convention already has a home, so we use it rather than inventing a parallel
 * one:
 *   - `metadata` is a first-class tool param on context_store / context_update /
 *     decision_record / task_create / … (10 write boundaries share `baseMetadata`), and the
 *     op registry documents it verbatim as "the tool-native way to carry STRUCTURED
 *     back-links".
 *   - It round-trips: stored as jsonb, MERGE-updated, rendered in the human channel AND
 *     carried in `structuredContent` (outputSchemas contextRecord.metadata) — so the READ
 *     path for an artifact ref already exists and needs no new plumbing.
 *   - Prod already carries ad-hoc provenance there: the control-plane's `kind:'dispatch-proof'`
 *     records (`{branch, commitSha, commitVerified, taskId}`) and the amp-orb eval's own
 *     `{amp_thread_id, amp_thread_url}`. The home is real and in use; what was missing is a
 *     VALIDATED, RESOLVABLE shape.
 *   - Precedent for a config-driven vocabulary over a metadata key: beliefConfig's
 *     `pairExcludeAutoRecordKinds` reads `metadata->>'kind'` from a configured list.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * ═══════════════════════════════════════════════════════════════════════════════════
 * Every knob the artifact-ref machinery touches lives HERE — a named value with a default,
 * a one-line doc comment, and an env override — never a literal buried in the service. The
 * acceptance criterion is explicit about the allowed `retrieval.provider` set being CONFIG,
 * not a hardcoded literal list; the same rule is applied to artifact types, the required-field
 * profiles, the hash algorithm, and the per-provider retrieval hints.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════
 * FAIL-CLOSED BY CONSTRUCTION (a past incident — "unrecognized ⇒ loud RED, never a silent pass")
 * ═══════════════════════════════════════════════════════════════════════════════════
 * A config'd allow-list is only a guard if the UNRECOGNIZED case is a stop. Two rules make
 * that structural here, and both are enforced in services/artifactRef.ts:
 *   1. An `artifactType` is usable only if it is BOTH in `allowedArtifactTypes` AND has a
 *      REQUIRED-FIELD PROFILE below. Env-adding a type without a profile does not silently
 *      admit an unverifiable artifact — it is a loud rejection naming the missing profile.
 *   2. A `retrieval.provider` is usable only if it is BOTH in `allowedProviders` AND has a
 *      LOCATOR RULE below (which field carries the location, and a retrieval hint). Same
 *      reasoning: an env-added provider with no rule cannot describe how to fetch anything,
 *      so admitting it would manufacture exactly the "reads as verified provenance but is
 *      not actionable" record this task exists to prevent.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default), exactly
 * like trustConfig.ts / beliefConfig.ts.
 */

/** Read a comma-separated string-list env var, else `fallback`. */
function envStrList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/** Read a positive-integer env var, else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a non-empty string env var, else `fallback`. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/**
 * Read a REGEX-SOURCE env var, else `fallback`. A pattern that does not compile falls back to
 * the default — a broken env var must never silently disable a safety guard (fail-closed to
 * the shipped rule, not open to "match anything").
 */
function envPattern(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const candidate = raw.trim();
  try {
    anchoredPattern(candidate);
  } catch {
    return fallback; // does not compile → keep the shipped rule
  }
  // SELF-PROBE — refuse a candidate that COMPILES but does not CONSTRAIN.
  //
  // (Comment corrected: an earlier version of this block claimed anchoredPattern "closes that
  // by double-wrapping". It does not — no amount of wrapping does, because the injected parens
  // re-balance. See LOCATOR_CHARSET_FLOOR for the measurement. The floor is the guarantee;
  // this probe is a second, independent line that stops a useless pattern from ever being
  // ADOPTED in the first place, so a misconfiguration is caught at load rather than silently
  // relying on the floor to carry every value.)
  //
  // A candidate that admits a known-bad string is refused and the shipped default stands.
  const re = anchoredPattern(candidate);
  if (PATTERN_MUST_REJECT.some((bad) => re.test(bad))) return fallback;
  return candidate;
}

/**
 * Strings any locator/identity charset pattern MUST reject. These are the actual injection
 * shapes this guard exists to stop, so a pattern that admits one is not a charset — it is a
 * hole with a regex around it.
 */
const PATTERN_MUST_REJECT: readonly string[] = [
  'x.bundle; rm -rf /tmp/pwned; echo ',
  'a`id`b',
  'a$(id)b',
  "a'; touch /tmp/x; echo '",
  'a b',
  'a\nb',
];

/**
 * THE STRUCTURAL FLOOR — the guarantee no configuration can weaken.
 *
 * WHY THIS EXISTS RATHER THAN A CLEVERER WRAP. The review proposed closing the anchor escape
 * (`pattern = 'x)|(.*'`) by double-wrapping. MEASURED — it does not work, and cannot:
 *   ^(?:x)|(.*)$        admits the payload
 *   ^(?:(?:x)|(.*))$    admits the payload
 *   ^(?:(?:(?:x)|(.*))) $  admits the payload
 * The injected `)` and `(` simply re-balance inside whatever wrapping you add, so the
 * alternation stays top-level relative to the anchors. WRAPPING IS STRUCTURALLY INCAPABLE of
 * constraining an attacker-supplied regex — any guarantee resting on it is a guarantee resting
 * on the attacker's goodwill.
 *
 * So the floor is not a regex we build around theirs; it is a rule they cannot reach: a
 * NON-CONFIGURABLE allow-list every locator/provenance value must satisfy IN ADDITION to the
 * configured pattern. Configuration can therefore only ever NARROW what is accepted, never
 * widen it — which is the property the header used to claim and the code did not have.
 */
export const LOCATOR_CHARSET_FLOOR = /^[A-Za-z0-9._~:@=+/-]+$/;

/**
 * Compile a configured charset pattern as an anchored full-string match.
 *
 * NOTE ON WHAT THIS DOES AND DOES NOT GUARANTEE (the header used to overclaim): the wrapping
 * anchors a WELL-FORMED pattern, which is all it is for. It does NOT make a HOSTILE pattern
 * safe — see LOCATOR_CHARSET_FLOOR above for the measurement and the actual guarantee.
 *
 * SINGLE SOURCE: exported and used by BOTH the config's env self-probe and the validator, so
 * the anchoring rule cannot exist in two copies that drift (it did).
 */
export function anchoredPattern(pattern: string): RegExp {
  return new RegExp(`^(?:(?:${pattern}))$`);
}

/**
 * The REQUIRED-FIELD PROFILE for one artifact type: which fields must be present for the
 * reference to describe a *verifiable* artifact, and which identity check is load-bearing.
 */
export interface ArtifactTypeProfile {
  /** Ref fields that MUST be present and non-empty for this type (beyond artifactType/retrieval). */
  requiredFields: string[];
  /**
   * Fields that carry a GIT REVISION (hex sha-1/sha-256) and are shape-checked as such when
   * present. Listing a field here does not make it required — `requiredFields` does that.
   */
  revisionFields: string[];
  /**
   * The identity fields a consumer MUST observe-and-match before the artifact may be accepted.
   * THE FAIL-CLOSED CORE: if a consumer cannot produce an observed value for every field in
   * this list, verification is NOT satisfied — it is BLOCKED. "Could not check" is never
   * "probably fine".
   */
  verifyFields: string[];
  /** Human/agent-actionable verification steps, `{placeholder}` substituted from the ref. */
  verifySteps: string[];
}

/**
 * The LOCATOR RULE for one retrieval provider: which ref field carries the location, and the
 * one-line instruction that turns the reference into an actual fetch.
 */
export interface ProviderRule {
  /** The `retrieval` field that carries this provider's locator (e.g. 'path' or 'uri'). */
  locatorField: string;
  /**
   * Ref fields this provider's hint REFERENCES and therefore requires. Without this, a hint can
   * name a field the artifact type does not require (`tarball` + `git-remote` → `<unset:head>`)
   * and emit a non-runnable instruction. Declaring it here makes the write boundary reject the
   * nonsense COMBINATION instead of the resolver emitting a broken line.
   */
  requiredRefFields: string[];
  /** Retrieval instruction, `{placeholder}` substituted from the ref (see artifactRef.ts). */
  hint: string;
}

export interface ArtifactRefConfig {
  /**
   * The reserved METADATA KEY that carries artifact references — an ARRAY of references on
   * any record whose `metadata` is written. Named here so the validator, the resolver, the
   * tool, and the docs can never drift. Env: MANDREL_ARTIFACT_REF_METADATA_KEY. Default
   * 'artifacts'.
   */
  metadataKey: string;
  /**
   * Max references on a single record — an anti-abuse bound, not a product limit (a record
   * describing more than a handful of artifacts is a smell, not a use case).
   * Env: MANDREL_ARTIFACT_REF_MAX_PER_RECORD. Default 16.
   */
  maxRefsPerRecord: number;
  /**
   * THE ALLOWED `retrieval.provider` SET (the acceptance criterion's named config). A provider
   * outside this list is REJECTED at the write boundary. Every entry must also have a
   * PROVIDER_RULES row or it is rejected anyway (fail-closed, see the header).
   * Env (comma-separated): MANDREL_ARTIFACT_REF_ALLOWED_PROVIDERS.
   * Default ['amp-thread-file','git-remote','https','local-path'].
   */
  allowedProviders: string[];
  /**
   * THE ALLOWED `artifactType` SET. A type outside this list is REJECTED at the write boundary.
   * Every entry must also have an ARTIFACT_TYPE_PROFILES row or it is rejected (fail-closed).
   * Env (comma-separated): MANDREL_ARTIFACT_REF_ALLOWED_TYPES.
   * Default ['git-bundle','git-commit','tarball','file'].
   */
  allowedArtifactTypes: string[];
  /**
   * The content-hash algorithm the `sha256` field carries. Named so a future migration to a
   * different digest is a config change plus a profile change, not a grep.
   * Env: MANDREL_ARTIFACT_REF_HASH_ALGORITHM. Default 'sha256'.
   */
  hashAlgorithm: string;
  /** Expected hex length of a `hashAlgorithm` digest. Env: MANDREL_ARTIFACT_REF_HASH_HEX_LENGTH. Default 64. */
  hashHexLength: number;
  /**
   * Minimum accepted length of a git revision hex string. Short prefixes are ambiguous, and an
   * ambiguous identity is not an identity — 7 is git's own conventional abbreviation floor.
   * Env: MANDREL_ARTIFACT_REF_MIN_REV_HEX. Default 7.
   */
  minRevisionHexLength: number;
  /** Maximum accepted git revision hex length (sha-256 git objects are 64). Env: MANDREL_ARTIFACT_REF_MAX_REV_HEX. Default 64. */
  maxRevisionHexLength: number;
  /** Max length of a free-form string field (repository/path/uri/producerThread) — anti-abuse. Env: MANDREL_ARTIFACT_REF_MAX_FIELD_LENGTH. Default 512. */
  maxFieldLength: number;

  /* ═══════════════════════════════════════════════════════════════════════════════════════
   * LOCATOR SAFETY — the charset/scheme allow-lists (an earlier task re-work, Reviewer F3).
   *
   * THE THREAT, stated plainly: the strings below are substituted into instructions that an
   * AUTONOMOUS AGENT is expected to follow WITHOUT a human reading them. That makes this a
   * command-construction surface. Validated only for non-emptiness, a locator like
   * `x.bundle; rm -rf /tmp/pwned; echo ` emits as a runnable payload wearing the authority of
   * a verification step — strictly WORSE than the prose-in-a-handoff status quo it replaces,
   * because the output now carries machine authority. Anyone who can write a record's metadata
   * could plant it.
   *
   * DEFENCE IN DEPTH — these patterns are defence 1 of 2. Defence 2 (shell-quoting every
   * record-derived value at emission, services/artifactRef.ts) is INDEPENDENT on purpose:
   * these patterns are env-overridable, so widening one by config must not be able to re-open
   * the hole on its own.
   *
   * WHAT IS ACTUALLY GUARANTEED (stated precisely, because the earlier wording overclaimed):
   * a value must satisfy BOTH the non-configurable LOCATOR_CHARSET_FLOOR *and* the configured
   * pattern below. Configuration can therefore only NARROW what is accepted, never widen it.
   * Wrapping a hostile pattern does NOT constrain it (measured — see LOCATOR_CHARSET_FLOOR),
   * so the floor, not the anchoring, is what holds. Belt and braces on top: a candidate env
   * pattern that fails to compile, or that still admits a PATTERN_MUST_REJECT string, is
   * refused at load and the shipped default stands.
   * ═══════════════════════════════════════════════════════════════════════════════════════ */

  /**
   * Allowed charset for a `retrieval.path` locator. Deliberately tight: path characters only,
   * no whitespace and no shell metacharacters. Env: MANDREL_ARTIFACT_REF_PATH_PATTERN.
   */
  locatorPathPattern: string;
  /** Allowed charset for `repository` (an org/repo slug). Env: MANDREL_ARTIFACT_REF_REPOSITORY_PATTERN. */
  repositoryPattern: string;
  /** Allowed charset for `producerThread` (a thread id or a branch name). Env: MANDREL_ARTIFACT_REF_PRODUCER_PATTERN. */
  producerThreadPattern: string;
  /**
   * URL schemes a `retrieval.uri` may use. The uri must PARSE as a URL and carry one of these
   * — so `file:` (local exfil target) and `javascript:` are refused even though they parse.
   * Env (comma-separated): MANDREL_ARTIFACT_REF_URI_SCHEMES. Default ['https','ssh','git'].
   */
  allowedUriSchemes: string[];
}

/**
 * THE LIVE CONFIG — read once at module load.
 */
export const ARTIFACT_REF_CONFIG: ArtifactRefConfig = {
  metadataKey: envStr('MANDREL_ARTIFACT_REF_METADATA_KEY', 'artifacts'),
  maxRefsPerRecord: envInt('MANDREL_ARTIFACT_REF_MAX_PER_RECORD', 16),
  allowedProviders: envStrList('MANDREL_ARTIFACT_REF_ALLOWED_PROVIDERS', [
    // The provider the eval's own recovery used: a file attached to the producing Amp thread.
    'amp-thread-file',
    // A git remote that can serve the object directly (fetch by rev).
    'git-remote',
    // A plain HTTPS-reachable artifact (release asset, object store URL).
    'https',
    // A path on the producing host — honest about being host-local (weakest provider).
    'local-path',
  ]),
  allowedArtifactTypes: envStrList('MANDREL_ARTIFACT_REF_ALLOWED_TYPES', [
    'git-bundle',
    'git-commit',
    'tarball',
    'file',
  ]),
  hashAlgorithm: envStr('MANDREL_ARTIFACT_REF_HASH_ALGORITHM', 'sha256'),
  hashHexLength: envInt('MANDREL_ARTIFACT_REF_HASH_HEX_LENGTH', 64),
  minRevisionHexLength: envInt('MANDREL_ARTIFACT_REF_MIN_REV_HEX', 7),
  maxRevisionHexLength: envInt('MANDREL_ARTIFACT_REF_MAX_REV_HEX', 64),
  maxFieldLength: envInt('MANDREL_ARTIFACT_REF_MAX_FIELD_LENGTH', 512),
  // Path characters only — letters, digits, and . _ - / + @ : = ~ — with no whitespace and no
  // shell metacharacter (; & | $ ` ( ) < > * ? ! # ' " \ or newline) anywhere in the set.
  locatorPathPattern: envPattern('MANDREL_ARTIFACT_REF_PATH_PATTERN', '[A-Za-z0-9._~:@=+/-]+'),
  // An org/repo slug (optionally host-qualified), nothing else.
  repositoryPattern: envPattern('MANDREL_ARTIFACT_REF_REPOSITORY_PATTERN', '[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*'),
  // A thread id (T-019f…) or a branch name (builder/caf5f00d-artifact-ref).
  producerThreadPattern: envPattern('MANDREL_ARTIFACT_REF_PRODUCER_PATTERN', '[A-Za-z0-9._~:@=+/-]+'),
  allowedUriSchemes: envStrList('MANDREL_ARTIFACT_REF_URI_SCHEMES', ['https', 'ssh', 'git']),
};

/**
 * REQUIRED-FIELD PROFILES per artifact type — the "what must be true for this to be a
 * verifiable artifact" contract. A type with no profile here is UNUSABLE even if it is in
 * `allowedArtifactTypes` (fail-closed).
 *
 * `{placeholder}` tokens in verifySteps are substituted from the reference at resolve time.
 */
export const ARTIFACT_TYPE_PROFILES: Readonly<Record<string, ArtifactTypeProfile>> = {
  /**
   * A `git bundle` FILE — the eval's own case. Identity is BOTH the file digest (the bytes you
   * fetched are the bytes that were accepted) AND the head revision (the bundle contains the
   * commit that was accepted). Both are required: a matching digest with an unexpected head is
   * still the wrong artifact.
   */
  'git-bundle': {
    requiredFields: ['repository', 'head', 'sha256'],
    revisionFields: ['head', 'base'],
    verifyFields: ['sha256', 'head'],
    verifySteps: [
      '{hashAlgorithm}sum {locator}  # MUST equal {sha256} — any difference BLOCKS acceptance',
      'git bundle verify {locator}   # bundle must be well-formed and its prerequisites satisfied',
      'git bundle list-heads {locator}  # MUST contain {head}',
    ],
  },
  /**
   * A commit reachable in a git REPOSITORY (no file to digest). Identity is the revision itself;
   * git's own object hashing is the integrity check, so `sha256` is not applicable.
   */
  'git-commit': {
    requiredFields: ['repository', 'head'],
    revisionFields: ['head', 'base'],
    verifyFields: ['head'],
    verifySteps: [
      'git -C <clone> cat-file -e {head}^{commit}  # the commit MUST exist after fetching',
      'git -C <clone> rev-parse {head}  # MUST resolve to exactly {head}',
    ],
  },
  /** A tar/tar.gz archive. Identity is the file digest. */
  tarball: {
    requiredFields: ['sha256'],
    revisionFields: ['head', 'base'],
    verifyFields: ['sha256'],
    verifySteps: ['{hashAlgorithm}sum {locator}  # MUST equal {sha256} — any difference BLOCKS acceptance'],
  },
  /** Any single opaque file. Identity is the file digest. */
  file: {
    requiredFields: ['sha256'],
    revisionFields: ['head', 'base'],
    verifyFields: ['sha256'],
    verifySteps: ['{hashAlgorithm}sum {locator}  # MUST equal {sha256} — any difference BLOCKS acceptance'],
  },
};

/**
 * LOCATOR RULES per provider — which `retrieval` field carries the location and how to fetch
 * it. A provider with no rule here is UNUSABLE even if it is in `allowedProviders`
 * (fail-closed).
 */
export const PROVIDER_RULES: Readonly<Record<string, ProviderRule>> = {
  'amp-thread-file': {
    locatorField: 'path',
    // The producing thread IS the address here — without it the instruction names no source.
    requiredRefFields: ['producerThread'],
    hint: 'Fetch the file {locator} from the PRODUCING thread {producerThread} (Amp thread file attachment). The producing thread is the authoritative source; do not reconstruct the artifact by hand.',
  },
  'git-remote': {
    locatorField: 'uri',
    // `git fetch <remote> <rev>` needs the rev; a git remote without a repository identity is
    // not a git remote. Declaring both here is what makes `tarball + git-remote` (which cannot
    // name a rev) a REJECTED combination rather than an `<unset:head>` instruction.
    requiredRefFields: ['repository', 'head'],
    hint: 'git fetch {locator} {head}  # fetch the object directly from the remote (repository {repository})',
  },
  https: {
    locatorField: 'uri',
    // Deliberately references NOTHING but the locator: an HTTPS artifact need not belong to a
    // repository, and a hint must never require more than the combination guarantees.
    requiredRefFields: [],
    hint: 'Download {locator} over HTTPS.',
  },
  'local-path': {
    locatorField: 'path',
    requiredRefFields: [],
    hint: 'Read {locator} on the PRODUCING HOST. Host-local: if you are not on that host this reference is not retrievable and acceptance must stop rather than substitute another copy.',
  },
};

/**
 * The effective, FAIL-CLOSED provider set: allowed AND has a locator rule. Exported so the
 * validator, the tool's error messages, and the tests all read the same derived truth.
 */
export function effectiveProviders(cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG): string[] {
  return cfg.allowedProviders.filter((p) => Object.prototype.hasOwnProperty.call(PROVIDER_RULES, p));
}

/** The effective, FAIL-CLOSED artifact-type set: allowed AND has a required-field profile. */
export function effectiveArtifactTypes(cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG): string[] {
  return cfg.allowedArtifactTypes.filter((t) =>
    Object.prototype.hasOwnProperty.call(ARTIFACT_TYPE_PROFILES, t),
  );
}
