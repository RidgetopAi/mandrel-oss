/**
 * INPUT HYGIENE — boundary-validation unit + mutation-probe
 *
 * THE INCIDENT (2026-07-17): a degraded client session created 12 tasks whose
 * `description` ended with RAW leaked tool-call XML (the field's own `</description>`
 * closing tag followed by `<parameter name="tags">[...]`), with `tags` stored EMPTY and
 * `createdBy` the literal STRING "null". Mandrel accepted every one silently. Mandrel is a
 * memory product, so silently storing poison corrupts every later session that reads it.
 *
 * WHAT THIS PROVES (NO DB — pure validation boundary, the seam every ingress path shares
 * via validationMiddleware → validateToolArguments → zod):
 *   1. The centralized detector (utils/inputHygiene) matches a RAW leak but NOT the same
 *      tags QUOTED in backticks/fences as documentation (a past incident pt 4 — a guard
 *      stricter than reality is a bug; THIS task's own description quotes those tags).
 *   2. MUTATION PROBE — replaying a corrupted incident payload through the PUBLIC
 *      validator now throws (rejected/flagged), where before it sailed through.
 *   3. The reserved-identity-string guard rejects the literal "null"/"undefined".
 */

import { describe, test, expect } from 'vitest';
import {
  stripCodeSpans,
  findArtifactSignatures,
  hasArtifactSignature,
  isReservedIdentityString,
} from '../utils/inputHygiene.js';
import { validateToolArguments } from '../middleware/validation.js';

// The exact shape of the incident: a real description whose tail is the leaked serialized
// tool call — the field's own closing wrapper tag then the next parameter.
const CORRUPTED_DESCRIPTION =
  'Implement the sessions rollout plan and file the follow-up tasks.\n' +
  '</description>\n' +
  '<parameter name="tags">["launch-blocker","repo:mandrel"]</parameter>';

// A LEGIT bug-report that DOCUMENTS the same tags inside backticks/fences — must PASS
// (this is exactly what an earlier task's own description does).
const LEGIT_DOC_DESCRIPTION =
  'The degraded client leaked raw tool-call XML: the description ended with ' +
  '`</description>` + `<parameter name="tags">[...]`. A legit description never contains ' +
  'these UN-QUOTED. Example of the leak:\n```\nfoo\n</description>\n```\nFix at the boundary.';

describe('inputHygiene detector — code-span aware', () => {
  test('stripCodeSpans removes fenced + inline code, keeps prose', () => {
    expect(stripCodeSpans('a `code` b')).not.toContain('code');
    expect(stripCodeSpans('a ```\nblock\n``` b')).not.toContain('block');
    expect(stripCodeSpans('plain prose here')).toContain('plain prose');
  });

  test('RAW leaked tool-call XML is detected', () => {
    const found = findArtifactSignatures(CORRUPTED_DESCRIPTION);
    expect(found.length).toBeGreaterThan(0);
    expect(hasArtifactSignature(CORRUPTED_DESCRIPTION)).toBe(true);
    // Both the incident signatures are present as RAW text.
    expect(found).toContain('</description>');
    expect(found).toContain('<parameter name=');
  });

  test('the SAME tags QUOTED as documentation are NOT flagged (no false positive)', () => {
    // This is the crux: a guard stricter than reality would reject a legit bug report.
    expect(findArtifactSignatures(LEGIT_DOC_DESCRIPTION)).toEqual([]);
    expect(hasArtifactSignature(LEGIT_DOC_DESCRIPTION)).toBe(false);
  });

  test('reserved identity strings rejected; real names accepted', () => {
    expect(isReservedIdentityString('null')).toBe(true);
    expect(isReservedIdentityString('  NULL ')).toBe(true);
    expect(isReservedIdentityString('undefined')).toBe(true);
    expect(isReservedIdentityString('Builder')).toBe(false);
    expect(isReservedIdentityString('coordinator')).toBe(false);
    expect(isReservedIdentityString('')).toBe(false); // empty handled by field rules
  });
});

describe('ADVERSARIAL — a raw leak must not hide behind an UNTERMINATED code fence (Reviewer finding)', () => {
  // The bypass Reviewer found: a lone/dangling ``` fence with a raw leak AFTER it. The old
  // detector stripped from the dangling fence to end-of-string, so the leak vanished from
  // the scan and slipped through. Fail-safe fix: an unclosed fence hides nothing.
  const DANGLING_FENCE_LEAK =
    'some text ```\n</description>\n<parameter name="tags">["launch-blocker"]';
  const DANGLING_TILDE_LEAK =
    'note ~~~\n</parameter>\n<invoke name="task_create">';

  // Legit CLOSED fence quoting the SAME signature — must STILL pass (don't regress the
  // quoted-docs-pass case that protects real bug reports like this task's own description).
  const CLOSED_FENCE_DOC =
    'here is the leak shape:\n```\nfoo\n</description>\n<parameter name="tags">[...]\n```\nfix at the boundary.';
  const CLOSED_INLINE_DOC = 'the tell is `</description>` followed by `<parameter name=`.';

  test('dangling ``` fence then a raw leak is DETECTED (was the bypass)', () => {
    expect(findArtifactSignatures(DANGLING_FENCE_LEAK).length).toBeGreaterThan(0);
    expect(hasArtifactSignature(DANGLING_FENCE_LEAK)).toBe(true);
  });

  test('dangling ~~~ fence then a raw leak is DETECTED', () => {
    expect(hasArtifactSignature(DANGLING_TILDE_LEAK)).toBe(true);
  });

  test('a properly CLOSED fence with the same signature inside still PASSES (no regression)', () => {
    expect(findArtifactSignatures(CLOSED_FENCE_DOC)).toEqual([]);
    expect(hasArtifactSignature(CLOSED_FENCE_DOC)).toBe(false);
  });

  test('a properly CLOSED inline span with the signature inside still PASSES', () => {
    expect(hasArtifactSignature(CLOSED_INLINE_DOC)).toBe(false);
  });

  test('BOTH-WAYS via the PUBLIC validator: dangling-fence leak REJECTED, closed-span docs PASS', () => {
    // Reject the bypass through the real boundary.
    expect(() =>
      validateToolArguments('task_create', { title: 'x', description: DANGLING_FENCE_LEAK }),
    ).toThrow(/tool-call XML/i);
    // Accept the legit closed-fence documentation.
    expect(() =>
      validateToolArguments('task_create', { title: 'x', description: CLOSED_FENCE_DOC }),
    ).not.toThrow();
  });
});

describe('MUTATION PROBE — replay a corrupted incident payload through the PUBLIC validator', () => {
  test('task_create with leaked-XML description is now REJECTED (was silently stored)', () => {
    expect(() =>
      validateToolArguments('task_create', {
        title: 'Sessions rollout',
        description: CORRUPTED_DESCRIPTION,
      }),
    ).toThrow(/tool-call XML/i);
  });

  test('task_create with assignedTo = literal "null" is now REJECTED', () => {
    expect(() =>
      validateToolArguments('task_create', { title: 'X', assignedTo: 'null' }),
    ).toThrow(/null.*undefined|stringified empty/i);
  });

  test('task_create with createdBy = literal "undefined" is now REJECTED', () => {
    expect(() =>
      validateToolArguments('task_create', { title: 'X', createdBy: 'undefined' }),
    ).toThrow();
  });

  test('a CLEAN task_create still validates (no false positive at the boundary)', () => {
    const ok = validateToolArguments('task_create', {
      title: 'A normal task',
      description: LEGIT_DOC_DESCRIPTION,
      assignedTo: 'Builder',
      createdBy: 'coordinator',
    });
    expect(ok.title).toBe('A normal task');
    expect(ok.assignedTo).toBe('Builder');
  });

  test('the class is guarded on the SIBLING write paths too (context_store, task_update)', () => {
    // context_store content — same memory surface, same guard.
    expect(() =>
      validateToolArguments('context_store', { content: CORRUPTED_DESCRIPTION, type: 'planning' }),
    ).toThrow(/tool-call XML/i);
    // but a context that DOCUMENTS the tags in code spans stores fine.
    expect(() =>
      validateToolArguments('context_store', { content: LEGIT_DOC_DESCRIPTION, type: 'planning' }),
    ).not.toThrow();
    // task_update description edit path.
    expect(() =>
      validateToolArguments('task_update', {
        taskId: '440ff00d-1111-2222-3333-444455556666',
        description: CORRUPTED_DESCRIPTION,
      }),
    ).toThrow(/tool-call XML/i);
  });
});

describe('SHORT-ID CONTRACT — task_create.dependencies shape', () => {
  test('an id8 short id PASSES the boundary shape (no longer a bare z.string that skips the resolver)', () => {
    // Shape-validation only here (resolution is DB-backed, covered by the contract test):
    // the point is the id8 is now ACCEPTED at the edge with the same shape every other id
    // arg uses, instead of being passed raw to the uuid[] column.
    const ok = validateToolArguments('task_create', {
      title: 'depends on something',
      dependencies: ['440ff00d'],
    });
    expect(ok.dependencies).toEqual(['440ff00d']);
  });

  test('a full UUID dependency PASSES', () => {
    const ok = validateToolArguments('task_create', {
      title: 't',
      dependencies: ['440ff00d-1111-2222-3333-444455556666'],
    });
    expect(ok.dependencies?.length).toBe(1);
  });

  test('a NON-HEX garbage dependency is REJECTED at the edge (tool-level, actionable)', () => {
    expect(() =>
      validateToolArguments('task_create', { title: 't', dependencies: ['not-an-id!!'] }),
    ).toThrow(/full UUID or a short id|hex/i);
  });
});
