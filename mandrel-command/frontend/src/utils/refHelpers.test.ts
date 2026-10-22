/**
 * Named-ref grammar test (Command UI).
 *
 * Pins the `ref:<slug>` grammar the reader uses to surface a context's named handle
 * (e.g. "ref:resume"). Mirrors the backend ref grammar (mcp-server/src/utils/refs.ts).
 *
 * NOTE: the `contextHandleChip` suite was removed with the helper itself —
 * its only consumer was ContextCard, which the grid→rail revert retired. The grammar tests
 * below are the live ones: findRefTag is still consumed by ContextReader.
 *
 * Consistent with this repo's convention (see SessionDetail.uuid.test.tsx) of
 * unit-testing the decision predicate rather than adding React render test infra.
 */
import { findRefTag, REF_TAG_REGEX } from './refHelpers';

describe('named-ref grammar', () => {
  test('REF_TAG_REGEX matches the canonical grammar, rejects garbage', () => {
    expect(REF_TAG_REGEX.test('ref:resume')).toBe(true);
    expect(REF_TAG_REGEX.test('ref:cp-gaps')).toBe(true);
    expect(REF_TAG_REGEX.test('ref:audit-retrieval-2')).toBe(true);
    expect(REF_TAG_REGEX.test('ref:Resume')).toBe(false);
    expect(REF_TAG_REGEX.test('ref:my resume')).toBe(false);
    expect(REF_TAG_REGEX.test('ref:-bad')).toBe(false);
    expect(REF_TAG_REGEX.test('ref:')).toBe(false);
    expect(REF_TAG_REGEX.test('task:abc12345')).toBe(false);
  });

  test('findRefTag returns the first well-formed ref, ignores malformed/non-ref tags', () => {
    expect(findRefTag(['audit', 'ref:resume', 'task:abc12345'])).toBe('ref:resume');
    expect(findRefTag(['audit', 'task:abc12345'])).toBeUndefined();
    expect(findRefTag(['ref:Bad Slug'])).toBeUndefined();
    expect(findRefTag(undefined)).toBeUndefined();
  });
});
