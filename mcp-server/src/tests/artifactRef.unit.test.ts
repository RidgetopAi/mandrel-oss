/**
 * FIRST-CLASS ARTIFACT REFERENCE — the pure core.
 *
 * Covers the four acceptance behaviours of the reference itself:
 *   1. a VALID reference round-trips and RESOLVES to source + expected identity + retrieval
 *      instructions (the deterministic lookup that replaces manual archaeology);
 *   2. a HASH MISMATCH BLOCKS acceptance — fail-closed, never a warning;
 *   3. an UNKNOWN PROVIDER is rejected;
 *   4. the allowed provider/type sets are CONFIG (proved by driving behaviour from an
 *      injected config, not by reading a literal).
 *
 * Plus the fail-closed edges that make those real: a partial observation is not acceptance,
 * an allow-listed-but-rule-less provider/type is still rejected, and a too-short observation
 * can never confirm a longer expectation.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  validateArtifactRef,
  validateMetadataArtifactRefs,
  shellQuote,
  verifyArtifactRef,
  resolveArtifactRef,
  readMetadataArtifactRefs,
  type ArtifactRef,
} from '../services/artifactRef.js';
import {
  ARTIFACT_REF_CONFIG,
  ARTIFACT_TYPE_PROFILES,
  LOCATOR_CHARSET_FLOOR,
  anchoredPattern,
  PROVIDER_RULES,
  effectiveProviders,
  effectiveArtifactTypes,
  type ArtifactRefConfig,
} from '../config/artifactRefConfig.js';

/** The evaluator's own case: the git bundle a replacement orchestrator had to recover. */
const HEAD = '6acef8712ab2e8c0ffee1234567890abcdef0123';
const BASE = '12ab2e8c0ffee1234567890abcdef01234567890';
const SHA256 = 'a'.repeat(64);
const OTHER_SHA256 = 'b'.repeat(64);

function goodRef(over: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    artifactType: 'git-bundle',
    repository: 'riverbend/amp-exp-1',
    head: HEAD,
    base: BASE,
    sha256: SHA256,
    producerThread: 'T-019f2b33-0840-74c2-911a-d2ecdcdefa30',
    retrieval: { provider: 'amp-thread-file', path: '.git/phase-c-core.bundle' },
    ...over,
  };
}

describe('validate — a valid reference round-trips', () => {
  test('the evaluator’s git-bundle reference validates', () => {
    const r = validateArtifactRef(goodRef());
    expect(r.ok, r.ok ? '' : r.errors.join(' | ')).toBe(true);
  });

  test('an expectation-only reference (no observation) is legal — it is not a lie, just unverified', () => {
    const r = validateArtifactRef(goodRef());
    expect(r.ok).toBe(true);
    const verdict = verifyArtifactRef(goodRef(), undefined);
    expect(verdict.status).toBe('unverified');
    expect(verdict.accepted).toBe(false);
  });

  test('metadata round-trip: refs read back out of the metadata bag they were written into', () => {
    const metadata = { [ARTIFACT_REF_CONFIG.metadataKey]: [goodRef()] };
    expect(validateMetadataArtifactRefs(metadata)).toEqual([]);
    const read = readMetadataArtifactRefs(metadata);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.refs).toHaveLength(1);
      expect((read.refs[0] as ArtifactRef).head).toBe(HEAD);
    }
  });
});

describe('resolve — source, expected identity, retrieval instructions', () => {
  const resolved = resolveArtifactRef(goodRef());

  test('returns the SOURCE (where it came from)', () => {
    expect(resolved.source.repository).toBe('riverbend/amp-exp-1');
    expect(resolved.source.provider).toBe('amp-thread-file');
    expect(resolved.source.locator).toBe('.git/phase-c-core.bundle');
    expect(resolved.source.producerThread).toContain('T-019f2b33');
  });

  test('returns the EXPECTED IDENTITY (hash / head / base)', () => {
    expect(resolved.identity.sha256).toBe(SHA256);
    expect(resolved.identity.head).toBe(HEAD);
    expect(resolved.identity.base).toBe(BASE);
    expect(resolved.identity.hashAlgorithm).toBe(ARTIFACT_REF_CONFIG.hashAlgorithm);
  });

  test('returns RETRIEVAL INSTRUCTIONS with the locator substituted in', () => {
    expect(resolved.retrieval.instructions.length).toBeGreaterThan(0);
    const all = resolved.retrieval.instructions.join('\n');
    expect(all).toContain('.git/phase-c-core.bundle');
    expect(all).toContain('T-019f2b33-0840-74c2-911a-d2ecdcdefa30');
    // No unsubstituted placeholders survive into the instructions an agent will follow.
    expect(all).not.toMatch(/\{[a-z]+\}/i);
  });

  test('returns VERIFICATION STEPS naming the exact expected values', () => {
    const steps = resolved.verification.steps.join('\n');
    expect(steps).toContain(SHA256);
    expect(steps).toContain(HEAD);
    expect(resolved.verification.failClosed).toBe(true);
    expect(resolved.verification.mustObserve).toEqual(['sha256', 'head']);
  });

  test('the answer carries the boundary: Mandrel stores no artifact bytes', () => {
    expect(resolved.storesArtifactBytes).toBe(false);
  });

  test('an unresolvable (malformed) reference THROWS rather than returning a partial answer', () => {
    expect(() => resolveArtifactRef({ artifactType: 'git-bundle' })).toThrow(/Unresolvable artifact reference/);
  });
});

describe('verify — FAIL-CLOSED (a hash mismatch BLOCKS acceptance)', () => {
  test('HASH MISMATCH ⇒ blocked, not accepted, and the reason says so loudly', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: OTHER_SHA256, head: HEAD });
    expect(v.status).toBe('blocked');
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('HASH MISMATCH');
    expect(v.reason).toContain('BLOCKED');
    expect(v.checks.find((c) => c.field === 'sha256')?.result).toBe('mismatch');
  });

  test('HEAD MISMATCH ⇒ blocked even when the digest matches (right bytes, wrong commit is still wrong)', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: SHA256, head: 'f'.repeat(40) });
    expect(v.status).toBe('blocked');
    expect(v.accepted).toBe(false);
  });

  test('a FULL match on every declared field ⇒ verified + accepted', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: SHA256, head: HEAD });
    expect(v.status).toBe('verified');
    expect(v.accepted).toBe(true);
  });

  test('a PARTIAL observation is NOT acceptance ("could not check" ≠ "probably fine")', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: SHA256 }); // head never observed
    expect(v.status).toBe('unverified');
    expect(v.accepted).toBe(false);
    expect(v.reason).toContain('not observed');
  });

  test('an abbreviated EXPECTED head is confirmed by a full observed head (git abbreviates)', () => {
    const v = verifyArtifactRef(goodRef({ head: '6acef87' }), { sha256: SHA256, head: HEAD });
    expect(v.status).toBe('verified');
    expect(v.accepted).toBe(true);
  });

  test('an observation SHORTER than the expectation can never confirm it (fail-closed direction)', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: SHA256, head: '6acef87' });
    expect(v.status).toBe('unverified');
    expect(v.accepted).toBe(false);
  });

  test('an abbreviated expected head that DISAGREES still mismatches (no accidental prefix pass)', () => {
    const v = verifyArtifactRef(goodRef({ head: '6acef87' }), { sha256: SHA256, head: 'deadbeef1234' });
    expect(v.status).toBe('blocked');
  });

  test('accepted is TRUE only for status "verified" — the gate is derived, never assembled', () => {
    for (const observed of [undefined, { sha256: OTHER_SHA256 }, { head: HEAD }, { sha256: SHA256 }]) {
      const v = verifyArtifactRef(goodRef(), observed);
      expect(v.accepted).toBe(v.status === 'verified');
    }
  });

  test('a self-contradicting reference (observed ≠ expected) is REJECTED at the metadata gate', () => {
    const metadata = {
      [ARTIFACT_REF_CONFIG.metadataKey]: [goodRef({ observed: { sha256: OTHER_SHA256, head: HEAD } })],
    };
    const errors = validateMetadataArtifactRefs(metadata);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('HASH MISMATCH');
  });

  test('a reference whose observation AGREES is accepted at the metadata gate', () => {
    const metadata = {
      [ARTIFACT_REF_CONFIG.metadataKey]: [goodRef({ observed: { sha256: SHA256, head: HEAD } })],
    };
    expect(validateMetadataArtifactRefs(metadata)).toEqual([]);
  });
});

describe('validate — malformed references are REJECTED (a lying record is worse than no record)', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', 'a-bundle-somewhere', /must be an object/],
    ['missing artifactType', { retrieval: { provider: 'amp-thread-file', path: 'x' } }, /artifactType/],
    ['unknown artifactType', goodRef({ artifactType: 'zip-of-hopes' } as any), /not an allowed artifact type/],
    ['missing retrieval', { artifactType: 'git-bundle', head: HEAD, sha256: SHA256, repository: 'r' }, /retrieval/],
    ['UNKNOWN PROVIDER', goodRef({ retrieval: { provider: 'usb-stick', path: 'x' } }), /not an allowed provider/],
    ['missing locator for the provider', goodRef({ retrieval: { provider: 'amp-thread-file' } }), /retrieval\.path/],
    ['wrong locator field for the provider', goodRef({ retrieval: { provider: 'https', path: 'x' } }), /retrieval\.uri/],
    ['missing required sha256 for git-bundle', goodRef({ sha256: undefined }), /sha256: required/],
    ['missing required head for git-bundle', goodRef({ head: undefined }), /head: required/],
    ['truncated sha256', goodRef({ sha256: 'abc123' }), /64-char hex/],
    ['non-hex sha256', goodRef({ sha256: 'z'.repeat(64) }), /64-char hex/],
    ['ambiguously short head', goodRef({ head: 'abc' }), /hex git revision/],
    ['non-hex head', goodRef({ head: 'not-a-sha-at-all-really' }), /hex git revision/],
    ['empty observed block', goodRef({ observed: {} }), /omit it entirely/],
    ['non-hex observed sha256', goodRef({ observed: { sha256: 'nope' } }), /observed\.sha256/],
  ];

  test.each(cases)('rejects: %s', (_label, raw, expected) => {
    const r = validateArtifactRef(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' | ')).toMatch(expected);
  });

  test('reports EVERY problem in one pass (a rejected write tells the writer everything)', () => {
    const r = validateArtifactRef({ artifactType: 'zip-of-hopes', retrieval: { provider: 'usb-stick' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(1);
  });
});

describe('validate — the metadata bag', () => {
  const KEY = ARTIFACT_REF_CONFIG.metadataKey;

  test('metadata with NO artifact key is untouched (zero blast radius on every other write)', () => {
    expect(validateMetadataArtifactRefs({ parent_task: 'x', kind: 'dispatch-proof' })).toEqual([]);
    expect(validateMetadataArtifactRefs(undefined)).toEqual([]);
    expect(validateMetadataArtifactRefs(null)).toEqual([]);
  });

  test('a non-array under the key is rejected with the fix in the message', () => {
    const errors = validateMetadataArtifactRefs({ [KEY]: goodRef() });
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/must be an ARRAY/);
  });

  test('null under the key is allowed — it is the metadata-merge DELETE sentinel', () => {
    expect(validateMetadataArtifactRefs({ [KEY]: null })).toEqual([]);
  });

  test('an empty array is allowed', () => {
    expect(validateMetadataArtifactRefs({ [KEY]: [] })).toEqual([]);
  });

  test('more refs than the configured maximum is rejected', () => {
    const many = Array.from({ length: ARTIFACT_REF_CONFIG.maxRefsPerRecord + 1 }, () => goodRef());
    const errors = validateMetadataArtifactRefs({ [KEY]: many });
    expect(errors.join(' ')).toMatch(/at most/);
  });

  test('the failing INDEX is named so a multi-artifact record is debuggable', () => {
    const errors = validateMetadataArtifactRefs({ [KEY]: [goodRef(), goodRef({ sha256: 'short' })] });
    expect(errors.join(' ')).toContain(`${KEY}[1]`);
    expect(errors.join(' ')).not.toContain(`${KEY}[0]`);
  });
});

describe('config, not literals — the allow-lists are driven by the config object', () => {
  /** A config that differs from the shipped default in every axis under test. */
  function cfg(over: Partial<ArtifactRefConfig>): ArtifactRefConfig {
    return { ...ARTIFACT_REF_CONFIG, ...over };
  }

  test('a provider REMOVED from config stops validating (behaviour follows config)', () => {
    const narrowed = cfg({ allowedProviders: ['https'] });
    const r = validateArtifactRef(goodRef(), narrowed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/not an allowed provider/);
  });

  test('an artifact type REMOVED from config stops validating', () => {
    const narrowed = cfg({ allowedArtifactTypes: ['file'] });
    const r = validateArtifactRef(goodRef(), narrowed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/not an allowed artifact type/);
  });

  test('the metadata KEY is config-driven (not the literal "artifacts")', () => {
    const renamed = cfg({ metadataKey: 'externalArtifacts' });
    expect(validateMetadataArtifactRefs({ externalArtifacts: [goodRef({ sha256: 'bad' })] }, renamed).length)
      .toBeGreaterThan(0);
    // …and the default key is ignored under the renamed config.
    expect(validateMetadataArtifactRefs({ artifacts: [goodRef({ sha256: 'bad' })] }, renamed)).toEqual([]);
  });

  test('the max-refs bound is config-driven', () => {
    const tiny = cfg({ maxRefsPerRecord: 1 });
    expect(validateMetadataArtifactRefs({ [tiny.metadataKey]: [goodRef(), goodRef()] }, tiny).length).toBe(1);
  });

  test('FAIL-CLOSED: a provider allow-listed with NO locator rule is still rejected', () => {
    const bogus = cfg({ allowedProviders: [...ARTIFACT_REF_CONFIG.allowedProviders, 'carrier-pigeon'] });
    const r = validateArtifactRef(goodRef({ retrieval: { provider: 'carrier-pigeon', path: 'x' } }), bogus);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/NO locator rule/);
    // and it never advertises itself as usable
    expect(effectiveProviders(bogus)).not.toContain('carrier-pigeon');
  });

  test('FAIL-CLOSED: an artifact type allow-listed with NO required-field profile is still rejected', () => {
    const bogus = cfg({ allowedArtifactTypes: [...ARTIFACT_REF_CONFIG.allowedArtifactTypes, 'vibes'] });
    const r = validateArtifactRef(goodRef({ artifactType: 'vibes' }), bogus);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/NO required-field profile/);
    expect(effectiveArtifactTypes(bogus)).not.toContain('vibes');
  });

  test('FAIL-CLOSED: verify blocks (never accepts) an artifact type it has no contract for', () => {
    const v = verifyArtifactRef({ ...goodRef(), artifactType: 'vibes' }, { sha256: SHA256, head: HEAD });
    expect(v.status).toBe('blocked');
    expect(v.accepted).toBe(false);
  });

  test('every SHIPPED allow-list entry is rule-backed (no dead entry that would fail closed in prod)', () => {
    expect(effectiveProviders()).toEqual(ARTIFACT_REF_CONFIG.allowedProviders);
    expect(effectiveArtifactTypes()).toEqual(ARTIFACT_REF_CONFIG.allowedArtifactTypes);
  });

  test('a tool’s OWN brace syntax survives substitution (git peel `^{commit}` is not our placeholder)', () => {
    // Found by dogfooding a real reference: a naive substituter turned the canonical existence
    // check `git cat-file -e <sha>^{commit}` into `…^<unset:commit>` — an instruction that reads
    // authoritative and is broken. Exactly the class this feature exists to remove, so it is
    // guarded here rather than only in the one template that tripped it.
    const r = resolveArtifactRef({
      artifactType: 'git-commit',
      repository: 'Riverbend/mandrel',
      head: HEAD,
      retrieval: { provider: 'git-remote', uri: 'https://github.com/Riverbend/mandrel.git' },
    });
    const steps = r.verification.steps.join('\n');
    expect(steps).toContain('^{commit}');
    expect(steps).toContain(HEAD);
    // Nothing WE own may render unset in a shipped template.
    expect(steps).not.toContain('<unset:');
    expect(r.retrieval.instructions.join('\n')).not.toContain('<unset:');
  });

  test('no shipped template leaves one of OUR placeholders unset on a fully-populated reference', () => {
    for (const t of effectiveArtifactTypes()) {
      const profile = ARTIFACT_TYPE_PROFILES[t];
      const known = new Set([...profile.requiredFields, ...profile.revisionFields, ...profile.verifyFields]);
      // "Fully populated" now means every identity field the TYPE has a contract for — a type
      // may no longer carry one it never verifies (N-B).
      const r = resolveArtifactRef({
        artifactType: t,
        repository: 'r/x',
        producerThread: 'T-x',
        ...(known.has('head') ? { head: HEAD } : {}),
        ...(known.has('base') ? { base: BASE } : {}),
        ...(known.has('sha256') ? { sha256: SHA256 } : {}),
        retrieval: { provider: 'https', uri: 'https://x/y' },
      });
      const all = [...r.retrieval.instructions, ...r.verification.steps].join('\n');
      expect(all, `${t} template referenced a value the reference does not carry`).not.toContain('<unset:');
    }
  });

  test('a hyphenated URL is accepted (the control-character class must not read as a hyphen range)', () => {
    const r = validateArtifactRef({
      artifactType: 'git-commit',
      repository: 'Riverbend/mandrel',
      head: HEAD,
      retrieval: { provider: 'git-remote', uri: 'https://git-host.example.com/Mandrel-Ai/my-repo.git' },
    });
    expect(r.ok, r.ok ? '' : r.errors.join(' | ')).toBe(true);
  });

  test('every shipped artifact type declares at least one verify field (nothing is un-verifiable)', () => {
    for (const t of effectiveArtifactTypes()) {
      const r = resolveArtifactRef(
        t === 'git-commit'
          ? { artifactType: t, repository: 'r/x', head: HEAD, retrieval: { provider: 'git-remote', uri: 'ssh://git@my-host.example/r/x.git' } }
          : { artifactType: t, repository: 'r/x', head: HEAD, sha256: SHA256, retrieval: { provider: 'https', uri: 'https://x/y' } },
      );
      expect(r.verification.mustObserve.length, `${t} must declare an identity to verify`).toBeGreaterThan(0);
      expect(r.verification.steps.length, `${t} must declare verification steps`).toBeGreaterThan(0);
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * ATTACK SUITE — the three ways around the guarantee that Reviewer got through
 * (an earlier task re-work). Each of these FAILED against the first build. They are written
 * as attacks, not as unit coverage: the question is never "does the happy path work", it is
 * "can I reach accepted / a runnable payload without earning it".
 * ═══════════════════════════════════════════════════════════════════════════════════════
 */
describe('ATTACK F2 — a STORED `observed` block must not self-certify', () => {
  test('resolving with NO live observation is unverified, even when the record carries a matching claim', () => {
    // The trap is structural: the write boundary REJECTS any stored `observed` that DISAGREES
    // with the expected identity, so the only stored claim that can exist is a tautology
    // (identical to the expected values) carrying zero information. If that flips the gate, a
    // fresh orchestrator is told VERIFIED without fetching a byte.
    const selfCertifying = goodRef({ observed: { sha256: SHA256, head: HEAD } });
    expect(validateMetadataArtifactRefs({ [ARTIFACT_REF_CONFIG.metadataKey]: [selfCertifying] })).toEqual([]);

    const r = resolveArtifactRef(selfCertifying); // caller measured NOTHING
    expect(r.verification.verdict.accepted, 'a stored claim must never produce accepted:true').toBe(false);
    expect(r.verification.verdict.status).toBe('unverified');
  });

  test('the stored claim is still SURFACED — as a prior claim, explicitly not trust-bearing', () => {
    const r = resolveArtifactRef(goodRef({ observed: { sha256: SHA256, head: HEAD } }));
    expect(r.verification.priorClaim?.sha256).toBe(SHA256);
    expect(r.verification.priorClaim?.note).toMatch(/not|never/i);
  });

  test('a LIVE observation still verifies (the fix does not break real acceptance)', () => {
    const r = resolveArtifactRef(goodRef({ observed: { sha256: SHA256, head: HEAD } }), { sha256: SHA256, head: HEAD });
    expect(r.verification.verdict.accepted).toBe(true);
  });
});

describe('ATTACK F3 — a locator must not be able to carry a runnable payload', () => {
  const PAYLOAD = 'x.bundle; rm -rf /tmp/pwned; echo ';

  test('DEFENCE 1 — the shell payload is REJECTED at the write boundary', () => {
    const errors = validateMetadataArtifactRefs({
      [ARTIFACT_REF_CONFIG.metadataKey]: [goodRef({ retrieval: { provider: 'amp-thread-file', path: PAYLOAD } })],
    });
    expect(errors.length, 'a locator carrying shell metacharacters must be rejected').toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/retrieval\.path/);
  });

  test('DEFENCE 1 — repository and uri are charset/URL constrained too', () => {
    expect(validateArtifactRef(goodRef({ repository: 'org/repo; rm -rf /' })).ok).toBe(false);
    expect(validateArtifactRef(goodRef({ producerThread: 'T-1; rm -rf /' })).ok).toBe(false);
    expect(
      validateArtifactRef({
        artifactType: 'git-commit', repository: 'o/r', head: HEAD,
        retrieval: { provider: 'git-remote', uri: 'not a url; rm -rf /' },
      }).ok,
    ).toBe(false);
    // …and a scheme outside the configured allow-list is refused even when it parses.
    expect(
      validateArtifactRef({
        artifactType: 'git-commit', repository: 'o/r', head: HEAD,
        retrieval: { provider: 'git-remote', uri: 'file:///etc/passwd' },
      }).ok,
    ).toBe(false);
  });

  test('DEFENCE 2 — every RECORD-derived value is emitted quoted, on a perfectly legitimate ref', () => {
    // Defence 2 is not conditional on the value being suspicious — it applies to everything
    // that came from the record, which is what makes it a guard rather than a filter.
    const r = resolveArtifactRef(goodRef());
    const emitted = [...r.retrieval.instructions, ...r.verification.steps].join('\n');
    expect(emitted).toContain(`'.git/phase-c-core.bundle'`);
    expect(emitted).toContain(`'${SHA256}'`);
    expect(emitted).toContain(`'${HEAD}'`);
    expect(emitted).toContain(`'T-019f2b33-0840-74c2-911a-d2ecdcdefa30'`);
  });

  test('DEFENCE 2 — PROVEN AGAINST A REAL SHELL: a quote-escaping payload stays one inert word', () => {
    // A regex assertion about quoting is a claim about what a shell WOULD do. This ASKS the
    // shell (a past incident — test from the consumer's vantage point; the consumer here is bash).
    //
    // NOTE ON LAYERING: defence 1 (the non-configurable charset floor) now makes it impossible
    // to get this payload into a stored reference at all — so this exercises the QUOTING LAYER
    // directly rather than through a reference. That is deliberate: defence 2 exists to hold if
    // defence 1 is ever weakened or bypassed (a direct DB writer, a future call site), and a
    // test that can only reach it THROUGH defence 1 would silently stop testing it.
    const canary = path.join(tmpdir(), `artifact-ref-canary-${process.pid}-${Date.now()}`);
    const payload = `a'; touch ${canary}; echo '`;
    const quoted = shellQuote(payload);

    // Round-trip through bash: it must come back BYTE-IDENTICAL as ONE word…
    const out = execFileSync('bash', ['-c', `printf '%s' ${quoted}`], { encoding: 'utf8' });
    expect(out).toBe(payload);
    // …and the embedded command must NOT have run.
    expect(existsSync(canary), 'the payload ESCAPED the quoting and executed').toBe(false);
    // POSIX escape: every embedded quote became '\''
    expect(quoted).toContain(`'\\''`);
  });

  test('DEFENCE 2 — the shell round-trip holds for every shell metacharacter', () => {
    for (const payload of ['a;b', 'a|b', 'a&b', 'a`id`b', 'a$(id)b', 'a>b', 'a b', 'a\nb', "a'b"]) {
      const out = execFileSync('bash', ['-c', `printf '%s' ${shellQuote(payload)}`], { encoding: 'utf8' });
      expect(out, `bash did not return ${JSON.stringify(payload)} intact`).toBe(payload);
    }
  });

  test('the OWN-value trust boundary: config values are not quoted, record values always are', () => {
    // {hashAlgorithm} is OURS (config) and forms part of the command NAME; every ref-derived
    // value is attacker-reachable and must be quoted. A NEW placeholder defaults to untrusted.
    const step = resolveArtifactRef(goodRef()).verification.steps[0];
    expect(step.startsWith('sha256sum ')).toBe(true);
    expect(step).toContain(`'${SHA256}'`);
  });
});

describe('N1 — an unrecognised shape under the reserved key is LOUD, never silently empty', () => {
  test('a non-array (legacy / direct-DB row) reports unresolvable rather than "no references"', () => {
    const r = readMetadataArtifactRefs({ [ARTIFACT_REF_CONFIG.metadataKey]: { artifactType: 'git-bundle' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ARRAY/i);
  });

  test('absent key and a real array both read cleanly', () => {
    const absent = readMetadataArtifactRefs({ kind: 'dispatch-proof' });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.refs).toEqual([]);
    const present = readMetadataArtifactRefs({ [ARTIFACT_REF_CONFIG.metadataKey]: [goodRef()] });
    expect(present.ok).toBe(true);
    if (present.ok) expect(present.refs).toHaveLength(1);
  });
});

describe('N2 — no VALID type×provider combination can emit an unset placeholder', () => {
  test('the full cross-product of shipped types and providers emits runnable instructions', () => {
    let combos = 0;
    for (const type of effectiveArtifactTypes()) {
      for (const provider of effectiveProviders()) {
        const rule = PROVIDER_RULES[provider];
        const profile = ARTIFACT_TYPE_PROFILES[type];
        // Build the MINIMAL ref this combination declares as required — nothing extra, so a
        // template referencing a field the combination does not guarantee shows up as unset.
        const ref: Record<string, unknown> = {
          artifactType: type,
          retrieval: { provider, [rule.locatorField]: rule.locatorField === 'uri' ? 'https://example.test/a' : 'a/b.bin' },
        };
        for (const f of [...profile.requiredFields, ...rule.requiredRefFields]) {
          ref[f] =
            f === 'sha256' ? SHA256 :
            f === 'head' || f === 'base' ? HEAD :
            f === 'repository' ? 'org/repo' : 'T-0000';
        }
        const check = validateArtifactRef(ref);
        expect(check.ok, `${type}+${provider} minimal ref must validate: ${check.ok ? '' : check.errors.join('; ')}`).toBe(true);
        const r = resolveArtifactRef(ref);
        const all = [...r.retrieval.instructions, ...r.verification.steps].join('\n');
        expect(all, `${type}+${provider} emitted an unset placeholder`).not.toContain('<unset:');
        combos++;
      }
    }
    // Guard the guard: a discovery bug that produced an empty cross-product would pass vacuously.
    expect(combos).toBeGreaterThanOrEqual(16);
  });
});

describe('N-B — the verify contract is closed on BOTH sides (ref fields and measurements)', () => {
  test('a type rejects an identity field it has no contract for', () => {
    const r = validateArtifactRef({
      artifactType: 'git-commit',
      repository: 'org/repo',
      head: HEAD,
      sha256: SHA256, // git-commit verifies the revision; nothing ever checks this
      retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/no verification contract/);
  });

  test('provenance labels are NOT identity and stay allowed on every type', () => {
    const r = validateArtifactRef({
      artifactType: 'file',
      sha256: SHA256,
      repository: 'org/repo',
      producerThread: 'T-0000',
      retrieval: { provider: 'https', uri: 'https://example.test/a.bin' },
    });
    expect(r.ok, r.ok ? '' : r.errors.join(' | ')).toBe(true);
  });

  test('an observation for a field the type does not verify BLOCKS (never partial-credit accepts)', () => {
    const ref: ArtifactRef = {
      artifactType: 'git-commit',
      repository: 'org/repo',
      head: HEAD,
      retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
    };
    // head matches — the old build returned verified and dropped the sha256 silently.
    const v = verifyArtifactRef(ref, { head: HEAD, sha256: OTHER_SHA256 });
    expect(v.status).toBe('blocked');
    expect(v.accepted).toBe(false);
    expect(v.reason).toMatch(/UNADJUDICABLE MEASUREMENT/);
  });

  test('measuring exactly the verified set still verifies', () => {
    const ref: ArtifactRef = {
      artifactType: 'git-commit',
      repository: 'org/repo',
      head: HEAD,
      retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
    };
    expect(verifyArtifactRef(ref, { head: HEAD }).accepted).toBe(true);
  });

  test('a supplied-but-too-short revision reports INCONCLUSIVE, not "you did not observe it"', () => {
    const v = verifyArtifactRef(goodRef(), { sha256: SHA256, head: '6acef87' });
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.field === 'head')?.result).toBe('inconclusive');
    expect(v.reason).toMatch(/too abbreviated to confirm/);
    expect(v.reason).not.toMatch(/\[head\] was not observed/);
  });
});

describe('N-C — the charset anchor cannot be escaped by a pattern that compiles', () => {
  const ESCAPE = 'x)|(.*';
  const PAYLOAD = 'x.bundle; rm -rf /tmp/pwned; echo ';

  test('the naive single wrap IS escapable — the bug being fixed, stated as a fact', () => {
    // Documents WHY the double wrap exists: alternation binds looser than the group, so the
    // second branch escapes the anchors entirely.
    expect(new RegExp(`^(?:${ESCAPE})$`).test(PAYLOAD)).toBe(true);
  });

  test('MEASURED: no amount of WRAPPING closes the escape — the injected parens re-balance', () => {
    // The review proposed double-wrapping. It does not work and cannot: this documents the
    // measurement so nobody "fixes" this again by adding another layer of parentheses.
    expect(new RegExp(`^(?:${ESCAPE})$`).test(PAYLOAD)).toBe(true);
    expect(new RegExp(`^(?:(?:${ESCAPE}))$`).test(PAYLOAD)).toBe(true);
    expect(new RegExp(`^(?:(?:(?:${ESCAPE})))$`).test(PAYLOAD)).toBe(true);
    expect(anchoredPattern(ESCAPE).test(PAYLOAD)).toBe(true); // honest: the helper alone does NOT save us
  });

  test('THE FLOOR is what holds: non-configurable, so config can only ever NARROW', () => {
    expect(LOCATOR_CHARSET_FLOOR.test(PAYLOAD)).toBe(false);
    for (const bad of ['a`id`b', 'a$(id)b', "a'; touch /tmp/x; echo '", 'a b', 'a\nb', 'a;b', 'a|b', 'a&b']) {
      expect(LOCATOR_CHARSET_FLOOR.test(bad), `floor admitted ${JSON.stringify(bad)}`).toBe(false);
    }
    // …and it still admits every legitimate locator shape we ship.
    for (const good of ['.git/phase-c-core.bundle', 'org/repo', 'T-019f2b33-0840-74c2-911a-d2ecdcdefa30', '/home/x/y_z.bin']) {
      expect(LOCATOR_CHARSET_FLOOR.test(good), `floor rejected ${JSON.stringify(good)}`).toBe(true);
    }
  });

  test('anchoredPattern() still matches what a normal charset should match', () => {
    expect(anchoredPattern('[a-z.]+').test('a.bundle')).toBe(true);
    expect(anchoredPattern('[a-z.]+').test('a bundle')).toBe(false);
    // a legitimate top-level alternation keeps working — anchored on BOTH branches
    expect(anchoredPattern('abc|def').test('def')).toBe(true);
    expect(anchoredPattern('abc|def').test('xdefy')).toBe(false);
  });

  test('even an ESCAPING configured pattern admits nothing — the floor runs first', () => {
    const escaped: ArtifactRefConfig = { ...ARTIFACT_REF_CONFIG, locatorPathPattern: ESCAPE };
    const r = validateArtifactRef(goodRef({ retrieval: { provider: 'amp-thread-file', path: PAYLOAD } }), escaped);
    expect(r.ok, 'an escaping pattern must not admit the injection payload').toBe(false);
  });

  describe('the env SELF-PROBE is pinned (an unpinned guard is a guard until someone touches it)', () => {
    /**
     * envPattern() runs at MODULE LOAD, so these re-import the config with a stubbed env.
     * Nothing is hardcoded: the "shipped default" is captured from a clean re-import, so the
     * test cannot drift from the config it guards.
     */
    async function loadWith(envValue?: string): Promise<string> {
      vi.resetModules();
      if (envValue === undefined) vi.unstubAllEnvs();
      else vi.stubEnv('MANDREL_ARTIFACT_REF_PATH_PATTERN', envValue);
      const mod = await import('../config/artifactRefConfig.js');
      return mod.ARTIFACT_REF_CONFIG.locatorPathPattern;
    }

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    test('a HOSTILE env pattern is refused at load — the shipped default stands', async () => {
      const shipped = await loadWith(undefined);
      // `x)|(.*` compiles fine and, wrapped, matches anything (see the measurement above).
      const withHostile = await loadWith('x)|(.*');
      expect(withHostile, 'a pattern that admits the payload must never be adopted').toBe(shipped);
    });

    test('every PATTERN_MUST_REJECT shape is actually refused as a candidate pattern', async () => {
      const shipped = await loadWith(undefined);
      // A pattern that trivially admits each known-bad string: the probe must reject all of them.
      for (const permissive of ['.*', '[\\s\\S]*', '.+|', 'x)|(.*']) {
        expect(await loadWith(permissive), `permissive pattern ${permissive} was adopted`).toBe(shipped);
      }
    });

    test('an UNCOMPILABLE env pattern also falls back (a broken var never disables the guard)', async () => {
      const shipped = await loadWith(undefined);
      expect(await loadWith('[unclosed')).toBe(shipped);
    });

    test('GUARD THE GUARD: a legitimate NARROWER pattern is still adopted', async () => {
      // Without this, "refuse everything" would pass the tests above while silently making the
      // knob inert — the probe must reject hostile patterns, not all patterns.
      const shipped = await loadWith(undefined);
      const narrower = await loadWith('[a-z0-9./-]+');
      expect(narrower).not.toBe(shipped);
      expect(narrower).toBe('[a-z0-9./-]+');
    });
  });

  test('the SHIPPED patterns reject every known-bad string', () => {
    for (const pattern of [
      ARTIFACT_REF_CONFIG.locatorPathPattern,
      ARTIFACT_REF_CONFIG.repositoryPattern,
      ARTIFACT_REF_CONFIG.producerThreadPattern,
    ]) {
      for (const bad of ['x.bundle; rm -rf /tmp/pwned; echo ', 'a`id`b', 'a$(id)b', 'a b', 'a\nb']) {
        expect(anchoredPattern(pattern).test(bad), `/${pattern}/ admitted ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });
});
