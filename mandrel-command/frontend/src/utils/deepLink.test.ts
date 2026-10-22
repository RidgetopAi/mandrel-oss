/**
 * Feature A — per-record deep-link route logic.
 *
 * The repo has no React render-testing infra (no @testing-library/react); see
 * SessionDetail.uuid.test.tsx. So we unit-test the PURE decision logic that the
 * detail pages (DecisionDetailPage / ContextDetailPage / TaskDetailPage) all
 * delegate to — fetch gating, the not-found predicate, `?q=` parsing, and route
 * path building — plus source-checks (in the per-page specs) that bind the
 * pages to these helpers and to the reused detail components.
 */
import {
  shouldFetchRecord,
  isRecordNotFound,
  getHighlightQuery,
  recordPath,
} from './deepLink';

const VALID_ID = 'c875b2af-9020-41b7-9595-d70221603464';

describe('shouldFetchRecord — only fetch for a real UUID', () => {
  test('valid UUID => fetch', () => {
    expect(shouldFetchRecord(VALID_ID)).toBe(true);
  });
  test('malformed / absent id => do NOT fetch (no guaranteed-400 request)', () => {
    for (const bad of ['not-a-uuid', 'session_x', 'undefined', '', undefined]) {
      expect(shouldFetchRecord(bad as any)).toBe(false);
    }
  });
});

describe('isRecordNotFound — clean not-found, never a blank/crash', () => {
  test('malformed id => not found immediately (never fetched)', () => {
    expect(
      isRecordNotFound({ id: 'bad', isLoading: false, isError: false, hasData: false })
    ).toBe(true);
  });

  test('valid id still loading => NOT not-found (show spinner)', () => {
    expect(
      isRecordNotFound({ id: VALID_ID, isLoading: true, isError: false, hasData: false })
    ).toBe(false);
  });

  test('valid id, load error => not found', () => {
    expect(
      isRecordNotFound({ id: VALID_ID, isLoading: false, isError: true, hasData: false })
    ).toBe(true);
  });

  test('valid id resolved with no record => not found', () => {
    expect(
      isRecordNotFound({ id: VALID_ID, isLoading: false, isError: false, hasData: false })
    ).toBe(true);
  });

  test('valid id resolved WITH a record => found (renders detail)', () => {
    expect(
      isRecordNotFound({ id: VALID_ID, isLoading: false, isError: false, hasData: true })
    ).toBe(false);
  });
});

describe('getHighlightQuery — parse optional ?q= term', () => {
  test('reads q from a URLSearchParams (react-router useSearchParams)', () => {
    expect(getHighlightQuery(new URLSearchParams('?q=column'))).toBe('column');
  });
  test('reads q from a raw search string', () => {
    expect(getHighlightQuery('q=archived_at')).toBe('archived_at');
  });
  test('trims surrounding whitespace', () => {
    expect(getHighlightQuery('q=%20%20hello%20%20')).toBe('hello');
  });
  test('absent q => undefined (nothing to thread)', () => {
    expect(getHighlightQuery('')).toBeUndefined();
    expect(getHighlightQuery(new URLSearchParams('foo=bar'))).toBeUndefined();
  });
  test('blank q => undefined (never threads an empty string)', () => {
    expect(getHighlightQuery('q=')).toBeUndefined();
    expect(getHighlightQuery('q=%20%20')).toBeUndefined();
  });
  test('preserves other params, decodes value', () => {
    expect(getHighlightQuery('a=1&q=hello%20world&b=2')).toBe('hello world');
  });
});

describe('recordPath — canonical in-app deep-link paths (tab-reusing nav)', () => {
  test('builds the base route per kind', () => {
    expect(recordPath('decision', VALID_ID)).toBe(`/decisions/${VALID_ID}`);
    expect(recordPath('context', VALID_ID)).toBe(`/contexts/${VALID_ID}`);
    expect(recordPath('task', VALID_ID)).toBe(`/tasks/${VALID_ID}`);
  });
  test('appends an encoded ?q= when provided', () => {
    expect(recordPath('context', VALID_ID, 'hello world')).toBe(
      `/contexts/${VALID_ID}?q=hello%20world`
    );
  });
  test('omits ?q= for blank/whitespace terms', () => {
    expect(recordPath('task', VALID_ID, '   ')).toBe(`/tasks/${VALID_ID}`);
    expect(recordPath('task', VALID_ID, '')).toBe(`/tasks/${VALID_ID}`);
  });
  test('round-trips through getHighlightQuery', () => {
    const p = recordPath('decision', VALID_ID, 'archived_at column');
    const search = p.slice(p.indexOf('?'));
    expect(getHighlightQuery(search)).toBe('archived_at column');
  });
});
