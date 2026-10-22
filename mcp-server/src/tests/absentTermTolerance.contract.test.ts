/**
 * ABSENT-TERM TOLERANCE — end-to-end over a seeded corpus.
 *
 * The REAL smartSearchHandler against a migrated Postgres (embeddings stubbed, as in
 * hybridSearch.contract.test.ts). Corpus: a small set of records about a business trip on
 * the 7th. One unfamiliar word — a typo, an ordinal, a quoted identifier — must not empty
 * the results; a short question whose only substantive term is absent still returns empty.
 * The decision logic itself is covered DB-free in absentTermTolerance.unit.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding, activeEmbeddingColumn } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding(), dimensions: embedDim(), model: 'mock' })),
  },
}));

import { db } from '../config/database.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';

const STAMP = Date.now();
let project: string;
let tripId: string;

const search = (q: string) => smartSearchHandler.smartSearchDetailed(project, q, undefined, 10);

describe('smart_search tolerates one unfamiliar word', () => {
  beforeAll(async () => {
    project = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1,'tolerance') RETURNING id`, [`tol-${STAMP}`],
    )).rows[0].id;
    const ins = async (content: string) =>
      (await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
         VALUES ($1,'note',$2,$3::vector) RETURNING id`,
        [project, content, `[${patternEmbedding().join(',')}]`],
      )).rows[0].id as string;
    await ins('Quarterly budget review notes for the finance team, nothing about travel.');
    await ins('The office printer was replaced and the network cabling was labelled.');
    tripId = await ins('Business trip to Denver on the 7th: flew out in the morning and met the client about the contract renewal.');
  });

  afterAll(async () => {
    try { await db.query('DELETE FROM contexts WHERE project_id = $1', [project]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM projects WHERE id = $1', [project]); } catch { /* ignore */ }
    await db.end();
  });

  const expectTripTop3 = async (q: string) => {
    const out = await search(q);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.slice(0, 3).map((r) => r.id)).toContain(tripId);
  };

  test('a typo ("buisiness") does not empty the results', () => expectTripTop3('When was my buisiness trip to Denver?'));
  test('an ordinal ("7th") does not empty the results', () => expectTripTop3('What did I do on the 7th during the trip?'));
  test('an ordinal absent from the corpus ("27th") does not empty the results', () => expectTripTop3('What did I do on the 27th during the trip to Denver?'));
  test('one unknown identifier in a long question does not empty the results', () =>
    expectTripTop3('Which client did I meet in Denver on the business trip about the contract renewal SIAC_GEE?'));

  test('a short question whose only substantive term is absent still returns empty', async () => {
    const out = await search('kubernetes setup?');
    expect(out.results).toEqual([]);
    expect(out.emptyReason?.kind).toBe('absent_terms');
  });
});
