/**
 * Unit tests for the context-search adapter (search consolidation).
 *
 * These pin the argument CONTRACT between the Command REST surface and the ONE
 * matching engine (mcp-server context_search). Pure functions → no DB, no MCP.
 *
 * Covers the consolidation acceptance cases:
 *   - min_similarity 0–1 is applied as ×100 (not ignored, not passed as a fraction).
 *   - projectId REQUIRED → throws (controller maps to 400) when absent.
 *   - id-prefix / full-UUID query routes to the by-id branch ({ id }).
 *   - response_format:'detailed' always (highlight needs full content).
 *   - additive dateFrom/dateTo forwarded; sort_by/order dropped (browse-only).
 */

import {
  buildContextSearchArgs,
  mapCanonicalRowToRest,
  MissingProjectIdError,
} from '../services/contextSearchAdapter';
import type { ContextSearchParams } from '../services/context';
import { allProjects, projectsScope } from '../services/projectListScope';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const FULL_UUID = '0f3906cd-db79-4a1a-9f0e-1a2b3c4d5e6f';

describe('buildContextSearchArgs', () => {
  it('REQUIRES projectId — throws MissingProjectIdError when absent (→ 400)', () => {
    const params: ContextSearchParams = { query: 'how do i start tmux', scope: allProjects };
    expect(() => buildContextSearchArgs(params)).toThrow(MissingProjectIdError);
  });

  it('scales min_similarity from the UI 0–1 into the canonical 0–100 (×100)', () => {
    const args = buildContextSearchArgs({
      query: 'vector search ranking',
      scope: projectsScope([PROJECT]),
      min_similarity: 0.3,
    });
    // 0.3 (UI) must become 30 (canonical), NOT 0.3 and NOT ignored.
    expect(args.minSimilarity).toBe(30);
  });

  it('omits minSimilarity entirely when the UI does not send one', () => {
    const args = buildContextSearchArgs({ query: 'anything', scope: projectsScope([PROJECT])});
    expect(args.minSimilarity).toBeUndefined();
  });

  it('routes a FULL UUID query to the by-id branch ({ id }), not semantic', () => {
    const args = buildContextSearchArgs({ query: FULL_UUID, scope: projectsScope([PROJECT])});
    expect(args.id).toBe(FULL_UUID);
    expect(args.query).toBeUndefined();
    expect(args.response_format).toBe('detailed');
  });

  it('routes a hex id-PREFIX query (>= min length) to the by-id branch', () => {
    const args = buildContextSearchArgs({ query: '0f3906cd', scope: projectsScope([PROJECT])});
    expect(args.id).toBe('0f3906cd');
    expect(args.query).toBeUndefined();
  });

  it('treats a short non-hex word as a normal semantic query (not id)', () => {
    const args = buildContextSearchArgs({ query: 'bucket', scope: projectsScope([PROJECT])});
    expect(args.id).toBeUndefined();
    expect(args.query).toBe('bucket');
  });

  it('builds a semantic query with forwarded structured filters + detailed format', () => {
    const args = buildContextSearchArgs({
      query: 'how to start the coordinator session',
      scope: projectsScope([PROJECT]),
      type: 'planning',
      tags: ['ref:resume'],
      limit: 25,
      offset: 10,
      date_from: '2026-01-01T00:00:00Z',
      date_to: '2026-07-01T00:00:00Z',
      // sort_by/sort_order are BROWSE-only and must be dropped here.
      sort_by: 'created_at',
      sort_order: 'desc',
    });
    expect(args).toMatchObject({
      projectId: PROJECT,
      query: 'how to start the coordinator session',
      type: 'planning',
      tags: ['ref:resume'],
      limit: 25,
      offset: 10,
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-07-01T00:00:00Z',
      response_format: 'detailed',
    });
    // Proof the browse-only sort keys never leak into the engine args.
    const bag = args as unknown as Record<string, unknown>;
    expect(bag.sort_by).toBeUndefined();
    expect(bag.sort_order).toBeUndefined();
  });
});

describe('mapCanonicalRowToRest', () => {
  it('maps a canonical structured row into the REST Context shape + project_name', () => {
    const rest = mapCanonicalRowToRest(
      {
        id: 'abc',
        contextType: 'planning',
        content: 'full body',
        tags: ['a', 'b'],
        metadata: { parent_task: 'x' },
        projectId: PROJECT,
        sessionId: 'sess-1',
        relevance: 87.5,
        relevanceScore: 9,
        similarity: 80,
        createdAt: '2026-07-05T00:00:00.000Z',
      },
      'Riverbend',
    );
    expect(rest).toMatchObject({
      id: 'abc',
      type: 'planning',
      content: 'full body',
      project_id: PROJECT,
      project_name: 'Riverbend',
      session_id: 'sess-1',
      relevance_score: 9,
      relevance: 87.5,
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
    });
  });
});
