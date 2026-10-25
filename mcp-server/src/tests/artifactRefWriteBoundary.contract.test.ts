/**
 * ARTIFACT REFERENCE — THE WRITE BOUNDARY.
 *
 * The unit suite proves the reference logic. This suite proves the logic is actually WIRED to
 * the boundary a real caller crosses: the zod validation schemas every MCP tool call is parsed
 * through (middleware/validation.ts → validationSchemas), which is what the routes and the
 * derived tool surface both use.
 *
 * DENY-BY-DEFAULT COVERAGE (a past incident — a coverage test is an allow-list unless it fails
 * closed). The boundary list is NOT hand-written here. It is DISCOVERED by walking every
 * schema in `validationSchemas` and finding each one that accepts a `metadata` property. Every
 * discovered boundary must reject a malformed artifact reference — so a NEW metadata boundary
 * added later is covered the moment it lands, and one that opts out of the shared `baseMetadata`
 * (re-declaring a raw `z.record(z.any())`) goes RED instead of quietly becoming a hole.
 *
 * The discovery itself is guarded: if it ever finds fewer boundaries than the floor below, the
 * suite fails LOUD rather than passing vacuously on an empty set.
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { validationSchemas } from '../middleware/validation.js';
import { ARTIFACT_REF_CONFIG } from '../config/artifactRefConfig.js';

const KEY = ARTIFACT_REF_CONFIG.metadataKey;
const HEAD = '6acef8712ab2e8c0ffee1234567890abcdef0123';
const SHA256 = 'a'.repeat(64);
const OTHER_SHA256 = 'b'.repeat(64);

const VALID_REF = {
  artifactType: 'git-bundle',
  repository: 'riverbend/amp-exp-1',
  head: HEAD,
  base: '12ab2e8c0ffee1234567890abcdef01234567890',
  sha256: SHA256,
  producerThread: 'T-019f2b33-0840-74c2-911a-d2ecdcdefa30',
  retrieval: { provider: 'amp-thread-file', path: '.git/phase-c-core.bundle' },
};

/**
 * The number of metadata write boundaries that existed when this guard was written (context
 * store/update, project create/update, decision record/update, task create/update/bulk_update,
 * link). A FLOOR, not an equality: adding boundaries is fine (they get covered automatically);
 * silently LOSING them means the discovery broke and the suite must say so.
 */
const KNOWN_METADATA_BOUNDARY_FLOOR = 10;

/** Unwrap ZodEffects/ZodOptional layers to reach the underlying ZodObject, if any. */
function asObjectSchema(schema: z.ZodTypeAny): z.ZodObject<any> | null {
  let cur: any = schema;
  for (let i = 0; i < 10 && cur; i++) {
    const name = cur?._def?.typeName;
    if (name === 'ZodObject') return cur as z.ZodObject<any>;
    if (name === 'ZodEffects') cur = cur._def.schema;
    else if (name === 'ZodOptional' || name === 'ZodNullable' || name === 'ZodDefault') cur = cur._def.innerType;
    else return null;
  }
  return null;
}

/** Every tool schema that accepts a `metadata` property — discovered, never listed. */
const METADATA_BOUNDARIES: string[] = Object.entries(validationSchemas)
  .filter(([, schema]) => {
    const obj = asObjectSchema(schema as z.ZodTypeAny);
    return !!obj && Object.prototype.hasOwnProperty.call(obj.shape, 'metadata');
  })
  .map(([name]) => name)
  .sort();

/** Parse `{metadata}` alone and return the issue text. Other fields may also complain — we only
 *  assert on whether the ARTIFACT-REFERENCE issue is present, which is field-local. */
function issueTextFor(tool: string, metadata: unknown): string {
  const result = (validationSchemas as Record<string, z.ZodTypeAny>)[tool].safeParse({ metadata });
  if (result.success) return '';
  return result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
}

describe('metadata write-boundary discovery (guard the guard)', () => {
  test('discovers at least the known metadata boundaries — never passes on an empty set', () => {
    // Printed so a reviewer sees WHICH boundaries this suite actually exercised.
    console.log(`[artifact-ref] metadata boundaries under guard (${METADATA_BOUNDARIES.length}): ${METADATA_BOUNDARIES.join(', ')}`);
    expect(METADATA_BOUNDARIES.length).toBeGreaterThanOrEqual(KNOWN_METADATA_BOUNDARY_FLOOR);
  });

  test('the boundaries include the ones the artifact reference is designed for', () => {
    // context_store carries the handoff; decision_record and task_create carry the other two
    // record types an orchestrator hands off through.
    for (const expected of ['context_store', 'context_update', 'decision_record', 'task_create']) {
      expect(METADATA_BOUNDARIES, `${expected} must be a guarded metadata boundary`).toContain(expected);
    }
  });
});

describe('EVERY metadata boundary rejects a malformed artifact reference', () => {
  test.each(METADATA_BOUNDARIES)('%s rejects an unknown retrieval provider', (tool) => {
    const text = issueTextFor(tool, {
      [KEY]: [{ ...VALID_REF, retrieval: { provider: 'usb-stick', path: 'x' } }],
    });
    expect(text, `${tool} silently accepted an unknown provider`).toMatch(/not an allowed provider/);
  });

  test.each(METADATA_BOUNDARIES)('%s rejects a structurally malformed reference', (tool) => {
    const text = issueTextFor(tool, { [KEY]: [{ artifactType: 'git-bundle' }] });
    expect(text, `${tool} silently accepted a reference with no retrieval/identity`).toMatch(/retrieval/);
  });

  test.each(METADATA_BOUNDARIES)('%s rejects a reference whose OBSERVED hash contradicts the expected one', (tool) => {
    const text = issueTextFor(tool, {
      [KEY]: [{ ...VALID_REF, observed: { sha256: OTHER_SHA256, head: HEAD } }],
    });
    expect(text, `${tool} silently accepted a self-contradicting (lying) reference`).toMatch(/HASH MISMATCH/);
  });

  test.each(METADATA_BOUNDARIES)('%s rejects a non-array under the reserved key', (tool) => {
    const text = issueTextFor(tool, { [KEY]: VALID_REF });
    expect(text).toMatch(/must be an ARRAY/);
  });

  test.each(METADATA_BOUNDARIES)('%s ACCEPTS a valid reference (the guard is not a blanket ban)', (tool) => {
    const text = issueTextFor(tool, { [KEY]: [VALID_REF] });
    // Other required fields of the tool may be missing — that is fine and expected. What must
    // NOT appear is any complaint about the artifact reference itself.
    expect(text).not.toMatch(/artifact|ARRAY|provider|sha256|MISMATCH/i);
  });

  test.each(METADATA_BOUNDARIES)('%s leaves unrelated metadata completely alone', (tool) => {
    // The shapes prod already carries: the control-plane dispatch-proof + the amp-orb eval refs.
    const text = issueTextFor(tool, {
      kind: 'dispatch-proof',
      commitSha: '32cff00da3f23164810611a2234274a1104de188',
      commitVerified: true,
      amp_thread_id: 'T-019f2b33-0840-74c2-911a-d2ecdcdefa30',
    });
    expect(text).not.toMatch(/artifact|provider|sha256|MISMATCH/i);
  });
});

describe('the boundary error is ACTIONABLE (a rejection must teach, not just refuse)', () => {
  test('names the offending index, the problem, and the allowed set', () => {
    const text = issueTextFor('context_store', {
      [KEY]: [VALID_REF, { ...VALID_REF, retrieval: { provider: 'usb-stick', path: 'x' } }],
    });
    expect(text).toContain(`${KEY}[1]`);
    expect(text).toContain('usb-stick');
    for (const p of ARTIFACT_REF_CONFIG.allowedProviders) expect(text).toContain(p);
  });

  test('a contradicted reference is refused with WHY it is dangerous, not just "invalid"', () => {
    const text = issueTextFor('context_store', {
      [KEY]: [{ ...VALID_REF, observed: { sha256: OTHER_SHA256, head: HEAD } }],
    });
    expect(text).toContain('HASH MISMATCH');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('worse than no record');
  });
});
