/**
 * FIRST-CLASS ARTIFACT REFERENCE — the service.
 *
 * Three pure capabilities over a structured EXTERNAL-artifact reference stored in a record's
 * `metadata` (see config/artifactRefConfig.ts for the shape's home + every tunable):
 *
 *   1. validate  — is this reference well-formed and actionable? Used at the WRITE BOUNDARY,
 *                  where a malformed reference is REJECTED, loudly. A silently-accepted bad
 *                  artifact ref is worse than no ref, because it READS AS VERIFIED PROVENANCE.
 *   2. resolve   — turn a stored reference into: source, expected identity (hash/head/base),
 *                  and RETRIEVAL INSTRUCTIONS. This is what replaces manual archaeology.
 *   3. verify    — adjudicate an OBSERVED identity against the expected one, FAIL-CLOSED.
 *                  A mismatch BLOCKS acceptance. A missing observation is NOT acceptance
 *                  either ("could not check" is never "probably fine"). There is deliberately
 *                  no "warning" verdict: the only way to reach `accepted:true` is that every
 *                  identity field the type declares was observed AND matched.
 *
 * MANDREL STILL NEVER STORES GIT. Nothing in this module reads, writes, fetches, or hashes an
 * artifact — it has no filesystem and no network access by construction. It describes and
 * adjudicates; the bytes live outside, exactly as the evaluator confirmed they should.
 */

import {
  ARTIFACT_REF_CONFIG,
  ARTIFACT_TYPE_PROFILES,
  PROVIDER_RULES,
  LOCATOR_CHARSET_FLOOR,
  anchoredPattern,
  effectiveArtifactTypes,
  effectiveProviders,
  type ArtifactRefConfig,
  type ProviderRule,
} from '../config/artifactRefConfig.js';

/** The retrieval half of a reference: WHERE the artifact can be fetched from. */
export interface ArtifactRetrieval {
  /** Provider key — must be in the configured, rule-backed provider set. */
  provider: string;
  /** Path locator (providers whose locatorField is 'path'). */
  path?: string;
  /** URI locator (providers whose locatorField is 'uri'). */
  uri?: string;
}

/** What a CONSUMER actually measured after fetching the artifact. */
export interface ArtifactObserved {
  sha256?: string;
  head?: string;
}

/** A structured reference to an artifact that lives OUTSIDE Mandrel. */
export interface ArtifactRef {
  artifactType: string;
  repository?: string;
  head?: string;
  base?: string;
  sha256?: string;
  producerThread?: string;
  retrieval: ArtifactRetrieval;
  /** Optional consumer observation. Its PRESENCE is a verification claim, checked at write. */
  observed?: ArtifactObserved;
}

/** One identity check performed by verifyArtifactRef. */
export interface ArtifactCheck {
  field: string;
  expected: string | null;
  observed: string | null;
  /**
   * 'match'        — observed and equal.
   * 'mismatch'     — observed and CONTRADICTING. The loud stop.
   * 'not-observed' — nothing was supplied for this field.
   * 'inconclusive' — something WAS supplied but could not confirm the expectation (e.g. an
   *                  abbreviation shorter than the expected revision). Distinct from
   *                  'not-observed' on purpose: reporting a supplied value as "not observed"
   *                  reads as the caller's omission when it was actually our inability.
   */
  result: 'match' | 'mismatch' | 'not-observed' | 'inconclusive';
}

export interface ArtifactVerdict {
  /**
   * 'verified'   — every declared identity field observed AND matched.
   * 'unverified' — nothing contradicts, but at least one declared field was not observed.
   * 'blocked'    — an observed value CONTRADICTS the expected one. A wrong artifact.
   */
  status: 'verified' | 'unverified' | 'blocked';
  /**
   * THE FAIL-CLOSED GATE. True ONLY for status 'verified'. Derived here (never assembled by a
   * caller) so no consumer can accidentally accept on a partial or contradicted check.
   */
  accepted: boolean;
  reason: string;
  checks: ArtifactCheck[];
}

export interface ResolvedArtifact {
  artifactType: string;
  /** Stated in the payload so the boundary travels with the answer. Always false. */
  storesArtifactBytes: false;
  source: {
    repository: string | null;
    producerThread: string | null;
    provider: string;
    locatorField: string;
    locator: string;
  };
  identity: {
    head: string | null;
    base: string | null;
    sha256: string | null;
    hashAlgorithm: string;
  };
  retrieval: {
    provider: string;
    locator: string;
    instructions: string[];
  };
  verification: {
    /** Always true — a mismatch blocks; there is no advisory mode. */
    failClosed: true;
    /** The identity fields that MUST be observed and matched before acceptance. */
    mustObserve: string[];
    steps: string[];
    verdict: ArtifactVerdict;
    /**
     * An observation the WRITER recorded on the reference. Reported for provenance only and
     * NEVER fed to the verdict — see the F2 note in resolveArtifactRef. Absent unless the
     * stored reference carries one.
     */
    priorClaim?: {
      sha256: string | null;
      head: string | null;
      note: string;
    };
  };
}

export type ValidationResult =
  | { ok: true; ref: ArtifactRef }
  | { ok: false; errors: string[] };

const HEX_RE = /^[0-9a-f]+$/i;

/**
 * The identity fields a reference can carry — i.e. the fields that can ever be VERIFIED.
 * `repository` / `producerThread` are deliberately absent: they are provenance labels, not
 * identity, and no type verifies them.
 */
const IDENTITY_FIELDS = ['sha256', 'head', 'base'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty string within the configured field-length bound. */
function isUsableString(v: unknown, cfg: ArtifactRefConfig): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= cfg.maxFieldLength;
}

/**
 * Full-string match against a configured charset pattern. A pattern that fails to compile is
 * treated as NO MATCH (fail-closed): a broken config must reject values, never wave them through.
 */
function matchesPattern(value: string, pattern: string): boolean {
  // THE FLOOR FIRST, and it is not negotiable by configuration. A configured pattern can only
  // ever NARROW what is accepted — never widen it — because a hostile pattern cannot be made
  // safe by wrapping (measured; see LOCATOR_CHARSET_FLOOR). This ordering is the entire
  // guarantee: config tightens, config never loosens.
  if (!LOCATOR_CHARSET_FLOOR.test(value)) return false;
  try {
    // anchoredPattern() is the SINGLE definition of "anchored full-string match" — shared with
    // the config's env self-probe so the two cannot drift (they did: both carried the same
    // `^(?:p)$` alternation escape).
    return anchoredPattern(pattern).test(value);
  } catch {
    return false;
  }
}

/** Validate a `retrieval.uri`: must parse as a URL and use an allow-listed scheme. */
function uriErrors(value: string, path: string, cfg: ArtifactRefConfig): string[] {
  // Whitespace/control characters never belong in a URI and are the classic smuggling vector.
  // Written as EXPLICIT \u escapes: raw control bytes in source are invisible in a diff/review
  // (they render as spaces, which reads like a hyphen range that would reject every URL).
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return [`${path}: must not contain whitespace or control characters`];
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [
      `${path}: must be a parseable absolute URL (e.g. https://host/org/repo.git or ` +
        `ssh://git@host/org/repo.git). scp-style "git@host:org/repo.git" is NOT a URL — use the ssh:// form`,
    ];
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!cfg.allowedUriSchemes.includes(scheme)) {
    return [`${path}: scheme "${scheme}" is not allowed — allowed: [${cfg.allowedUriSchemes.join(', ')}]`];
  }
  return [];
}

/**
 * VALIDATE one artifact reference. Returns every problem found (not just the first) so a
 * rejected write tells the writer everything that is wrong in one pass.
 *
 * Fail-closed on the two allow-lists: a type/provider is usable only if it is BOTH configured
 * AND rule-backed (see artifactRefConfig's header) — an env-added name with no profile/rule is
 * a loud rejection, never a silent admission.
 */
export function validateArtifactRef(
  raw: unknown,
  cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG,
  path = 'artifact',
): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${path}: must be an object (got ${raw === null ? 'null' : typeof raw})`] };
  }

  // ── artifactType ───────────────────────────────────────────────────────────────────
  const artifactType = raw.artifactType;
  const usableTypes = effectiveArtifactTypes(cfg);
  if (!isUsableString(artifactType, cfg)) {
    errors.push(`${path}.artifactType: required, must be one of [${usableTypes.join(', ')}]`);
  } else if (!cfg.allowedArtifactTypes.includes(artifactType)) {
    errors.push(
      `${path}.artifactType: "${artifactType}" is not an allowed artifact type — allowed: [${usableTypes.join(', ')}]`,
    );
  } else if (!Object.prototype.hasOwnProperty.call(ARTIFACT_TYPE_PROFILES, artifactType)) {
    // Configured but rule-less: fail CLOSED, and say exactly why.
    errors.push(
      `${path}.artifactType: "${artifactType}" is allowed by config but has NO required-field profile ` +
        `(ARTIFACT_TYPE_PROFILES) — it cannot describe a verifiable artifact, so it is rejected. ` +
        `Add a profile before allowing the type.`,
    );
  }

  const profile = typeof artifactType === 'string' ? ARTIFACT_TYPE_PROFILES[artifactType] : undefined;

  // ── retrieval ──────────────────────────────────────────────────────────────────────
  const retrieval = raw.retrieval;
  const usableProviders = effectiveProviders(cfg);
  let providerRule: ProviderRule | undefined;
  if (!isPlainObject(retrieval)) {
    errors.push(`${path}.retrieval: required object {provider, path|uri}`);
  } else {
    const provider = retrieval.provider;
    if (!isUsableString(provider, cfg)) {
      errors.push(`${path}.retrieval.provider: required, must be one of [${usableProviders.join(', ')}]`);
    } else if (!cfg.allowedProviders.includes(provider)) {
      errors.push(
        `${path}.retrieval.provider: "${provider}" is not an allowed provider — allowed: [${usableProviders.join(', ')}]`,
      );
    } else if (!Object.prototype.hasOwnProperty.call(PROVIDER_RULES, provider)) {
      errors.push(
        `${path}.retrieval.provider: "${provider}" is allowed by config but has NO locator rule ` +
          `(PROVIDER_RULES) — there is no way to fetch it, so it is rejected. Add a rule before allowing it.`,
      );
    } else {
      providerRule = PROVIDER_RULES[provider];
      const locatorField = providerRule.locatorField;
      const locator = (retrieval as Record<string, unknown>)[locatorField];
      if (!isUsableString(locator, cfg)) {
        errors.push(
          `${path}.retrieval.${locatorField}: required for provider "${provider}" ` +
            `(non-empty, ≤ ${cfg.maxFieldLength} chars) — a reference with no locator is not retrievable`,
        );
      } else if (locatorField === 'uri') {
        // A uri must PARSE as a URL and carry an allow-listed scheme, so `file:` (a local
        // exfil/overwrite target) and `javascript:` are refused even though they parse.
        errors.push(...uriErrors(locator, `${path}.retrieval.${locatorField}`, cfg));
      } else if (!matchesPattern(locator, cfg.locatorPathPattern)) {
        errors.push(
          `${path}.retrieval.${locatorField}: contains characters outside the allowed set ` +
            `(/${cfg.locatorPathPattern}/) — this locator is substituted into instructions an agent ` +
            `executes, so whitespace and shell metacharacters are refused`,
        );
      }

      // The provider's HINT references these fields; without them it emits a non-runnable
      // instruction (`<unset:head>`). Reject the nonsense COMBINATION at the boundary instead.
      for (const field of providerRule.requiredRefFields) {
        if (!isUsableString(raw[field], cfg)) {
          errors.push(
            `${path}.${field}: required by retrieval provider "${provider}" — its retrieval ` +
              `instruction references it, so without it the reference cannot describe how to fetch anything`,
          );
        }
      }
    }
  }

  // ── required identity fields for this type ─────────────────────────────────────────
  if (profile) {
    for (const field of profile.requiredFields) {
      if (!isUsableString(raw[field], cfg)) {
        errors.push(
          `${path}.${field}: required for artifactType "${artifactType}" ` +
            `(non-empty, ≤ ${cfg.maxFieldLength} chars)`,
        );
      }
    }
  }

  // ── shape of the identity fields ───────────────────────────────────────────────────
  if (raw.sha256 !== undefined) {
    const v = raw.sha256;
    if (typeof v !== 'string' || !HEX_RE.test(v) || v.length !== cfg.hashHexLength) {
      errors.push(
        `${path}.sha256: must be a ${cfg.hashHexLength}-char hex ${cfg.hashAlgorithm} digest`,
      );
    }
  }
  // ── N-B (half 1): a reference may not carry an identity field its TYPE does not verify ──
  // A `git-commit` ref carrying a `sha256` looks like verifiable identity and is not: nothing
  // ever checks it. Left admissible, it invites a caller to measure and submit that hash, and
  // the measurement then evaporates against a contract that never asked for it — the F1 class
  // (a supplied measurement silently discarded) reintroduced through the DATA instead of the
  // control flow. Refuse the field at the boundary so the situation cannot arise.
  if (profile) {
    const known = new Set([...profile.requiredFields, ...profile.revisionFields, ...profile.verifyFields]);
    for (const field of IDENTITY_FIELDS) {
      if (raw[field] !== undefined && !known.has(field)) {
        errors.push(
          `${path}.${field}: artifactType "${artifactType}" has no verification contract for it ` +
            `(it verifies [${profile.verifyFields.join(', ')}]) — a field nothing checks reads as ` +
            `identity without being identity, so it is refused rather than carried`,
        );
      }
    }
  }

  const revisionFields = profile?.revisionFields ?? ['head', 'base'];
  for (const field of revisionFields) {
    const v = raw[field];
    if (v === undefined) continue;
    if (
      typeof v !== 'string' ||
      !HEX_RE.test(v) ||
      v.length < cfg.minRevisionHexLength ||
      v.length > cfg.maxRevisionHexLength
    ) {
      errors.push(
        `${path}.${field}: must be a hex git revision of ${cfg.minRevisionHexLength}–${cfg.maxRevisionHexLength} chars ` +
          `(an abbreviation shorter than ${cfg.minRevisionHexLength} is ambiguous, and an ambiguous identity is not an identity)`,
      );
    }
  }
  // ── LOCATOR SAFETY, defence 1 of 2 (Reviewer F3) ──────────────────────────────────
  // These strings are substituted into instructions an autonomous agent follows without a
  // human reading them, so "non-empty and ≤512 chars" is not a validation — it is an
  // injection surface. Constrain the CHARSET here (and quote at emission: defence 2).
  for (const [field, pattern] of [
    ['repository', cfg.repositoryPattern],
    ['producerThread', cfg.producerThreadPattern],
  ] as const) {
    const v = raw[field];
    if (v === undefined) continue;
    if (!isUsableString(v, cfg)) {
      errors.push(`${path}.${field}: must be a non-empty string ≤ ${cfg.maxFieldLength} chars`);
    } else if (!matchesPattern(v, pattern)) {
      errors.push(
        `${path}.${field}: contains characters outside the allowed set (/${pattern}/) — ` +
          `this value is substituted into instructions an agent executes, so a shell metacharacter is refused`,
      );
    }
  }

  // ── observed (a verification CLAIM — shape-checked here, adjudicated below) ─────────
  if (raw.observed !== undefined) {
    if (!isPlainObject(raw.observed)) {
      errors.push(`${path}.observed: must be an object {sha256?, head?} of MEASURED values`);
    } else {
      const obs = raw.observed;
      if (obs.sha256 !== undefined) {
        const v = obs.sha256;
        if (typeof v !== 'string' || !HEX_RE.test(v) || v.length !== cfg.hashHexLength) {
          errors.push(`${path}.observed.sha256: must be a ${cfg.hashHexLength}-char hex ${cfg.hashAlgorithm} digest`);
        }
      }
      if (obs.head !== undefined) {
        const v = obs.head;
        if (
          typeof v !== 'string' ||
          !HEX_RE.test(v) ||
          v.length < cfg.minRevisionHexLength ||
          v.length > cfg.maxRevisionHexLength
        ) {
          errors.push(
            `${path}.observed.head: must be a hex git revision of ${cfg.minRevisionHexLength}–${cfg.maxRevisionHexLength} chars`,
          );
        }
      }
      if (obs.sha256 === undefined && obs.head === undefined) {
        errors.push(
          `${path}.observed: present but empty — omit it entirely rather than claiming an observation that was not made`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, ref: raw as unknown as ArtifactRef };
}

/**
 * Validate the artifact references carried in a record's `metadata`, returning every error.
 * An empty array is returned when the metadata carries no artifact references at all — this
 * function is the ONLY gate the write boundary needs.
 *
 * `null` under the key is ALLOWED: the context_update path treats a null metadata value as a
 * DELETE sentinel (metadataMerge), and deleting a reference must stay possible.
 */
export function validateMetadataArtifactRefs(
  metadata: unknown,
  cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG,
): string[] {
  if (!isPlainObject(metadata)) return [];
  if (!Object.prototype.hasOwnProperty.call(metadata, cfg.metadataKey)) return [];

  const value = metadata[cfg.metadataKey];
  if (value === null) return []; // delete sentinel — not a malformed reference

  const key = cfg.metadataKey;
  if (!Array.isArray(value)) {
    return [
      `metadata.${key}: must be an ARRAY of artifact references (got ${typeof value}). ` +
        `Wrap a single reference in an array: {"${key}": [ {...} ]}`,
    ];
  }
  if (value.length > cfg.maxRefsPerRecord) {
    return [`metadata.${key}: at most ${cfg.maxRefsPerRecord} artifact references per record (got ${value.length})`];
  }

  const errors: string[] = [];
  value.forEach((raw, i) => {
    const result = validateArtifactRef(raw, cfg, `metadata.${key}[${i}]`);
    if (!result.ok) {
      errors.push(...result.errors);
      return;
    }
    // A reference that CLAIMS an observation must not contradict its own expected identity.
    // This is the write-boundary half of the fail-closed rule: Mandrel will not persist a
    // record asserting a verified artifact whose measured identity disagrees.
    const verdict = verifyArtifactRef(result.ref, result.ref.observed, cfg);
    if (verdict.status === 'blocked') {
      errors.push(
        `metadata.${key}[${i}]: ${verdict.reason} — this reference contradicts itself and is REJECTED. ` +
          `A record that reads as verified provenance but points at a different artifact is worse than no record.`,
      );
    }
  });
  return errors;
}

/**
 * Compare an expected identity value against an observed one.
 *
 * DIGESTS: exact, case-insensitive.
 * GIT REVISIONS: the EXPECTED value (which may legitimately be an abbreviation — the eval's own
 * reference reads `"head": "6acef87…"`) must be a PREFIX of, or equal to, the OBSERVED value
 * (which comes from `git rev-parse` / `git bundle list-heads` and is full-length). The reverse
 * is deliberately NOT accepted: an observation SHORTER than the expectation cannot confirm it,
 * so it reports as not-observed rather than as a match. Fail-closed in the only direction that
 * matters.
 */
function compareIdentity(
  field: string,
  expected: string | undefined,
  observed: string | undefined,
  isRevision: boolean,
): ArtifactCheck {
  if (expected === undefined || expected === null || observed === undefined || observed === null) {
    return { field, expected: expected ?? null, observed: observed ?? null, result: 'not-observed' };
  }
  const e = expected.toLowerCase();
  const o = observed.toLowerCase();
  if (isRevision) {
    if (o.length < e.length) {
      // Too short to confirm — NOT a match, NOT a mismatch, and NOT the caller staying silent.
      return { field, expected, observed, result: 'inconclusive' };
    }
    return { field, expected, observed, result: o.startsWith(e) ? 'match' : 'mismatch' };
  }
  return { field, expected, observed, result: e === o ? 'match' : 'mismatch' };
}

/**
 * VERIFY an observed identity against a reference, FAIL-CLOSED.
 *
 * `accepted` is true ONLY when every identity field the artifact type declares in
 * `verifyFields` was observed AND matched. A single mismatch is `blocked` — a loud stop, never
 * a warning. Nothing observed (or only some of it) is `unverified`, which is also NOT accepted.
 */
export function verifyArtifactRef(
  ref: ArtifactRef,
  observed: ArtifactObserved | undefined,
  cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG,
): ArtifactVerdict {
  const profile = ARTIFACT_TYPE_PROFILES[ref.artifactType];
  if (!profile) {
    // Unknown type ⇒ we cannot state what would make it correct ⇒ BLOCKED, never accepted.
    return {
      status: 'blocked',
      accepted: false,
      reason: `no required-field profile for artifactType "${ref.artifactType}" — cannot state a verification contract, so acceptance is blocked`,
      checks: [],
    };
  }

  // ── N-B (half 2): a supplied measurement is NEVER silently discarded ────────────────────
  // The type's contract names what it verifies. An observation for anything else cannot be
  // adjudicated — and "cannot be adjudicated" must be a STOP, exactly as it is for an
  // out-of-range index (F1). Reporting `verified` while quietly dropping a value the caller
  // measured is how a consumer concludes their check passed when it was never run.
  const unadjudicable = Object.entries(observed ?? {})
    .filter(([field, value]) => value !== undefined && value !== null && !profile.verifyFields.includes(field))
    .map(([field]) => field);
  if (unadjudicable.length > 0) {
    return {
      status: 'blocked',
      accepted: false,
      reason:
        `UNADJUDICABLE MEASUREMENT on [${unadjudicable.join(', ')}] — artifactType ` +
        `"${ref.artifactType}" verifies [${profile.verifyFields.join(', ')}] and nothing else, so the ` +
        `value(s) you measured cannot be checked against anything. Acceptance is BLOCKED rather than ` +
        `granted on the fields that happen to match: a measurement you supplied must never be silently dropped.`,
      checks: [],
    };
  }

  const revisionFields = new Set(profile.revisionFields);
  const checks: ArtifactCheck[] = profile.verifyFields.map((field) =>
    compareIdentity(
      field,
      (ref as unknown as Record<string, string | undefined>)[field],
      (observed as unknown as Record<string, string | undefined> | undefined)?.[field],
      revisionFields.has(field),
    ),
  );

  const mismatches = checks.filter((c) => c.result === 'mismatch');
  if (mismatches.length > 0) {
    const names = mismatches.map((m) => m.field).join(', ');
    return {
      status: 'blocked',
      accepted: false,
      reason:
        `${cfg.hashAlgorithm === 'sha256' && names.includes('sha256') ? 'HASH MISMATCH' : 'IDENTITY MISMATCH'} on [${names}] — ` +
        `this is NOT the accepted artifact. Acceptance is BLOCKED: ` +
        mismatches.map((m) => `${m.field} expected ${m.expected}, observed ${m.observed}`).join('; '),
      checks,
    };
  }

  const missing = checks.filter((c) => c.result === 'not-observed');
  const inconclusive = checks.filter((c) => c.result === 'inconclusive');
  if (missing.length > 0 || inconclusive.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`[${missing.map((c) => c.field).join(', ')}] ${missing.length === 1 ? 'was' : 'were'} not observed`);
    }
    if (inconclusive.length > 0) {
      // Named separately: the caller DID supply these, we just could not confirm with them.
      parts.push(
        `[${inconclusive.map((c) => c.field).join(', ')}] ${inconclusive.length === 1 ? 'was' : 'were'} supplied but ` +
          `too abbreviated to confirm the expected value (observe the full revision)`,
      );
    }
    return {
      status: 'unverified',
      accepted: false,
      reason:
        `not verified — ${parts.join('; ')}. ` +
        `"Could not check" is not "probably fine": observe every field in [${profile.verifyFields.join(', ')}] before accepting.`,
      checks,
    };
  }

  return {
    status: 'verified',
    accepted: true,
    reason: `verified — observed identity matches on [${profile.verifyFields.join(', ')}]`,
    checks,
  };
}

/**
 * Substitute `{token}` placeholders from a reference's own values.
 *
 * ONLY KNOWN KEYS ARE TOUCHED. Retrieval/verify templates legitimately contain brace syntax
 * that is NOT ours — git's peel notation `{head}^{commit}` is the motivating case (caught by
 * dogfooding this on a real reference: a naive substituter turned the canonical existence
 * check into `…^<unset:commit>`, i.e. an instruction that reads authoritative and is broken,
 * which is the exact failure mode this whole feature exists to remove). So:
 *   - a KNOWN key with a value      → substituted;
 *   - a KNOWN key with NO value     → `<unset:key>` (loud — our template referenced something
 *                                     the reference does not carry);
 *   - anything else                 → left VERBATIM (it belongs to the tool, not to us).
 */
function substitute(template: string, values: Record<string, string | null>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match; // not ours — hands off
    const v = values[key];
    if (v === null || v === undefined) return `<unset:${key}>`;
    // DEFENCE 2 (see shellQuote): every RECORD-derived value is quoted inert. Only the values
    // WE own (TRUSTED_PLACEHOLDERS) go in raw.
    return TRUSTED_PLACEHOLDERS.has(key) ? v : shellQuote(v);
  });
}

/**
 * Placeholders whose value comes from OUR CONFIG, not from the record — the trust boundary.
 *
 * `{hashAlgorithm}` is the only one: it forms part of a command NAME (`{hashAlgorithm}sum`),
 * so quoting it would be wrong, and it is not attacker-reachable. DENY-BY-DEFAULT: a
 * placeholder added later is untrusted (and therefore quoted) unless someone deliberately adds
 * it here — forgetting is safe, which is the direction a guard must fail in.
 */
const TRUSTED_PLACEHOLDERS: ReadonlySet<string> = new Set(['hashAlgorithm']);

/**
 * POSIX single-quote a value so it is one inert shell word.
 *
 * DEFENCE 2 OF 2 against instruction injection (Reviewer F3). These instructions are followed
 * by an AUTONOMOUS AGENT without a human reading them, so a locator like
 * `x.bundle; rm -rf /tmp/pwned; echo ` would otherwise emit as a runnable payload carrying the
 * authority of a verification step.
 *
 * Defence 1 (the charset/scheme allow-lists in artifactRefConfig) rejects such a value at the
 * WRITE boundary. This is deliberately INDEPENDENT of it: those patterns are env-overridable,
 * so widening one by config must not be able to re-open the hole. Embedded quotes are escaped
 * the POSIX way (`'` → `'\''`), so a value cannot close the quoting and break out.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * RESOLVE a stored reference into source, expected identity, and retrieval instructions —
 * the deterministic lookup that replaces manual archaeology.
 *
 * Throws on an invalid reference: resolution of a malformed reference has no honest answer,
 * and returning a partial one would be the "reads as provenance but is not" failure again.
 * (Nothing invalid can be stored through a Mandrel write boundary — this guards direct/legacy
 * callers and rows written before this contract existed.)
 */
export function resolveArtifactRef(
  raw: unknown,
  observed?: ArtifactObserved,
  cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG,
): ResolvedArtifact {
  const validated = validateArtifactRef(raw, cfg);
  if (!validated.ok) {
    throw new Error(`Unresolvable artifact reference: ${validated.errors.join('; ')}`);
  }
  const ref = validated.ref;
  const profile = ARTIFACT_TYPE_PROFILES[ref.artifactType];
  const rule = PROVIDER_RULES[ref.retrieval.provider];
  const locator = (ref.retrieval as unknown as Record<string, string>)[rule.locatorField];

  const values: Record<string, string | null> = {
    locator,
    head: ref.head ?? null,
    base: ref.base ?? null,
    sha256: ref.sha256 ?? null,
    hashAlgorithm: cfg.hashAlgorithm,
    repository: ref.repository ?? null,
    producerThread: ref.producerThread ?? null,
  };

  // ── F2: A STORED CLAIM NEVER VERIFIES ANYTHING ─────────────────────────────────────────
  // ONLY a LIVE observation (the `observed` argument — someone who just fetched and measured
  // the artifact) can move the verdict. The stored `ref.observed` deliberately does NOT feed
  // it, and the reason is structural, not stylistic: the write boundary REJECTS any stored
  // observation that DISAGREES with the expected identity, so the only stored claim that can
  // exist is one identical to the expected values — a tautology carrying zero information.
  // Letting it flip the gate would tell a fresh orchestrator "verified" without a byte being
  // fetched, which is exactly the "reads as verified provenance" failure this feature exists
  // to remove. The claim is still surfaced below as `priorClaim`, clearly not trust-bearing.
  const verdict = verifyArtifactRef(ref, observed, cfg);

  return {
    artifactType: ref.artifactType,
    storesArtifactBytes: false,
    source: {
      repository: ref.repository ?? null,
      producerThread: ref.producerThread ?? null,
      provider: ref.retrieval.provider,
      locatorField: rule.locatorField,
      locator,
    },
    identity: {
      head: ref.head ?? null,
      base: ref.base ?? null,
      sha256: ref.sha256 ?? null,
      hashAlgorithm: cfg.hashAlgorithm,
    },
    retrieval: {
      provider: ref.retrieval.provider,
      locator,
      instructions: [substitute(rule.hint, values)],
    },
    verification: {
      failClosed: true,
      mustObserve: [...profile.verifyFields],
      steps: profile.verifySteps.map((s) => substitute(s, values)),
      verdict,
      ...(ref.observed
        ? {
            priorClaim: {
              sha256: ref.observed.sha256 ?? null,
              head: ref.observed.head ?? null,
              note:
                'RECORDED BY THE WRITER, NOT TRUST-BEARING. It is never used to verify anything and ' +
                'cannot produce acceptance — only a live observation you measured yourself can. ' +
                'Fetch the artifact and observe it.',
            },
          }
        : {}),
    },
  };
}

/**
 * Read the raw artifact-reference array off a record's metadata (never throws).
 *
 * Returns a RESULT, not a bare array, because "no references" and "a shape I do not recognise"
 * are different answers and collapsing them is a fail-OPEN. The write boundary rejects a
 * non-array under the reserved key, so this only fires for a legacy row or a direct-DB writer
 * — precisely the case where quietly reporting "carries NO artifact references" would hide
 * real provenance behind a reassuring message.
 */
export type MetadataRefsResult =
  | { ok: true; refs: unknown[] }
  | { ok: false; reason: string };

export function readMetadataArtifactRefs(
  metadata: unknown,
  cfg: ArtifactRefConfig = ARTIFACT_REF_CONFIG,
): MetadataRefsResult {
  if (!isPlainObject(metadata)) return { ok: true, refs: [] };
  const value = metadata[cfg.metadataKey];
  if (value === undefined || value === null) return { ok: true, refs: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason:
        `metadata.${cfg.metadataKey} is not an ARRAY (found ${typeof value}) — this record carries ` +
        `an UNRESOLVABLE artifact reference, not "no artifact references". Repair it with ` +
        `context_update: {"${cfg.metadataKey}": [ {...} ]}`,
    };
  }
  return { ok: true, refs: value };
}
