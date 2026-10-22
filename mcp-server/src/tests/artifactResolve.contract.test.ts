/**
 * ARTIFACT RESOLUTION END-TO-END — `context_artifact`.
 *
 * THE ACCEPTANCE THIS PROVES: "a fresh orchestrator can deterministically locate and verify an
 * accepted external artifact with NO human archaeology."
 *
 * So this suite deliberately re-enacts the evaluator's scenario end-to-end through the PUBLIC
 * tool path (validate → routeExecutor — the exact path the HTTP bridge and an MCP client use):
 *
 *   1. a producer stores a HANDOFF carrying a structured artifact reference;
 *   2. a REPLACEMENT orchestrator, holding nothing but the record id, calls context_artifact
 *      and gets back the source, the expected identity, and the retrieval + verification steps;
 *   3. it fetches the artifact, measures it, and submits the measurement:
 *        - the RIGHT artifact  ⇒ accepted;
 *        - the WRONG artifact  ⇒ a hard, loud STOP (isError), never a warning.
 *
 * It also proves the negative space: a malformed reference cannot be stored in the first place,
 * and a record with no reference says so plainly instead of pretending.
 *
 * Embeddings are mocked so the suite is offline + deterministic (mirrors the other DB-backed
 * contract tests).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';
import Ajv from 'ajv';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { artifactRoutes } from '../routes/artifact.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { buildOutputSchema } from '../config/outputSchemas.js';
import { ARTIFACT_REF_CONFIG } from '../config/artifactRefConfig.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const STAMP = Date.now();
const CONN = `artifact-resolve-${STAMP}`;
const PROJ_NAME = `artifact-resolve-P-${STAMP}`;
const KEY = ARTIFACT_REF_CONFIG.metadataKey;

/** The accepted artifact — the evaluator's git bundle. */
const HEAD = '6acef8712ab2e8c0ffee1234567890abcdef0123';
const BASE = '12ab2e8c0ffee1234567890abcdef01234567890';
const SHA256 = 'a'.repeat(64);
/** What a WRONG artifact hashes to. */
const WRONG_SHA256 = 'b'.repeat(64);

const REF = {
  artifactType: 'git-bundle',
  repository: 'riverbend/amp-exp-1',
  head: HEAD,
  base: BASE,
  sha256: SHA256,
  producerThread: 'T-019f2b33-0840-74c2-911a-d2ecdcdefa30',
  retrieval: { provider: 'amp-thread-file', path: '.git/phase-c-core.bundle' },
};

let projectId: string;
let handoffId: string;

/** Run a tool through the FULL public path (validate THEN routeExecutor). */
async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId: CONN });
}

/** Assert structuredContent validates against the tool's ADVERTISED outputSchema (ajv). */
function expectConformant(resp: any, label: string) {
  expect(resp.structuredContent, `[${label}] must carry structuredContent`).toBeTruthy();
  const validate = ajv.compile(buildOutputSchema('context_artifact' as any));
  const ok = validate(resp.structuredContent) as boolean;
  expect(ok, `[${label}] must validate against the advertised outputSchema: ${JSON.stringify(validate.errors)}`).toBe(true);
}

describe('context_artifact — deterministic locate + fail-closed verify', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'artifact-ref resolution fuse') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    await viaTool('project_switch', { project: projectId });

    // STEP 1 — the producer records the handoff, artifact reference attached.
    const stored = await viaTool('context_store', {
      type: 'handoff',
      content:
        '★ HANDOFF — Phase C core accepted. The work is on an external git bundle; ' +
        'the structured reference (not this prose) is the authoritative pointer.',
      metadata: { [KEY]: [REF] },
    });
    handoffId = stored.structuredContent?.context?.id;
    expect(handoffId, 'the handoff must have stored').toBeTruthy();
  });

  afterAll(async () => {
    if (projectId) {
      for (const t of ['contexts', 'tasks', 'sessions']) {
        try { await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]); } catch { /* ignore */ }
      }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── STEP 2: the replacement orchestrator, holding only an id ───────────────────────────
  describe('a fresh orchestrator holding only the record id', () => {
    test('gets the SOURCE, the EXPECTED IDENTITY and RETRIEVAL INSTRUCTIONS in one call', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId });
      expectConformant(resp, 'resolve');
      expect(resp.isError).toBeFalsy();

      const sc = resp.structuredContent;
      expect(sc.count).toBe(1);
      expect(sc.recordType).toBe('context');
      const a = sc.artifacts[0];

      // Source — where it came from.
      expect(a.source.repository).toBe('riverbend/amp-exp-1');
      expect(a.source.provider).toBe('amp-thread-file');
      expect(a.source.locator).toBe('.git/phase-c-core.bundle');
      expect(a.source.producerThread).toContain('T-019f2b33');
      // Expected identity — what it must BE.
      expect(a.identity.sha256).toBe(SHA256);
      expect(a.identity.head).toBe(HEAD);
      expect(a.identity.base).toBe(BASE);
      // Retrieval + verification — how to GET it and how to KNOW it is right.
      expect(a.retrieval.instructions.join(' ')).toContain('.git/phase-c-core.bundle');
      expect(a.verification.steps.join(' ')).toContain(SHA256);
      expect(a.verification.mustObserve).toEqual(['sha256', 'head']);
      expect(a.verification.failClosed).toBe(true);
    });

    test('resolves by SHORT ID too (the form every Mandrel reference is copied in)', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId.slice(0, 8) });
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.recordId).toBe(handoffId);
    });

    test('the human channel is readable without the structured channel (no archaeology either way)', async () => {
      const text = (await viaTool('context_artifact', { id: handoffId })).content[0].text as string;
      expect(text).toContain('git-bundle');
      expect(text).toContain(HEAD);
      expect(text).toContain('.git/phase-c-core.bundle');
      expect(text).toContain('FAIL-CLOSED');
      // The boundary is stated in the answer itself.
      expect(text).toContain('Mandrel stores NO artifact bytes');
    });

    test('the answer states the boundary: Mandrel stores no artifact bytes', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId });
      expect(resp.structuredContent.storesArtifactBytes).toBe(false);
    });

    test('an UNMEASURED artifact rests at accepted:false — never absent, never true', async () => {
      // The honest resting state. A consumer may key on `accepted` alone and be safe: hiding
      // the field would let its ABSENCE be read as "fine", and `true` is unreachable without a
      // full matching observation.
      const sc = (await viaTool('context_artifact', { id: handoffId })).structuredContent;
      expect(sc.accepted).toBe(false);
      expect(sc.verificationStatus).toBe('unverified');
      expect(sc.reason).toMatch(/not observed/);
    });
  });

  // ── STEP 3: acceptance adjudication ────────────────────────────────────────────────────
  describe('acceptance adjudication is FAIL-CLOSED', () => {
    test('the RIGHT artifact (both identities observed and matching) ⇒ accepted', async () => {
      const resp = await viaTool('context_artifact', {
        id: handoffId,
        observedSha256: SHA256,
        observedHead: HEAD,
      });
      expectConformant(resp, 'verified');
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.accepted).toBe(true);
      expect(resp.structuredContent.verificationStatus).toBe('verified');
    });

    test('the WRONG artifact (hash mismatch) ⇒ a HARD STOP, not a warning', async () => {
      const resp = await viaTool('context_artifact', {
        id: handoffId,
        observedSha256: WRONG_SHA256,
        observedHead: HEAD,
      });
      expectConformant(resp, 'blocked');
      // The load-bearing assertion: the caller is STOPPED, not advised.
      expect(resp.isError, 'a hash mismatch must be an ERROR response').toBe(true);
      expect(resp.structuredContent.ok).toBe(false);
      expect(resp.structuredContent.accepted).toBe(false);
      expect(resp.structuredContent.verificationStatus).toBe('blocked');
      const text = resp.content[0].text as string;
      expect(text).toContain('BLOCKED');
      expect(text).toContain('HASH MISMATCH');
      expect(text).toContain('Do NOT proceed');
    });

    test('the right bytes at the WRONG commit ⇒ also a hard stop', async () => {
      const resp = await viaTool('context_artifact', {
        id: handoffId,
        observedSha256: SHA256,
        observedHead: 'f'.repeat(40),
      });
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.accepted).toBe(false);
    });

    test('a PARTIAL observation is never an acceptance', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId, observedSha256: SHA256 });
      expect(resp.structuredContent.accepted).toBe(false);
      expect(resp.structuredContent.verificationStatus).toBe('unverified');
    });

    test('a garbage "observation" is rejected at the schema, never silently compared', async () => {
      expect(() => validateToolArguments('context_artifact', { id: handoffId, observedSha256: 'not-hex!!' }))
        .toThrow(/observedSha256/);
    });
  });


  // ═════════════════════════════════════════════════════════════════════════════════════
  // ATTACK SUITE — the ways around the guarantee (an earlier task re-work). Each of these
  // reached a NON-blocked answer against the first build.
  // ═════════════════════════════════════════════════════════════════════════════════════
  describe('ATTACK F1 — an out-of-range index must not swallow the adjudication', () => {
    test('a contradicting measurement aimed at a non-existent index is a HARD STOP, not a 200', async () => {
      const resp = await viaTool('context_artifact', {
        id: handoffId,
        index: 5, // the record has exactly 1 reference
        observedSha256: WRONG_SHA256,
        observedHead: HEAD,
      });
      expect(resp.isError, 'an unadjudicable measurement must never return success').toBe(true);
      expect(resp.structuredContent.ok).toBe(false);
      expect(resp.structuredContent.accepted).not.toBe(true);
      // …and it must NOT claim nothing was observed — the caller measured something.
      expect(resp.content[0].text).not.toMatch(/were not observed/);
      expect(resp.content[0].text).toMatch(/index/i);
    });

    test('an out-of-range index is rejected even with no measurement (a caller mistake is not a silent no-op)', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId, index: 5 });
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.ok).toBe(false);
    });

    test('a measurement against a record with ZERO references is a STOP, not a 200', async () => {
      // The SAME fail-open class as the out-of-range index, one branch earlier: the empty-record
      // path returns before the index guard, so it needs its own. Found by re-walking every
      // branch that can reach a response without a verdict, not by a new attack.
      const plain = await viaTool('context_store', { type: 'completion', content: 'no artifacts on this one' });
      const resp = await viaTool('context_artifact', {
        id: plain.structuredContent.context.id,
        observedSha256: SHA256,
        observedHead: HEAD,
      });
      expect(resp.isError, 'a measurement that cannot be adjudicated must never return success').toBe(true);
      expect(resp.structuredContent.accepted).toBe(false);
      expect(resp.content[0].text).toMatch(/ADJUDICATION IMPOSSIBLE/);
    });

    test('POST-CONDITION: no branch can return success while discarding a measurement', async () => {
      // The structural invariant, exercised across every reachable shape: if a measurement was
      // supplied, the answer is an ERROR or it carries a verdict. Never a third thing. This is
      // what makes a future early-return safe by construction rather than by my enumeration.
      const plain = await viaTool('context_store', { type: 'completion', content: 'post-condition sweep' });
      const cases: any[] = [
        { id: handoffId },                                   // resolvable, 1 ref
        { id: handoffId, index: 0 },                         // explicit valid index
        { id: handoffId, index: 99 },                        // out of range
        { id: plain.structuredContent.context.id },          // zero references
        { id: '00000000-0000-4000-8000-000000000000' },      // not found
      ];
      for (const base of cases) {
        const resp = await viaTool('context_artifact', { ...base, observedSha256: SHA256, observedHead: HEAD });
        const carriesVerdict = resp.structuredContent?.verificationStatus !== undefined;
        expect(
          resp.isError === true || carriesVerdict,
          `a measurement was silently discarded for ${JSON.stringify(base)}: ${JSON.stringify(resp.structuredContent)}`,
        ).toBe(true);
        // and nothing in this sweep may claim acceptance
        if (!carriesVerdict) expect(resp.structuredContent?.accepted).not.toBe(true);
      }
    });

    test('index 0 on a 1-reference record still works (the bound is off-by-one safe)', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId, index: 0, observedSha256: SHA256, observedHead: HEAD });
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.accepted).toBe(true);
    });
  });

  describe('ATTACK F2 — a stored observation must not self-certify through the tool', () => {
    test('a record whose reference carries a matching `observed` still resolves as UNVERIFIED', async () => {
      const stored = await viaTool('context_store', {
        type: 'handoff',
        content: 'handoff whose artifact reference carries a (tautological) prior observation',
        metadata: { [KEY]: [{ ...REF, observed: { sha256: SHA256, head: HEAD } }] },
      });
      const resp = await viaTool('context_artifact', { id: stored.structuredContent.context.id });
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.accepted, 'a stored claim must never reach accepted:true').toBe(false);
      expect(resp.structuredContent.verificationStatus).toBe('unverified');
      // The prior claim is surfaced, clearly labelled as not trust-bearing.
      expect(resp.content[0].text).toMatch(/prior claim/i);
    });
  });

  describe('ATTACK F3 — an injected payload cannot be stored, so it can never be emitted', () => {
    test('a locator carrying shell metacharacters is refused at context_store', () => {
      expect(() =>
        validateToolArguments('context_store', {
          type: 'handoff',
          content: 'handoff with a weaponised locator',
          metadata: { [KEY]: [{ ...REF, retrieval: { provider: 'amp-thread-file', path: 'x.bundle; rm -rf /tmp/pwned; echo ' } }] },
        }),
      ).toThrow(/retrieval\.path/);
    });

    test('every emitted line for a stored reference is free of un-quoted metacharacters from the record', async () => {
      const resp = await viaTool('context_artifact', { id: handoffId });
      const a = resp.structuredContent.artifacts[0];
      for (const line of [...a.retrieval.instructions, ...a.verification.steps]) {
        // Nothing from the record can introduce a command separator: the only ; & | ` $ that
        // may appear are inside our own template prose, never adjacent to a substituted value.
        expect(line).not.toMatch(/rm -rf/);
      }
    });
  });

  describe('N1 — a legacy/direct-DB row with a non-array under the reserved key is LOUD', () => {
    test('reports unresolvable rather than "carries NO artifact references"', async () => {
      const stored = await viaTool('context_store', { type: 'completion', content: 'legacy-shaped row' });
      const id = stored.structuredContent.context.id;
      // Write the malformed shape DIRECTLY, bypassing the write boundary — exactly how a
      // legacy row or a direct DB writer would produce it.
      await db.query(
        `UPDATE contexts SET metadata = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [KEY]: { artifactType: 'git-bundle' } }), id],
      );
      const resp = await viaTool('context_artifact', { id });
      expect(resp.isError, 'an unrecognised shape must not read as "no references"').toBe(true);
      expect(resp.content[0].text).not.toMatch(/carries NO artifact references/);
      expect(resp.content[0].text).toMatch(/ARRAY/i);
    });
  });


  // ═════════════════════════════════════════════════════════════════════════════════════
  // N-A — the post-condition must be PINNED, not merely present.
  //
  // Reviewer disabled guard 2 AND the post-condition together and all 24 tests still passed:
  // the two mutually masked each other, so the post-condition could be DELETED with the whole
  // suite green. A guarantee that can be silently removed lasts exactly as long as nobody
  // touches the file. These two tests are the pin.
  // ═════════════════════════════════════════════════════════════════════════════════════
  describe('N-A — the adjudication invariant is pinned by its own tests', () => {
    test('BEHAVIOURAL: a measurement against a MALFORMED reference is a hard stop', async () => {
      // The uncovered path: index 0 exists, but the reference there is too malformed to resolve,
      // so no verdict is produced. Covered by guard 2 AND by the post-condition — this goes RED
      // if BOTH are removed, which is the combination that previously slipped through.
      const stored = await viaTool('context_store', { type: 'completion', content: 'malformed ref at index 0' });
      const id = stored.structuredContent.context.id;
      // Written directly: the write boundary would (correctly) refuse this shape.
      await db.query(`UPDATE contexts SET metadata = $1::jsonb WHERE id = $2`, [
        JSON.stringify({ [KEY]: [{ artifactType: 'git-bundle' }] }),
        id,
      ]);
      const resp = await viaTool('context_artifact', { id, observedSha256: SHA256, observedHead: HEAD });
      expect(resp.isError, 'a measurement against an unresolvable reference must stop').toBe(true);
      expect(resp.structuredContent.accepted).not.toBe(true);
      expect(resp.structuredContent.verificationStatus).toBeUndefined();
    });

    test('WRAPPER ISOLATION: the post-condition itself converts a verdict-less 200 into a stop', async () => {
      // This is the test that PINS THE CLAIM. It bypasses every inner guard by stubbing the
      // inner handler to return exactly what a future careless early-return would return: a
      // success with no verdict. Only the wrapper can catch that, so this goes RED the moment
      // the post-condition is deleted — which is precisely what no existing test could detect.
      const spy = vi
        .spyOn(artifactRoutes as any, 'resolveInner')
        .mockResolvedValue({
          content: [{ type: 'text', text: 'a future early-return that forgot to adjudicate' }],
          structuredContent: { ok: true, recordId: handoffId, count: 1 },
        });
      try {
        const resp = await artifactRoutes.handleResolve({ id: handoffId, observedSha256: SHA256 }, { connectionId: CONN });
        expect(resp.isError, 'the post-condition must convert a verdict-less success into an error').toBe(true);
        expect(resp.structuredContent?.ok).toBe(false);
        expect(resp.structuredContent?.accepted).toBe(false);
        expect(String(resp.structuredContent?.reason)).toMatch(/post-condition/);
        expect(resp.content[0].text).toMatch(/ADJUDICATION LOST/);
      } finally {
        spy.mockRestore();
      }
    });

    test('WRAPPER ISOLATION: with NO measurement supplied, the wrapper stays out of the way', async () => {
      // The invariant is scoped to a supplied measurement. A plain resolve must pass through
      // untouched, or the post-condition would be a blanket failure rather than a guard.
      const spy = vi
        .spyOn(artifactRoutes as any, 'resolveInner')
        .mockResolvedValue({
          content: [{ type: 'text', text: 'plain resolve' }],
          structuredContent: { ok: true, recordId: handoffId, count: 0 },
        });
      try {
        const resp = await artifactRoutes.handleResolve({ id: handoffId }, { connectionId: CONN });
        expect(resp.isError).toBeFalsy();
        expect(resp.structuredContent?.ok).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  // N-B — a supplied measurement is never silently discarded, through the DATA either.
  // ═════════════════════════════════════════════════════════════════════════════════════
  describe('N-B — a measurement outside the type\'s verify contract cannot evaporate', () => {
    test('a git-commit reference cannot even CARRY a sha256 (the field nothing checks)', () => {
      expect(() =>
        validateToolArguments('context_store', {
          type: 'handoff',
          content: 'git-commit ref carrying an unverifiable sha256',
          metadata: {
            [KEY]: [{
              artifactType: 'git-commit', repository: 'org/repo', head: HEAD, sha256: SHA256,
              retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
            }],
          },
        }),
      ).toThrow(/no verification contract/);
    });

    test('measuring a field the type does not verify is BLOCKED, not quietly ignored', async () => {
      const stored = await viaTool('context_store', {
        type: 'handoff',
        content: 'a clean git-commit reference',
        metadata: {
          [KEY]: [{
            artifactType: 'git-commit', repository: 'org/repo', head: HEAD,
            retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
          }],
        },
      });
      // A matching head AND a sha256 this type never verifies: the old build answered
      // accepted:true and dropped the sha256 on the floor.
      const resp = await viaTool('context_artifact', {
        id: stored.structuredContent.context.id,
        observedSha256: WRONG_SHA256,
        observedHead: HEAD,
      });
      expect(resp.isError, 'an unadjudicable measurement must stop, not be discarded').toBe(true);
      expect(resp.structuredContent.accepted).toBe(false);
      expect(resp.content[0].text).toMatch(/UNADJUDICABLE MEASUREMENT/);
    });

    test('the same reference verifies normally when only the verified field is measured', async () => {
      const stored = await viaTool('context_store', {
        type: 'handoff',
        content: 'a clean git-commit reference, measured correctly',
        metadata: {
          [KEY]: [{
            artifactType: 'git-commit', repository: 'org/repo', head: HEAD,
            retrieval: { provider: 'git-remote', uri: 'https://github.com/org/repo.git' },
          }],
        },
      });
      const resp = await viaTool('context_artifact', { id: stored.structuredContent.context.id, observedHead: HEAD });
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.accepted).toBe(true);
    });

    test('a too-short observedHead degrades SAFELY and says why (no surface change needed)', async () => {
      // Deliberately NOT rejected at the zod edge: tightening the param would change the
      // advertised inputSchema (the golden fixture, the reviewer's to regenerate). It degrades
      // fail-closed instead — and now reports the honest reason rather than blaming the caller.
      const resp = await viaTool('context_artifact', { id: handoffId, observedSha256: SHA256, observedHead: '6acef87' });
      expect(resp.structuredContent.accepted).toBe(false);
      expect(resp.structuredContent.verificationStatus).toBe('unverified');
      expect(String(resp.structuredContent.reason)).toMatch(/too abbreviated to confirm/);
    });
  });

  // ── the negative space ─────────────────────────────────────────────────────────────────
  describe('the negative space', () => {
    test('a MALFORMED reference cannot be stored in the first place (write boundary)', () => {
      expect(() =>
        validateToolArguments('context_store', {
          type: 'handoff',
          content: 'handoff with a bad artifact ref',
          metadata: { [KEY]: [{ ...REF, retrieval: { provider: 'usb-stick', path: 'x' } }] },
        }),
      ).toThrow(/not an allowed provider/);
    });

    test('a SELF-CONTRADICTING reference cannot be stored (a lying record is worse than none)', () => {
      expect(() =>
        validateToolArguments('context_store', {
          type: 'handoff',
          content: 'handoff claiming a verification that does not hold',
          metadata: { [KEY]: [{ ...REF, observed: { sha256: WRONG_SHA256, head: HEAD } }] },
        }),
      ).toThrow(/HASH MISMATCH/);
    });

    test('a record with NO reference says so plainly, and teaches the shape', async () => {
      const plain = await viaTool('context_store', { type: 'completion', content: 'no artifacts here' });
      const resp = await viaTool('context_artifact', { id: plain.structuredContent.context.id });
      expectConformant(resp, 'empty');
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.count).toBe(0);
      expect(resp.content[0].text).toContain(`metadata.${KEY}`);
    });

    test('an unknown id is an error, not an empty success', async () => {
      const resp = await viaTool('context_artifact', { id: '00000000-0000-4000-8000-000000000000' });
      expectConformant(resp, 'not-found');
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.ok).toBe(false);
    });

    test('a task can carry a reference too (the same contract on another record type)', async () => {
      const task = await viaTool('task_create', {
        title: `artifact-bearing task ${STAMP}`,
        metadata: { [KEY]: [REF] },
      });
      const taskId = task.structuredContent?.task?.id;
      expect(taskId).toBeTruthy();
      const resp = await viaTool('context_artifact', { id: taskId, recordType: 'task' });
      expect(resp.isError).toBeFalsy();
      expect(resp.structuredContent.recordType).toBe('task');
      expect(resp.structuredContent.artifacts[0].identity.head).toBe(HEAD);
    });
  });
});
