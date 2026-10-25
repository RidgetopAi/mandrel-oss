/**
 * ACTOR REGISTRY — PURE taxonomy + normalization unit tests (Sessions Foundation Phase 1,
 * an earlier decision). NO DB, NO network.
 *
 * Locks the actor taxonomy contract used for CLASSIFICATION (Phase 1 does not use it for
 * behavior):
 *   - normalizeActor collapses equivalent strings to one stable slug key and maps blank → null;
 *   - classifyActor resolves normalize → exact registry hit → prefix rule → default;
 *   - the parametric builder-<id8> family classifies as agent via the prefix rule;
 *   - the flagged `anonymous` fallback classifies (as AGENT — interactive is the default)
 *     rather than throwing;
 *   - the registry + default kind are env-extendable (configs-not-hardcoded).
 *
 * UPDATED (an earlier decision / ref:session-boundary): `anonymous` classifies 'agent', NOT
 * 'automation'. The cases below previously asserted 'automation'; that encoded the OLD intent
 * (header-less == machinery), which is false on a customer tenant where anonymous IS the
 * customer. Interactive is now the DEFAULT and automation is the ENUMERATED opt-in — so the
 * anonymous path no longer gets the same-UTC-day rollover.
 *
 * EXTENDED: COMPOSITE ACTORS — a verified OAuth `sub`
 * SCOPES the declared handle instead of overriding it, behind MANDREL_ACTOR_COMPOSITE_ENABLED
 * (default OFF). Three new sections at the bottom of this file:
 *   1. LEGACY PARITY — replays a golden fixture RECORDED from the pre-change commit's own
 *      source, proving the flag-OFF path is byte-identical to main.
 *   2. THE SHIPPED DEFAULT IS OFF — behaviorally, not by reading the literal.
 *   3. COMPOSITE MODE — composition, delimiter sanitation (the forgery guard), and
 *      last-segment classification.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTOR_COMPOSITE_DELIMITER,
  ACTOR_IDENTITY_ENV,
  ACTOR_RESERVED_DELIMITER_CHARS,
  compositeActorEnabled,
} from '../config/actorIdentityConfig.js';
import {
  ACTOR_ANONYMOUS,
  classifyActor,
  deriveActor,
  encodePrincipalActor,
  normalizeActor,
  refineActor,
  sanitizeDeclaredActor,
  type ActorKind,
} from '../config/actorRegistry.js';

describe('actorRegistry.normalizeActor', () => {
  it('trims, lowercases, and hyphenates whitespace to a stable slug', () => {
    expect(normalizeActor('  Coordinator ')).toBe('coordinator');
    expect(normalizeActor('Deploy Smoke')).toBe('deploy-smoke');
    expect(normalizeActor('Builder  --  ABC123')).toBe('builder-abc123');
  });

  it('maps blank / undefined / null to null (no actor derivable)', () => {
    expect(normalizeActor('')).toBeNull();
    expect(normalizeActor('   ')).toBeNull();
    expect(normalizeActor(undefined)).toBeNull();
    expect(normalizeActor(null)).toBeNull();
  });

  it('is idempotent on already-normalized values', () => {
    for (const v of ['coordinator', 'deploy-smoke', 'builder-0803f00d', 'anonymous']) {
      expect(normalizeActor(v)).toBe(v);
    }
  });
});

describe('actorRegistry.classifyActor', () => {
  it('classifies enumerated humans', () => {
    expect(classifyActor('operator')).toBe<ActorKind>('human');
    expect(classifyActor('Operator')).toBe('human'); // normalized first
    expect(classifyActor('carol')).toBe('human');
  });

  it('classifies enumerated agents', () => {
    for (const a of ['coordinator', 'reviewer', 'researcher', 'ops-bot', 'auditor', 'builder']) {
      expect(classifyActor(a)).toBe('agent');
    }
  });

  it('classifies the parametric builder-<id8> family as agent via the prefix rule', () => {
    expect(classifyActor('builder-0803f00d')).toBe('agent');
    expect(classifyActor('builder-sessions-phase1')).toBe('agent');
    expect(classifyActor('reviewer-abc123')).toBe('agent');
  });

  it('classifies enumerated automation (the opt-in): tick, deploy-smoke, cron', () => {
    expect(classifyActor('tick')).toBe('automation');
    expect(classifyActor('deploy-smoke')).toBe('automation');
    expect(classifyActor('cron')).toBe('automation');
  });

  /**
   * THE REGRESSION GUARD for an earlier decision. If this ever flips back to 'automation',
   * every unconfigured tenant silently gets the same-UTC-day rollover again and their
   * sessions split at 00:00 UTC mid-work. Interactive is the DEFAULT.
   */
  it('classifies the anonymous fallback as AGENT — interactive is the default, not automation', () => {
    expect(classifyActor(ACTOR_ANONYMOUS)).toBe<ActorKind>('agent');
    expect(classifyActor(ACTOR_ANONYMOUS)).not.toBe('automation');
  });

  it('treats blank/undefined as anonymous → agent (never throws, never automation)', () => {
    expect(classifyActor(undefined)).toBe('agent'); // anonymous → agent
    expect(classifyActor('')).toBe('agent');
    expect(classifyActor(null)).toBe('agent');
  });

  /**
   * The anonymous fallback and the unknown-actor default must classify the SAME way — that
   * agreement is WHY 'agent' was chosen over 'human' (one rule, not two copies
   * that drift). This test fails if either side is changed in isolation.
   */
  it('the anonymous fallback agrees with the unknown-actor default (no drift between the two paths)', () => {
    expect(classifyActor(ACTOR_ANONYMOUS)).toBe(classifyActor('some-unregistered-thing'));
  });

  /**
   * Automation stays an EXPLICIT, enumerated opt-in — a tenant declaring its own bot still
   * gets automation (and its day-roll) without a code change. Proves the new default did not
   * remove the escape hatch.
   */
  it('a tenant can still opt its own bot INTO automation via the env registry', () => {
    const saved = process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
    process.env.MANDREL_ACTOR_REGISTRY_EXTRA = 'theirbot:automation';
    try {
      expect(classifyActor('theirbot')).toBe('automation');
      expect(classifyActor(ACTOR_ANONYMOUS)).toBe('agent'); // unchanged by the extra
    } finally {
      if (saved === undefined) delete process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
      else process.env.MANDREL_ACTOR_REGISTRY_EXTRA = saved;
    }
  });

  it('falls back to the default kind (agent) for an unknown declared actor', () => {
    expect(classifyActor('some-unregistered-thing')).toBe('agent');
  });
});

describe('actorRegistry.deriveActor — LEGACY default path (flag OFF: auth > declared > none)', () => {
  it('an authenticated principal WINS over a client-declared header (never trust say-so over auth)', () => {
    expect(deriveActor('operator', 'attacker')).toBe('operator');
    expect(deriveActor('  operator  ', 'coordinator')).toBe('operator');
  });

  it('uses the declared value when there is no authenticated principal', () => {
    expect(deriveActor(undefined, 'tick')).toBe('tick');
    expect(deriveActor(null, '  tick  ')).toBe('tick');
    expect(deriveActor('', 'tick')).toBe('tick');
  });

  it('returns undefined (→ anonymous at stamp time) when neither is present', () => {
    expect(deriveActor(undefined, undefined)).toBeUndefined();
    expect(deriveActor('', '   ')).toBeUndefined();
    expect(deriveActor(null, null)).toBeUndefined();
  });
});

describe('actorRegistry env-extendability (configs-not-hardcoded)', () => {
  const savedRegistry = process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
  const savedDefault = process.env.MANDREL_ACTOR_DEFAULT_KIND;

  beforeEach(() => {
    delete process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
    delete process.env.MANDREL_ACTOR_DEFAULT_KIND;
  });
  afterEach(() => {
    if (savedRegistry === undefined) delete process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
    else process.env.MANDREL_ACTOR_REGISTRY_EXTRA = savedRegistry;
    if (savedDefault === undefined) delete process.env.MANDREL_ACTOR_DEFAULT_KIND;
    else process.env.MANDREL_ACTOR_DEFAULT_KIND = savedDefault;
  });

  it('adds actors from MANDREL_ACTOR_REGISTRY_EXTRA without a code change', () => {
    process.env.MANDREL_ACTOR_REGISTRY_EXTRA = 'scout:agent,payroll-bot:automation';
    expect(classifyActor('scout')).toBe('agent');
    expect(classifyActor('payroll-bot')).toBe('automation');
  });

  it('env extras override a built-in and env default kind changes the fallback', () => {
    process.env.MANDREL_ACTOR_REGISTRY_EXTRA = 'tick:agent';
    expect(classifyActor('tick')).toBe('agent'); // built-in automation overridden
    process.env.MANDREL_ACTOR_DEFAULT_KIND = 'human';
    expect(classifyActor('totally-unknown')).toBe('human');
  });
});

// =============================================================================================
// COMPOSITE ACTOR IDENTITY
// =============================================================================================

const FLAG = ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, 'fixtures', 'actorRegistry.legacy-golden.json');

interface LegacyGolden {
  _capturedFromCommit: string;
  _capturedUnderEnv: Record<string, string>;
  deriveActor: Array<{ sub: string | null; declared: string | null; out: string | null }>;
  unary: Array<{ in: string | null; normalize: string | null; classify: ActorKind }>;
}

const GOLDEN: LegacyGolden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as LegacyGolden;

/**
 * The reserved-delimiter set AS PINNED BY THIS TEST FILE — a deliberate second copy, and the one
 * place in here that must NOT track the product constant (Reviewer N-b/N-c).
 *
 * WHY A LITERAL: the degenerate-parity filter below excludes fixture rows containing a reserved
 * character. If that filter read ACTOR_RESERVED_DELIMITER_CHARS, then widening the product's set
 * would widen the exclusion IN LOCKSTEP — guard and product agreeing while covering less and
 * less, which is precisely the a past incident shape. Exact row counts do NOT close that on their own:
 * a probe adding '#' to the product set kept the counts at 152/112 (no fixture value contains
 * '#') and passed GREEN. So the filter is pinned to a literal, and the product constant is
 * asserted EQUAL to it — a widening then REDs immediately and unconditionally, whatever the
 * fixture happens to contain.
 */
const RESERVED_AT_PIN: readonly string[] = ['/', ':'];

/**
 * Snapshot + restore the three env vars this whole section steers, so the suite-wide env-leak
 * guard (vitest.setup.ts) stays satisfied no matter which case ran last.
 */
function useActorEnvSandbox(): void {
  const saved: Record<string, string | undefined> = {};
  const VARS = [FLAG, 'MANDREL_ACTOR_REGISTRY_EXTRA', 'MANDREL_ACTOR_DEFAULT_KIND'];
  beforeAll(() => {
    for (const v of VARS) saved[v] = process.env[v];
  });
  beforeEach(() => {
    // The golden fixture was captured with the registry extras + default-kind override UNSET.
    // Reproduce that env exactly, or the replay would be comparing against a different config.
    for (const v of VARS) delete process.env[v];
  });
  afterAll(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v] as string;
    }
  });
}

/**
 * LEGACY == TODAY. The Lesson-025 regression guard that must hold at EVERY phase of this
 * change: with the kill switch OFF (the shipped default), the actor stack behaves exactly as
 * it did before the change.
 *
 * THE ORACLE IS A RECORDING, NOT A RE-IMPLEMENTATION. The fixture was produced by executing
 * the PRE-CHANGE source itself (`git show <commit>:…/actorRegistry.ts`) over a 35-value input
 * matrix — 1225 deriveActor pairs plus every distinct output — so this test cannot drift into
 * "two programs that happen to agree" (a past incident rule 2). Regenerating it requires an
 * explicit decision to change legacy behavior.
 */
describe('COMPOSITE ACTORS — legacy parity: flag OFF is byte-identical to the pre-change commit', () => {
  useActorEnvSandbox();

  it('the fixture is NOT vacuous', () => {
    expect(GOLDEN._capturedUnderEnv[FLAG]).toBe('<unset>');
    // Fail-closed floors: a fixture that got truncated/emptied must RED, not silently pass.
    expect(GOLDEN.deriveActor.length).toBeGreaterThanOrEqual(1000);
    expect(GOLDEN.unary.length).toBeGreaterThanOrEqual(30);
    // …and it must actually contain the shapes this change is about.
    const bothPresent = GOLDEN.deriveActor.filter(
      (r) => (r.sub ?? '').trim() !== '' && (r.declared ?? '').trim() !== '',
    );
    expect(bothPresent.length).toBeGreaterThan(0); // the override case (the bug being fixed)
    const delimiterDeclared = GOLDEN.deriveActor.filter((r) =>
      (r.declared ?? '').includes(ACTOR_COMPOSITE_DELIMITER),
    );
    expect(delimiterDeclared.length).toBeGreaterThan(0); // the forgery shape
    const delimiterUnary = GOLDEN.unary.filter((u) =>
      (u.in ?? '').includes(ACTOR_COMPOSITE_DELIMITER),
    );
    expect(delimiterUnary.length).toBeGreaterThan(0); // the composite shape
  });

  it('deriveActor reproduces every recorded (sub, declared) → actor row', () => {
    expect(compositeActorEnabled()).toBe(false); // the state under test, asserted not assumed
    const drift: string[] = [];
    for (const row of GOLDEN.deriveActor) {
      const got = deriveActor(row.sub, row.declared) ?? null;
      if (got !== row.out) {
        drift.push(`deriveActor(${JSON.stringify(row.sub)}, ${JSON.stringify(row.declared)}) → ${JSON.stringify(got)}, legacy was ${JSON.stringify(row.out)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('normalizeActor / classifyActor reproduce every recorded row', () => {
    const drift: string[] = [];
    for (const row of GOLDEN.unary) {
      const n = normalizeActor(row.in);
      if (n !== row.normalize) drift.push(`normalizeActor(${JSON.stringify(row.in)}) → ${JSON.stringify(n)}, legacy was ${JSON.stringify(row.normalize)}`);
      const c = classifyActor(row.in);
      if (c !== row.classify) drift.push(`classifyActor(${JSON.stringify(row.in)}) → ${c}, legacy was ${row.classify}`);
    }
    expect(drift).toEqual([]);
  });

  it('a null and an undefined argument stay interchangeable on every function (the fixture records null)', () => {
    expect(deriveActor(undefined, undefined)).toBe(deriveActor(null, null));
    expect(deriveActor(undefined, 'tick')).toBe(deriveActor(null, 'tick'));
    expect(normalizeActor(undefined)).toBe(normalizeActor(null));
    expect(classifyActor(undefined)).toBe(classifyActor(null));
  });

  /**
   * THE PARITY TEST'S OWN TEETH. If the two modes agreed on every recorded row, the replay
   * above would pass no matter what the flag did — a green light that measures nothing. This
   * asserts the fixture contains rows the composite mode genuinely CHANGES, so "flag OFF
   * reproduces it" is a real constraint.
   */
  it('is DISCRIMINATING: turning the flag ON changes recorded rows (so the replay is not vacuous)', () => {
    process.env[FLAG] = 'true';
    const changedDerive = GOLDEN.deriveActor.filter((r) => (deriveActor(r.sub, r.declared) ?? null) !== r.out);
    const changedClassify = GOLDEN.unary.filter((u) => classifyActor(u.in) !== u.classify);
    expect(changedDerive.length).toBeGreaterThan(0);
    expect(changedClassify.length).toBeGreaterThan(0);
  });
});

/**
 * THE SHIPPED DEFAULT IS OFF (merge, deploy and enable are three separate
 * decisions). Asserted BEHAVIORALLY — through deriveActor/classifyActor, not by reading the
 * flag's literal — so flipping the default in actorIdentityConfig.ts REDs these cases.
 */
describe('COMPOSITE ACTORS — the kill switch defaults OFF (merging this changes nothing at runtime)', () => {
  useActorEnvSandbox();

  it('UNSET → disabled: a verified sub still OVERRIDES the declared handle (today’s behavior)', () => {
    expect(process.env[FLAG]).toBeUndefined();
    expect(compositeActorEnabled()).toBe(false);
    expect(deriveActor('operator@example.com', 'builder-abc')).toBe('operator@example.com');
    expect(deriveActor('operator@example.com', 'builder-abc')).not.toContain(ACTOR_COMPOSITE_DELIMITER);
  });

  it.each(['', '   ', 'flase', 'maybe', 'enabled'])(
    'blank / unrecognized %j → falls back to the OFF default (a typo cannot half-enable it)',
    (value) => {
      process.env[FLAG] = value;
      expect(compositeActorEnabled()).toBe(false);
      expect(deriveActor('operator@example.com', 'builder-abc')).toBe('operator@example.com');
    },
  );

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'On'])('explicit truthy %j → enabled', (value) => {
    process.env[FLAG] = value;
    expect(compositeActorEnabled()).toBe(true);
    expect(deriveActor('operator@example.com', 'builder-abc')).toBe('operator@example.com/builder-abc');
  });

  it.each(['0', 'false', 'no', 'off', 'FALSE', 'Off'])('explicit falsey %j → disabled', (value) => {
    process.env[FLAG] = value;
    expect(compositeActorEnabled()).toBe(false);
    expect(deriveActor('operator@example.com', 'builder-abc')).toBe('operator@example.com');
  });
});

describe('COMPOSITE ACTORS — scoped composition (flag ON)', () => {
  useActorEnvSandbox();
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  it('sub + declared → a SERVER-ASSEMBLED composite: the sub SCOPES the handle, never overrides it', () => {
    expect(deriveActor('operator@example.com', 'builder-abc')).toBe('operator@example.com/builder-abc');
    expect(deriveActor('  operator@example.com  ', '  worker-7  ')).toBe('operator@example.com/worker-7');
  });

  /**
   * THE WHOLE POINT: N agents under ONE human must be N actors. Today they
   * all collapse to the sub.
   */
  it('N declared handles under ONE verified principal yield N DISTINCT actors', () => {
    const sub = 'operator@example.com';
    const actors = ['coordinator', 'builder-a1b2c3d4', 'builder-e5f6a7b8', 'tick'].map((h) => deriveActor(sub, h));
    expect(new Set(actors).size).toBe(4);
    for (const a of actors) expect(a).toMatch(/^operator@example\.com\//);
  });

  it('DEGENERATE — sub only → the bare sub (a lone human on the connector configures nothing)', () => {
    expect(deriveActor('operator@example.com', undefined)).toBe('operator@example.com');
    expect(deriveActor('operator@example.com', null)).toBe('operator@example.com');
    expect(deriveActor('operator@example.com', '   ')).toBe('operator@example.com');
  });

  it('DEGENERATE — declared only → the declared handle (the static-bearer path, unchanged)', () => {
    expect(deriveActor(undefined, 'tick')).toBe('tick');
    expect(deriveActor(null, '  tick  ')).toBe('tick');
    expect(deriveActor('', 'builder-0803f00d')).toBe('builder-0803f00d');
  });

  it('DEGENERATE — neither → undefined (→ the flagged anonymous actor at stamp time)', () => {
    expect(deriveActor(undefined, undefined)).toBeUndefined();
    expect(deriveActor(null, null)).toBeUndefined();
    expect(deriveActor('', '   ')).toBeUndefined();
  });

  /**
   * The three degenerate cases must be BYTE-IDENTICAL to the legacy recording — replayed from
   * the golden fixture rather than restated by hand, so this cannot quietly disagree with what
   * main actually did.
   *
   * THE PRECONDITION IS STATED, NOT ASSUMED (Reviewer N1): byte-identity holds for
   * delimiter-free inputs — which is every realistic sub and handle. The two deliberate
   * divergences in composite mode are excluded HERE, by an explicit filter, and each is
   * asserted positively in its own case below, so neither can hide inside a widened filter:
   *   - a DECLARED value containing a reserved char is sanitized (the forgery guard),
   *   - a PRINCIPAL containing one is encoded (the collision guard).
   */
  it('all three degenerate cases replay the LEGACY golden rows byte-for-byte (delimiter-free inputs)', () => {
    // NOTE: RESERVED_AT_PIN, deliberately NOT ACTOR_RESERVED_DELIMITER_CHARS — see its docstring.
    const hasDelimiter = (v: string | null) =>
      RESERVED_AT_PIN.some((ch) => (v ?? '').includes(ch));
    const degenerate = GOLDEN.deriveActor.filter((r) => {
      const s = (r.sub ?? '').trim();
      const d = (r.declared ?? '').trim();
      const isDegenerate = !(s !== '' && d !== '');
      return isDegenerate && !hasDelimiter(r.declared) && !hasDelimiter(r.sub);
    });
    // EXACT counts, not a floor (Reviewer N-b/N-c). A floor lets the exclusion widen silently:
    // adding a character to ACTOR_RESERVED_DELIMITER_CHARS widens the filter in LOCKSTEP with the
    // product, so the two copies of the rule agree while covering less and less — the a past incident
    // shape exactly. Pinning both sides means any change to the reserved set REDs here and has to
    // be re-justified. (Measured on the 35-value matrix: 264 degenerate rows, 152 kept / 112
    // excluded. A probe that added '#' to the reserved set was silently absorbed by the old floor.)
    const allDegenerate = GOLDEN.deriveActor.filter((r) => {
      const sub = (r.sub ?? '').trim();
      const dec = (r.declared ?? '').trim();
      return !(sub !== '' && dec !== '');
    });
    expect(allDegenerate.length).toBe(264);
    expect(degenerate.length).toBe(152);
    expect(allDegenerate.length - degenerate.length).toBe(112);

    const drift = degenerate.filter((r) => (deriveActor(r.sub, r.declared) ?? null) !== r.out);
    expect(drift).toEqual([]);
  });

  /**
   * The excluded rows, asserted POSITIVELY. A filter that quietly drops rows is an allow-list
   *; these two cases pin exactly what the filter above is allowed to exclude and
   * WHY, so widening it later shows up as a contradiction rather than a silent pass.
   */
  /**
   * THE PIN ITSELF. Widening (or narrowing) the product's reserved set must be a DECISION that
   * lands in a reviewed diff with the parity split re-reasoned — never a silent change that the
   * filter above absorbs. This is the assertion the exact row counts could not make.
   */
  it('the reserved delimiter set is PINNED — changing it is a decision, not a silent widening', () => {
    expect([...ACTOR_RESERVED_DELIMITER_CHARS].sort()).toEqual([...RESERVED_AT_PIN].sort());
  });

  it('DELIBERATE DIVERGENCE 1 — a delimiter-bearing DECLARED value is sanitized, not passed through', () => {
    expect(deriveActor(undefined, 'victim@x/coordinator')).toBe('victim@x-coordinator');
    // legacy recorded the raw pass-through for the same input:
    const legacyRow = GOLDEN.deriveActor.find((r) => r.sub === null && r.declared === 'a/b');
    expect(legacyRow?.out).toBe('a/b');
    expect(deriveActor(null, 'a/b')).toBe('a-b');
  });

  it('DELIBERATE DIVERGENCE 2 — a delimiter-bearing PRINCIPAL is encoded, not passed through', () => {
    const legacyRow = GOLDEN.deriveActor.find((r) => r.sub === 'a/b' && r.declared === null);
    expect(legacyRow?.out).toBe('a/b');
    expect(deriveActor('a/b', null)).toBe('a%2Fb');
  });
});

describe('COMPOSITE ACTORS — delimiter sanitation is the FORGERY GUARD (flag ON)', () => {
  useActorEnvSandbox();
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  /**
   * THE INVARIANT, stated as one property over the whole declared surface: an actor string
   * that CONTAINS the composite delimiter can only have been assembled SERVER-SIDE. If a
   * client-declared value could ever carry it through, a static-bearer caller could spell
   * another principal's composite and land in their namespace.
   */
  it('INVARIANT — no client-declared value can ever produce a delimiter without a verified sub', () => {
    const hostile = [
      'victim@example.com/coordinator',
      '/coordinator',
      'coordinator/',
      'a/b/c',
      'x:y',
      '::',
      '/',
      ':',
      'sub/builder-abc',
      'UPPER/Operator',
      'a//b',
    ];
    for (const declared of hostile) {
      const actor = deriveActor(undefined, declared);
      for (const ch of ACTOR_RESERVED_DELIMITER_CHARS) {
        expect(actor ?? '').not.toContain(ch);
      }
    }
  });

  it('a hostile declared handle cannot collide with the composite a real principal would get', () => {
    const victimActor = deriveActor('victim@example.com', 'coordinator'); // the real, server-composed one
    const forged = deriveActor(undefined, 'victim@example.com/coordinator'); // the attempt
    expect(victimActor).toBe('victim@example.com/coordinator');
    expect(forged).not.toBe(victimActor);
  });

  it('the DECLARED half is stripped while the verified principal is ENCODED (never silently mangled)', () => {
    // The principal keeps its information (reversibly encoded); the declared half does not.
    expect(deriveActor('auth0|abc/123', 'builder-x')).toBe('auth0|abc%2F123/builder-x');
    expect(deriveActor(undefined, 'auth0|abc/123')).toBe('auth0|abc-123');
    // …and the handle is still the segment after the (single) delimiter, so classification works.
    expect(classifyActor('auth0|abc%2F123/tick')).toBe('automation');
  });

  it('sanitizeDeclaredActor replaces every reserved char and never returns a delimiter', () => {
    expect(sanitizeDeclaredActor('a/b')).toBe('a-b');
    expect(sanitizeDeclaredActor('x:y')).toBe('x-y');
    expect(sanitizeDeclaredActor('a/b:c/d')).toBe('a-b-c-d');
    expect(sanitizeDeclaredActor('plain-handle')).toBe('plain-handle');
    for (const ch of ACTOR_RESERVED_DELIMITER_CHARS) {
      expect(sanitizeDeclaredActor(`pre${ch}post`)).not.toContain(ch);
    }
  });

  /**
   * REVIEWER N1 — the invariant is only true if VERIFIED PRINCIPALS are delimiter-free too.
   * An OAuth `sub` is not guaranteed to be (an issuer-URL-shaped sub contains `/` and `:`).
   * Left raw, `sub='a/b'` alone and `sub='a' + declared='b'` both produce the actor `a/b` — a
   * real cross-principal collision inside the feature that promises none. Probed and RED before
   * encodePrincipalActor() existed.
   */
  it('INVARIANT — two DIFFERENT principals can never produce the same actor (delimiter-bearing sub)', () => {
    const bareDelimiterSub = deriveActor('a/b', undefined);
    const composed = deriveActor('a', 'b');
    expect(bareDelimiterSub).not.toBe(composed);
    // the same shape with the reserved colon, and with an issuer-URL-shaped sub
    expect(deriveActor('a:b', undefined)).not.toBe(deriveActor('a', 'b'));
    expect(deriveActor('https://issuer/u1', undefined)).not.toBe(deriveActor('https://issuer', 'u1'));
  });

  /**
   * ── THE RESIDUAL, PINNED DELIBERATELY (Reviewer B2) ─────────────────────────────────────
   *
   * THIS TEST ASSERTS A LIMITATION, NOT A GUARANTEE. It exists because the docstrings here once
   * claimed, absolutely, that "a client-supplied string can never produce another principal's
   * actor" — and that is FALSE for the shape that matters most: a principal with NO declared
   * handle has a FLAT actor, and a declared-only caller can spell it exactly. That shape is the
   * COMMON case ("a lone human on the Claude.ai connector configures nothing").
   *
   * The three invariant tests above all missed it because each was written in the shape its
   * author expected — one about delimiters, one comparing against a COMPOSITE victim, one
   * comparing two VERIFIED principals. None asked the flat question. So this one asks it
   * directly, and will FAIL LOUDLY if someone ever "fixes" it silently — at which point the
   * locked degenerate cases in an earlier decision have changed and that must be a decision, not
   * a side effect.
   *
   * IT IS NOT FIXABLE HERE: an earlier change locks BOTH flat cases to the identity function (sub-only →
   * sub, declared-only → declared). Two identity functions over the same domain collide totally.
   * The upgrade path is per-agent MINTED CREDENTIALS, not a stronger string rule.
   *
   * READ THIS BEFORE BUILDING ANYTHING AUTHZ-SHAPED ON `actor`. It is ATTRIBUTION.
   */
  it('RESIDUAL (pinned, not a guarantee) — a declared-only caller CAN spell a bare principal’s flat actor', () => {
    for (const principal of ['victim@example.com', '9f1c2b3a-4d5e-6f70', 'auth0|abc123']) {
      const principalOnly = deriveActor(principal, undefined);
      const declaredOnly = deriveActor(undefined, principal);
      expect(declaredOnly).toBe(principalOnly); // ← the residual, asserted as fact
      // …and it survives stamp-time normalization, so the DB row collides too.
      expect(normalizeActor(declaredOnly)).toBe(normalizeActor(principalOnly));
    }
    // Case-folding closes the last gap a reader might hope for:
    expect(normalizeActor(deriveActor(undefined, 'victim@example.com'))).toBe(
      normalizeActor(deriveActor('Victim@Example.com', undefined)),
    );
    // An ENCODED principal is equally spellable — encoding separates COMPOSITES, not the flat space.
    expect(deriveActor(undefined, 'a%2Fb')).toBe(deriveActor('a/b', undefined));
  });

  /**
   * The CONTRAST that says exactly how far the guarantee does reach: the moment a principal has
   * a handle, its actor moves into the composite namespace and becomes unspellable. This is the
   * boundary the narrowed docstrings claim, asserted as a pair with the residual above so the
   * two can never drift apart in a reader's head.
   */
  it('…but the moment a principal HAS a handle, its composite actor is unspellable', () => {
    const victim = deriveActor('victim@example.com', 'coordinator');
    expect(victim).toBe('victim@example.com/coordinator');
    for (const attempt of ['victim@example.com/coordinator', 'victim@example.com%2Fcoordinator', 'victim@example.com-coordinator']) {
      expect(deriveActor(undefined, attempt)).not.toBe(victim);
    }
  });

  it('principal encoding is INJECTIVE — a literal "%2F" in a sub is distinguishable from an encoded "/"', () => {
    expect(encodePrincipalActor('a/b')).not.toBe(encodePrincipalActor('a%2Fb'));
    expect(deriveActor('a/b', 'x')).not.toBe(deriveActor('a%2Fb', 'x'));
  });

  it('encoding is a NO-OP for every realistic sub — the common path is untouched by construction', () => {
    for (const sub of [
      'operator@example.com',
      '9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
      'auth0|abc123',
      'google-oauth2|107654321',
      'operator',
    ]) {
      expect(encodePrincipalActor(sub)).toBe(sub);
      expect(deriveActor(sub, undefined)).toBe(sub); // degenerate sub-only case unchanged
      expect(deriveActor(sub, 'builder-x')).toBe(`${sub}/builder-x`);
    }
  });

  /**
   * The structural reason first-split and last-split are the same reading for anything this
   * system can PRODUCE: the principal is encoded (no raw delimiter) and the handle is stripped
   * (no raw delimiter), so a well-formed composite holds EXACTLY ONE. Guards the ambiguity that
   * "classify the last segment" vs "split on the first delimiter" would otherwise leave open.
   */
  it('every actor the system can PRODUCE holds at most ONE delimiter (first-split ≡ last-split)', () => {
    const subs = ['operator@example.com', 'a/b', 'a:b', 'https://issuer/u1', 'auth0|abc123', 'x%2Fy'];
    const declared = ['coordinator', 'a/b', 'victim@x/coordinator', 'x:y', 'builder-0803f00d', '///'];
    const produced: string[] = [];
    for (const s of subs) {
      for (const dd of [...declared, undefined]) {
        const actor = deriveActor(s, dd);
        if (actor !== undefined) produced.push(actor);
      }
    }
    // …and the SAME invariant must survive a downstream refinement, or a second pass through
    // the identity path could grow a third segment and break the grammar.
    for (const base of [...produced]) {
      for (const dd of declared) {
        const refined = refineActor(base, dd);
        if (refined !== undefined) produced.push(refined);
      }
    }
    expect(produced.length).toBeGreaterThan(50); // non-vacuous
    for (const actor of produced) {
      const parts = actor.split(ACTOR_COMPOSITE_DELIMITER);
      expect(parts.length).toBeLessThanOrEqual(2);
      expect(parts[parts.length - 1]).toBe(actor.slice(actor.indexOf(ACTOR_COMPOSITE_DELIMITER) + 1));
    }
  });

  /**
   * refineActor is the DOWNSTREAM entry point: an already-derived actor plus
   * a caller-declared handle. These pin the two properties that make it safe to call it from
   * any route — it never re-derives, and a declared value can only ever move the HANDLE.
   */
  it('refineActor never RE-DERIVES an already-derived actor (the double-derivation trap)', () => {
    process.env[FLAG] = 'true';
    const derived = deriveActor('operator@example.com', 'coordinator') as string;
    expect(derived).toBe('operator@example.com/coordinator');
    // deriveActor would encode the composite as if it were a raw principal — refineActor must not.
    expect(deriveActor(derived, 'builder-x')).toBe('operator@example.com%2Fcoordinator/builder-x');
    expect(refineActor(derived, 'builder-x')).toBe('operator@example.com/builder-x');
  });

  it('refineActor: a declared handle can move the HANDLE segment, never the PRINCIPAL', () => {
    process.env[FLAG] = 'true';
    const refined = refineActor('attacker@evil.com/worker-1', 'victim@example.com/coordinator') as string;
    expect(refined.split(ACTOR_COMPOSITE_DELIMITER)[0]).toBe('attacker@evil.com');
    expect(refined).not.toBe('victim@example.com/coordinator');
  });

  it('refineActor: composites OFF → the derived actor WINS (declared never replaces it)', () => {
    delete process.env[FLAG];
    expect(refineActor('coordinator', 'somebody-else')).toBe('coordinator');
    expect(refineActor(undefined, 'builder-0803f00d')).toBe('builder-0803f00d'); // dispatcher path
    expect(refineActor(undefined, undefined)).toBeUndefined();
    expect(refineActor('coordinator', undefined)).toBe('coordinator');
  });

  it('an all-delimiter declared handle degrades safely to the anonymous fallback, never throws', () => {
    const actor = deriveActor(undefined, '///');
    expect(() => classifyActor(actor)).not.toThrow();
    expect(normalizeActor(actor)).toBeNull(); // '---' → '' → null → anonymous at stamp time
    expect(classifyActor(actor)).toBe(classifyActor(ACTOR_ANONYMOUS));
  });
});

describe('COMPOSITE ACTORS — classification reads the LAST segment (flag ON)', () => {
  useActorEnvSandbox();
  beforeEach(() => {
    process.env[FLAG] = 'true';
  });

  /**
   * THE REGRESSION THIS PREVENTS: an enumerated automation running under an OAuth principal
   * would classify as 'agent' (the default kind) instead of 'automation' — silently losing its
   * same-UTC-day session rollover, which is the ONLY session boundary the hourly tick has.
   */
  it('an enumerated actor classifies the SAME under a principal as it does bare', () => {
    for (const handle of ['tick', 'deploy-smoke', 'cron', 'operator', 'coordinator', 'carol']) {
      expect(classifyActor(`operator@example.com/${handle}`)).toBe(classifyActor(handle));
    }
  });

  it('the parametric builder-<id8> family still hits its prefix rule inside a composite', () => {
    expect(classifyActor('operator@example.com/builder-0803f00d')).toBe('agent');
    expect(classifyActor('operator@example.com/reviewer-abc123')).toBe('agent');
  });

  it('classification ignores the PRINCIPAL half — only the trailing handle decides the kind', () => {
    // 'operator' is an enumerated HUMAN; as a principal prefix it must not make the actor human.
    expect(classifyActor('operator/tick')).toBe('automation');
    // …and the same handle under a different principal classifies identically.
    expect(classifyActor('someone-else@example.com/tick')).toBe('automation');
  });

  it('a non-composite actor is unaffected by last-segment classification', () => {
    expect(classifyActor('tick')).toBe('automation');
    expect(classifyActor('builder-0803f00d')).toBe('agent');
    expect(classifyActor(ACTOR_ANONYMOUS)).toBe('agent');
    expect(classifyActor(undefined)).toBe('agent');
  });

  it('an env-declared automation keeps its kind inside a composite (the opt-in still works)', () => {
    process.env.MANDREL_ACTOR_REGISTRY_EXTRA = 'theirbot:automation';
    expect(classifyActor('customer@example.com/theirbot')).toBe('automation');
  });

  /**
   * normalizeActor runs at STAMP time on the already-derived actor. If it ever started
   * stripping the delimiter, every composite would be shredded back into one flat actor —
   * re-creating the exact collapse this change exists to prevent.
   */
  it('normalizeActor PRESERVES the composite delimiter in both modes (the stamp-time survival guarantee)', () => {
    const composite = deriveActor('Operator@Example.com', 'Builder-ABC') as string;
    expect(composite).toBe('Operator@Example.com/Builder-ABC');
    expect(normalizeActor(composite)).toBe('operator@example.com/builder-abc');
    expect(normalizeActor(composite)).toContain(ACTOR_COMPOSITE_DELIMITER);
    delete process.env[FLAG];
    expect(normalizeActor(composite)).toBe('operator@example.com/builder-abc'); // mode-independent
  });
});
