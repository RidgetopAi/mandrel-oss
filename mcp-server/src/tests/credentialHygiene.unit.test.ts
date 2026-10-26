/**
 * CREDENTIAL DETECTION — Mandrel's first credential detector
 *
 * THE STATE THIS CLOSES: nothing in this repo had ever detected a credential in any stored
 * field. The scanner that already existed detects LEAKED TOOL-CALL XML — seven structural
 * wrapper tags — which is a different problem; a synthetic credential in
 * `metadata.capture.evidence` stored successfully with it in force.
 *
 * ★ THE CONTROL SET IS THE POINT OF THIS FILE. ★
 * The failure mode here is an OVER-BROAD scanner, not a missed token. The highest-value field
 * scanned (`metadata.capture.evidence`) exists to hold PASTED COMMAND OUTPUT, so a detector
 * that fires on git shas, uuids, base64 or diff hunks gets disabled, and then we have a guard
 * that READS as protection while providing none — strictly worse than the honest zero we had
 * (an earlier decision rejected entropy detection for exactly this reason). So the ACCEPTS
 * below are load-bearing evidence, not garnish, and they outnumber the REFUSALS on purpose.
 *
 * ── NO REAL CREDENTIAL APPEARS IN THE FIXTURES ────────────────────────────────────────────
 * The fixtures live in helpers/credentialFixtures.ts (shared with the SQL-sweep contract test)
 * and every positive is ASSEMBLED AT RUNTIME from a prefix plus a repeated-character body
 * (`'ghp_' + 'A'.repeat(36)`). That is deliberate on two counts: the value is obviously
 * synthetic to any reader, and no token-shaped literal is ever committed to the tree for a
 * secret scanner (or a human skimming a diff) to trip over. The tripwire test below asserts it.
 *
 * NO REGISTERED GUARD CLASS, deliberately. This is a PRODUCT input-boundary guard, not a
 * detector for one of our own engineering failure classes, so it has no registry row and it
 * carries no class marker.
 *
 * This file deliberately does not spell that marker out, not even to explain itself: the
 * marker is a MACHINE TOKEN swept by STAGE 0a22d out of these directories, and the sweep
 * cannot tell a declaration from a sentence about one. An earlier draft wrote the token
 * followed by "n/a" and the stage parsed the class id as `n`, correctly emitting a FINDING.
 */

import { describe, test, expect } from 'vitest';
import {
  findCredentialSignatures,
  findCredentialSignaturesDeep,
} from '../utils/credentialDetection.js';
import {
  CREDENTIAL_SIGNATURES,
  CREDENTIAL_PLACEHOLDER_PATTERN,
  ENV_ASSIGNMENT_PLACEHOLDER_PATTERN,
} from '../config/credentialDetectionConfig.js';
import { METADATA_SCAN_MAX_DEPTH } from '../config/inputHygieneConfig.js';
import { validateToolArguments } from '../middleware/validation.js';

import { body, SYNTHETIC, CREDENTIAL, HISTORICAL_SHAPES, CONTROLS } from './helpers/credentialFixtures.js';

describe('THE VOCABULARY — config/credentialDetectionConfig.ts', () => {
  test('every signature id is unique', () => {
    const ids = CREDENTIAL_SIGNATURES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('no pattern carries the /g flag — a global regex makes .exec() STATEFUL', () => {
    // With /g, RegExp.exec advances lastIndex on the SHARED config object, so the SECOND
    // call against the same signature starts mid-string and can miss. That is a guard that
    // silently weakens with use; the type system cannot catch it, so this assertion does.
    for (const sig of CREDENTIAL_SIGNATURES) {
      expect({ id: sig.id, global: sig.pattern.global }).toEqual({ id: sig.id, global: false });
    }
  });

  test('the detector is not stateful — the same value matches on every call', () => {
    for (let i = 0; i < 3; i++) {
      expect(findCredentialSignatures(SYNTHETIC['github-token'])).toEqual(['github-token']);
    }
  });

  test('EVERY registered signature has a synthetic positive fixture in this file', () => {
    // The population this suite asserts over is the WHOLE vocabulary, by construction: adding
    // a signature to the config without a fixture here turns this RED rather than shipping an
    // untested pattern.
    const missing = CREDENTIAL_SIGNATURES.map((s) => s.id).filter((id) => !(id in SYNTHETIC));
    expect(missing).toEqual([]);
  });

  test('no synthetic fixture is a real-looking secret — all bodies are repeated characters', () => {
    // Cheap tripwire against someone "improving" a fixture by pasting a real value.
    for (const [id, value] of Object.entries(SYNTHETIC)) {
      expect(`${id}:${/(.)\1{9,}/.test(value)}`).toBe(`${id}:true`);
    }
  });

  test('the placeholder pattern exempts env-var names and nothing token-shaped', () => {
    expect(CREDENTIAL_PLACEHOLDER_PATTERN.test('MCP_AUTH_TOKEN')).toBe(true);
    expect(CREDENTIAL_PLACEHOLDER_PATTERN.test('REPLACE_WITH_YOUR_TOKEN')).toBe(true);
    expect(CREDENTIAL_PLACEHOLDER_PATTERN.test('sk-ant-api03-mixedCase')).toBe(false);
  });
});

describe('DETECTION — each structurally-identifiable shape is found, and named', () => {
  test.each(Object.keys(SYNTHETIC))('%s is detected', (id) => {
    expect(findCredentialSignatures(SYNTHETIC[id])).toContain(id);
  });

  test.each(HISTORICAL_SHAPES)('HISTORICAL SHAPE — %s — is REFUSED', (_name, value, expectedId) => {
    expect(findCredentialSignatures(value)).toContain(expectedId);
    expect(() =>
      validateToolArguments('context_store', { content: value, type: 'completion' }),
    ).toThrow(/live credential/i);
  });

  test('the assignment placeholder vocabulary admits the documented words and nothing token-shaped', () => {
    for (const ok of ['your_password_here', 'Your-Password-Here', 'my-secret-value', 'changeme', 'replace-me-now']) {
      expect(`${ok}:${ENV_ASSIGNMENT_PLACEHOLDER_PATTERN.test(ok)}`).toBe(`${ok}:true`);
    }
    for (const no of ['DUMMY_' + body(12, 'z'), 'throwaway_0633d03240dbd725', 'yourpassword123456', 'changeme_but_really_a_secret']) { // shared-scratch-ok: detector FIXTURE — a token-shaped NEGATIVE for the placeholder pattern; no database or role of this name is touched
      expect(`${no}:${ENV_ASSIGNMENT_PLACEHOLDER_PATTERN.test(no)}`).toBe(`${no}:false`);
    }
    // ...and it is ADDITIVE: a SCREAMING_SNAKE body is still exempt through the shared pattern
    // (so this one need not, and must not, carry an /i-flagged [A-Z0-9_]+ of its own).
    expect(findCredentialSignatures('MCP_AUTH_TOKEN=REPLACE_WITH_YOUR_TOKEN')).toEqual([]);
    expect(findCredentialSignatures(`MCP_AUTH_TOKEN=DUMMY_${body(12, 'z')}`)).toEqual(['env-assignment-literal']);
  });

  test('a credential embedded in surrounding prose is still found', () => {
    const evidence = `$ aws sts get-caller-identity\nAccessKeyId: ${CREDENTIAL}\nexit 0`;
    expect(findCredentialSignatures(evidence)).toEqual(['aws-access-key-id']);
  });

  test('a fenced code block does NOT exempt a credential (unlike the tool-XML rule)', () => {
    // The tool-XML scan strips code spans, because quoting a wrapper tag as documentation is
    // legitimate. Pasting a live secret is never legitimate, so a fence must not launder it.
    expect(findCredentialSignatures('```\n' + CREDENTIAL + '\n```')).toEqual(['aws-access-key-id']);
    expect(findCredentialSignatures('`' + CREDENTIAL + '`')).toEqual(['aws-access-key-id']);
  });

  test('a PREFIX with no secret body is NOT a finding — that is the documentation escape hatch', () => {
    for (const prefix of ['sk-ant-', 'ghp_', 'glpat-', 'AKIA', 'AIza', 'npm_', 'xoxb-', 'hf_']) {
      expect(`${prefix}:${findCredentialSignatures(prefix).length}`).toBe(`${prefix}:0`);
    }
  });

  test('non-strings, empty strings and null are not findings', () => {
    for (const v of [undefined, null, 0, 42, true, {}, [], '']) {
      expect(findCredentialSignatures(v)).toEqual([]);
    }
  });
});

describe('★ THE CONTROL SET — ordinary evidence still stores (the assertion that matters most)', () => {
  test.each(CONTROLS)('%s is NOT flagged', (_name, value) => {
    expect(findCredentialSignatures(value)).toEqual([]);
  });

  test.each(CONTROLS)(
    '%s survives the REAL write boundary, in content AND in metadata.capture.evidence',
    (_name, value) => {
      // Not just the predicate — the shipped entry point, with the whole superRefine stack.
      expect(() =>
        validateToolArguments('context_store', {
          content: value,
          type: 'completion',
          metadata: { capture: { status: 'verified', evidence: value } },
        }),
      ).not.toThrow();
    },
  );

  test('a control is not flagged at ANY depth of a metadata bag either', () => {
    const bag = { capture: { evidence: CONTROLS.map(([name, value]) => ({ command: name, output: value })) } };
    expect(findCredentialSignaturesDeep(bag).findings).toEqual([]);
    expect(findCredentialSignaturesDeep(bag).truncated).toBe(false);
  });
});

describe('THE WRITE BOUNDARY — the shipped validator refuses a credential, by field', () => {
  test('context_store.content', () => {
    expect(() =>
      validateToolArguments('context_store', { content: `key was ${CREDENTIAL}`, type: 'code' }),
    ).toThrow(/live credential/i);
  });

  test('metadata.capture.evidence — the field the capture contract pushes tool output into', () => {
    expect(() =>
      validateToolArguments('context_store', {
        content: 'clean prose',
        type: 'completion',
        metadata: { capture: { status: 'verified', evidence: [{ command: 'env', output: CREDENTIAL }] } },
      }),
    ).toThrow(/metadata\.capture\.evidence\[0\]\.output/);
  });

  test('an ARBITRARY metadata key is guarded too — the population is the whole bag', () => {
    expect(() =>
      validateToolArguments('context_store', {
        content: 'clean prose',
        type: 'completion',
        metadata: { scratch: { deeper: [CREDENTIAL] } },
      }),
    ).toThrow(/metadata\.scratch\.deeper\[0\]/);
  });

  test.each([
    ['context_store', { content: CREDENTIAL, type: 'code' }],
    ['task_create', { title: `rotate ${CREDENTIAL}` }],
    ['task_create', { title: 'clean', description: CREDENTIAL }],
    [
      'decision_record',
      { decisionType: 'process', title: 't', description: 'd', rationale: CREDENTIAL, impactLevel: 'low' },
    ],
    ['project_create', { name: 'p-cred-probe', description: CREDENTIAL }],
    ['session_start', { title: 'clean', goal: CREDENTIAL }],
    ['task_update', { taskId: '440f0091-1111-2222-3333-444455556666', notes: CREDENTIAL }],
  ])('%s refuses a credential in its prose fields', (tool, args) => {
    expect(() => validateToolArguments(tool, args as never)).toThrow(/live credential/i);
  });

  test('the message names the KIND and never echoes the secret', () => {
    // The single most important property of this guard: rejecting a leaked secret must not
    // itself write the secret into a transcript. The detector returns ids, so there is no
    // matched-text field for a message to reach for — this asserts that end to end.
    let message = '';
    try {
      validateToolArguments('context_store', { content: `oops ${CREDENTIAL}`, type: 'code' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/AWS access key id/i);
    expect(message).not.toContain(CREDENTIAL);
    // ...and not a fragment of it either: no run of the secret body survives into the message.
    expect(message).not.toContain(CREDENTIAL.slice(4, 16));
  });
});

describe('TAGS — the last unscanned stored free-text field (baseTags split)', () => {
  /**
   * A tool-XML signature, so the tag scan is proved for BOTH hygiene rules. Kept SHORT on
   * purpose: tags carry an anti-abuse length cap, and a fixture over that cap would be
   * rejected for its LENGTH — which would make these assertions pass without the hygiene rule
   * ever running (a hollow guard, CLASSES.md C3). Both fixtures here are well under it.
   */
  const RAW_LEAK = '</description>';

  test.each([
    ['context_store', (tags: string[]) => ({ content: 'c', type: 'code', tags })],
    ['context_update', (tags: string[]) => ({ contextId: 'aaaaaaaa1111', tags })],
    [
      'decision_record',
      (tags: string[]) => ({
        decisionType: 'process', title: 't', description: 'd', rationale: 'r', impactLevel: 'low', tags,
      }),
    ],
    ['decision_update', (tags: string[]) => ({ decisionId: 'aaaaaaaa1111', tags })],
    ['task_create', (tags: string[]) => ({ title: 't', tags })],
    ['task_update', (tags: string[]) => ({ taskId: '440f0091-1111-2222-3333-444455556666', tags })],
  ])('%s WRITES tags with hygiene: a credential and a raw leak are both refused', (tool, build) => {
    expect(() => validateToolArguments(tool, build([CREDENTIAL]) as never)).toThrow(/live credential/i);
    expect(() => validateToolArguments(tool, build([RAW_LEAK]) as never)).toThrow(/tool-call XML/i);
    expect(() => validateToolArguments(tool, build(['batch:13', 'task:1c0af00d']) as never)).not.toThrow();
  });

  test.each([
    ['context_search', (tags: string[]) => ({ query: 'q', tags })],
    ['decision_search', (tags: string[]) => ({ query: 'q', tags })],
    ['task_list', (tags: string[]) => ({ tags })],
  ])(
    '%s FILTERS by tags with no hygiene — you must still be able to search for the poison',
    (tool, build) => {
      // This is why baseTags had to be split rather than wrapped. Wrapping the one shared
      // definition would make a SEARCH throw on a signature-bearing filter value, i.e. refuse
      // to let anyone look for exactly the records they are trying to find and clean up.
      expect(() => validateToolArguments(tool, build([RAW_LEAK]) as never)).not.toThrow();
      expect(() => validateToolArguments(tool, build([CREDENTIAL]) as never)).not.toThrow();
    },
  );
});

describe('SHARED BOUNDS — one walker, one truncation semantics (CLASSES.md C1/C5)', () => {
  test('a bag too deep to walk is still REFUSED, so an unscanned bag never reads as clean', () => {
    let node: unknown = 'leaf';
    for (let i = 0; i < METADATA_SCAN_MAX_DEPTH + 5; i++) node = { n: node };
    expect(() =>
      validateToolArguments('context_store', { content: 'c', type: 'code', metadata: node as never }),
    ).toThrow(/too deeply nested|too large/i);
    // ...and the credential walk reports the same third state on the same input, rather than
    // returning an empty (= looks-clean) finding list with no signal.
    expect(findCredentialSignaturesDeep(node).truncated).toBe(true);
  });
});
