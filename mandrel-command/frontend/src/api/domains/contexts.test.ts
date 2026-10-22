/**
 * Contract guard (blue-tape FIX #5): the contexts `toQuery` mapper must emit snake_case
 * for EVERY key the Command backend reads. The backend (controllers/context.ts +
 * ContextSearchQuerySchema) reads snake_case and Zod-STRIPS unknown keys — so the old
 * camelCase `sortBy`/`sortOrder`/`projectId`/`sessionId` were silently dropped and the
 * Contexts sort dropdown did nothing. This test pins the wire contract so the drift
 * (invisible at runtime — no error, just an ignored sort) can't regress.
 */
import { describe, it, expect } from 'vitest';
import { toQuery } from './contexts';
import type { ContextSearchParams } from '../../types/context';

describe('contexts toQuery — snake_case wire contract', () => {
  const params: ContextSearchParams = {
    query: 'auth',
    project_id: 'p-1',
    session_id: 's-1',
    type: 'handoff',
    tags: ['a', 'b'],
    min_similarity: 0.5,
    date_from: '2026-01-01',
    date_to: '2026-02-01',
    limit: 20,
    offset: 0,
    sort_by: 'created_at',
    sort_order: 'asc',
  };

  it('emits snake_case for sort_by / sort_order / project_id / session_id', () => {
    const q = toQuery(params);
    expect(q.sort_by).toBe('created_at');
    expect(q.sort_order).toBe('asc');
    expect(q.project_id).toBe('p-1');
    expect(q.session_id).toBe('s-1');
  });

  it('does NOT emit the old camelCase keys the backend would strip', () => {
    const q = toQuery(params) as Record<string, unknown>;
    expect('sortBy' in q).toBe(false);
    expect('sortOrder' in q).toBe(false);
    expect('projectId' in q).toBe(false);
    expect('sessionId' in q).toBe(false);
  });

  it('joins tags into a comma string and preserves the other snake_case keys', () => {
    const q = toQuery(params);
    expect(q.tags).toBe('a,b');
    expect(q.min_similarity).toBe(0.5);
    expect(q.date_from).toBe('2026-01-01');
    expect(q.date_to).toBe('2026-02-01');
  });
});
