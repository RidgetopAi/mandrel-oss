/**
 * METADATA SUBTREE HYGIENE — the leaked-tool-call-XML rule applied to `metadata`
 *
 * THE HOLE: `content` / `title` / `description` are wrapped in artifactFreeText; `metadata`
 * was scanned for NOTHING. P4 L1 then made that acute — its capture contract instructs agents
 * to cite "the command and its output" in `metadata.capture.evidence`, so the field we push
 * raw tool output into had LESS hygiene than the prose beside it.
 *
 * WHAT THIS PROVES (no DB — the pure validation boundary every ingress path shares):
 *   1. the reported field is guarded, AND the rejection NAMES the offending path;
 *   2. the guard is on the SHARED metadata definition, so its siblings and the other write
 *      boundaries are covered by construction rather than by anyone remembering them;
 *   3. it is NOT over-broad — ordinary command output, angle brackets, HTML, and
 *      backtick-quoted documentation of the very tags it matches all still store;
 *   4. a bag too deep/large to walk is REFUSED rather than passed, so "could not measure"
 *      never gets spelled "clean" (CLASSES.md C1).
 *
 * Every payload here is OBVIOUSLY SYNTHETIC. No real credential appears in this file.
 */

import { describe, test, expect } from 'vitest';
import { findArtifactSignaturesDeep } from '../utils/inputHygiene.js';
import { METADATA_SCAN_MAX_DEPTH, METADATA_SCAN_MAX_NODES } from '../config/inputHygieneConfig.js';
import { validateToolArguments } from '../middleware/validation.js';

/** The incident shape: a RAW (un-quoted) serialized tool call bled into a value. */
const RAW_LEAK =
  'ran the gate, it was green\n' +
  '</description>\n' +
  '<parameter name="tags">["x"]</parameter>';

/** The SAME tags, deliberately marked as code — documentation, not a leak. */
const QUOTED_DOC =
  'The degraded client wrote `</description>` then `<parameter name="tags">` into the value.';

/** What an honest `verified` capture actually looks like. */
const ORDINARY_EVIDENCE = '$ npx vitest run\n Test Files  1 passed (1)\n      Tests  12 passed (12)';

const capture = (evidence: unknown) => ({ capture: { status: 'verified', evidence } });
const ctx = (metadata: unknown) => ({ content: 'clean prose', type: 'completion', metadata });

describe('findArtifactSignaturesDeep — the subtree walker', () => {
  test('finds a leak at any depth, in objects and arrays, and reports WHERE', () => {
    const scan = findArtifactSignaturesDeep({ capture: { evidence: [{ output: RAW_LEAK }] } });
    expect(scan.findings.map((f) => f.path)).toEqual(['capture.evidence[0].output']);
    expect(scan.findings[0].signatures).toContain('<parameter name=');
    expect(scan.truncated).toBe(false);
  });

  test('non-strings and quoted documentation are not findings', () => {
    const scan = findArtifactSignaturesDeep({
      n: 1,
      b: true,
      nul: null,
      doc: QUOTED_DOC,
      out: ORDINARY_EVIDENCE,
      nested: { arr: [1, null, 'plain'] },
    });
    expect(scan.findings).toEqual([]);
    expect(scan.truncated).toBe(false);
  });

  test('a bag deeper than the bound reports TRUNCATED, not clean', () => {
    let node: unknown = RAW_LEAK;
    for (let i = 0; i < METADATA_SCAN_MAX_DEPTH + 5; i++) node = { n: node };
    const scan = findArtifactSignaturesDeep(node);
    // The leak is out of reach — so the honest answer is "I could not measure", and the
    // empty findings list must NOT be readable as clean.
    expect(scan.findings).toEqual([]);
    expect(scan.truncated).toBe(true);
  });

  test('a bag wider than the NODE bound also reports TRUNCATED, not clean', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < METADATA_SCAN_MAX_NODES + 10; i++) wide[`k${i}`] = 'plain';
    expect(findArtifactSignaturesDeep(wide).truncated).toBe(true);
  });

  test('an EMPTY container sitting at the depth bound hides nothing, so it is not truncation', () => {
    // Exactly METADATA_SCAN_MAX_DEPTH wrappers puts the empty `{}` AT the bound: it is the
    // first node not walked into, and walking into it would have found nothing.
    let node: unknown = {};
    for (let i = 0; i < METADATA_SCAN_MAX_DEPTH; i++) node = { n: node };
    expect(findArtifactSignaturesDeep(node).truncated).toBe(false);
    // ...whereas a NON-empty container at that same bound IS unwalked content, and says so.
    let withChild: unknown = { n: 'unreachable leaf' };
    for (let i = 0; i < METADATA_SCAN_MAX_DEPTH; i++) withChild = { n: withChild };
    expect(findArtifactSignaturesDeep(withChild).truncated).toBe(true);
  });
});

describe('THE REPORTED FIELD — metadata.capture.evidence at the public validator', () => {
  test('a raw leak in evidence is REJECTED, and the message names the field', () => {
    expect(() => validateToolArguments('context_store', ctx(capture(RAW_LEAK)))).toThrow(
      /metadata\.capture\.evidence/,
    );
    expect(() => validateToolArguments('context_store', ctx(capture(RAW_LEAK)))).toThrow(
      /tool-call XML/i,
    );
  });

  test('the ARRAY evidence form is walked too, and the index is named', () => {
    expect(() =>
      validateToolArguments('context_store', ctx(capture([{ command: 'x', output: RAW_LEAK }]))),
    ).toThrow(/metadata\.capture\.evidence\[0\]\.output/);
  });
});

describe('THE CLASS, NOT THE INSTANCE — siblings and other boundaries, by construction', () => {
  test('an ARBITRARY metadata key is guarded, not just the reserved ones', () => {
    expect(() => validateToolArguments('context_store', ctx({ scratch: RAW_LEAK }))).toThrow(
      /metadata\.scratch/,
    );
  });

  test.each([
    ['task_create', { title: 'clean title', metadata: capture(RAW_LEAK) }],
    [
      'decision_record',
      {
        decisionType: 'process',
        title: 't',
        description: 'd',
        rationale: 'r',
        impactLevel: 'low',
        metadata: capture(RAW_LEAK),
      },
    ],
    [
      'link',
      {
        from: 'aaaaaaaa',
        fromType: 'context',
        to: 'bbbbbbbb',
        toType: 'context',
        edgeType: 'related_to',
        metadata: capture(RAW_LEAK),
      },
    ],
    ['project_create', { name: 'p-hygiene-probe', metadata: capture(RAW_LEAK) }],
  ])('%s inherits the metadata guard from the shared definition', (tool, args) => {
    expect(() => validateToolArguments(tool, args as any)).toThrow(/tool-call XML/i);
  });

  test('`notes` is metadata by another door (it is appended into metadata.noteLog) and is guarded', () => {
    expect(() =>
      validateToolArguments('task_update', {
        taskId: '440ff00d-1111-2222-3333-444455556666',
        notes: RAW_LEAK,
      }),
    ).toThrow(/tool-call XML/i);
  });

  test('the decision + project + handoff prose fields the first pass missed are guarded', () => {
    expect(() =>
      validateToolArguments('decision_record', {
        decisionType: 'process',
        title: 't',
        description: 'd',
        rationale: 'r',
        impactLevel: 'low',
        alternativesConsidered: [{ name: 'a', reasonRejected: RAW_LEAK }],
      }),
    ).toThrow(/tool-call XML/i);
    expect(() =>
      validateToolArguments('project_create', { name: 'p-hygiene-probe', description: RAW_LEAK }),
    ).toThrow(/tool-call XML/i);
    expect(() =>
      validateToolArguments('context_store', {
        content: 'clean prose',
        type: 'handoff',
        spine: RAW_LEAK,
      }),
    ).toThrow(/tool-call XML/i);
    // The session + membership prose the FIRST round of this sweep still missed: both are
    // persisted (sessions.title / sessions.session_goal, branch_membership_moves.reason).
    expect(() => validateToolArguments('session_start', { title: RAW_LEAK })).toThrow(
      /tool-call XML/i,
    );
    expect(() => validateToolArguments('session_start', { goal: RAW_LEAK })).toThrow(
      /tool-call XML/i,
    );
    expect(() =>
      validateToolArguments('branch_assign', { id: 'aaaaaaaa1111', spine: 'bbbbbbbb2222', reason: RAW_LEAK }),
    ).toThrow(/tool-call XML/i);
    expect(() =>
      validateToolArguments('branch_unassign', { id: 'aaaaaaaa1111', reason: RAW_LEAK }),
    ).toThrow(/tool-call XML/i);
    // ...and ordinary text on those same four still stores.
    expect(() => validateToolArguments('session_start', { title: 'Batch 2', goal: 'close the sweep' })).not.toThrow();
    expect(() =>
      validateToolArguments('branch_assign', { id: 'aaaaaaaa1111', spine: 'bbbbbbbb2222', reason: 'moved under the spine' }),
    ).not.toThrow();
  });

  test('a bag too deep to walk is REFUSED — an unscanned bag is not a clean bag', () => {
    let node: unknown = 'leaf';
    for (let i = 0; i < METADATA_SCAN_MAX_DEPTH + 5; i++) node = { n: node };
    expect(() => validateToolArguments('context_store', ctx(node))).toThrow(/too deeply nested/i);
  });
});

describe('NOT OVER-BROAD — an evidence field is command output, and must stay writable', () => {
  test.each([
    ['ordinary test output', ORDINARY_EVIDENCE],
    ['the tags QUOTED as documentation', QUOTED_DOC],
    ['shell redirection and comparisons', "$ awk '$3 > 5 && $1 < 9' f.txt | tee out.log\n42 rows"],
    ['HTML in captured output', '$ curl -sI x\nHTTP/2 200\n<html><body><p>ok</p></body></html>'],
    ['a diff hunk', '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = <T,>(x: T) => x;'],
    ['an empty string', ''],
  ])('evidence: %s still stores', (_label, evidence) => {
    expect(() =>
      validateToolArguments('context_store', {
        content: 'clean prose',
        type: 'completion',
        metadata: { capture: { status: 'believed', evidence } },
      }),
    ).not.toThrow();
  });

  test('a normal mixed-type metadata bag still stores', () => {
    expect(() =>
      validateToolArguments(
        'context_store',
        ctx({
          capture: { status: 'verified', evidence: ORDINARY_EVIDENCE },
          tranche: 'b2',
          count: 3,
          ok: true,
          missing: null,
          nested: { a: { b: ['x', 2, false] } },
        }),
      ),
    ).not.toThrow();
  });

  test('an empty bag stores, and so does a record with no metadata at all', () => {
    expect(() => validateToolArguments('context_store', ctx({}))).not.toThrow();
    expect(() =>
      validateToolArguments('context_store', { content: 'clean prose', type: 'completion' }),
    ).not.toThrow();
  });
});
